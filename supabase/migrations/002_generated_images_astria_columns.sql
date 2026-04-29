-- Add columns referenced by the generation + sync routes that were missing
-- from the original schema. Without these, the insert in /api/generate
-- silently fails (column does not exist) and the route returns {"images":[]}.

alter table public.generated_images
  add column if not exists astria_source_url text,
  add column if not exists astria_prompt_id  bigint;

create index if not exists generated_images_astria_prompt_id_idx
  on public.generated_images(astria_prompt_id);
