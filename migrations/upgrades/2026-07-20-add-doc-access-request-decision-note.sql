-- Add decision_note to doc_access_request: the reviewer's free-text reason
-- captured when denying an access request via the interactive approval card. The
-- value arrives from octo-server verbatim as DecisionRequest.inputs["deny_reason"]
-- (cross-repo contract: octo-server pkg/cardtmpl DocsDenyReasonInputID). NOT NULL
-- DEFAULT '' so existing rows and approve decisions (which carry no note) are
-- unaffected. Column width mirrors `reason` (VARCHAR(512)); the docs backend
-- truncates the submitted value to 500 chars before writing.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 has no `ADD COLUMN IF NOT EXISTS`, so
-- the ALTER is guarded behind an information_schema existence check in a throwaway
-- stored procedure — the same convention as 2026-07-14-add-doc-share-scope.sql.
-- Re-running (or retrying a partial apply, per migrate.ts's at-least-once
-- execution contract) is a no-op, not an `ERROR 1060 Duplicate column`.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-20-add-doc-access-request-decision-note.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_access_request_decision_note //

CREATE PROCEDURE octo_add_doc_access_request_decision_note()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_access_request'
      AND column_name  = 'decision_note'
  ) THEN
    ALTER TABLE doc_access_request
      ADD COLUMN decision_note VARCHAR(512) NOT NULL DEFAULT '' AFTER decided_by;
  END IF;
END //

CALL octo_add_doc_access_request_decision_note() //

DROP PROCEDURE IF EXISTS octo_add_doc_access_request_decision_note //

DELIMITER ;
