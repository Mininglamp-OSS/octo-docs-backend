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
will execute the existing idempotent upgrade files once to populate the ledger.

## Automatic execution is deployment-specific

The upstream image contains this directory, but it does **not** run migrations
automatically. Its default command starts the application directly. Operators
must deliberately integrate `npm run migrate` into deployment, preferably as a
pre-deploy Job, Helm hook, or Argo CD PreSync hook.

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

Do not place documentation or helper files with a `.sql` extension under
`upgrades/`; the runner will attempt to execute them.
