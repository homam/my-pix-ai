# Compose (multi-source composites) — launch handoff

> **For the next session.** Written 2026-10-06 at the end of the session that built and deployed
> the feature. Read this first, then [COMPOSITES.md](COMPOSITES.md) (design, spike numbers,
> runbook) and, for the original product brief,
> [MULTI_SOURCE_COMPOSITES_HANDOFF.md](MULTI_SOURCE_COMPOSITES_HANDOFF.md).
> Goal of the next session: take Compose from "deployed and verified" to "live for real users".

## Where things stand

| | State |
|---|---|
| Code | Commit `610eb4a` (+ this doc) on branch **`feat/multi-source-composites`** in `my-pix-ai`. **Not merged to `main`, not pushed.** `main` is at `63daa6c` (the global CSS cascade-layer fix), so the branch fast-forwards. |
| Migration | `product-image-tools/supabase/migrations/0028_mypix_composites.sql`, commit `e25e392` on branch **`mypix-composites-0028`** in `product-image-tools` — not merged, not pushed. **Already applied** to the shared project (`jrzaobtnunduxkzkgtbx`) as `0028_mypix_composites` + `0028b_mypix_composites_one_active_job`. ⚠️ That branch was left checked out in the shared `product-image-tools` folder, and **another session committed `8dcac44` (Dressing Room 0035, also applied live) on top of it**. So the branch is `main` (`196b25b`) + `e25e392` + `8dcac44`; merging it lands both, which is correct. Don't rewrite it, and check whether that other session is still working in the folder before switching its checkout. |
| Production | **Deployed 2026-10-06 to both brands** via `scripts/deploy.sh` from the branch's working tree: `my-pix-ai` → https://wy7kp3ie3e.eu-central-1.awsapprunner.com, `glowshot` → https://pyt65zu7sr.eu-central-1.awsapprunner.com. Preflight 67/68 (1 skip = needs a target), `/api/health` all green incl. `imaging:sharp`, smoke 19/19 on each brand with its own test account. The CSS fix `63daa6c` went out in the same deploy. |
| Runtime env | Both services have `ANTHROPIC_API_KEY` (MyPix key from Homam, also in local `.env.local`) and `FAL_KEY`, so Compose is **on for both brands** with fal `nano-banana-pro/edit` at native 4K and the Claude review. The fal webhook uses the existing `ASTRIA_WEBHOOK_PUBLIC_URL` + `ASTRIA_WEBHOOK_SECRET` — nothing extra to set. |
| Real users | **None can use it yet**: see blocker 3 (no way to buy credits in production). |

### Verified vs. not verified

- **Verified live (real fal + Claude, through the UI, local server on the shared project):** a 4-photo
  group with a must-preserve detail (kept, confirmed by the review); a 2-photo + 89-second
  1080×1920 MOV group (9 timestamped frames, native 5504×3072); a "Fix this" area correction
  v1 → v2 that the review passed. One real fal 422 "could not generate images" → refunded, which
  is why the free automatic resubmission exists.
- **Verified with the mock engine (smoke 11–18 + 17b):** upload → job → All photos → correction →
  two versions; idempotent charge; refund exactly once; transient-failure resubmission; owner-only
  media; direct table writes denied; delete removes rows, gallery entries and private media.
- **Review eval** (`npm run eval:review`, 4 fixtures): all expectations hold — run twice, once with
  the production key.
- **Never run in production with the paid provider.** Never run: a 15-photo group, a real iPhone
  HEVC `.MOV` (the test clip was H.264 built from frames), a **move** correction end to end in the
  app with real photos (the move technique itself is proven in the spike and by the eval), the fal
  **webhook** (local dev has no public URL; it is only a nudge — polling works without it).

## The path to live — in order

### 1. Land the code (decision: Homam)

Production runs code that exists only on local branches. **A deploy from `main` today would remove
Compose from production** (DB and stored media are unaffected; projects would just be unreachable).

```bash
cd ~/dev/ts/products/my-pix-ai && git checkout main && git merge --ff-only feat/multi-source-composites && git push
cd ~/dev/ts/products/product-image-tools && git checkout main && git merge --ff-only mypix-composites-0028 && git push
# fast-forwards main to 8dcac44: brings 0028 (this feature) AND 0035 (Dressing Room, another
# session's commit on the same branch). Both are applied live. Untracked 0024/0025 hearth files in
# that folder belong to another session too — leave them alone.
```

Pushing `my-pix-ai/main` triggers `.github/workflows/verify.yml` (typecheck + unit + preflight for
both brands). Hourly production smoke runs from `main` too — once merged, it exercises composite
steps 11–13 and 18 against production every hour (render steps skip on the paid provider).

### 2. Prove it in production (≈ $2 of fal + Claude)

