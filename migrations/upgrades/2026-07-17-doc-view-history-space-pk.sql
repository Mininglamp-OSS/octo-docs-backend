-- Recent-view per-space independence: doc_view_history PK -> (uid, doc_id, space_id).
--
-- WHAT: extends the doc_view_history primary key from (uid, doc_id) to the
--   three-part key (uid, doc_id, space_id). doc_id is KEPT; space_id is ADDED to
--   the key (per PM decision, Option A — XIN-1297 P1-b).
--
-- WHY: recent-view is READ-scoped to the viewer's current space (GET /docs/recent
--   filters doc_view_history.space_id = X-Space-Id) and the ingest now WRITES the
--   viewer's current space. With the old (uid, doc_id) key the single row's
--   space_id was overwritten on every re-open, so a doc reachable from two spaces
--   "flip-flopped" — it showed up only in the most-recently-opened space and
--   dropped out of the other. Adding space_id to the PK gives one row per
--   (user, doc, space), so the doc stays "recent" in every space it was opened
--   from — per-space independent recent-view.
--
-- WHO NEEDS THIS: every deployment that already created doc_view_history with the
--   old (uid, doc_id) key (fresh installs get the three-part key straight from
--   migrations/schema.sql and do NOT need this file).
--
-- DATA: no loss. Existing rows are already unique on (uid, doc_id), hence trivially
--   unique on the superset (uid, doc_id, space_id) — no duplicate-key error. Each
--   existing row keeps its current space_id (the last space it was viewed in);
--   subsequent opens in OTHER spaces add new rows. No backfill.
--
-- SAFETY: idempotent / re-runnable. The PK change is guarded behind an
--   information_schema check (skip when space_id is already part of the PRIMARY
--   KEY), matching the convention in 2026-07-14-add-doc-share-scope.sql. The
--   secondary index idx_uid_space_viewed is unchanged.
--
-- COST: `ALTER TABLE ... DROP PRIMARY KEY, ADD PRIMARY KEY` rebuilds the clustered
--   index — a full table copy under a metadata lock. doc_view_history is a
--   net-new, retention-capped table (DOC_VIEW_RETAIN_COUNT / DOC_VIEW_RETAIN_DAYS)
--   so it is small, but schedule in a low-traffic window on a hot deployment.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-17-doc-view-history-space-pk.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_doc_view_history_space_pk //

CREATE PROCEDURE octo_doc_view_history_space_pk()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_schema    = DATABASE()
      AND table_name      = 'doc_view_history'
      AND constraint_name = 'PRIMARY'
      AND column_name     = 'space_id'
  ) THEN
    ALTER TABLE doc_view_history
      DROP PRIMARY KEY,
      ADD PRIMARY KEY (uid, doc_id, space_id);
  END IF;
END //

DELIMITER ;

CALL octo_doc_view_history_space_pk();

DROP PROCEDURE IF EXISTS octo_doc_view_history_space_pk;
