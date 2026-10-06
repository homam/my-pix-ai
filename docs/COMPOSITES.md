# Multi-source composites

> Implements [MULTI_SOURCE_COMPOSITES_HANDOFF.md](MULTI_SOURCE_COMPOSITES_HANDOFF.md) (the
> 2026-10-06 session). Studio → **Compose**: drop several photos of one scene (plus an optional
> video) into a group, get one wide composite per group, check it, and ask for targeted
> corrections that are saved as new versions.

## The user journey

1. **Studio → Compose.** One or more *groups*; each group = one scene = one composite.
2. **Drop media.** JPEG/PNG/WebP photos and at most one MOV/MP4 per group. Everything is read
   **in the browser first**: photos are decoded (EXIF orientation applied) and get a ≤2048 px
   reference copy, a 64-bit difference hash and a sharpness score; a video is decoded by the
   browser and stills are drawn at timestamps (an 89 s clip → 0:00, 0:10 … 1:20, like the session).
3. **Contact sheet.** Automatic selection picks a small, varied set (anchor first, near-duplicates
   and blurry stills dropped, target 6, hard cap 10). Every badge — *Anchor*, *Near-duplicate*,
   *Soft*, *Over the limit* — can be overridden with one click; a still the user turns on is
   *kept* and automatic re-selection never drops it.
4. **Scene priority** ("keep the harbor geometry") and **must preserve** ("the two light spots
   above the sun") are optional; the default look is *faithful to photos*.
5. **Generate** — one button renders every ready group; the price is shown before submitting.
   Rendering is asynchronous (40–60 s); the page polls, and the user may leave.
6. **Review.** Every version is checked by a vision model against its sources: duplicates,
   seams, horizon, light vs. reflection, foreground geometry, invented content, and whether each
   must-preserve detail survived. Uncertain is flagged, never hidden.
7. **Correct.** A plain-language instruction, optionally pointing at the image — *mark what's
   wrong* (red circle) and *where it should go* (green). Each review issue has **Fix this**,
   which pre-fills the instruction and the marks. The result is a new child version; every
   earlier version stays downloadable.
8. **Download.** The native render, with its real dimensions; when the native render is below
   4K, also a 4K-dimension export that is labelled as upscaled everywhere it appears.
9. **All photos** lists every version (kind `composite`) and links back to its project.

## Provider spike — 2026-10-06 (Phase 1 exit evidence)

The session's original 24-MP photos were not on this machine; inputs were cut from the session's
labelled contact sheets (photos at 266–480 px) plus its full-resolution 1080×1920 video frames,
and the session's own first coastline render (the one with the sun/glint error) as the
correction target. All calls through fal's queue API.

| Task | nano-banana-pro (Gemini 3 Pro Image) | nano-banana-2 (Gemini 3.1 Flash Image) | Seedream 4.5 |
|---|---|---|---|
| Light spots (4 photos) | ✅ one wing, one sun, both spots kept · 2752×1536 @2K · 38 s | ✅ same · 22 s | ❌ six tiled strips: 4 wings, 3 suns, seams |
| Video group (2 photos + 3 frames) | ✅ faithful coastline · **5504×3072 native @4K** · 47 s | ⚠️ invented a river, recomposed · 54 s | ❌ tiled strips with seams |
| Correction, text only | sun/glint gap 8.0% → 5.0% of width | 8.0% → 2.7% | "fixed" by moving the glint and recomposing the harbor |
| Correction, explicit % | 6.3% (worse) | 7.5% (no change) | — |
| Correction, red/green guide | 5.0% | aligned by moving the glint instead | — |
| **Correction, transplant + cleanup** | **0.0%**, harbor intact | **0.0%**, harbor intact | — |
| Price (fal, 2026-10-06) | $0.15/image, 4K = $0.30 | $0.08/image | $0.04/image |

Decisions that follow:

- **Provider: `fal-ai/nano-banana-pro/edit` at native 4K** (`COMPOSITE_MODEL` /
  `COMPOSITE_RESOLUTION` override without a code change). It was the only model that kept the
  user-marked detail AND the real geography, and its 4K output is native — so for the default
  configuration the "upscaled to 4K" export simply does not exist. Seedream is rejected outright.
- **Generative editors cannot be trusted to move things.** Text, percentages and drawn guides
  all left the sun where it was or moved the wrong thing. What both Gemini models do perfectly is
  *remove a marked leftover*. So a **move correction** is split: the app pastes a feathered patch
  of the element at the user's target position itself (`lib/composite/imaging.ts transplant`,
  exact pixels), and the provider only repaints the leftover inside a red guide circle. Measured
  residual offset: 0.0% on both models.
