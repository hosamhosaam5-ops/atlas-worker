-- Remove providers that are no longer supported. Safe and idempotent.
DELETE FROM capabilities WHERE capability_id = 'github_models';
