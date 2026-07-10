/**
 * XIN-794 one-off migration CLI — re-repair whiteboard docs whose persisted
 * state carries the legacy illegal fractional-index key (`r`+base36, e.g.
 * `r00000003`) the pre-fix repair wrote back.
 *
 * Run with tsx (see the `migrate:fractional-index` npm script):
 *
 *   # 1. DRY RUN (default) — list victim docs, write NOTHING:
 *   npm run migrate:fractional-index
 *
 *   # 2. APPLY — re-repair each victim to legal keys and UPSERT the new state:
 *   npm run migrate:fractional-index -- --apply
 *
 * DB connection comes from the same env the server uses (MYSQL_HOST/PORT/USER/
 * PASSWORD/DATABASE — see src/config/env.ts). The detection + repair logic is in
 * src/whiteboard/migrateFractionalIndex.ts (pure, unit-tested); this file only
 * wires MySQL around it.
 *
 * Safety:
 *   - dry-run first, always: prints the exact document_name + matched element
 *     ids of every victim before any write.
 *   - the repaired bytes are byte-identical to what the server converges to on
 *     the next cold-start load (repairWhiteboardState / fixed clientID), so this
 *     is idempotent — re-running finds nothing to do.
 *   - a live doc will also self-heal on its next load (fix ①+②); this script is
 *     for docs that are not reopened.
 *   - fault-isolated: each victim is migrated in its own transaction inside a
 *     try/catch, so one bad doc (corrupt bytes, deadlock, dropped connection)
 *     is logged and skipped instead of aborting the whole batch. Any failure is
 *     summarized at the end and forces a non-zero exit code.
 */
/* eslint-disable no-console -- this is a stdout-driven ops CLI, not a request path */
import { pathToFileURL } from 'node:url'
import { query, transaction, closePool } from '../src/db/pool.js'
import { yjsDocumentRepo } from '../src/db/repos/yjsDocumentRepo.js'
import { parseDocumentName } from '../src/permission/documentName.js'
import {
  findLegacyIllegalIndices,
  migrateState,
} from '../src/whiteboard/migrateFractionalIndex.js'

interface DocRow {
  document_name: string
  state: Buffer
}

interface Victim {
  documentName: string
  elementIds: string[]
}

function isWhiteboardKey(documentName: string): boolean {
  try {
    return parseDocumentName(documentName).kind === 'whiteboard'
  } catch {
    return false
  }
}

/** Scan every whiteboard row and collect the ones carrying a legacy illegal index. */
async function scanVictims(): Promise<Victim[]> {
  // `%:wb:%` prefilters to whiteboard keys (octo:{space}:{folder}:wb:{board});
  // parseDocumentName then confirms the exact shape.
  const rows = await query<DocRow>(
    "SELECT document_name, state FROM yjs_document WHERE document_name LIKE '%:wb:%'",
  )
  const victims: Victim[] = []
  for (const row of rows) {
    if (!isWhiteboardKey(row.document_name)) continue
    const elementIds = findLegacyIllegalIndices(new Uint8Array(row.state))
    if (elementIds.length > 0) {
      victims.push({ documentName: row.document_name, elementIds })
    }
  }
  return victims.sort((a, b) => a.documentName.localeCompare(b.documentName))
}

export interface MigrationFailure {
  documentName: string
  error: string
}

export interface MigrationResult {
  mode: 'DRY RUN' | 'APPLY'
  total: number
  migrated: number
  unchanged: number
  failed: MigrationFailure[]
}

/**
 * Re-repair a single victim inside its own transaction. Re-reads under FOR
 * UPDATE so a concurrent editor's write is not clobbered, then upserts the
 * migrated bytes. Returns whether the row was rewritten. Throws on DB/decode
 * failure — the caller isolates that so one bad doc cannot abort the batch.
 */
async function migrateVictim(v: Victim): Promise<{ changed: boolean }> {
  return transaction(async (tx) => {
    const current = await yjsDocumentRepo.selectForUpdateTx(tx, v.documentName)
    const { state, changed } = migrateState(current)
    if (!changed) {
      console.log(`  = ${v.documentName}  (already legal on re-read, skipped)`)
      return { changed: false }
    }
    await yjsDocumentRepo.upsertStateTx(tx, v.documentName, Buffer.from(state))
    console.log(`  ✓ ${v.documentName}  (repaired -> legal keys, ${state.length} bytes)`)
    return { changed: true }
  })
}

/**
 * Apply the migration to every victim, isolating failures. A single doc's
 * transaction erroring (bad bytes, deadlock, lost connection) is recorded and
 * the run continues with the remaining victims — a fast-fail here would leave
 * the batch half-migrated on the first flaky row. Failures are surfaced (never
 * swallowed): each is logged, collected in the summary, and drives a non-zero
 * exit code in {@link main}.
 */
export async function applyMigration(victims: Victim[]): Promise<MigrationResult> {
  let migrated = 0
  let unchanged = 0
  const failed: MigrationFailure[] = []
  for (const v of victims) {
    try {
      const { changed } = await migrateVictim(v)
      if (changed) migrated++
      else unchanged++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed.push({ documentName: v.documentName, error: message })
      console.error(`  ✗ ${v.documentName}  (FAILED, skipped: ${message})`)
    }
  }
  return { mode: 'APPLY', total: victims.length, migrated, unchanged, failed }
}

/**
 * Scan for victims and, when `apply` is set, re-repair each. Dry-run (the
 * default) writes NOTHING — it never enters {@link applyMigration}, so no
 * transaction or upsert is issued. Returns the run summary.
 */
export async function runMigration(apply: boolean): Promise<MigrationResult> {
  const mode: MigrationResult['mode'] = apply ? 'APPLY' : 'DRY RUN'
  console.log(`[migrate:fractional-index] mode=${mode}`)

  const victims = await scanVictims()
  console.log(`[migrate:fractional-index] scanned whiteboards, victims=${victims.length}`)
  for (const v of victims) {
    console.log(`  - ${v.documentName}  (illegal-index elements: ${v.elementIds.join(', ')})`)
  }

  if (victims.length === 0) {
    console.log('[migrate:fractional-index] nothing to do.')
    return { mode, total: 0, migrated: 0, unchanged: 0, failed: [] }
  }
  if (!apply) {
    console.log('[migrate:fractional-index] dry run only — re-run with --apply to write.')
    return { mode, total: victims.length, migrated: 0, unchanged: 0, failed: [] }
  }

  const result = await applyMigration(victims)
  console.log(
    `[migrate:fractional-index] done. migrated=${result.migrated} unchanged=${result.unchanged} failed=${result.failed.length} total=${result.total}`,
  )
  if (result.failed.length > 0) {
    console.error(
      `[migrate:fractional-index] ${result.failed.length} document(s) FAILED and were skipped:`,
    )
    for (const f of result.failed) {
      console.error(`    - ${f.documentName}: ${f.error}`)
    }
  }
  return result
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const result = await runMigration(apply)
  // A partial failure must be visible to the operator / CI, not hidden behind a
  // 0 exit code just because the batch was not aborted.
  if (result.failed.length > 0) process.exitCode = 1
}

// Only auto-run when invoked as the CLI entrypoint (tsx scripts/...). Importing
// this module (e.g. from tests) exercises the exported functions without
// touching a real MySQL pool.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main()
    .catch((err) => {
      console.error('[migrate:fractional-index] FAILED:', err)
      process.exitCode = 1
    })
    .finally(() => {
      void closePool()
    })
}