- Real-run finding: nano-banana-pro sometimes answers **422 "Could not generate images with the
  given prompts and images"** on inputs it rendered before. That class gets **one free automatic
  resubmission**; content-policy and oversized-input failures do not (`lib/composite/errors.ts`).

### Live run through the app — 2026-10-06

Driven through the real UI (Chrome 154, local dev server against the shared project, fal +
Claude live):

| Group | Inputs | Result |
|---|---|---|
| Sunset light spots | 4 photos; must preserve "the two red-orange light spots above the sun" | v1 **5504×3072 native**, ~70 s render + 22 s review. One wing, one sun; the spots → *preserved*. Flagged (low): ground detail sharper than the hazy photos |
| Second sunset with video | 2 photos + 89 s 1080×1920 MOV → 9 frames → 1 photo + 5 frames selected | First attempt: fal 422 "could not generate images" → refunded (this is what added the automatic resubmission). *Render again*: v1 **5504×3072 native**. Flagged (medium): "a chain of extra small orange dots, more than the two in the photos" at (0.62, 0.22) |
| ↳ correction via **Fix this** | area mode, red circle pre-placed on the dot chain | v2 from v1, review **passed** incl. `correction_applied`. By eye: two clear dots as in the photos; a very faint third trace remains |

## Automatic review (Claude)

`lib/composite/review.ts` — `claude-opus-5-5`, structured output, server-side refusal fallback
(`fallbacks: "default"`), effort `medium` (`COMPOSITE_REVIEW_EFFORT`), 85 s timeout. It returns
per-check pass/fail/uncertain, a status per must-preserve detail, and issues with 0–1 coordinates
of the wrong element and, for a misplaced one, of where it belongs — which is what lets **Fix
this** pre-fill a move. Descriptions are neutral: it never names a cause for an optical effect.

Measured with `npm run eval:review` on the spike fixtures (12–19 s each, ≈$0.05 each):

| Fixture | Result |
|---|---|
| Session coastline render (sun not above its glint) | `light_reflection: fail` — issue at (0.35, 0.14) → (0.28, 0.14); pixel measurement was sun 0.352 / glint 0.273 |
| Seedream tiling | `duplicate_elements: fail`, `seams: fail` — "wing and engine repeated four times", "sun appears more than once" |
| nano-banana-pro light-spots render | `duplicate_elements: pass`; "the two red-orange light spots above the sun" → **preserved** |
| Transplant correction of the coastline | all pass, `correction_applied: pass` |

The review never blocks a version. It labels it *passed*, *flagged* or *unavailable* (no key,
timeout, refusal), and the UI tells the user what to look at in the last case. Env-gated:
on with `ANTHROPIC_API_KEY`; `COMPOSITE_REVIEW=off` disables it.

## Architecture

```
browser ── decode, hash, frames ──► POST /api/composites/[id]/sources   (validate media, mint signed upload slots)
        ── PUT bytes ─────────────► private bucket mypix-composites       (no storage policies at all)
        ──────────────────────────► POST …/sources/complete              (believe storage, not the browser)
        ──────────────────────────► POST …/render  {idempotencyKey}     insert job → charge → sign inputs → fal queue
        ── every 4 s ─────────────► GET /api/composites/jobs/[id]        poll fal → save version → review   (one heavy step per call)
fal ── on completion ─────────────► POST /api/webhooks/fal-composite    same advance, as a nudge (payload ignored)
        ──────────────────────────► POST /api/composites/versions/[id]/correct   text | area | move → child version
        ──────────────────────────► GET /api/composites/media/{version|source}/[id]   owner check → 302 to a 15-min signed URL
```

**Nothing waits for a render inside a request.** App Runner cuts requests at 120 s and a 4K
render takes 40–60 s, so the provider's queue is the worker: submitting returns at once, and
each poll (or webhook) advances the job one heavy step — saving a version, or reviewing it — with
a lease so two concurrent polls can never save one result twice.

**Why the browser decodes video** (the handoff asked for a background worker): App Runner has
no worker tier, and an 89-second phone clip is ~100 MB — above the shared Supabase project's
**50 MB per-object cap** (measured: a 51 MB upload is rejected `413`). Decoding locally shows
candidate frames before anything is uploaded. Cost: codec coverage — HEVC `.MOV` decodes in
Safari and in Chrome/Edge on macOS (verified in Chrome 154), not in Firefox, which gets a
specific message. A video over `COMPOSITE_MAX_STORED_VIDEO_MB` (default 50) keeps its metadata
and frames; its original is not stored, and the UI says so. To keep large originals, raise the
project's upload limit (Supabase → Storage settings, Pro plan) and the env var together.

