-- Upgrade migration: add doc_meta.octo_doc_slug for html doc registration
--
-- WHAT: adds the `octo_doc_slug VARCHAR(128) NULL DEFAULT NULL` column and the
--   per-space composite unique key `uk_octo_doc_slug (space_id, octo_doc_slug)`
--   (P0 tenant isolation: the slug is only meaningful within a space, so its
--   uniqueness must be scoped per space, never globally).
--
-- NOTES: octo_doc_slug is nullable — non-html rows stay NULL, and MySQL permits
--   multiple NULLs in a unique index, so non-html rows never collide.
--
-- SAFETY: idempotent / re-runnable via minimal information_schema guards. MySQL
--   8 lacks ADD COLUMN / ADD KEY IF NOT EXISTS, so each ALTER is guarded by a
--   single IF NOT EXISTS check; re-running is a no-op (guard hit -> skip).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-13-add-doc-meta-octo-doc-slug.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_meta_octo_doc_slug //

CREATE PROCEDURE octo_add_doc_meta_octo_doc_slug()
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_meta'
      AND column_name  = 'octo_doc_slug'
  ) THEN
    ALTER TABLE doc_meta
      ADD COLUMN octo_doc_slug VARCHAR(128) NULL DEFAULT NULL AFTER doc_type;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_meta'
      AND index_name   = 'uk_octo_doc_slug'
  ) THEN
    ALTER TABLE doc_meta
      ADD UNIQUE KEY uk_octo_doc_slug (space_id, octo_doc_slug);
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_meta_octo_doc_slug();

DROP PROCEDURE IF EXISTS octo_add_doc_meta_octo_doc_slug;
