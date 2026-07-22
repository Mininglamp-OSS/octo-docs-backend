-- Upgrade migration: add doc_access_notify_card table
-- (task docs-access-decision-card-sync)
--
-- WHAT: creates `doc_access_notify_card`, a ledger of the notification cards
--   delivered to a document's approvers (某审批人：owner + admins) when someone
--   submits an access request. One row per (request_id, recipient) records the
--   IM coordinates (channel + message id) of that recipient's card.
--
-- WHY: when an access request is approved/denied, the backend must drive EVERY
--   approver's card to a terminal state, not just the one the decider clicked.
--   Doing so requires knowing each delivered card's (channel_id, message_id);
--   octo-server's notify response now returns those coordinates and we persist
--   them here so the decision path can look them up and mutate every card.
--
-- WHO NEEDS THIS: only EXISTING deployments upgrading across this batch. Fresh
--   installs get the table from migrations/schema.sql.
--
-- PRIVACY: recipient_uid identifies an approver ("某审批人"); no display names or
--   account handles are stored — only the opaque Octo uid needed to locate the
--   card, consistent with the surrounding tables (doc_member.uid etc.).
--
-- SAFETY: idempotent / re-runnable. Uses CREATE TABLE IF NOT EXISTS, so running
--   it when the table already exists is a no-op (no error).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-22-add-doc-access-notify-card.sql

CREATE TABLE IF NOT EXISTS doc_access_notify_card (
  request_id    VARCHAR(64)  NOT NULL,               -- doc_access_request.request_id this card belongs to
  recipient_uid VARCHAR(64)  NOT NULL,               -- approver who received the card (owner or admin)
  channel_id    VARCHAR(64)  NOT NULL,               -- IM channel the card was delivered on (DM = recipient)
  channel_type  TINYINT      NOT NULL DEFAULT 1,     -- IM channel type (1=person)
  message_id    VARCHAR(64)  NOT NULL,               -- IM message id (string: int64 exceeds JS safe integer)
  client_msg_no VARCHAR(64)  NOT NULL DEFAULT '',    -- IM client message no (idempotency / audit)
  status        TINYINT      NOT NULL DEFAULT 1,     -- 1=active(sent) 2=terminalized
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (request_id, recipient_uid)            -- leftmost prefix serves the decision-time lookup by request_id
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
