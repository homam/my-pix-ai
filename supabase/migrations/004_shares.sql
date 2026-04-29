-- Public, shareable links to one or more generated images.
-- Slug is the public identifier in /s/<slug> URLs.

create table if not exists public.shares (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  model_id     uuid not null references public.models(id) on delete cascade,
  image_ids    uuid[] not null,
  prompt       text not null,
  view_count   integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists shares_slug_idx on public.shares(slug);
create index if not exists shares_user_id_idx on public.shares(user_id);

alter table public.shares enable row level security;

-- Anyone (incl. unauthenticated) can read a share by slug. The route looks
-- it up by slug; image_ids are dereferenced via the service role on the
-- public page so the underlying generated_images RLS doesn't block render.
drop policy if exists shares_public_read on public.shares;
create policy shares_public_read
  on public.shares for select
  using (true);

-- Only the owner can create or delete their shares.
drop policy if exists shares_owner_insert on public.shares;
create policy shares_owner_insert
  on public.shares for insert
  with check (auth.uid() = user_id);

drop policy if exists shares_owner_delete on public.shares;
create policy shares_owner_delete
  on public.shares for delete
  using (auth.uid() = user_id);

-- Atomic view counter — fire-and-forget from the public page render.
create or replace function public.increment_share_view(p_slug text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.shares set view_count = view_count + 1 where slug = p_slug;
$$;
revoke all on function public.increment_share_view(text) from public;
grant execute on function public.increment_share_view(text) to anon, authenticated;
