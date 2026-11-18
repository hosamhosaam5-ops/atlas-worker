# ATLAS Clean v1 — Phase 2 production specification

**Status: SUPERSEDED.** The implementation plan and operational controls are now maintained in [clean-v1-production-operations.md](clean-v1-production-operations.md).

The current implementation PR uses the existing GitHub Actions secret CF_TRIAL_API_TOKEN. It does not create secrets. A workflow_dispatch read-only preflight checks token validity, Worker metadata read, and Account Analytics Read, but cannot prove deployment write permission. That permission remains UNKNOWN until an owner-authorized deployment operation.

Deployment remains disabled by default. The production marker must remain DISARMED unless the owner explicitly says «فعّل الإنتاج» and confirms the current receiving wallet. The canonical marker path is ops/triggers/clean-v1-production.trigger. The canonical production target is atlas-clean-v1 via wrangler.clean-v1.toml only.

No deployment, token creation, payment, route update, D1/atlas_db access, or evidence-card update is authorized by this document.
