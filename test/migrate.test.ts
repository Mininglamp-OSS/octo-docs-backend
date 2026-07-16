import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  connectionMigrationDb,
  loadMigrationFiles,
  runMigrations,
  sha256,
  splitSqlStatements,
  type MigrationConnection,
  type MigrationDb,
} from '../src/db/migrate.js'

class FakeDb implements MigrationDb {
  readonly ledger = new Map<string, string>()
  readonly executed: string[] = []

  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const normalized = sql.trim().replace(/\s+/g, ' ')
    if (/^SELECT GET_LOCK/i.test(normalized)) return [{ acquired: 1 }]
    if (/^SELECT RELEASE_LOCK/i.test(normalized)) return [{ released: 1 }]
    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(normalized)) return []
    if (/^SELECT checksum FROM schema_migrations WHERE filename = \?/i.test(normalized)) {
      const filename = String(params[0])
      const checksum = this.ledger.get(filename)
      return checksum ? [{ checksum }] : []
    }
    if (/^INSERT INTO schema_migrations/i.test(normalized)) {
      this.ledger.set(String(params[0]), String(params[1]))
      return []
    }
    this.executed.push(sql.trim())
    return []
  }
}

describe('migration runner', () => {
  it('splits MySQL scripts with DELIMITER blocks', () => {
    const statements = splitSqlStatements(`
CREATE TABLE demo (id INT);
DELIMITER //
CREATE PROCEDURE add_demo()
BEGIN
  INSERT INTO demo VALUES (1);
END //
DELIMITER ;
CALL add_demo();
DROP PROCEDURE add_demo;
`)

    expect(statements).toEqual([
      'CREATE TABLE demo (id INT)',
      'CREATE PROCEDURE add_demo()\nBEGIN\n  INSERT INTO demo VALUES (1);\nEND',
      'CALL add_demo()',
      'DROP PROCEDURE add_demo',
    ])
  })

  it('loads migration files in filename order', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octo-migrations-'))
    await writeFile(path.join(dir, '2026-07-02-b.sql'), 'SELECT 2;')
    await writeFile(path.join(dir, '2026-07-01-a.sql'), 'SELECT 1;')
    await writeFile(path.join(dir, 'README.md'), 'not sql')

    const files = await loadMigrationFiles(dir)
    expect(files.map((f) => f.filename)).toEqual(['2026-07-01-a.sql', '2026-07-02-b.sql'])
  })

  it('applies new migrations and records checksums', async () => {
    const db = new FakeDb()
    const files = [
      {
        filename: '2026-07-01-a.sql',
        path: '/tmp/a.sql',
        sql: 'SELECT 1;',
        checksum: sha256('SELECT 1;'),
      },
      {
        filename: '2026-07-02-b.sql',
        path: '/tmp/b.sql',
        sql: 'SELECT 2;',
        checksum: sha256('SELECT 2;'),
      },
    ]

    const result = await runMigrations(db, files)
    expect(result).toEqual({
      applied: ['2026-07-01-a.sql', '2026-07-02-b.sql'],
      skipped: [],
    })
    expect(db.executed).toEqual(['SELECT 1', 'SELECT 2'])
    expect(db.ledger.get('2026-07-01-a.sql')).toBe(sha256('SELECT 1;'))
  })

  it('skips an already recorded migration with the same checksum', async () => {
    const db = new FakeDb()
    const sql = 'SELECT 1;'
    db.ledger.set('2026-07-01-a.sql', sha256(sql))

    const result = await runMigrations(db, [
      { filename: '2026-07-01-a.sql', path: '/tmp/a.sql', sql, checksum: sha256(sql) },
    ])

    expect(result).toEqual({ applied: [], skipped: ['2026-07-01-a.sql'] })
    expect(db.executed).toEqual([])
  })

  it('fails fast when an already recorded migration checksum changed', async () => {
    const db = new FakeDb()
    db.ledger.set('2026-07-01-a.sql', sha256('SELECT 1;'))

    await expect(
      runMigrations(db, [
        {
          filename: '2026-07-01-a.sql',
          path: '/tmp/a.sql',
          sql: 'SELECT changed;',
          checksum: sha256('SELECT changed;'),
        },
      ]),
    ).rejects.toThrow(/checksum mismatch/)
    expect(db.executed).toEqual([])
  })
})

