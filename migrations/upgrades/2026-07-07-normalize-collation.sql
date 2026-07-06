-- Upgrade migration: normalize all table collations to utf8mb4_0900_ai_ci
--
-- WHAT: converts every octo-docs table in the current database to
--   CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci.
--
-- WHY: migrations/schema.sql historically declared `DEFAULT CHARSET=utf8mb4`
--   WITHOUT an explicit COLLATE, so the effective collation followed the
--   server's utf8mb4 default: utf8mb4_0900_ai_ci on MySQL 8, but
--   utf8mb4_general_ci on MySQL 5.7 / MariaDB or in a restored legacy dump.
--   A local DB that ended up with a mix of the two (some tables 0900, some
--   general_ci) fails cross-table VARCHAR joins with
--   "Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and
--   (utf8mb4_general_ci,IMPLICIT)" — e.g. the doc list query joins
--   doc_meta.doc_id = doc_member.doc_id (src/db/repos/docMetaRepo.ts).
--   schema.sql now pins the collation for fresh installs; this file fixes
--   already-created (drifted) databases.
--
-- WHO NEEDS THIS: existing/local DBs created before the collation pin, or
--   restored from a legacy dump. Fresh installs from the updated schema.sql
--   are already all-0900 and do NOT need this file (running it is a no-op).
--
-- SAFETY: idempotent / re-runnable. Only tables that (a) exist and (b) are not
--   already utf8mb4_0900_ai_ci are converted, via a cursor over
--   information_schema. Running it when everything is already normalized touches
--   nothing. CONVERT TO CHARACTER SET rewrites the table, so run it during a
--   maintenance window on large tables.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-07-normalize-collation.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_normalize_collation //

CREATE PROCEDURE octo_normalize_collation()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE tname VARCHAR(64);
  DECLARE cur CURSOR FOR
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_type   = 'BASE TABLE'
      AND table_name IN (
        'doc_meta', 'doc_member', 'doc_invite', 'doc_invite_redemption',
        'doc_access_request', 'yjs_document', 'yjs_snapshot', 'yjs_update_log',
        'doc_attachment', 'doc_comment', 'doc_version'
      )
      AND table_collation <> 'utf8mb4_0900_ai_ci';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  convert_loop: LOOP
    FETCH cur INTO tname;
    IF done = 1 THEN
      LEAVE convert_loop;
    END IF;
    SET @ddl = CONCAT(
      'ALTER TABLE `', tname,
      '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci'
    );
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END LOOP;
  CLOSE cur;
END //

DELIMITER ;

CALL octo_normalize_collation();

DROP PROCEDURE IF EXISTS octo_normalize_collation;
