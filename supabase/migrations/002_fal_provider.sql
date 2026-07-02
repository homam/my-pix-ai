-- ============================================================
-- 002_fal_provider.sql
-- Adds an optional second image provider (fal.ai, FLUX.2) alongside Astria.
--
-- Astria remains the default and only requires no change. fal is opt-in: a
-- model gains a FLUX.2 version only once its LoRA is trained on fal, at which
-- point fal_lora_url is populated. Astria-trained weights are NOT portable to
-- fal, so this is a separate (additional) training run — see lib/fal.ts.
--
-- Idempotent: safe to re-run. Apply in Supabase SQL Editor.
-- ============================================================

-- Which engine this model is trained on and renders with. A model is bound to
-- one engine at training time. 'astria' = FLUX.1 dev (default, existing rows);
-- 'fal' = FLUX.2.
alter table public.models
  add column if not exists provider text not null default 'astria'
    check (provider in ('astria', 'fal'));

-- FLUX.2 LoRA weights URL (fal). null = this model has no fal version and can
-- only be rendered on Astria.
alter table public.models
  add column if not exists fal_lora_url text;

-- Optional: fal's training request id, so a poll/webhook can reconcile a fal
-- training job back to this model (mirrors how astria_tune_id is used).
alter table public.models
  add column if not exists fal_request_id text;

comment on column public.models.fal_lora_url is
  'fal.ai FLUX.2 LoRA weights URL. Set after a fal training run. Null = Astria-only.';
comment on column public.models.fal_request_id is
  'fal.ai training request id used to reconcile async training completion.';
