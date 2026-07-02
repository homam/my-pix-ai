-- Studio features: face swap, inpainting, outpainting, restore, virtual try-on.
--
-- 1. generated_images grows a `kind` discriminator and an optional link to the
--    source image it was edited from. model_id becomes nullable because some
--    studio tools (restore, inpaint on uploaded photos) don't involve a
--    trained model.
-- 2. garment_tunes stores Astria faceid fine-tunes of clothing items used by
--    virtual try-on.
-- 3. credit_transactions gains the 'garment' type.

alter table public.generated_images
  alter column model_id drop not null;

alter table public.generated_images
  add column if not exists kind text not null default 'generation'
    check (kind in ('generation', 'faceswap', 'inpaint', 'outpaint', 'restore', 'tryon')),
  add column if not exists source_image_id uuid references public.generated_images(id) on delete set null;

create index if not exists generated_images_kind_idx on public.generated_images(kind);

-- Garment fine-tunes for virtual try-on (Astria faceid tunes, class "clothing").
create table if not exists public.garment_tunes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  astria_tune_id bigint,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  image_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists garment_tunes_user_id_idx on public.garment_tunes(user_id);

alter table public.garment_tunes enable row level security;

create policy "Users can view own garments"
  on public.garment_tunes for select
  using (auth.uid() = user_id);

create policy "Users can insert own garments"
  on public.garment_tunes for insert
  with check (auth.uid() = user_id);

create policy "Users can update own garments"
  on public.garment_tunes for update
  using (auth.uid() = user_id);

create policy "Users can delete own garments"
  on public.garment_tunes for delete
  using (auth.uid() = user_id);

-- Allow 'garment' transaction type (garment faceid tune creation cost).
alter table public.credit_transactions
  drop constraint if exists credit_transactions_type_check;

alter table public.credit_transactions
  add constraint credit_transactions_type_check
  check (type in ('purchase', 'training', 'generation', 'refund', 'garment'));
