-- Upgrade migration: 4-state comment adjudication lifecycle (feature #78)
--
-- WHAT: adds the adjudication lifecycle to doc_comment.
--   * status TINYINT NOT NULL DEFAULT 0 — 0=open 1=approved 2=rejected 3=committed
--     (root-only, exactly like the legacy `resolved` flag was).
--   * adjudicated_by / adjudicated_at / adjudication_note — audit trail (留痕) of
--     who adjudicated, when, and an optional note.
--   * idx_doc_status (doc_id, status, deleted, id) — status-filtered listing
--     (e.g. the agent pulling its approved execution list).
--
-- WHY: comments move from a binary open/resolved flag to a 4-state lifecycle:
--     open --approve(writer)--> approved --agent commit--> committed
--       └----reject(writer)---> rejected
--   committed is terminal; approved/rejected can reopen to open. `status` becomes
--   the single source of truth; `resolved` survives as a DERIVED mirror for old
--   clients (resolved = status != open). The existing `resolved`/resolved_by/at
--   columns and idx_doc_open are kept unchanged for backward-compat.
--
-- BACKFILL: `resolved` is ambiguous against the new axis, so map it forward with
--   the least-lossy interpretation. An old "resolved" comment is one an editor
--   ACTED ON, so it maps to `approved` (keeps it out of the default open list and
--   preserves resolved=1 under the derived rule). Open rows stay open.
--     resolved = 0 -> status = 0 (open)
--     resolved = 1 -> status = 1 (approved); copy resolved_by/at into
--                     adjudicated_by/at as the audit stamp.
--
-- WHO NEEDS THIS: EXISTING deployments upgrading across this batch. Fresh installs
--   already get these columns/indexes/comments from migrations/schema.sql.
--
-- SAFETY: the ADD COLUMN / ADD KEY steps are NOT idempotent on plain MySQL (no
--   IF NOT EXISTS for columns across all supported versions); run once. The
--   backfill UPDATEs are re-runnable (they re-derive status from resolved).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-15-add-comment-lifecycle.sql

ALTER TABLE doc_comment
  ADD COLUMN status TINYINT NOT NULL DEFAULT 0
    COMMENT '仅线程根有意义（4 态裁决生命周期）：0=open 1=approved 2=rejected 3=committed'
    AFTER anchor_text,
  ADD COLUMN adjudicated_by VARCHAR(64) NULL
    COMMENT '裁决人 uid（approve/reject/commit/reopen 均留痕）'
    AFTER status,
  ADD COLUMN adjudicated_at DATETIME(3) NULL
    COMMENT '裁决时间'
    AFTER adjudicated_by,
  ADD COLUMN adjudication_note VARCHAR(1024) NOT NULL DEFAULT ''
    COMMENT '裁决备注（可空串）'
    AFTER adjudicated_at,
  ADD KEY idx_doc_status (doc_id, status, deleted, id);

-- Refresh the legacy column comment to note it is now a derived mirror.
ALTER TABLE doc_comment
  MODIFY COLUMN resolved TINYINT NOT NULL DEFAULT 0
  COMMENT '遗留派生镜像（供旧客户端）：resolved = (status != open)';

-- Backfill: forward-map the legacy resolved flag onto the lifecycle, copying the
-- resolve stamp into the new audit columns for resolved rows.
UPDATE doc_comment
  SET status = 1,
      adjudicated_by = resolved_by,
      adjudicated_at = resolved_at
  WHERE resolved = 1;

UPDATE doc_comment
  SET status = 0
  WHERE resolved = 0;
