-- Upgrade migration: add doc_view_history table ("recent viewed", FEAT-B)
--
-- WHAT: creates the `doc_view_history` table exactly as defined in
--   migrations/schema.sql, backing the "recent viewed" list, the view-ingest
--   endpoint (POST /api/v1/docs/{docId}/view), and the collab-token best-effort
--   fallback ingest.
--
-- WHY: recent-view is a net-new capability. One row per (uid, doc_id): opening a
--   document UPSERTs the row and refreshes viewed_at (idempotent dedup). Query
--   endpoints join this table to doc_meta / doc_member and filter at query time
--   (status + visibility), so a revoked / deleted / archived doc drops out of the
--   next query immediately. Deployments created BEFORE this batch have no such
--   table; the application now reads/writes it and would crash until it exists.
--
-- WHO NEEDS THIS: only EXISTING deployments upgrading across this batch. Fresh
--   installs already get the table from the CREATE TABLE in
--   migrations/schema.sql (doc_view_history) and do NOT need to run this file.
--
-- BACKFILL: none. The table starts empty; "recent viewed" accumulates from the
--   first document open after deploy (no historical view data exists).
--
-- SAFETY: idempotent / re-runnable. CREATE TABLE IF NOT EXISTS, so running it
--   when the table already exists is a no-op (no error).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-15-add-doc-view-history.sql

CREATE TABLE IF NOT EXISTS doc_view_history (
  uid        VARCHAR(64) NOT NULL,
  doc_id     VARCHAR(64) NOT NULL,
  space_id   VARCHAR(64) NOT NULL,
  viewed_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (uid, doc_id),
  KEY idx_uid_space_viewed (uid, space_id, viewed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
