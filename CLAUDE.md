# MyPix AI

> **Product tag:** Premium VAS · Original · Brand: **MyPix AI** — pay-as-you-go credit packs ($9/$29/$59), no subscription. Not a rebrand of any sibling in `/products`.
>
> **aionized platform status:** fully cut over (2026-07-04) to the shared platform project (same one `product-image-tools`/Pixby uses — see its [docs/PLATFORM.md](../product-image-tools/docs/PLATFORM.md)), registered as product/brand `mypix`. `lib/supabase/client.ts` and `server.ts` construct every client with `db: { schema: 'mypix' }`, so all existing `.from('models')`/`.from('generated_images')`/etc. calls resolve to `mypix.*` unchanged. `lib/credits.ts` now wraps `@aionized/platform-client` (`core.wallets`/`spend_credits`/`grant_credits`, brand-scoped) instead of the old `public.user_credits`/`add_credits`/`deduct_credits` — same exported function signatures (`getBalance`/`deductCredits`/`addCredits`), so callers didn't need to change. The old standalone project (`ewpqjvpejzomijulugth`) is **paused** (not deleted — kept as a safety net) and no longer used (it had 0 real users — dev/test data only). `starter_credits` for `mypix` is `0` in `core.products` (no free tier in the real pricing model; the old project's "1000 dev-mode" grant was never production-real). `.env.local` updated to point at the shared project with a real `SUPABASE_SERVICE_ROLE_KEY`.
>
> **Deployed** on AWS App Runner (`eu-central-1`, not the `ap-northeast-1`/Tokyo some other docs assume) at `https://wy7kp3ie3e.eu-central-1.awsapprunner.com` — redeployed 2026-07-04 via `scripts/deploy.sh` with the new project's build args, plus a separate `aws apprunner update-service` call to repoint the service's runtime `SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` (the service was live and pointing at the old project in between the schema migration and this redeploy — briefly broken in prod). `@aionized/platform-client` is consumed via a vendored tarball (`vendor/`) — see `../platform-client/README.md`.

AI photo studio: users upload photos → fine-tune a FLUX.1 LoRA on their likeness → generate photorealistic photos in any scenario.

## Stack
- **Framework**: Next.js 15 App Router + TypeScript
- **Auth + DB + Storage**: Supabase (magic-link + email/password auth, Postgres with RLS, Storage for photo uploads)
- **AI**: Astria.ai (FLUX.1 LoRA training + inference, ~$2.13/user)
- **Payments (optional)**: Stripe — enabled when `STRIPE_SECRET_KEY` is set
- **Email (optional)**: Resend — enabled when `RESEND_API_KEY` is set
- **UI**: Tailwind CSS v4

Cloudflare R2 is **not** used — photo storage is Supabase Storage. Stripe and Resend are **env-gated**: they're wired into the code but silently no-op when their env vars are missing. So in local dev you only need Supabase + Astria; in production, add Stripe and Resend when you're ready.

---

## White-label / rebranding

This codebase redeploys under a different brand (name, copy, legal entity, logo, favicon, colors)
without code forks — the same one-product-many-brands model as
`product-image-tools/docs/PLATFORM.md`. Features and credit costs are product-scoped and
identical across brands; identity is brand-scoped. At the shared five-dimension rebrand standard
(2026-07-04) used by the "Rebranding / white-labeling" sections in the `product-pdf-tools`,
`product-image-tools`, and `ai-all-in-one-chat` READMEs.

A rebrand touches five places:

1. **`lib/brand.ts`** — add a `BrandConfig` entry: display name, `<title>`/meta/OG copy,
   canonical production URL, support email, legal entity (company name, optional address +
   jurisdiction, © since-year), and the **retail credit packs** (names, credits, $ prices).
   `/terms` and `/privacy` render from the same config. An unknown key fails the build loudly.
