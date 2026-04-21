# MyPix AI

AI photo studio: users upload photos → fine-tune a FLUX.1 LoRA on their likeness → generate photorealistic photos in any scenario.

## Stack
- **Framework**: Next.js 15 App Router + TypeScript
- **Auth + DB**: Supabase (magic-link auth, Postgres with RLS)
- **AI**: Astria.ai (FLUX.1 LoRA training + inference, ~$2.13/user)
- **Storage**: Cloudflare R2 (user uploads + generated images)
- **Payments**: Stripe (one-time credit packs)
- **Email**: Resend
- **UI**: Tailwind CSS v4 + Radix primitives

## Key flows
1. User uploads 15–25 photos → R2 presigned PUT → `/api/train` → Astria tune
2. Astria webhooks `/api/webhooks/astria` when training done → updates model status + emails user
3. User generates images → `/api/generate` → Astria prompt → stored in Supabase
4. Stripe checkout `/api/checkout` → webhook `/api/webhooks/stripe` → credits added via `add_credits` RPC

## Credit economics
- New users get 20 free credits (1 free model training)
- Training costs 20 credits, generation costs 1 credit per image
- Packs: Starter (50/$9), Pro (200/$29), Ultra (500/$59)

## Local dev setup
1. `cp .env.local.example .env.local` — fill in all keys
2. `npm install`
3. Run Supabase migration: `supabase db push` or paste `supabase/migrations/001_initial.sql` in SQL editor
4. `npm run dev`

## Env vars required
See `.env.local.example` for full list. Key ones:
- `ASTRIA_API_KEY`, `ASTRIA_WEBHOOK_SECRET`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`

## Astria notes
- Base tune ID: `1504944` (FLUX.1 dev) — verify at astria.ai if model IDs change
- Trigger token: `ohwx person` (prepended to all generation prompts automatically)
- Portrait preset used for training — best for face identity preservation
- Webhook payload: `{ tune: AstriaTune }` with `trained_at` set on success
