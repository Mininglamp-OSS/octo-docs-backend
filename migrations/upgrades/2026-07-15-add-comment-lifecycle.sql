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
--   already ACTED ON / closed out — i.e. done — which on the new axis is the
--   terminal `committed` state, NOT `approved`. `approved` means "queued, not yet
--   executed": mapping resolved history there would re-queue every historical
--   resolved comment for the agent to re-execute against the live doc body (data
--   pollution). `committed` is terminal (no outbound transitions), kept for audit,
--   and never re-picked up by the approved-execution pull. It also preserves the
--   derived-mirror rule (resolved = status != open) since committed != open.
--   Open rows stay open.
--     resolved = 0 -> status = 0 (open)
--     resolved = 1 -> status = 3 (committed); copy resolved_by/at into
--                     adjudicated_by/at as the audit stamp.
--
-- WHO NEEDS THIS: EXISTING deployments upgrading across this batch. Fresh installs
--   already get these columns/indexes/comments from migrations/schema.sql.
--
-- SAFETY: idempotent / re-runnable. MySQL 8 has no `ADD COLUMN IF NOT EXISTS`
--   (nor `ADD KEY` / `ADD CONSTRAINT IF NOT EXISTS`), so each DDL step is guarded
--   behind an information_schema existence check in a throwaway stored procedure —
--   the same convention as 2026-06-23-add-doc-attachment-file-name.sql and
--   2026-07-14-add-doc-share-scope.sql. Re-running (or retrying a partial apply)
--   is a no-op, not an `ERROR 1060 Duplicate column` / `ERROR 1061 Duplicate key` /
--   `ERROR 3822 Duplicate check constraint`. The backfill UPDATE is likewise
--   re-runnable (it re-derives status from resolved).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-15-add-comment-lifecycle.sql

DELIMITER //

DROP PROCEDURE IF EXISTS octo_add_doc_comment_lifecycle //

CREATE PROCEDURE octo_add_doc_comment_lifecycle()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_comment'
      AND column_name  = 'status'
  ) THEN
    ALTER TABLE doc_comment
      ADD COLUMN status TINYINT NOT NULL DEFAULT 0
        COMMENT '仅线程根有意义（4 态裁决生命周期）：0=open 1=approved 2=rejected 3=committed'
        AFTER anchor_text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_comment'
      AND column_name  = 'adjudicated_by'
  ) THEN
    ALTER TABLE doc_comment
      ADD COLUMN adjudicated_by VARCHAR(64) NULL
        COMMENT '裁决人 uid（approve/reject/commit/reopen 均留痕）'
        AFTER status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_comment'
      AND column_name  = 'adjudicated_at'
  ) THEN
    ALTER TABLE doc_comment
      ADD COLUMN adjudicated_at DATETIME(3) NULL
        COMMENT '裁决时间'
        AFTER adjudicated_by;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_comment'
      AND column_name  = 'adjudication_note'
  ) THEN
    ALTER TABLE doc_comment
      ADD COLUMN adjudication_note VARCHAR(1024) NOT NULL DEFAULT ''
        COMMENT '裁决备注（可空串）'
        AFTER adjudicated_at;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name   = 'doc_comment'
      AND index_name   = 'idx_doc_status'
  ) THEN
    ALTER TABLE doc_comment
      ADD KEY idx_doc_status (doc_id, status, deleted, id);
  END IF;

  -- status 只能取 4 态生命周期的合法值（与 schema.sql 的 chk_doc_comment_status 对齐）。
  -- 一个漂移/越界的存储值会经 statusFromNumber(...) ?? 'open' 静默读成 open，CHECK 是最后防线。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema    = DATABASE()
      AND table_name      = 'doc_comment'
      AND constraint_name = 'chk_doc_comment_status'
  ) THEN
    ALTER TABLE doc_comment
      ADD CONSTRAINT chk_doc_comment_status CHECK (status BETWEEN 0 AND 3);
  END IF;

  -- Refresh the legacy column comment to note it is now a derived mirror.
  -- MODIFY COLUMN is naturally idempotent (converges to the target definition),
  -- but guard on the current comment so a re-run is a true no-op.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema  = DATABASE()
      AND table_name    = 'doc_comment'
      AND column_name   = 'resolved'
      AND column_comment = '遗留派生镜像（供旧客户端）：resolved = (status != open)'
  ) THEN
    ALTER TABLE doc_comment
      MODIFY COLUMN resolved TINYINT NOT NULL DEFAULT 0
      COMMENT '遗留派生镜像（供旧客户端）：resolved = (status != open)';
  END IF;
END //

DELIMITER ;

CALL octo_add_doc_comment_lifecycle();

DROP PROCEDURE IF EXISTS octo_add_doc_comment_lifecycle;

-- Backfill: forward-map the legacy resolved flag onto the lifecycle. A legacy
-- resolved comment maps to `approved` (1), matching the runtime legacy shim
-- (setResolved(true) -> approved) so the same legacy signal never lands on two
-- different lifecycle states. `approved` is reopenable (approved -> open), so the
-- pre-upgrade corpus stays reopenable via the preserved PATCH { resolved: false }
-- path; landing it on the terminal `committed` state would permanently break
-- reopen (approved -> open allowed, committed -> open rejected). It copies the
-- resolve stamp into the new audit columns. Re-runnable: it re-derives status
-- from resolved, and only touches rows still carrying the legacy resolved=1 flag
-- whose status has not yet been advanced past open (so it never clobbers a live
-- reopened/approved row).
UPDATE doc_comment
  SET status = 1,
      adjudicated_by = resolved_by,
      adjudicated_at = resolved_at
  WHERE resolved = 1
    AND status = 0;

-- Note: rows with resolved = 0 already have status = 0 from the ADD COLUMN
-- DEFAULT 0 above, so no separate open backfill is needed.
