-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- Models
-- ============================================================
create table public.models (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  status      text not null default 'pending'
                check (status in ('pending','training','ready','failed')),
  astria_tune_id  bigint,
  cover_image_url text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index models_user_id_idx on public.models(user_id);

alter table public.models enable row level security;

create policy "Users can manage their own models"
  on public.models
  for all
  using (auth.uid() = user_id);

-- ============================================================
-- Model training images
-- ============================================================
create table public.model_images (
  id        uuid primary key default gen_random_uuid(),
  model_id  uuid not null references public.models(id) on delete cascade,
  url       text not null,
  created_at timestamptz not null default now()
);

alter table public.model_images enable row level security;

create policy "Users can view images of their own models"
  on public.model_images
  for select
  using (
    exists (
      select 1 from public.models m
      where m.id = model_id and m.user_id = auth.uid()
    )
  );

-- ============================================================
-- Generated images
-- ============================================================
create table public.generated_images (
  id              uuid primary key default gen_random_uuid(),
  model_id        uuid not null references public.models(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  prompt          text not null,
  url             text not null,
  astria_image_id text,
  created_at      timestamptz not null default now()
);

create index generated_images_model_id_idx on public.generated_images(model_id);
create index generated_images_user_id_idx on public.generated_images(user_id);

alter table public.generated_images enable row level security;

create policy "Users can manage their own generated images"
  on public.generated_images
  for all
  using (auth.uid() = user_id);

-- ============================================================
-- User credits
-- ============================================================
create table public.user_credits (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null unique references auth.users(id) on delete cascade,
  balance   integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

alter table public.user_credits enable row level security;

create policy "Users can view their own credits"
  on public.user_credits
  for select
  using (auth.uid() = user_id);

-- ============================================================
-- Credit transactions (audit log)
-- ============================================================
create table public.credit_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  amount          integer not null,  -- positive = credit, negative = debit
  type            text not null check (type in ('purchase','training','generation','refund')),
  stripe_session_id text,
  description     text not null,
  created_at      timestamptz not null default now()
);

create index credit_transactions_user_id_idx on public.credit_transactions(user_id);

alter table public.credit_transactions enable row level security;

create policy "Users can view their own transactions"
  on public.credit_transactions
  for select
  using (auth.uid() = user_id);

-- ============================================================
-- Functions
-- ============================================================

-- Atomically add credits (called from service role)
create or replace function public.add_credits(
  p_user_id         uuid,
  p_amount          integer,
  p_stripe_session_id text,
  p_description     text
) returns void
language plpgsql security definer
as $$
begin
  insert into public.user_credits (user_id, balance)
    values (p_user_id, p_amount)
    on conflict (user_id) do update
      set balance = user_credits.balance + p_amount,
          updated_at = now();

  insert into public.credit_transactions
    (user_id, amount, type, stripe_session_id, description)
    values (
      p_user_id,
      p_amount,
      case when p_stripe_session_id is not null then 'purchase' else 'refund' end,
      p_stripe_session_id,
      p_description
    );
end;
$$;

-- Atomically deduct credits; returns new balance or -1 if insufficient
create or replace function public.deduct_credits(
  p_user_id     uuid,
  p_amount      integer,
  p_type        text,
  p_description text
) returns integer
language plpgsql security definer
as $$
declare
  v_balance integer;
begin
  select balance into v_balance
    from public.user_credits
    where user_id = p_user_id
    for update;

  if v_balance is null or v_balance < p_amount then
    return -1;
  end if;

  update public.user_credits
    set balance = balance - p_amount,
        updated_at = now()
    where user_id = p_user_id;

  insert into public.credit_transactions
    (user_id, amount, type, description)
    values (p_user_id, -p_amount, p_type, p_description);

  return v_balance - p_amount;
end;
$$;

-- Auto-create credits row for new users (with 20 free credits to train one model)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
as $$
begin
  insert into public.user_credits (user_id, balance)
    values (new.id, 20);  -- 20 free credits = 1 free model training
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