// Regression: the FakeDb suite above never feeds the runner the ACTUAL shipped
// migration files, which is how the `DELIMITER`-after-comment crash and the
// `;`-inside-a-comment mis-split slipped past CI. Exercise the real files.
describe('shipped migration files parse cleanly', () => {
  const upgradesDir = fileURLToPath(new URL('../migrations/upgrades', import.meta.url))

  it('splits every real upgrade file without throwing or leaking comments', async () => {
    const files = await loadMigrationFiles(upgradesDir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const statements = splitSqlStatements(file.sql)
      expect(statements.length, `${file.filename} produced no statements`).toBeGreaterThan(0)
      for (const statement of statements) {
        const firstCodeLine = statement
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0)
        // A statement must start with real SQL, never a stray `--`/`#` comment
        // fragment (which is what the missing comment handling used to emit).
        expect(firstCodeLine, `${file.filename}: empty/comment-only statement`).toBeTruthy()
        expect(
          /^(--|#)/.test(firstCodeLine!),
          `${file.filename}: comment leaked into a statement: ${statement.slice(0, 60)}`,
        ).toBe(false)
      }
    }
  })

  it('handles a comment preamble before DELIMITER and a ; inside a comment', () => {
    const sql = [
      '-- header line 1',
      '-- header line 2 mentions a semicolon; still just a comment',
      '',
      'DELIMITER //',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      'END //',
      'DELIMITER ;',
      'CALL p();',
    ].join('\n')
    expect(() => splitSqlStatements(sql)).not.toThrow()
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND',
      'CALL p()',
    ])
  })

  it('does not split on a delimiter char inside a string literal or trailing comment', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b'); -- trailing; note")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
    ])
  })
})

// Regression for the advisory-lock connection-affinity blocker: GET_LOCK,
// every migration statement, and RELEASE_LOCK must run on ONE connection.
describe('advisory lock connection affinity', () => {
  class RecordingConn implements MigrationConnection {
    readonly log: string[] = []
    private readonly ledger = new Map<string, string>()
    async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      this.log.push(sql.trim().replace(/\s+/g, ' ').slice(0, 24))
      const n = sql.trim().replace(/\s+/g, ' ')
      if (/^SELECT GET_LOCK/i.test(n)) return [[{ acquired: 1 }], []]
      if (/^SELECT RELEASE_LOCK/i.test(n)) return [[{ released: 1 }], []]
      if (/^SELECT checksum FROM schema_migrations/i.test(n)) {
        const c = this.ledger.get(String(params[0]))
        return [c ? [{ checksum: c }] : [], []]
      }
      if (/^INSERT INTO schema_migrations/i.test(n)) {
        this.ledger.set(String(params[0]), String(params[1]))
        return [[], []]
      }
      return [[], []]
    }
  }

  it('routes the lock and all statements through the single bound connection', async () => {
    // A pool that would hand out a DISTINCT connection on every call — proving
    // the runner takes exactly one and never rotates.
    const handedOut: RecordingConn[] = []
    const pool = {
      async getConnection() {
        const c = new RecordingConn()
        handedOut.push(c)
        return c
      },
    }
    const conn = await pool.getConnection()
    const db = connectionMigrationDb(conn)
    await runMigrations(db, [
      { filename: '2026-07-01-a.sql', path: '/tmp/a.sql', sql: 'SELECT 1;', checksum: sha256('SELECT 1;') },
    ])

    expect(handedOut).toHaveLength(1) // only one connection ever taken
    expect(conn.log[0]).toMatch(/GET_LOCK/i) // lock first...
    expect(conn.log.at(-1)).toMatch(/RELEASE_LOCK/i) // ...release last, same conn
  })
})
