-- Add decision_note to doc_access_request: the reviewer's free-text reason
-- captured when denying (or approving) an access request via the interactive
-- approval card. The value arrives from octo-server verbatim as
-- DecisionRequest.inputs["deny_reason"] (cross-repo contract: octo-server
-- pkg/cardtmpl DocsDenyReasonInputID = "deny_reason"). NOT NULL DEFAULT '' so
-- existing rows and approve decisions (which carry no note) are unaffected.
-- Column width mirrors `reason` (VARCHAR(512)); the docs backend truncates the
-- submitted value defensively before writing.
ALTER TABLE doc_access_request
  ADD COLUMN decision_note VARCHAR(512) NOT NULL DEFAULT '' AFTER decided_by;
