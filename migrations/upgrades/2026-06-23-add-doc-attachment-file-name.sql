-- Upgrade migration: add doc_attachment.file_name (batch3)
--
-- WHAT: adds the `file_name VARCHAR(512) NOT NULL DEFAULT ''` column to the
--   existing `doc_attachment` table, positioned AFTER `size_bytes`, matching
--   migrations/schema.sql exactly.
--
-- WHY: `file_name` was introduced in batch3 to carry the original (sanitized)
--   upload filename so downloads can set a correct Content-Disposition header.
--   Deployments created BEFORE batch3 have a `doc_attachment` table without
--   this column; the application now reads it and crashes on those DBs until
--   the column exists.
--
-- WHO NEEDS THIS: only EXISTING deployments upgrading across batch3. Fresh
--   installs already get the column from the CREATE TABLE in
--   migrations/schema.sql (doc_attachment, file_name) and do NOT need to run
--   this file.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 has no `ADD COLUMN IF NOT EXISTS`,
--   so we guard the ALTER behind an information_schema.columns check via a
--   throwaway stored procedure. Running it when the column already exists is a
--   no-op (no error).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-06-23-add-doc-attachment-file-name.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_attachment_file_name //

CREATE PROCEDURE octo_add_doc_attachment_file_name()
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_attachment'
      AND column_name  = 'file_name'
  ) THEN
    ALTER TABLE doc_attachment
      ADD COLUMN file_name VARCHAR(512) NOT NULL DEFAULT '' AFTER size_bytes;
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_attachment_file_name();

DROP PROCEDURE IF EXISTS octo_add_doc_attachment_file_name;
