import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  loadMigrationFiles,
  runMigrations,
  sha256,
  splitSqlStatements,
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
