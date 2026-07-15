-- Upgrade migration: document commenter role (role=4) on doc_member / doc_invite
--
-- WHAT: refreshes the inline COMMENT on doc_member.role and doc_invite.role to
--   document the new `4=commenter` value. No column type or default changes:
--   both columns are already TINYINT and accept 4 as-is.
--
-- WHY: the `commenter` role sits BETWEEN reader and writer (can view the body
--   and write comments, but cannot edit the body). To avoid a risky renumbering
--   of the already-stored reader=1/writer=2/admin=3 values, commenter takes the
--   next free stored value (4); comparison rank is decoupled in application code
--   (see src/permission/role.ts). Storage is therefore unchanged — only the
--   human-facing column comments need to reflect the new value.
--
-- WHO NEEDS THIS: only EXISTING deployments upgrading across this batch, purely
--   to keep the column comments accurate. Fresh installs already get the updated
--   comments from migrations/schema.sql. The application does NOT depend on the
--   column comment, so skipping this file has no functional effect.
--
-- SAFETY: idempotent / re-runnable. MODIFY COLUMN restates the column with an
--   updated comment only; the type/nullability/default are re-specified to their
--   existing values, so running it repeatedly is a no-op.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/upgrades/2026-07-15-add-commenter-role.sql

ALTER TABLE doc_member
  MODIFY COLUMN role TINYINT NOT NULL
  COMMENT '1=reader 2=writer 3=admin 4=commenter';

ALTER TABLE doc_invite
  MODIFY COLUMN role TINYINT NOT NULL DEFAULT 2
  COMMENT '1=reader 2=writer(默认) 3=admin 4=commenter';
