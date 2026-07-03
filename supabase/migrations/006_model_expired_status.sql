-- ============================================================
-- 006_model_expired_status.sql
-- Adds an 'expired' model status.
--
-- Astria deletes a fine-tune (weights, training images, prompts, generated
-- images) roughly 30 days after training completes, unless the tune was created
-- with auto_extend. Generating/editing against a deleted tune 422s with
-- {"base":["Tune <id> has expired."]}. When the generate/edit routes detect that
-- error they flag the owning model 'expired' so the UI can prompt a retrain
-- instead of failing forever on a dead tune. This widens the status check
-- constraint to allow the new value.
--
-- Additive + idempotent — safe to run on an existing DB. Until this runs, the
-- routes still refund and return a clear message; only the best-effort DB flag
-- is skipped (the UPDATE fails the old constraint and is logged, not fatal).
-- ============================================================

alter table public.models
  drop constraint if exists models_status_check;

alter table public.models
  add constraint models_status_check
    check (status in ('pending', 'training', 'ready', 'failed', 'expired'));
