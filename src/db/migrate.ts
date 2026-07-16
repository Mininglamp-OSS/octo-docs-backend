/**
 * Database migration runner for community/self-hosted deployments.
 *
 * The repo intentionally keeps migrations as plain SQL files so operators can
 * inspect or run them manually. This runner adds the missing operational layer:
 * ordered execution, a schema_migrations ledger, checksum drift detection, and
 * a MySQL advisory lock to avoid concurrent deploy races.
 */
/* eslint-disable no-console */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface MigrationDb {
  query(sql: string, params?: unknown[]): Promise<unknown>
}

export interface MigrationFile {
  filename: string
  path: string
  checksum: string
  sql: string
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

const LEDGER_TABLE = 'schema_migrations'
const LOCK_NAME = 'octo_docs_backend_migrations'

function rows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.sql')).sort()
  const files: MigrationFile[] = []
  for (const filename of names) {
    const filePath = path.join(dir, filename)
    const sql = await fs.readFile(filePath, 'utf8')
    files.push({ filename, path: filePath, sql, checksum: sha256(sql) })
  }
  return files
}

/**
 * Split MySQL scripts into executable statements, including migration files that
 * use `DELIMITER //` for stored procedures. This is deliberately small and
 * line-oriented: our migrations put delimiter markers on their own lines and
 * terminate statements at the end of a line, matching mysql CLI conventions.
 */
export function splitSqlStatements(sql: string): string[] {
  let delimiter = ';'
  let buf = ''
  const statements: string[] = []

  for (const rawLine of sql.split(/\r?\n/)) {
    const delim = rawLine.trim().match(/^DELIMITER\s+(.+)$/i)
    if (delim) {
      const pending = buf.trim()
      if (pending !== '') {
        throw new Error(`DELIMITER changed while a statement was still open: ${pending.slice(0, 80)}`)
      }
      delimiter = delim[1]!
      continue
    }

    buf += rawLine + '\n'
    const trimmed = buf.trimEnd()
    if (!trimmed.endsWith(delimiter)) continue

    const statement = trimmed.slice(0, trimmed.length - delimiter.length).trim()
    if (statement !== '') statements.push(statement)
    buf = ''
  }

  const trailing = buf.trim()
  if (trailing !== '') statements.push(trailing)
  return statements
}

export async function ensureMigrationLedger(db: MigrationDb): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename    VARCHAR(255) NOT NULL,
      checksum    CHAR(64)     NOT NULL,
      executed_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}

async function getRecordedChecksum(db: MigrationDb, filename: string): Promise<string | null> {
  const result = await db.query(`SELECT checksum FROM ${LEDGER_TABLE} WHERE filename = ?`, [filename])
  const first = rows(result)[0]
  return typeof first?.checksum === 'string' ? first.checksum : null
}

async function recordMigration(db: MigrationDb, file: MigrationFile): Promise<void> {
  await db.query(`INSERT INTO ${LEDGER_TABLE} (filename, checksum) VALUES (?, ?)`, [
    file.filename,
    file.checksum,
  ])
}

async function executeMigrationSql(db: MigrationDb, file: MigrationFile): Promise<void> {
  const statements = splitSqlStatements(file.sql)
  for (const statement of statements) {
    await db.query(statement)
  }
}

async function acquireMigrationLock(db: MigrationDb, timeoutSeconds: number): Promise<void> {
  const result = await db.query('SELECT GET_LOCK(?, ?) AS acquired', [LOCK_NAME, timeoutSeconds])
  const acquired = rows(result)[0]?.acquired
  if (acquired !== 1 && acquired !== '1') {
    throw new Error(`Could not acquire MySQL migration lock ${LOCK_NAME}`)
  }
}

async function releaseMigrationLock(db: MigrationDb): Promise<void> {
  await db.query('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME])
}

export async function runMigrations(
  db: MigrationDb,
  files: MigrationFile[],
  opts: { lockTimeoutSeconds?: number } = {},
): Promise<MigrationResult> {
  const applied: string[] = []
  const skipped: string[] = []
  await acquireMigrationLock(db, opts.lockTimeoutSeconds ?? 60)

  try {
    await ensureMigrationLedger(db)
    for (const file of files) {
      const recorded = await getRecordedChecksum(db, file.filename)
      if (recorded !== null) {
        if (recorded !== file.checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file.filename}: already executed SQL was modified`,
          )
        }
        skipped.push(file.filename)
        continue
      }

      await executeMigrationSql(db, file)
      await recordMigration(db, file)
      applied.push(file.filename)
    }
  } finally {
    await releaseMigrationLock(db)
  }

  return { applied, skipped }
}

function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR || path.resolve(process.cwd(), 'migrations/upgrades')
}

function lockTimeoutSeconds(): number {
  const raw = process.env.MIGRATION_LOCK_TIMEOUT_SECONDS
  if (!raw) return 60
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error('MIGRATION_LOCK_TIMEOUT_SECONDS must be >= 0')
  return n
}

async function main(): Promise<void> {
  await import('../config/loadEnv.js')
  const { getPool, closePool } = await import('./pool.js')
  const migrationsDir = defaultMigrationsDir()
  const files = await loadMigrationFiles(migrationsDir)
  const pool = getPool()
  const db: MigrationDb = {
    async query(sql, params) {
      const [result] = await pool.query(sql, params)
      return result
    },
  }

  try {
    const result = await runMigrations(db, files, { lockTimeoutSeconds: lockTimeoutSeconds() })
    for (const name of result.skipped) console.log(`[migrate] skipped ${name}`)
    for (const name of result.applied) console.log(`[migrate] applied ${name}`)
    console.log(`[migrate] complete: ${result.applied.length} applied, ${result.skipped.length} skipped`)
  } finally {
    await closePool()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error('[migrate] failed:', err)
      process.exitCode = 1
    })
}
