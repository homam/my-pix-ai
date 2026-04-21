# MyPix AI

AI photo studio: users upload photos → fine-tune a FLUX.1 LoRA on their likeness → generate photorealistic photos in any scenario.

## Stack
- **Framework**: Next.js 15 App Router + TypeScript
- **Auth + DB + Storage**: Supabase (magic-link auth, Postgres with RLS, Storage for photo uploads)
- **AI**: Astria.ai (FLUX.1 LoRA training + inference, ~$2.13/user)
- **Payments (optional)**: Stripe — enabled when `STRIPE_SECRET_KEY` is set
- **Email (optional)**: Resend — enabled when `RESEND_API_KEY` is set
- **UI**: Tailwind CSS v4

Cloudflare R2 is **not** used — photo storage is Supabase Storage. Stripe and Resend are **env-gated**: they're wired into the code but silently no-op when their env vars are missing. So in local dev you only need Supabase + Astria; in production, add Stripe and Resend when you're ready.

---

## Local dev setup

### 1. Supabase project (free tier works)
- Create a project at [supabase.com](https://supabase.com)
- In **SQL Editor**, paste and run `supabase/migrations/001_initial.sql`. This creates all tables, RLS policies, the `user-uploads` Storage bucket, and the `add_credits` / `deduct_credits` RPCs.
- In **Project Settings → API**, grab:
  - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
  - anon/public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - service_role key → `SUPABASE_SERVICE_ROLE_KEY`
- In **Authentication → URL Configuration**, add `http://localhost:4871/auth/callback` to the list of allowed redirect URLs.

### 2. Astria.ai API key
- Sign up at [astria.ai](https://astria.ai) and create an API key.
- Put it in `.env.local` as `ASTRIA_API_KEY`.
- Training one model costs about $1.50 on your Astria account; image generation is ~$0.0125/image.

### 3. Environment
```bash
cp .env.local.example .env.local
# fill in the Supabase + Astria values
```

### 4. Install and run
```bash
npm install
npm run dev
```

App is at [http://localhost:4871](http://localhost:4871). Sign up with any email → click magic link → you start with 1000 credits (training costs 20, generation costs 1 per image). Need more? Visit `/pricing` and click **Grant me 500 credits**.

### Optional: enable Stripe checkout
1. Create products + prices in Stripe dashboard (Starter/Pro/Ultra).
2. Add to `.env.local`:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_PRICE_STARTER=price_...
   STRIPE_PRICE_PRO=price_...
   STRIPE_PRICE_ULTRA=price_...
   ```
3. For local webhooks: `stripe listen --forward-to localhost:4871/api/webhooks/stripe`
4. Restart dev server — `/pricing` will now show real pack cards with Stripe checkout.

### Optional: enable Resend emails
```
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=hello@yourdomain.com
```
Without these, emails on training-complete / training-failed are logged to the server console instead of sent.

---

## How the Astria webhook works (and how we avoid needing it locally)

Astria trains a model asynchronously (~10 min) and normally POSTs to a callback URL on completion. Our app handles this two ways:

### Dev mode (what you want for now): **polling**
- Leave `ASTRIA_WEBHOOK_PUBLIC_URL` unset.
- The train route doesn't register a callback with Astria.
- The model detail page (`/models/[id]`) auto-polls `/api/models/[id]/refresh` every 20s while status is `training`. This endpoint calls Astria's GET `/tunes/{id}` and updates our DB when `trained_at` is set.
- There's also a manual **"Check status now"** button.

**Nothing to configure — it just works.**

### Production (or if you want live webhooks locally)
Option A — deploy to Vercel and set `ASTRIA_WEBHOOK_PUBLIC_URL=https://mypix.ai`.

Option B — local dev with live webhooks via ngrok:
```bash
brew install ngrok   # or download from ngrok.com
ngrok http 3000
# copy the https URL, e.g. https://abc123.ngrok-free.app
```
Then in `.env.local`:
```
ASTRIA_WEBHOOK_PUBLIC_URL=https://abc123.ngrok-free.app
```
Restart `npm run dev`. Now Astria will POST completion callbacks to your local server.

Either way, polling remains as a fallback — webhooks can be lost, so you always have a deterministic recovery path.

---

## Key flows

1. **Create model**: Upload 15–25 photos → client gets a signed upload URL per file from `/api/upload` → uploads directly to Supabase Storage (`user-uploads` bucket) → `/api/train` deducts 20 credits and calls Astria to create a tune.
2. **Training**: Astria trains FLUX.1 LoRA (~10 min). UI polls `/api/models/[id]/refresh` for status. On success, model status flips to `ready`.
3. **Generate**: `/api/generate` calls Astria with the user's tune ID and a prompt (auto-prepended with `ohwx person` trigger token). Results are stored in `generated_images`.

---

## Credit economics
- New users get 1000 free credits (dev mode generosity).
- Training: 20 credits. Generation: 1 credit per image.
- `/pricing` grants 500 credits per click (dev only — disable in prod with `DEV_GRANT_CREDITS=false`).

---

## Key files
- `lib/astria.ts` — Astria API client (createTune, generateImages, getTune)
- `lib/storage.ts` — Supabase Storage signed upload URLs
- `lib/credits.ts` — deductCredits / addCredits (wraps Supabase RPCs)
- `app/api/webhooks/astria/route.ts` — training completion webhook (for when you set up ngrok / deploy)
- `app/api/models/[id]/refresh/route.ts` — polling fallback
- `components/NewModelForm.tsx` — photo upload + training kickoff
- `components/GenerateSection.tsx` — prompt input + image gallery
- `components/TrainingProgress.tsx` — auto-refreshing training state UI
- `supabase/migrations/001_initial.sql` — full schema + Storage bucket + RPCs

---

## Astria notes
- Base tune ID: `1504944` (FLUX.1 dev). Verify at astria.ai if model IDs change.
- Trigger token: `ohwx person` (auto-prepended to all generation prompts).
- Portrait preset (`flux-lora-portrait`) — best for face identity preservation.
- Webhook payload: `{ tune: AstriaTune }` with `trained_at` set on success.
