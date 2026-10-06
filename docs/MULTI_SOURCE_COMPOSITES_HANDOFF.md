# Multi-source photo composites — feature handoff

**Status:** proposal, based on the VLC–AMS session on 2026-10-06. No product code has been changed.

## Terms and user outcome

- **Source group:** one user-selected folder or collection of photos and videos that depict one scene. Each group produces one composite by default.
- **Representative frame:** a still extracted from a video and selected as an image input. The video itself is not sent to the image generator in this workflow.
- **Composite:** one coherent image that combines visual evidence from several sources. The AI version may synthesize pixels; it is not a geometrically exact panorama.
- **Version:** a saved render or correction of a composite. The original render and its source group remain available when a user asks for an edit.
- **Native resolution:** pixels returned by the image provider. **Export resolution** may be larger after resampling; resampling does not recover source detail.

**User outcome:** Upload several related photos, optionally a video, and receive one polished composite for each group. Then give a plain-language correction such as “the sun and reflection do not align” and receive a new version with the requested element fixed.

## What happened in the session

| Group | Inputs inspected | Inputs used for generation | Result |
| --- | --- | --- | --- |
| 1 — city | 7 portrait JPEGs | 5 photos spanning the city view | Wide aerial city composite |
| 2 — coastline | 15 portrait JPEGs | 5 photos spanning the coastline and harbor | Wide harbor composite; later corrected |
| 3 — first sunset | 11 portrait JPEGs | 5 photos spanning the sunset sequence | Wide sunset composite |
| 4 — second sunset | 3 JPEGs + one 88.9 s, 1080 × 1920 MOV | 2 photos + frames at 10, 40, and 70 s | Wide sunset composite using photo and video evidence |
| 5 — light spots | 4 portrait JPEGs | All 4 photos | Composite retaining the two red-orange spots above the sun |

The photos were 4284 × 5712. I listed each folder, checked dimensions and video metadata, made labeled contact sheets for selection, and extracted review frames from the video at 10-second intervals. I chose sources that covered the scene without sending every near-duplicate. The built-in image generator used here accepted at most **five reference paths per request**; treat that as a constraint of this session's tool, not an assumed limit of a production provider.

The generation instruction asked for a seamless, wide photographic view; specified the important subjects and lighting; and prohibited seams, duplicated landmarks, extra suns or wings, text, and watermarks. Folder 4's prompt identified the video frames as supporting sources. Folder 5's prompt explicitly preserved the two visible spots above the sun without relying on a diagnosis of what caused them.

The generated native images were about 1.7–2.1K pixels wide. I exported 4096-pixel-wide JPEGs by resampling. Those files have 4K dimensions but **not 4K native detail**. The product must display both dimensions and never label a resized output “native 4K.”

### The correction that exposed the main quality risk

The first coastline render placed the bright sun around 36% across the image while the land and water glint sat around 25%. The original photo `IMG_3102.jpeg` showed the light and glint aligned. I submitted the first render as the **edit target** and that original as a **supporting reference**, with a narrow instruction: move the sun/cloud opening above the existing glint, remove the old opening, and preserve the harbor, coastline, boats, and framing. The corrected image was saved as a new version.

**Product rule:** a composite is not finished merely because it looks attractive. Before presenting it as final, check relationships that should remain physically coherent: sun/reflection, shadows/light source, horizon, waterline, aircraft geometry, repeated buildings, and repeated people or objects. Let the user correct a specific region without starting the whole project again.

## Decision 1 — feature scope

### What needs to change

Studio currently works with one source image per edit. `SourcePicker` in `components/studio/StudioTools.tsx` takes one dropped file, `lib/uploadClient.ts` sends image files through `POST /api/upload`, and `POST /api/edit` supports one `sourceUrl` plus an optional mask. The existing Astria edit path does not implement multi-reference composition or video input.

### Required MVP behavior

