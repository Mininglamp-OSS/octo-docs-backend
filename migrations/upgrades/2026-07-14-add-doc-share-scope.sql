-- Space-scoped document share permissions (link-based read/edit), GitHub #64.
--
-- Adds a per-document share scope + share role to doc_meta. Both columns are
-- additive with fixed defaults: MySQL 8 backfills every existing row with the
-- defaults, so all pre-existing docs (and every INSERT that omits the columns)
-- stay `restricted` — no accidental exposure, no data backfill. Reversible via
-- `DROP COLUMN` / `DROP CONSTRAINT`.
--
--   share_scope  0 = restricted (default), 1 = anyone_in_space
--   share_role   1 = read, 2 = edit   (meaningful only when share_scope = 1)
--
-- The CHECK constraints are defense-in-depth (MySQL 8.0.16+). The authoritative
-- validation lives in the PUT /share handler, which rejects any out-of-enum
-- value with 400 before the DB write; a raw UPDATE with an illegal value fails
-- the CHECK. The reader side (effectiveRole) additionally coerces any
-- unexpected stored value to the most-restrictive interpretation, so an
-- out-of-range value can never open access.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 has no `ADD COLUMN IF NOT EXISTS`
-- (nor `ADD CONSTRAINT IF NOT EXISTS`), so each ALTER is guarded behind an
-- information_schema existence check in a throwaway stored procedure — the same
-- convention as 2026-06-23-add-doc-attachment-file-name.sql. Re-running (or
-- retrying a partial apply) is a no-op, not an `ERROR 1060 Duplicate column` /
-- `ERROR 3822 Duplicate check constraint`.
--
-- COST: `ADD COLUMN` with a constant default is instant metadata-only in MySQL
-- 8. `ADD CONSTRAINT CHECK`, however, VALIDATES existing rows with a full-table
-- scan and briefly holds a metadata lock, so this is NOT a strictly zero-downtime
-- change on a large hot doc_meta — schedule it in a low-traffic window (all
-- existing rows carry the safe defaults, so validation always passes).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-14-add-doc-share-scope.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_meta_share_scope //

CREATE PROCEDURE octo_add_doc_meta_share_scope()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_meta'
      AND column_name  = 'share_scope'
  ) THEN
    ALTER TABLE doc_meta
      ADD COLUMN share_scope TINYINT NOT NULL DEFAULT 0
        COMMENT '0=restricted(默认) 1=anyone_in_space';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_meta'
      AND column_name  = 'share_role'
  ) THEN
    ALTER TABLE doc_meta
      ADD COLUMN share_role TINYINT NOT NULL DEFAULT 1
        COMMENT 'anyone_in_space 生效时的角色：1=read 2=edit；restricted 时忽略';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema    = DATABASE()
      AND table_name      = 'doc_meta'
      AND constraint_name = 'chk_doc_meta_share_scope'
  ) THEN
    ALTER TABLE doc_meta
      ADD CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0, 1));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema    = DATABASE()
      AND table_name      = 'doc_meta'
      AND constraint_name = 'chk_doc_meta_share_role'
  ) THEN
    ALTER TABLE doc_meta
      ADD CONSTRAINT chk_doc_meta_share_role CHECK (share_role IN (1, 2));
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_meta_share_scope();

DROP PROCEDURE IF EXISTS octo_add_doc_meta_share_scope;
