-- M6 — ChatGPT bridge audit identity metadata.
-- Additive migration: preserve existing bridge audit rows while enabling caller provenance.
ALTER TABLE bridge_audit ADD COLUMN caller_ip TEXT;
ALTER TABLE bridge_audit ADD COLUMN user_agent TEXT;
ALTER TABLE bridge_audit ADD COLUMN chat_id TEXT;
