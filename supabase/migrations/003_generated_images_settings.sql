-- Store per-generation settings (prompt suffix, realism preset, aspect ratio,
-- toggles, seed) on each row so the UI can show "what was used" and so users
-- can remix a specific image by copying its seed back into the form.
--
-- Nullable / no default — legacy rows and fan-out submissions where the seed
-- wasn't tracked stay valid.

alter table public.generated_images
  add column if not exists settings jsonb;

-- No GIN index yet — query patterns are "load images for a model, render
-- their settings inline". Add later if we start filtering by settings keys.