## Data model — platform migration 0028

`product-image-tools/supabase/migrations/0028_mypix_composites.sql` (applied 2026-10-06, plus
`0028b` — the one-active-job index).

| Table | Holds |
|---|---|
| `mypix.composite_groups` | name, status, scene priority, must-preserve list, style, aspect, anchor, current version |
| `mypix.composite_sources` | `photo` / `video` / `frame` (frame → parent video + timestamp), original name/type/size/dimensions, sequence, original path (nullable), reference path, sharpness, dHash, selected/pinned |
| `mypix.composite_jobs` | render or correction; idempotency key (unique per user); mode, instruction, marks; provider/model/request handles; exact prompt and references; `cost_credits`, `charged_at`, `refunded_at`; lease; input paths and attempts |
| `mypix.composite_versions` | version number, parent version, kind, prompt, instruction, references, provider, native path/mime/dimensions/bytes, preview, export, review |
| `mypix.generated_images` | + kind `composite`, + `composite_version_id` (cascade) for All photos |

**Privileges.** `authenticated` gets `SELECT` (RLS: own rows) on the four tables and nothing
else; every write goes through app routes with the service-role client and the session's user
id — so nobody can clear `refunded_at` for a second refund or point a job at someone else's
media. The preflight asserts the UPDATE grant equals the RLS-client write set (empty here) and
the smoke proves a direct PATCH is denied. **One active job per group** is a partial unique
index, mapped to `409 job_running`.

**Storage** (`mypix-composites`, private, MIME allow-list):
`{userId}/composites/{groupId}/originals|refs|frames|renders|exports|work/…`. Paths are always
built server-side from the session user id; a stored path is re-checked against that tree before
it is signed (`isOwnCompositePath`). The image provider gets 6-hour signed URLs; browsers get
1-hour (page) or 15-minute (media route) ones. The preflight fails if this bucket is ever public;
`/api/health` reports it too, and also proves sharp loads in the container (`imaging:sharp`) —
the deploy gate's smoke skips renders on the paid provider, so this is what catches a broken
native binary. Account deletion clears the user's tree in this bucket as well as in `mypix`.

## States

`draft → uploading → preparing → ready_to_generate → queued → generating → review → complete`,
with `failed` and `cancelled` terminal (`lib/composite/states.ts`). The group mirrors its newest
active job and settles on `complete` once it has a version. A correction is a new job on an
existing version and never rewrites it.

## Money

`CREDIT_COSTS.COMPOSITE = 5` per render or correction (ledger reason `composite`). At $0.118–
$0.18 per credit that is $0.59–$0.90 against ≈$0.35 of cost (4K render $0.30 + review ≈$0.05).
Charged once, when the job is accepted (insert → charge → submit); a retried click with the same
idempotency key gets the first job back without a second charge. A failed or cancelled job is
refunded **exactly once** — `refunded_at` flips from null only for the caller that wins the
conditional update, and the grant runs only then (proved by smoke step 17). The automatic
resubmission is free (smoke step 17b).

## Environment

| Var | Effect |
|---|---|
| `FAL_KEY` | Composites on (fal). Absent → Compose is hidden, routes answer 503 |
| `COMPOSITE_PROVIDER` | `off` · `mock` (dev/CI only; refused in production builds unless `COMPOSITE_ALLOW_MOCK=1`) |
| `COMPOSITE_MODEL` / `COMPOSITE_RESOLUTION` | default `fal-ai/nano-banana-pro/edit` / `4K` |
| `ANTHROPIC_API_KEY` | Automatic review on; `COMPOSITE_REVIEW=off` disables; `COMPOSITE_REVIEW_EFFORT` |
| `COMPOSITE_WEBHOOK_PUBLIC_URL` (else `ASTRIA_WEBHOOK_PUBLIC_URL`) + `COMPOSITE_WEBHOOK_SECRET` (else `ASTRIA_WEBHOOK_SECRET`) | fal webhook nudges; without them, polling alone finishes jobs |
| `COMPOSITE_MAX_PHOTOS`, `COMPOSITE_MAX_STORED_VIDEO_MB`, `COMPOSITE_MAX_VIDEO_SECONDS` | caps (30 / 50 / 600) |

## Verification

```bash
npm test                     # selection, prompts, dimensions/labels, states, review verdict, error mapping
npm run preflight            # new tables per role, UPDATE grants (none), bucket exists AND is private
npm run smoke                # steps 11–18 (+17b): the composite journey (full render path needs the mock engine)
REVIEW_FIXTURES=…/manifest.json npm run eval:review   # paid, opt-in: the review against known-defect fixtures
```