2. **Env** — deploy with `NEXT_PUBLIC_BRAND_KEY=<key>` (unset = `mypix`; must match a
   `core.brands` row on the shared platform project — one INSERT, see PLATFORM.md "Onboard a NEW
   BRAND"), the brand's domain in `NEXT_PUBLIC_APP_URL`, its own `STRIPE_PRICE_*` / `STRIPE_*`
   keys and `RESEND_FROM_EMAIL`.
3. **Colors are part of the `BrandConfig`** (since the 2026-07-04 multi-brand rollout):
   `theme` in `lib/brand.ts` holds the `brand200…600` + `brand2_*` scale per brand; the root
   layout injects it over the `--color-brand-*` defaults in `app/globals.css` `@theme` (for
   `mypix` the injection is a no-op — keep its values identical to the CSS defaults).
   Components use `brand-*` utilities (`bg-brand-600`, `text-brand-400`, `border-brand-500/40`,
   …), never raw palette classes; the semantic tokens (`--color-primary` / `--color-accent` /
   `--color-ring`), `.gradient-text`, `.glow`, `.legal-prose`, and the studio mask tint (read at
   runtime in `components/studio/MaskCanvas.tsx`) all derive from the scale.
4. **`app/icon.tsx`** — the favicon, generated at build time from `BRAND.theme` (gradient tile +
   sparkle mark). Replaced the old static `app/icon.svg` whose hexes had to be kept in sync by
   hand — no per-brand favicon edits needed anymore.
5. **`components/brand/Logo.tsx`** — the mark + wordmark (`Logo`, with `LogoMark` for the icon
   alone); the wordmark text comes from `BRAND`. Swap the mark or layout here once; every
   header/footer call site picks it up. (Remaining `Sparkles` icons elsewhere are decorative
   feature/button icons, not logos.)

**Entities (2026-07-05, PLATFORM.md §10):** brands belong to a legal **entity** — `mypix` to
`entity1`, `glowshot` to `entity2` (legal names TBD; `lib/brand.ts` derives each brand's legal
block from the `ENTITIES` map, falling back to the brand display name). **User accounts never
cross entities**: `core.bind_entity` binds a user on first wallet touch and every wallet RPC
raises `ENTITY_MISMATCH` across the line.

Product economics stay brand-independent by design (`CREDIT_COSTS` in `types/index.ts` — features
belong to the product, per PLATFORM.md), and Stripe **price IDs stay per-deployment env vars**
(`STRIPE_PRICE_*`), so each brand deployment points at its own Stripe prices. Never hardcode the
brand name, support email, pack prices, legal entity, accent color, or logo mark in components —
import `BRAND` (and `brandUrl()`) from `lib/brand.ts`, use `brand-*` utilities, render `<Logo />`.

**Auth & payments are brand-scoped capabilities** (decided 2026-07-04; auth **partially
implemented 2026-07-05**): brands of this product may support *different* login methods
(magic link, username/password, magic token, …) and *different* payment rails (Stripe,
DCB, …). Features stay product-scoped; how a user gets in and pays belongs to the brand.
Implemented so far (per `product-image-tools/docs/PLATFORM.md` §9 declare/enable/enforce):
`BrandConfig.auth.methods` in `lib/brand.ts` declares each brand's login methods (both
brands: `magic_link` + `password`), and the login page renders only declared methods —
email+password sign-in is live (`signInWithPassword`), with accounts **owner-provisioned
in the Supabase dashboard** (no self-serve signup UI). Password reset is self-serve
(2026-07-05): "Forgot password?" on `/login` → `resetPasswordForEmail` → recovery email →
`/auth/callback?next=/reset-password` → `app/(auth)/reset-password/page.tsx`
(`updateUser({password})`; no session on that page = expired link). Still TODO:
`payments.providers` declaration, per-deployment env enablement
(declared-but-unconfigured should fail the build loudly), and **server-side** rejection
of non-declared methods — hiding a login button is not the boundary.

Not brand-scoped yet (acceptable for now, flagged for later): landing-page marketing copy beyond
name/tagline (`app/page.tsx` hero/features/scenario chips), and each brand still shares one
Supabase project + Astria account per deployment. (The palette, logo mark, and favicon are
brand-scoped as of 2026-07-04 — items 3–5 above.)

---

## Local dev setup

### 1. Supabase project
**As of 2026-07-04, do NOT create a fresh standalone Supabase project for this.** This app runs
on the shared aionized platform project ("aionized-platform" in the dashboard, ref
`jrzaobtnunduxkzkgtbx`) — the same one `product-image-tools`/Pixby, `product-pdf-tools`, and
`ai-all-in-one-chat`/Hearth use. `supabase/migrations/001_initial.sql` and friends in this repo
describe the **old, retired** standalone schema (kept for history, not applied anywhere live) —
the real schema for this product now lives in `product-image-tools/supabase/migrations/0009_onboard_mypix_schema.sql`
(`mypix.*` tables) plus the shared `core.*` schema for wallets/credits. See
`product-image-tools/docs/PLATFORM.md` for the full contract.
- `.env.local` already has the correct `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` for the shared project — copy from there, don't regenerate from a new project.
- In **Authentication → URL Configuration** (on the shared project), add
  `http://localhost:4871/auth/callback` to the list of allowed redirect URLs if it's not already there.

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

