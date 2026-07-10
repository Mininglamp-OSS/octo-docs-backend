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
 */
/* eslint-disable no-console -- this is a stdout-driven ops CLI, not a request path */
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

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const mode = apply ? 'APPLY' : 'DRY RUN'
  console.log(`[migrate:fractional-index] mode=${mode}`)

  const victims = await scanVictims()
  console.log(`[migrate:fractional-index] scanned whiteboards, victims=${victims.length}`)
  for (const v of victims) {
    console.log(`  - ${v.documentName}  (illegal-index elements: ${v.elementIds.join(', ')})`)
  }

  if (victims.length === 0) {
    console.log('[migrate:fractional-index] nothing to do.')
    return
  }
  if (!apply) {
    console.log('[migrate:fractional-index] dry run only — re-run with --apply to write.')
    return
  }

  let migrated = 0
  let unchanged = 0
  for (const v of victims) {
    await transaction(async (tx) => {
      // Re-read under FOR UPDATE so a concurrent editor's write is not clobbered.
      const current = await yjsDocumentRepo.selectForUpdateTx(tx, v.documentName)
      const { state, changed } = migrateState(current)
      if (!changed) {
        unchanged++
        console.log(`  = ${v.documentName}  (already legal on re-read, skipped)`)
        return
      }
      await yjsDocumentRepo.upsertStateTx(tx, v.documentName, Buffer.from(state))
      migrated++
      console.log(`  ✓ ${v.documentName}  (repaired -> legal keys, ${state.length} bytes)`)
    })
  }
  console.log(
    `[migrate:fractional-index] done. migrated=${migrated} unchanged=${unchanged} total=${victims.length}`,
  )
}

main()
  .catch((err) => {
    console.error('[migrate:fractional-index] FAILED:', err)
    process.exitCode = 1
  })
  .finally(() => {
    void closePool()
  })
