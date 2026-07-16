# Database migrations

This directory contains the database schema and incremental MySQL migrations for
Octo Docs Backend.

## Layout

- `schema.sql` is for fresh databases only. It contains the complete current
  schema.
- `upgrades/*.sql` contains incremental migrations for existing databases. The
  migration runner executes only files ending in `.sql`, in filename order.
- This README is documentation only and is never treated as a migration.

## Running migrations

Build the application, then run the migration runner before starting the new
server version:

```bash
npm run build
npm run migrate
```

For local development without a build:

```bash
npm run migrate:dev
```

The runner:

- creates and maintains the `schema_migrations` ledger;
- records each migration filename, SHA-256 checksum, and execution time;
- skips an already-recorded migration when its checksum matches;
- fails if an applied migration file was modified; and
- uses the MySQL advisory lock `octo_docs_backend_migrations` to prevent
  concurrent execution.

The first runner invocation on a database that was previously migrated by hand
will attempt to execute the existing idempotent upgrade files to populate the
ledger. Migration SQL execution and the ledger insert are separate operations
because MySQL DDL auto-commits. If the process stops between those operations,
the next run executes that migration again. Upgrade files must therefore remain
safe to re-run, not merely safe when the ledger already contains an entry.

## Configuration

The runner uses the application's standard `MYSQL_*` connection settings; see
`.env.example` for their defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `MIGRATIONS_DIR` | `migrations/upgrades` relative to the current working directory | Override the directory scanned for `.sql` files. |
| `MIGRATION_LOCK_TIMEOUT_SECONDS` | `60` | Seconds to wait for the MySQL advisory lock. Use `0` to fail immediately when another migration run holds the lock. |

If the runner cannot acquire `octo_docs_backend_migrations` within this timeout,
it exits non-zero. During overlapping deploys this is expected mutual exclusion;
the failed deployment should be retried after the active migration finishes.

## Automatic execution is deployment-specific

The upstream `Dockerfile` copies this directory into its image, but it does
**not** run migrations automatically. Its default command starts the application
directly. Operators must deliberately integrate `npm run migrate` into
deployment, preferably as a pre-deploy Job, Helm hook, or Argo CD PreSync hook.

A deployment that intentionally couples migration to application startup can
use an equivalent command:

```sh
npm run migrate && exec node dist/index.js
```

In that model, a migration failure must prevent the application from starting.
The image must include `migrations/`, and the migration process must receive the
same MySQL configuration and credentials as the application.

## Adding a migration

1. Add `upgrades/YYYY-MM-DD-<description>.sql`.
2. Make the migration safe to retry and compatible with the currently running
   application version.
3. Update `schema.sql` so fresh installs include the resulting schema.
4. Add or update tests for the affected schema contract.
5. Never edit a migration after it has been applied. Add a new migration
   instead, otherwise checksum validation will fail.

The SQL splitter supports MySQL `DELIMITER` directives for stored procedures.
Keep each `DELIMITER` directive on its own line and terminate statements with
the active delimiter at the end of a line, matching the existing upgrade files.

Do not place documentation or helper files with a `.sql` extension under
`upgrades/`; the runner will attempt to execute them.