App is at [http://localhost:4871](http://localhost:4871). Sign up with any email → click magic link → **you start with 0 credits** (training costs 20, generation costs 1 per image — no free tier in the real pricing model, see `core.products.mypix.starter_credits` in the shared platform). Need credits for local testing? Visit `/pricing` and click **Grant me 500 credits** (dev-only endpoint, `app/api/dev/grant-credits`).

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

## Production deployment (AWS App Runner — canonical)

Production runs on **AWS App Runner**: https://wy7kp3ie3e.eu-central-1.awsapprunner.com
(account `178269041738`, region `eu-central-1`, service `my-pix-ai`, 1 vCPU / 2 GB).
App Runner is closed to new AWS customers since 2026-04-30 (we're grandfathered, no EOL date,
new services still allowed) — staying for now; exit runbook + migration triggers in
`../product-image-tools/docs/APP-RUNNER-SUNSET.md`.

**To deploy:** `./scripts/deploy.sh` — builds the linux/amd64 image **per brand** (standalone
Next.js build; `NEXT_PUBLIC_*` baked in as build args) and rolls out **every** brand in
`deploy/brands/*.env`: `mypix` → service `my-pix-ai` (ECR `:latest`) and, since 2026-07-04,
`glowshot` → service `glowshot` at `https://pyt65zu7sr.eu-central-1.awsapprunner.com` (ECR
`:glowshot`). Feature sets stay in sync across brands, so a deploy is all-brands by definition.
Secrets (`SUPABASE_SERVICE_ROLE_KEY`, `ASTRIA_API_KEY`, `FAL_KEY`, …) are runtime env vars on
each service, not in the image (`glowshot` has its own `ASTRIA_WEBHOOK_PUBLIC_URL`).
`DEV_GRANT_CREDITS=false` in production.

Gotchas encoded in the Dockerfile — don't undo them:
- App Runner injects its own `HOSTNAME` at runtime, so the CMD forces `HOSTNAME=0.0.0.0`
  (ENV alone gets overridden and Next.js binds the wrong interface → health-check death).
- App Runner has a **hard 120s request cap**; Astria/fal inference polling defaults to
  100s (`lib/astria.ts` / `lib/fal.ts`) so timeouts fail inside the window and refund.

Supabase auth: Site URL is the App Runner domain; redirect allow-list has the App Runner,
Vercel, and `http://localhost:4871` callbacks.

A legacy Vercel deployment exists at https://my-pix-ai-opal.vercel.app (same Supabase DB)
but is **frozen — do not deploy to it**; App Runner is the only deploy target.

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

1. **Create model**: Upload 15–25 photos → client gets a signed upload URL per file from `/api/upload` → uploads directly to Supabase Storage (`mypix` bucket) → `/api/train` deducts 20 credits and calls Astria to create a tune.
2. **Training**: Astria trains FLUX.1 LoRA (~10 min). UI polls `/api/models/[id]/refresh` for status. On success, model status flips to `ready`.
3. **Generate**: `/api/generate` calls Astria with the user's tune ID and a prompt (auto-prepended with `ohwx person` trigger token). Results are stored in `generated_images`.
4. **Studio edits**: `/studio` hosts five tools, all going through `POST /api/edit` (discriminated by `mode`):
   - **faceswap** — put a trained model's face into any uploaded photo (img2img at low denoising + `face_swap` + `inpaint_faces`)
   - **inpaint** — background swap / object removal; the client paints a mask (`components/studio/MaskCanvas.tsx`), uploads it, Astria repaints the white area
   - **outpaint** — uncrop via `--outpaint` prompt args at `denoising_strength=0`
   - **restore** — restore/colorize old photos (img2img on the base tune, no trained model needed)
   - **tryon** — virtual outfit try-on: garments are Astria faceid fine-tunes (`garment_tunes` table via `POST /api/garments`, 5 credits) combined with the user's LoRA via `<lora:...>` + `<faceid:...>` prompt tokens

   Edits cost 1 credit/image (`GENERATION` type). Results land in `generated_images` with a `kind` column; `model_id` is nullable for model-free edits. Schema: `supabase/migrations/005_studio.sql`.
5. **Retrain**: `POST /api/models/[id]/retry` re-runs training on an existing
   model (statuses `ready` | `failed` | `expired` | `pending`). Body is optional:
   `{ provider?, imageUrls? }` — omit both (the one-click card button) to reuse
   the stored photos on the current engine; pass `provider` to **switch engine**
   (Standard/Astria ↔ Ultra/fal); pass `imageUrls` (freshly uploaded to the
   model's folder) to **replace the photo set** (old stored photos are then
   pruned). Costs 20 credits (`TRAINING`), refunded on failure. Both `/api/train`
   (first training) and this route share one engine-branched core,
   `lib/training.ts` → `kickoffTraining()`, which also clears the other engine's
   identity fields when switching. UI: `components/RetrainPanel.tsx` on the model
   page (engine picker + reuse/upload photos) and a quick one-click Retrain on
   dashboard cards for failed/expired models.

---

## Credit economics
- New users get **0** free credits (updated 2026-07-04 — no free tier in the real pricing model;
  `core.products.mypix.starter_credits = 0` in the shared platform. The old standalone project's
  "1000 dev-mode" auto-grant was retired along with that project).
- Training: 20 credits. Generation: 1 credit per image.
- `/pricing` grants 500 credits per click (dev only — disable in prod with `DEV_GRANT_CREDITS=false`).

---

## Key files
- `lib/brand.ts` — white-label brand registry (name, SEO copy, support email, legal entity, credit packs, color theme); selected by `NEXT_PUBLIC_BRAND_KEY`. Brands: `mypix` (purple/pink), `glowshot` (amber/rose, service `glowshot` on App Runner)
- `components/brand/Logo.tsx` — swappable brand mark + wordmark (all header/footer logos render this)
- `app/icon.tsx` — favicon generated from `BRAND.theme` at build time
- `app/globals.css` — `--color-brand-*` accent scale in `@theme`; components use `brand-*` utilities, never raw palette classes
- `lib/astria.ts` — Astria API client (createTune, generateImages, editImage, createGarmentTune, getTune); throws `AstriaTuneExpiredError` on expired-tune 422s
- `lib/training.ts` — shared `kickoffTraining()` (engine-branched training kickoff) used by both `/api/train` and the retry route
- `app/api/models/[id]/retry/route.ts` — retrain: re-roll / switch engine / new photos
- `components/RetrainPanel.tsx` — retrain UI (engine picker + reuse/upload photos)
- `lib/photoUpload.ts` — client signed-URL photo upload helper (shared by NewModelForm + RetrainPanel)
- `app/api/edit/route.ts` — all five studio edit modes
- `components/studio/StudioTools.tsx` — studio UI (tool tabs, uploads, mask editor, garment manager)
- `app/(dashboard)/photos/page.tsx` — "All photos" library across all models + studio edits (filter by `kind`)
- `lib/storage.ts` — Supabase Storage signed upload URLs
- `lib/credits.ts` — getBalance / deductCredits / addCredits, wraps `@aionized/platform-client`'s `core.wallets` RPCs (brand `mypix`) — not raw Supabase RPCs directly, since 2026-07-04
- `app/api/webhooks/astria/route.ts` — training completion webhook (for when you set up ngrok / deploy)
- `app/api/models/[id]/refresh/route.ts` — polling fallback
- `components/NewModelForm.tsx` — photo upload + training kickoff
- `components/GenerateSection.tsx` — prompt input + image gallery
- `components/TrainingProgress.tsx` — auto-refreshing training state UI
- `supabase/migrations/001_initial.sql` (and friends) — **retired**, describes the old standalone project's schema; not applied anywhere live. Current schema: `product-image-tools/supabase/migrations/0009_onboard_mypix_schema.sql` (`mypix.*`) + shared `core.*`

---

## Astria notes
- Base tune ID: `1504944` (FLUX.1 dev), overridable via `ASTRIA_BASE_TUNE_ID`.
  Point it at a newer base (e.g. a FLUX.2 base) once Astria publishes its gallery
  id — no code change. Verify at astria.ai if model IDs change.
- Trigger token: `ohwx person` (auto-prepended to all generation prompts).
- Portrait preset (`flux-lora-portrait`) — best for face identity preservation.
- Webhook payload: `{ tune: AstriaTune }` with `trained_at` set on success.
- Quality flags wired into generation (`lib/astria.ts`): `face_swap`,
  `inpaint_faces`, `hires_fix`, `color_grading` (`Film Velvia` | `Film Portra` |
  `Ektar`). `inpaint_faces`/`hires_fix` require `super_resolution`, which the
  client auto-enables. Per-request overrides in `/api/generate`; env defaults
  `ASTRIA_FACE_SWAP` / `ASTRIA_INPAINT_FACES` / `ASTRIA_HIRES_FIX` /
  `ASTRIA_COLOR_GRADING`. `color_grading` defaults off in all presets — the enum
  is unverified against a live generation and a wrong value 422s, so opt in
  explicitly once confirmed (same caution as the realism-LoRA env gate).

### Tune expiration (`Tune <id> has expired`)
Astria deletes a fine-tune — weights, training images, prompts, generated images
— roughly **30 days after training completes**, unless the tune was created with
`auto_extend` (a **paid** per-tune Astria add-on). Generating or editing against
a deleted tune returns `422 {"base":["Tune <id> has expired."]}`.

- **Prevention (opt-in):** `ASTRIA_AUTO_EXTEND=true` sets `auto_extend` on every
  new tune in `createTune`/`createGarmentTune`. Off by default — auto-extending
  every tune forever adds ongoing Astria cost, which fights the pay-as-you-go
  model, so it's a deliberate per-deployment choice.
- **Detection:** `lib/astria.ts` throws a typed `AstriaTuneExpiredError` (carrying
  the tune id parsed from the 422) from `generateImages`/`editImage`.
- **Handling:** `/api/generate` and `/api/edit` catch it, **refund** the request's
  credits, flag the owning model `status='expired'` (best-effort — matched by
  `astria_tune_id` in the edit route so it also covers try-on garment tunes), and
  return a clear `409 { code: "model_expired" }`.
- **Recovery:** the deleted weights are gone — the model must be **retrained**.
  Uploaded photos live in our own Storage bucket (independent of Astria), so the
  model detail page shows an "expired → Retrain model" state that re-runs training
  from the stored photos via `/api/models/[id]/retry` (which now accepts
  `expired`). Requires migration `006_model_expired_status.sql` (adds `expired`
  to the `models.status` check); the routes degrade gracefully until it's run.
- **fal note:** the fal LoRA URL (`fal_lora_url`) can also expire on fal's side;
  that surfaces as a generic error, not `AstriaTuneExpiredError`, and isn't yet
  given the same retrain treatment.

## Providers (two engines: Astria FLUX.1 + optional fal FLUX.2)
A model is **bound to one engine at creation** (`models.provider`, chosen in the
new-model form as **Standard** = Astria / **Ultra** = fal — the UI never names the
vendor or model). Training and generation both use that engine; generation
derives it from the model row, not from the client. The seam is `lib/providers.ts`.

- **Astria** (`lib/astria.ts`) — default/primary. FLUX.1 dev, identity + face tooling.
- **fal** (`lib/fal.ts`) — optional, env-gated on `FAL_KEY`, reaches **FLUX.2**.
  Inert until `FAL_KEY` is set; the "Ultra" tier is hidden in the UI and
  `getProvider("fal")` throws a clean 4xx otherwise (before any credits).

**Identity is not portable** — an Astria LoRA can't render on fal or vice versa,
so each engine trains its own LoRA. fal training ≈ $6.40/model vs Astria ≈ $1.50
(the app still charges the same `TRAINING` credits; the $ gap is on the fal bill).

**fal lifecycle** (mirrors the Astria polling flow):
1. `POST /api/models` stores `provider`. `POST /api/train` (fal branch): fetches
   all photos, builds a store-method zip (`lib/zip.ts`, no dependency), uploads
   it to the `mypix` bucket, and calls `falSubmitTraining` → stores
   `fal_request_id`, status `training`.
2. `/api/models/[id]/refresh` polls `falTrainingStatus`; on COMPLETED it writes
   `fal_lora_url` + status `ready`, on FAILED it refunds. No webhook needed locally.
3. `/api/generate` renders on the model's engine via `falGenerateFlux2`.

Requires migration `002_fal_provider.sql` (`provider`, `fal_lora_url`,
`fal_request_id`). **Live-verified end-to-end (2026-07-02)**: a real 100-step
training (zip → Supabase → fal → poll → LoRA) followed by a FLUX.2 generation
produced a real image, exercising the actual `lib/fal.ts` + `lib/zip.ts`. Field
names (`image_data_url`, `default_caption`, `output_lora_format`,
`loras[]`, `diffusers_lora_file.url`) are confirmed. Two gotchas found & handled:
fal's queue does **not** validate synchronously (bad input 200-enqueues then
FAILs on poll — our code treats FAILED as failure), and a sub-path model
(`fal-ai/flux-2/lora`) returns status/result URLs under the **parent** app path
(`fal-ai/flux-2/requests/...`), so we use fal's returned URLs, not reconstructed
ones. fal's queue wait can be several minutes before training even starts.

**Not yet done:** several pre-existing UI strings still name the vendor
("Sync from Astria", "Sent to Astria", landing-page "Powered by FLUX.1") — scrub
these if the engine must stay fully hidden. A fal training webhook (vs polling)
is optional, matching how Astria webhooks are optional locally.
