-- Space-scoped document share permissions (link-based read/edit), GitHub #64.
--
-- Adds a per-document share scope + share role to doc_meta. Both columns are a
-- single additive ALTER: MySQL 8 backfills every existing row with the fixed
-- defaults, so all pre-existing docs (and every INSERT that omits the columns)
-- stay `restricted` — no accidental exposure, no data backfill, no downtime.
-- Reversible via `DROP COLUMN`.
--
--   share_scope  0 = restricted (default), 1 = anyone_in_space
--   share_role   1 = read, 2 = edit   (meaningful only when share_scope = 1)
--
-- The CHECK constraints are defense-in-depth (MySQL 8.0.16+). The authoritative
-- validation lives in the PUT /share handler, which rejects any out-of-enum
-- value with 400 before the DB write; a raw UPDATE with an illegal value fails
-- the CHECK. The reader side (effectiveRole) additionally coerces any
-- unexpected stored value to the most-restrictive interpretation, so an
-- out-of-range value can never open access.

ALTER TABLE doc_meta
  ADD COLUMN share_scope TINYINT NOT NULL DEFAULT 0
    COMMENT '0=restricted(默认) 1=anyone_in_space',
  ADD COLUMN share_role  TINYINT NOT NULL DEFAULT 1
    COMMENT 'anyone_in_space 生效时的角色：1=read 2=edit；restricted 时忽略',
  ADD CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0, 1)),
  ADD CONSTRAINT chk_doc_meta_share_role  CHECK (share_role IN (1, 2));
