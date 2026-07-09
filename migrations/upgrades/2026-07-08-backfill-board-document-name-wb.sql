-- Upgrade migration: backfill legacy board document_name to the 5-segment :wb: key
--
-- WHAT: rewrites every `doc_type='board'` row whose `document_name` is still the
--   legacy 4-segment form `octo:{space}:{folder}:{doc_id}` into the canonical
--   5-segment whiteboard key `octo:{space}:{folder}:wb:{doc_id}`, reconstructed
--   from the row's own `space_id` / `folder_id` / `doc_id`. The rewrite is
--   byte-identical to what buildWhiteboardName(space, folder, docId) now mints
--   (src/whiteboard/schema/name.ts), preserving the §8.1 key/row invariant
--   (documentName 3rd segment === folder_id). The rename cascades to every table
--   keyed by document_name: yjs_document, yjs_snapshot, yjs_update_log, and the
--   denormalized document_name snapshots on doc_version / doc_comment.
--
-- WHY: before this batch, POST /api/v1/docs (src/api/routes/docs.ts) accepted
--   docType='board' but always built a 4-segment document_name via
--   buildDocumentName(), so any board created on the old code persisted under a
--   4-segment key. Collab-token issuance and WS auth resolve a board by its
--   5-segment `:wb:` key through an EXACT document_name match
--   (docMetaRepo.getByDocumentName → resolveDocMetaByName). A pre-existing
--   4-segment board row therefore never matches the `:wb:` lookup and returns
--   404. buildCreatedDocumentName in this batch fixes newly created boards
--   (mint-forward) but does NOT touch rows already persisted 4-segment; this
--   migration is the backfill for those pre-existing rows.
--
-- WHO NEEDS THIS: only EXISTING deployments that created board rows on the old
--   4-segment code path. On a deployment with zero legacy board rows this file
--   is a pure no-op (every UPDATE matches 0 rows and the assertion passes), so it
--   is also the verifiable confirm-zero check: it proves, on whatever env it runs
--   against, that no board row is left off the canonical `:wb:` key.
--
-- SAFETY: single transaction, idempotent / re-runnable. Each UPDATE is gated on
--   the row still carrying the exact legacy 4-segment key, so once rewritten the
--   predicate no longer matches and a re-run is a no-op. The dependent
--   document_name tables are rewritten BEFORE doc_meta so each join still sees the
--   legacy key (yjs_* join on document_name; doc_version / doc_comment join on the
--   stable doc_id). permission_epoch is a doc_meta column and travels with the row,
--   so no separate epoch migration is needed; any Redis epoch cache is ephemeral
--   and rebuilt from DB. A post-migration assertion requires
--   `legacy_board_rows_remaining = 0` (every board row on the canonical 5-segment
--   `:wb:` key); a non-zero count rolls the whole transaction back and aborts so a
--   data anomaly can never pass silently.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-08-backfill-board-document-name-wb.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_backfill_board_document_name_wb //

CREATE PROCEDURE octo_backfill_board_document_name_wb()
BEGIN
  DECLARE v_before    BIGINT DEFAULT 0;
  DECLARE v_remaining BIGINT DEFAULT 0;

  -- Any SQL error inside the body rolls the transaction back and re-raises, so a
  -- partial rename can never be committed.
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  -- Verifiable evidence: how many legacy 4-segment board rows exist before the
  -- backfill (0 on a clean/confirm-zero env).
  SELECT COUNT(*) INTO v_before
  FROM doc_meta
  WHERE doc_type = 'board'
    AND document_name = CONCAT('octo:', space_id, ':', folder_id, ':', doc_id);
  SELECT v_before AS legacy_board_rows_before;

  START TRANSACTION;

  -- Dependent document_name tables first (join on the still-legacy key).
  UPDATE yjs_document y
    JOIN doc_meta d ON y.document_name = d.document_name
    SET y.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':wb:', d.doc_id)
    WHERE d.doc_type = 'board'
      AND d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':', d.doc_id);

  UPDATE yjs_snapshot y
    JOIN doc_meta d ON y.document_name = d.document_name
    SET y.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':wb:', d.doc_id)
    WHERE d.doc_type = 'board'
      AND d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':', d.doc_id);

  UPDATE yjs_update_log y
    JOIN doc_meta d ON y.document_name = d.document_name
    SET y.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':wb:', d.doc_id)
    WHERE d.doc_type = 'board'
      AND d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':', d.doc_id);

  -- doc_version / doc_comment carry a denormalized document_name snapshot; join on
  -- the stable doc_id and gate on doc_meta still holding the legacy key.
  UPDATE doc_version v
    JOIN doc_meta d ON v.doc_id = d.doc_id
    SET v.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':wb:', d.doc_id)
    WHERE d.doc_type = 'board'
      AND d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':', d.doc_id);

  UPDATE doc_comment c
    JOIN doc_meta d ON c.doc_id = d.doc_id
    SET c.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':wb:', d.doc_id)
    WHERE d.doc_type = 'board'
      AND d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':', d.doc_id);

  -- doc_meta LAST — renaming it here breaks the join predicate used above.
  UPDATE doc_meta d
    SET d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':wb:', d.doc_id)
    WHERE d.doc_type = 'board'
      AND d.document_name = CONCAT('octo:', d.space_id, ':', d.folder_id, ':', d.doc_id);

  -- Assertion: every board row must now be on the canonical 5-segment :wb: key.
  -- This catches legacy 4-segment rows AND any other malformed board key.
  SELECT COUNT(*) INTO v_remaining
  FROM doc_meta
  WHERE doc_type = 'board'
    AND document_name <> CONCAT('octo:', space_id, ':', folder_id, ':wb:', doc_id);

  IF v_remaining <> 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'assertion failed: legacy_board_rows_remaining <> 0 after backfill';
  END IF;

  COMMIT;

  -- 0 = success; the migration guarantees no board row is left off the :wb: key.
  SELECT v_remaining AS legacy_board_rows_remaining;
END //

DELIMITER ;

CALL octo_backfill_board_document_name_wb();

DROP PROCEDURE IF EXISTS octo_backfill_board_document_name_wb;