Smoke against a local server with the free engine: start the **"my-pix-ai (mock composites)"**
launch configuration (`COMPOSITE_PROVIDER=mock COMPOSITE_REVIEW=off npm run dev`), then
`npm run smoke`. Against a deployment with the paid provider, steps 11–13 and 18 run (upload,
HEIC rejected, private bucket, owner-only media, direct writes denied, delete) and the render
steps are skipped unless `VERIFY_COMPOSITE_RENDER=1` asks for a real ≈$1 run. The smoke account
needs ≥15 credits for the full journey.

## Support runbook

```sql
-- A user's recent composite jobs, newest first
select j.id, j.kind, j.status, j.error, j.cost_credits, j.charged_at, j.refunded_at,
       j.options->>'attempts' as attempts, j.created_at, g.name
from mypix.composite_jobs j join mypix.composite_groups g on g.id = j.group_id
where j.user_id = '<uid>' order by j.created_at desc limit 20;

-- Charged, failed, never refunded (should be empty; the refund grant failed after the claim was released)
select id, user_id, cost_credits, error from mypix.composite_jobs
where status in ('failed', 'cancelled') and charged_at is not null and refunded_at is null;

-- Stuck: active for more than 25 minutes (a poll or webhook fails them at 20)
select id, user_id, status, submitted_at from mypix.composite_jobs
where status in ('queued', 'generating', 'review') and created_at < now() - interval '25 minutes';
```

- **Stuck job:** any GET of `/api/composites/jobs/<id>` as the owner advances it; past 20 minutes
  it is cancelled at the provider, failed and refunded. A job stuck in `review` completes as
  *unavailable* when the reviewer times out.
- **Missing refund** (second query non-empty): grant manually with
  `select core.grant_credits('<uid>', '<brand>', <cost>, 'Refund (composite: support)', null);`
  then `update mypix.composite_jobs set refunded_at = now() where id = '<job>';`.
- **Logs** (JSON lines): `composite_job_submitted`, `composite_provider_failed` (raw provider
  body), `composite_job_resubmitted`, `composite_version_saved`, `composite_reviewed`,
  `composite_refunded`, `composite_refund_failed`.

## Acceptance checklist (handoff) — status

| Item | Status |
|---|---|
| Two groups, media in each, exactly one initial composite per group | ✅ UI-driven, mock and live (fal) |
| 15 JPEGs succeed; 3 JPEGs + 89 s portrait MOV shows timestamped frames and succeeds | ✅ MOV (H.264 .MOV built from the session's frames): 9 timestamped frames, live 4K render. ⚠️ Not yet run: a 15-photo group and a real iPhone HEVC file — the session's originals were not on this machine; caps allow 30 photos |
| Marked detail kept or clearly flagged | ✅ live: "the two red-orange light spots above the sun" → *preserved*; extra dots in the video group → *flagged* |
| Correction creates a new version; old version downloadable | ✅ smoke 16 + live correction v1 → v2 |
| Review flags duplicated suns/wings, seams, sun/reflection misalignment | ✅ `eval:review`, 4/4 fixtures |
| Native dimensions shown; resized exports identified; never "native 4K" | ✅ unit-tested labels; UI shows both files with dimensions before download |
| Owner-only originals/frames/status/versions/exports; failed job refunded exactly once | ✅ smoke 13 + 17 |
| Authenticated smoke: upload → queued job → All photos → correction → two versions | ✅ smoke 11–18 (19/19 passing, incl. 17b: transient failure resubmitted once, charged once) |

## Before launch (Phase 2/3 gates — not done here)

- **Product, privacy and provider terms sign-off.** Photos go to fal (and from fal to Google)
  and previews to Anthropic. Retention/rights terms of both need approval before release.
- **Production env — done 2026-10-06:** `ANTHROPIC_API_KEY` (a MyPix key) is set on both App
  Runner services (`my-pix-ai`, `glowshot`). The fal webhook needs nothing new: both services
  already carry `ASTRIA_WEBHOOK_PUBLIC_URL` + `ASTRIA_WEBHOOK_SECRET`, which
  `compositeWebhookUrl()` falls back to. **The composites code itself is not deployed yet.**
  Once it is, composites switch on wherever `FAL_KEY` is set (both services today) — set
  `COMPOSITE_PROVIDER=off` on a brand that should not have them yet.
- **Live 15-photo and real-HEVC runs** with the session's original files, and a fixture set
  larger than four for the review eval.
- **Raise the 50 MB object cap** if original videos must be kept.
- Owner/QA assignments from the handoff's rollout table remain open.
