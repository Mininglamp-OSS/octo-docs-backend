-- Upgrade migration: add doc_access_request table (screen 4c "request access")
--
-- WHAT: creates the `doc_access_request` table exactly as defined in
--   migrations/schema.sql, backing the screen 4c request/approve/deny flow.
--
-- WHY: no-permission recipients who open a forwarded document link get 403;
--   they can now submit an access request that owner/admin pull and process.
--   Deployments created BEFORE this batch have no such table; the application
--   now reads/writes it and would crash until the table exists.
--
-- WHO NEEDS THIS: only EXISTING deployments upgrading across this batch. Fresh
--   installs already get the table from the CREATE TABLE in
--   migrations/schema.sql (doc_access_request) and do NOT need to run this file.
--
-- SAFETY: idempotent / re-runnable. Uses CREATE TABLE IF NOT EXISTS, so running
--   it when the table already exists is a no-op (no error).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-02-add-doc-access-request.sql

CREATE TABLE IF NOT EXISTS doc_access_request (
  doc_id         VARCHAR(64)  NOT NULL,
  uid            VARCHAR(64)  NOT NULL,
  requested_role TINYINT      NOT NULL DEFAULT 1,  -- 1=reader 2=writer
  reason         VARCHAR(512) NOT NULL DEFAULT '',
  status         TINYINT      NOT NULL DEFAULT 1,  -- 1=pending 2=approved 3=denied 4=cancelled
  request_id     VARCHAR(64)  NOT NULL,
  decided_by     VARCHAR(64)  NOT NULL DEFAULT '',
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, uid),
  UNIQUE KEY uk_request_id (request_id),
  KEY idx_doc_status (doc_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
