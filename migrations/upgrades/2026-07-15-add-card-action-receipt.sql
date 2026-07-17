-- Upgrade migration: add card_action_receipt table (card-action callback idempotency)
--
-- WHAT: durable idempotency store for signed card-action callbacks from
--   octo-server (docs approve/deny buttons). Keyed by the callback `event_id`.
--   The stored `response` is the exact typed DecisionResult returned on the first
--   apply and replayed verbatim on any at-least-once redelivery of that event_id.
--
-- WHY: octo-server delivers card actions at-least-once (timeout / crash / lost
--   response can redeliver the same event_id). The consumer contract
--   (docs/card-action-callback-consumer.md) requires a durable event_id
--   idempotency guard that returns the SAME stored response on replay.
--
-- SAFETY: idempotent / re-runnable (CREATE TABLE IF NOT EXISTS).
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-15-add-card-action-receipt.sql

CREATE TABLE IF NOT EXISTS card_action_receipt (
  event_id   VARCHAR(32)  NOT NULL,               -- octo callback event_id (decimal string; NOT coerced to number)
  response   TEXT         NULL,                    -- JSON DecisionResult; NULL between claim and finalize
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