1. Add **Compose** to Studio. Accept several photos and an optional MOV/MP4 video in one source group. Let users create multiple groups before submitting; default to one output per group.
2. Show a contact sheet per group. Extract candidate video frames and mark them as frames with timestamps. Let the user remove weak or duplicate inputs and choose an anchor photo/frame.
3. Offer two explicit controls: **scene priority** (for example, “keep the harbor geometry”) and **must preserve** (for example, “the two light spots above the sun”). Default to “faithful to sources.”
4. Generate a wide preview. Show the source thumbnails beside it. Ask for a specific correction in ordinary language; save each correction as a new version with the instruction and source references.
5. Offer the native render and a clearly labeled 4K-dimension export when native resolution is smaller. Show dimensions before download.
6. Put completed composites in **All photos** with a “Composite” filter and a link back to their source group and versions.

### Why this is high priority

The existing single-image Studio flow cannot reproduce the session. The correction step is essential: the most obvious error in the result was a physical inconsistency that a broad “make it better” prompt would not reliably fix.

## Decision 2 — processing pipeline

### Required sequence

1. **Ingest:** Upload files from the browser; the web product cannot read a user's local folder path directly. Keep each file's original name, type, dimensions, group, and sequence order. Reject unsupported media before any credit charge.
2. **Video preparation:** Decode video in a background worker, record duration/orientation, and extract timestamped candidate frames. The session used a 10-second review interval; the product can sample more densely around meaningful visual changes. Keep the original video separate from the frames.
3. **Selection:** Generate labeled contact sheets and choose a small, varied set of sharp, relevant references. Deduplicate near-identical frames. Preserve any user-selected anchor or marked detail even if an automatic ranking would drop it. Provider reference limits must be discovered and enforced per provider.
4. **Generation:** Build a structured prompt from the selected sources: scene, subject, composition, light, must-preserve details, and prohibited artifacts. Send the source images/frames to a provider that actually supports multiple references. The Codex built-in image tool used in the session is **not a production API for this app**.
5. **Review:** Inspect the result for content and geometry. At minimum, catch obvious duplicate suns/wings, seams, horizon shifts, and light/reflection misalignment. Flag uncertain cases for user review; do not silently invent or erase requested phenomena.
6. **Versioned correction:** Use the current composite as edit target, one or more original sources as evidence, and a narrow correction instruction. Preserve unaffected areas. Store the new render, parent version, instruction, and actual references used.
7. **Export:** Preserve the provider-native image. Any 4K export must be labeled “upscaled to 4K” unless it genuinely has native 4K detail. Do not promise print-size detail solely from pixel dimensions.

**Prompt contract used in the session (adapt the source count to the chosen provider):**

```text
Use case: compositing
Inputs: image 1 = anchor photo; images 2–N = supporting photos or timestamped video frames
Create one seamless, wide, photographic view of [scene].
Preserve: [landmarks, light, aircraft geometry, user-marked details].
Keep the viewpoint and colors faithful to the inputs.
Avoid: seams, repeated landmarks, extra suns/wings, invented objects, text, watermark.
```

For a correction, send the **current version as edit target** and an **original source as evidence**. Specify exactly what may change (“move the sun above the existing reflection and remove its old opening”) and what must remain fixed (“harbor, coastline, boats, crop”). Save the returned image as a child version rather than replacing the target.

### Execution constraints

- A render in this session took roughly 1–2 minutes. AWS App Runner has a 120-second request cap documented in `CLAUDE.md`; video extraction, rendering, and correction must run as asynchronous jobs with polling or progress updates, not one synchronous `/api/edit` request.
- Choose and test a production multi-reference image provider before implementation. Do not assume existing Astria `editImage` or the fal identity-generation path supports this request shape. Compare reference count, edit fidelity, native output size, latency, cost, and rights/retention terms using the actual API.
- Support at least the observed case of 15 photos in one group and an approximately 89-second portrait MOV. Set final file-size and duration caps after a cost/performance spike.
- Original travel photos and videos are user media. Use user-owned storage paths and verified authorization. Avoid exposing raw video publicly merely because the current `mypix` image bucket is public for Astria fetches; use a private staging location or short-lived signed access where the provider permits it.

## Decision 3 — repo integration and data contract