Use real originals (Homam's session photos — not the downscaled fixtures in this repo):

1. A **15-photo** group (the handoff's acceptance case) — check selection picks ≤ 10 and the render saves.
2. A **real iPhone HEVC `.MOV`** in Safari and in Chrome on macOS (Firefox must show the HEVC message).
3. The **coastline correction**: render the coastline group; if the review flags sun/reflection,
   press *Fix this* (it pre-fills a *move*) and confirm v2 aligns (spike measured 0.0% residual).
4. Confirm the **webhook** arrives — after any render:

```bash
aws logs filter-log-events --region eu-central-1 \
  --log-group-name /aws/apprunner/my-pix-ai/5e1e4dbfbd034093b68a587a30c27366/application \
  --filter-pattern '"webhook_advanced"' --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --query 'events[].message' --output text
# glowshot: /aws/apprunner/glowshot/a53183f6b6a04aab87fc0afcbae0c808/application
```

   `bad_signature` there means the HMAC secret differs between submit and callback; absence means
   fal is not calling back (polling still finishes jobs).

Credits for the tester's own production account (there is no purchase path yet — see 3):

```sql
select id from auth.users where email = '<tester email>';
select core.grant_credits('<uid>'::uuid, 'mypix', 50, 'comp', 'compose launch test');
```

The account must belong to the brand's entity (mypix → entity1, glowshot → entity2) or every
wallet call fails `ENTITY_MISMATCH`.

### 3. Blockers that are not about Compose itself

- **No purchase path in production.** Neither App Runner service has `STRIPE_*` env vars, so
  `/pricing` renders display-only packs and `DEV_GRANT_CREDITS=false`; credits arrive only by admin
  grant. This is product-wide (training and generation too), but Compose cannot have real users
  until payments are on (Stripe keys + price ids, or the DCB adapter — see CLAUDE.md "Auth &
  payments are brand-scoped capabilities").
- **Legal / privacy sign-off (Homam).** Photos and video stills go to fal (Gemini 3 Pro Image runs
  on Google) and previews to Anthropic. The original handoff makes provider rights/retention
  approval a Phase 3 gate. Proposed privacy-page edits (`app/(legal)/privacy/page.tsx`), not
  applied — legal copy is Homam's call:
  - §2 "Photos you upload" → "**Photos and videos you upload** — used solely to train your personal
    AI model and to perform the edits and composites you request. Videos are read in your browser;
    we keep the stills taken from them and, when under 50 MB, the original file."
  - §4 "AI training and image-generation infrastructure" → "AI training, image-generation **and
    image-analysis** infrastructure".
  - §5 add: "Deleting a composite deletes its uploads, video stills and every version." (true:
    `DELETE /api/composites/[id]`; account deletion also clears the private bucket since `610eb4a`.)
- **Brand scope.** Compose is on for glowshot as well (both services have `FAL_KEY`). To hide it on
  one brand: add `COMPOSITE_PROVIDER=off` to that service's runtime env (merge into the existing
  map — `aws apprunner update-service` replaces the whole `RuntimeEnvironmentVariables` object).

### 4. Gaps to close before inviting real users (engineering)

Ordered by risk. None was in the original MVP list; all are real.

1. **Free storage via uploads.** Registering sources and uploading cost nothing; only renders are
   charged. Nothing caps a user's total groups, sources or bytes, and **draft groups never expire**.
   Add: a per-user cap (e.g. 20 open drafts / 2 GB in `mypix-composites`), and a cleanup of drafts
   with no versions older than N days (delete via the same path as `DELETE /api/composites/[id]`).
2. **Refunds depend on someone looking.** A job advances only when its owner polls or fal calls
   the webhook. A job whose tab closed AND whose webhook failed stays charged until the owner opens
   the project again. Add a periodic sweeper (App Runner has no cron: an EventBridge schedule →
   `POST /api/internal/composites/sweep` with a shared secret, or a Supabase `pg_cron` job calling
   it) that runs `advanceJob` on every active job older than ~5 minutes. The support queries in
   COMPOSITES.md "Support runbook" find such jobs today.
3. **Cost visibility.** fal spend is shared with the Ultra engine and has no alert; Anthropic spend
   is per review (~$0.05). Add a fal balance/spend alert and a CloudWatch metric filter on
   `composite_job_submitted` / `composite_provider_failed` / `composite_refunded` /
   `composite_reviewed` (log lines are JSON). The handoff's Phase 3 "review failure/latency
   metrics" has nothing to look at yet — this is it.
4. **Rate limits.** No per-user limit on render submits beyond credits and one active job per group.

### 5. Product polish (nice to have)

- Discoverability: Compose lives only as a Studio tab. Landing page, `/pricing` (doesn't mention the
  5-credit cost) and the sidebar don't mention it.
- **HEIC** photos are rejected with a message; iPhone defaults to HEIC. Client-side conversion
  (e.g. `heic2any`) or a server decode would remove the most common first-run failure.
- **Firefox + HEVC** cannot extract frames. Fallback: upload the clip and extract server-side
  (fal's ffmpeg endpoints, or a worker) — needs the 50 MB object cap raised.
- **Original videos over 50 MB are not stored** (frames are). Raising Supabase's global upload
  limit (Storage settings, Pro plan) + `COMPOSITE_MAX_STORED_VIDEO_MB` keeps them.
- Text-only corrections are unreliable for *moving* things (spike); the UI already nudges users to
  mark the element. An *area* correction removed most of an extra-dot chain but left a faint trace.
- The review is stochastic (e.g. `invented_content` flips between uncertain and fail across runs);
  grow the eval beyond 4 fixtures with consented images before tuning its prompt.
- A CI job that runs the full smoke against a mock-engine dev server would cover steps 14–17b on
  every push (today they only run locally).

## Where everything is

- **Design + runbook:** `docs/COMPOSITES.md`. Short version in `CLAUDE.md` → "Multi-source composites".
- **Server:** `lib/composite/` — `jobs.ts` (start / advance / finalize / review / refund-once /
  resubmit), `provider.ts` (fal + mock engines), `review.ts` (Claude), `imaging.ts` (sharp),
  `storage.ts` (private bucket), `view.ts`, `config.ts`, `schemas.ts`, `http.ts`, and the pure,
  unit-tested `selection.ts`, `prompt.ts`, `dimensions.ts`, `states.ts`, `errors.ts`.
- **Browser:** `lib/composite/client/` (decode, dHash, sharpness, frames, XHR uploads, API).
- **Routes:** `app/api/composites/**`, `app/api/webhooks/fal-composite`, page
  `app/(dashboard)/studio/composites/[id]`.
- **UI:** `components/studio/compose/` (`ComposeTool`, `GroupDraft`, `CompositeProject`,
  `MarkableImage`, `parts`); `StudioTools.tsx` tab; `AllPhotosGallery.tsx` composite handling.
- **Verification:** `verify/src/composite.unit.test.ts`, smoke steps 11–18 + 17b in
  `verify/src/smoke.spec.ts`, `verify/src/review.eval.ts` (+ `vitest.review-eval.config.ts`),
  private-bucket rule in `verify/src/diagnose.ts`, `imaging:sharp` + bucket checks in
  `app/api/health/route.ts`.
- **Infra facts:** AWS account `178269041738`, region `eu-central-1`; service ARNs
  `…:service/my-pix-ai/5e1e4dbfbd034093b68a587a30c27366` and
  `…:service/glowshot/a53183f6b6a04aab87fc0afcbae0c808`. Bucket `mypix-composites` (private, MIME
  allow-list, 50 MB global object cap). Smoke accounts: `demo@mobilesparkcreations.com` (mypix,
  405 credits after this session) and `verify+glowshot@mobilesparkcreations.com` (glowshot, 500).

## How to run and check locally

```bash
npm run dev            # real fal + Claude (costs money per render); port 4871
# free engine for UI work and the full smoke: launch config "my-pix-ai (mock composites)"
#   = COMPOSITE_PROVIDER=mock COMPOSITE_REVIEW=off npm run dev
npm run typecheck && npm test
npm run preflight
npm run smoke          # against localhost; 19/19 with the mock engine
REVIEW_FIXTURES=verify/fixtures/private/review/manifest.json npm run eval:review   # ≈$0.20
```

`verify/fixtures/private/` is **git-ignored** and holds downscaled copies of Homam's session
photos: `review/` (eval fixtures + `manifest.json`) and `ui/` (the light-spots photos, two sunset
photos and `IMG_3150.MOV`, an 89 s H.264 clip built from the session's frames — not a real iPhone
HEVC file). Never commit them. The originals behind the session live in
`~/Documents/Codex/2026-10-06/f/` (contact sheets, frames, the session's 4K outputs).

Signing in locally without a password: the smoke's `mintSession` + `sessionCookieHeader`
(`verify/src/session.ts`) mint a cookie for the test account; `/api/dev/grant-credits` tops it up
locally (`DEV_GRANT_CREDITS=true` only in `.env.local`).

## Gotchas learned the hard way

- **Hot reload can pair a new route with an old module.** A correction submitted mid-refactor
  reached fal with no prompt and no images (a 422). The fal engine now refuses an empty request,
  but restart the dev server after changing `lib/composite/jobs.ts`'s contract.
- **fal 422 bodies echo the whole prompt.** Never show provider errors raw — `errors.ts`
  `classifyProviderError` maps them; the raw body is in the `composite_provider_failed` log line.
- **`update-service` replaces the whole runtime env map.** Read it, merge, write it back.
- **Signed upload URLs work on the private bucket with no storage policies** (verified); public
  URLs answer 400 there. Objects over 50 MB are rejected 413 by the project-wide cap.
- **The global `* { border-color }` rule** used to override every Tailwind border colour; fixed in
  `63daa6c`, which is why Compose styles selection with `ring-*` and inline colours.
- **Playwright MCP** can only read and write files inside the repo directory; stage fixtures under
  it and delete the `.playwright-mcp/` folder it leaves behind.

## Test data left in the shared project

- Two live projects on `demo@mobilesparkcreations.com` (mypix): "Sunset light spots"
  (`e8eff0e5-…`, 1 version) and "Second sunset with video" (`685bc456-…`, v1 + v2). Real renders
  of Homam's photos — keep as demo material or delete via the project page.
- 500 dev credits were granted to that account during testing (`Dev grant (+500)`).