| Area | Required change |
| --- | --- |
| `components/studio/StudioTools.tsx` and `app/(dashboard)/studio/page.tsx` | Add Compose entry and group-based picker, preview, progress, and correction UI. No trained face model is required. |
| `app/api/upload/route.ts` / `lib/uploadClient.ts` | Extend or add a separate authenticated media upload path for multiple images and MOV/MP4, with type, size, and ownership checks. Keep existing training/edit uploads working. |
| New job API and worker | Create group, enqueue generation/correction, report status, and return version IDs. Use idempotency keys so retries cannot spend twice or create duplicate versions. |
| Storage | Use `userId/composites/{groupId}/originals`, `/frames`, `/renders`, and `/exports` or equivalent ownership-preserving paths. Keep originals and native renders distinct from upscaled exports. |
| Data | Add `composite_groups`, `composite_sources` (photo or video frame, with timestamp), `composite_jobs`, and `composite_versions` (parent, prompt, provider, native dimensions, export dimensions, status). Link a finished version to `generated_images` for the existing gallery. `source_image_id` alone cannot represent several source files. |
| Types/gallery | Add `composite` to `ImageKind` and the database `kind` constraint, update `types/index.ts` and `components/AllPhotosGallery.tsx`. Create live schema changes in the shared platform migration location, **not** this repo's retired standalone `supabase/migrations`. |
| Credits | Add a product-scoped composite cost after provider economics are measured. Charge per submitted render/correction only when the job is accepted; refund failed jobs through the existing service-role wallet path. Display the price before submission. |

Suggested states: `draft → uploading → preparing → ready_to_generate → queued → generating → review → complete`, with `failed` and `cancelled` terminal paths. A correction starts a new job linked to an existing version; it does not overwrite that version.

## Acceptance checklist

- [ ] A user can create two source groups, upload media to each, and receive exactly one initial composite per group.
- [ ] A group with 15 JPEGs succeeds; a group with 3 JPEGs plus an 89-second portrait MOV shows timestamped candidate frames and succeeds.
- [ ] The user can keep a marked detail such as the two spots above the sun; the preview preserves it or clearly flags that it failed.
- [ ] A correction like “align the sun with the existing reflection; keep the harbor unchanged” creates a new version, and the old version remains downloadable.
- [ ] The result review catches or flags duplicated suns/wings, visible seams, and gross sun/reflection misalignment on a small fixture set.
- [ ] Downloads show native dimensions and identify resized exports; a 4096-pixel export from a 1942-pixel render is never described as native 4K.
- [ ] Only the owner can read a group's originals, frames, job status, versions, and exports. A failed job refunds its charge exactly once.
- [ ] A new authenticated smoke journey covers upload → queued job → result in All photos → correction → two versions. Follow `docs/VERIFICATION.md` for the app's preflight and smoke gates.

## Rollout and accountability

**Assumption:** one engineer with design and product review available. Timelines start when a production provider and worker capacity are available.

**Assignment gate:** Homam provides product signoff and names an engineering owner and a design/QA counterpart before Day 1. The assigned people sign off on the standards below; a phase is not complete while its owner is unassigned.

| Phase | Deadline | Owner and signoff | Exit standard |
| --- | --- | --- | --- |
| 1 — provider/quality spike | Day 7 | Engineering owner; product signoff | Prove multi-reference + video-frame input, a targeted correction, native output dimensions, latency, and cost using the five session groups. Reject a provider that cannot preserve the user-marked detail or correct the sun/reflection case. |
| 2 — private beta | Day 14 | Engineering + design owners; QA signoff | Group upload, frame review, async jobs, versions, credit/refund behavior, ownership, and dimension labels pass the acceptance checklist on both brands. |
| 3 — launch standard | Day 30 | Product + engineering owners | Run the authenticated smoke journey, review failure/latency metrics, document support recovery for failed jobs, and release only after provider and privacy terms are approved. |

## What I would not rely on

- A single broad generation prompt as proof of geographic or physical accuracy. The first coastline render looked polished and still got the sun/reflection relationship wrong.
- Upscaling as a substitute for native detail. The session's 4K exports were resampled from smaller renders.
- The current one-source Astria edit route as a multi-source backend, or a long synchronous request on App Runner.
- Automatic naming of an optical phenomenon from a photo. Preserve what the user points to; use neutral visual descriptions when the cause is uncertain.
- Flattening corrections into the original render. Keep source lineage and every version so the user can compare and revert.
