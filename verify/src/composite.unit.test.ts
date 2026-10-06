/**
 * LAYER 3 — the composite pipeline's pure logic (docs/COMPOSITES.md).
 *
 * Each block pins a rule from the 2026-10-06 session handoff that would
 * otherwise only be a sentence in a document:
 *   - a resized export is never "native 4K" (the session's 4096-px exports were
 *     resampled from ~1.9K renders);
 *   - the user's anchor and kept stills survive automatic selection, near-
 *     duplicates and blurry stills do not, and the provider cap is hard;
 *   - prompts quote what the user asked to preserve, verbatim;
 *   - a correction never rewrites a version, and the state machine has no path
 *     from a terminal state back to work.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  closestAspect,
  downloadName,
  exportPlan,
  nativeLabel,
  upscaledLabel,
} from '@/lib/composite/dimensions';
import {
  autoSelect,
  defaultAnchor,
  formatTimestamp,
  frameTimes,
  hammingHex,
  type Candidate,
} from '@/lib/composite/selection';
import { buildCorrectionPrompt, buildRenderPrompt } from '@/lib/composite/prompt';
import { allowedFrom, canTransition, groupStatusFrom, jobStatusForProvider } from '@/lib/composite/states';
import { verdictFor } from '@/lib/composite/review';
import { classifyProviderError } from '@/lib/composite/errors';
import { isOwnCompositePath, compositePath } from '@/lib/composite/storage';

describe('dimensions: native vs upscaled', () => {
  it('a 1942-px render gets a 4096-px export that is labelled upscaled, never native 4K', () => {
    const plan = exportPlan({ width: 1942, height: 809 });
    expect(plan.nativeIs4K).toBe(false);
    expect(plan.upscaled).toEqual({ width: 4096, height: 1706 });
    expect(nativeLabel(plan)).toBe('Native render · 1942 × 809');
    expect(nativeLabel(plan)).not.toMatch(/4K/);
    const up = upscaledLabel(plan)!;
    expect(up).toMatch(/^Upscaled to 4K dimensions · 4096 × 1706/);
    expect(up).toMatch(/resampled from the 1942 × 809 native render/);
    expect(up).not.toMatch(/native 4K/);
  });

  it('a provider-native 4K render (5504 × 3072) has no separate export and says so', () => {
    const plan = exportPlan({ width: 5504, height: 3072 });
    expect(plan.nativeIs4K).toBe(true);
    expect(plan.upscaled).toBeNull();
    expect(upscaledLabel(plan)).toBeNull();
    expect(nativeLabel(plan)).toBe('Native render · 5504 × 3072 · native 4K');
  });

  it('portrait renders scale on their long edge', () => {
    expect(exportPlan({ width: 1536, height: 2752 }).upscaled).toEqual({ width: 2286, height: 4096 });
  });

  it('file names state which file it is and its real dimensions', () => {
    expect(downloadName('Coastline & harbor', 2, 'upscaled', { width: 4096, height: 1706 }, 'jpg')).toBe(
      'coastline-harbor-v2-upscaled-4k-4096x1706.jpg',
    );
    expect(downloadName('', 1, 'native', { width: 5504, height: 3072 }, 'png')).toBe(
      'composite-v1-native-5504x3072.png',
    );
  });

  it('a correction keeps the shape of its target', () => {
    expect(closestAspect({ width: 5504, height: 3072 })).toBe('16:9');
    expect(closestAspect({ width: 3168, height: 1344 })).toBe('21:9');
    expect(closestAspect({ width: 1080, height: 1920 })).toBe('9:16');
  });
});

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  kind: 'photo',
  sequence: Number(id.replace(/\D/g, '')) || 0,
  sharpness: 100,
  phash: '0000000000000000',
  pinned: false,
  ...over,
});

describe('selection', () => {
  it('measures dHash distance in bits', () => {
    expect(hammingHex('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingHex('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingHex('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingHex(null, '00')).toBe(Infinity);
  });

  it('keeps one of a pair of near-identical stills — the sharper one', () => {
    const r = autoSelect(
      [
        cand('p1', { phash: '00000000000000ff', sharpness: 50 }),
        cand('p2', { phash: '00000000000000fe', sharpness: 90 }),
        cand('p3', { phash: 'ffffffff00000000' }),
      ],
      { target: 6, max: 10, anchorId: null },
    );
    expect(r.selected).toEqual(['p2', 'p3']);
    expect(r.notes.p1).toEqual({ kind: 'duplicate', of: 'p2' });
  });

  it('drops a blurry still unless the user kept it', () => {
    const base = [
      cand('p1', { phash: '00000000ffffffff', sharpness: 120 }),
      cand('p2', { phash: 'ffffffff00000000', sharpness: 110 }),
      cand('p3', { phash: '0f0f0f0f0f0f0f0f', sharpness: 10 }),
    ];
    expect(autoSelect(base, { target: 6, max: 10, anchorId: null }).notes.p3).toEqual({ kind: 'soft' });
    const kept = autoSelect(base.map((c) => (c.id === 'p3' ? { ...c, pinned: true } : c)), {
      target: 6,
      max: 10,
      anchorId: null,
    });
    expect(kept.selected).toContain('p3');
    expect(kept.notes.p3).toEqual({ kind: 'kept' });
  });

  it('never drops the anchor, even a soft duplicate, and always puts it first', () => {
    const r = autoSelect(
      [
        cand('p1', { phash: 'ffffffff00000000', sharpness: 200 }),
        cand('p2', { phash: 'ffffffff00000001', sharpness: 5 }),
        cand('p3', { phash: '00000000ffffffff', sharpness: 150 }),
      ],
      { target: 2, max: 10, anchorId: 'p2' },
    );
    expect(r.selected[0]).toBe('p2');
    expect(r.notes.p2).toEqual({ kind: 'anchor' });
  });

  it('respects the provider cap as a hard limit, and the target as a soft one', () => {
    // Pseudo-random 64-bit hashes: any two differ in ~32 bits, so none is a duplicate.
    const many = Array.from({ length: 15 }, (_, i) =>
      cand(`p${i}`, { phash: createHash('md5').update(`still-${i}`).digest('hex').slice(0, 16) }),
    );
    for (const a of many) for (const b of many) if (a !== b) expect(hammingHex(a.phash, b.phash)).toBeGreaterThan(5);
    const auto = autoSelect(many, { target: 6, max: 10, anchorId: 'p7' });
    expect(auto.selected).toHaveLength(6);
    expect(auto.selected[0]).toBe('p7');
    const pinnedAll = autoSelect(many.map((c) => ({ ...c, pinned: true })), { target: 6, max: 10, anchorId: null });
    expect(pinnedAll.selected).toHaveLength(10);
    expect(Object.values(pinnedAll.notes).filter((n) => n.kind === 'over_limit')).toHaveLength(5);
  });

  it('defaults the anchor to the sharpest photo, not a frame', () => {
    expect(
      defaultAnchor([
        cand('f1', { kind: 'frame', sharpness: 999 }),
        cand('p1', { sharpness: 10 }),
        cand('p2', { sharpness: 30 }),
      ]),
    ).toBe('p2');
  });

  it('samples an 89-second clip every 10 seconds, like the session', () => {
    expect(frameTimes(88.9)).toEqual([0.5, 10, 20, 30, 40, 50, 60, 70, 80]);
    expect(frameTimes(12).length).toBeGreaterThanOrEqual(5);
    expect(frameTimes(0)).toEqual([]);
    expect(formatTimestamp(70)).toBe('1:10');
  });
});

describe('prompts', () => {
  const sources = [
    { kind: 'photo' as const, name: 'IMG_3146.jpeg' },
    { kind: 'photo' as const, name: 'IMG_3148.jpeg' },
    { kind: 'frame' as const, name: 'f', videoName: 'IMG_3150.MOV', timeS: 40 },
  ];

  it('follows the session contract: anchor, supporting inputs, preserve, avoid', () => {
    const p = buildRenderPrompt({
      name: 'Second sunset',
      scenePriority: 'keep the coastline shape',
      mustPreserve: ['the two red-orange spots above the sun'],
      style: 'faithful',
      aspectRatio: '16:9',
      sources,
    });
    expect(p).toMatch(/^Use case: compositing/);
    expect(p).toMatch(/image 1 = anchor photo; images 2–3 = supporting photos or timestamped video frames/);
    expect(p).toMatch(/Image 3: a still frame from the video "IMG_3150.MOV" at 0:40/);
    expect(p).toMatch(/Preserve: "the two red-orange spots above the sun"/);
    expect(p).toMatch(/Scene priority: "keep the coastline shape"/);
    expect(p).toMatch(/faithful to the inputs/);
    expect(p).toMatch(/Avoid: seams/);
    expect(p).toMatch(/a second sun, extra wings/);
  });

  it('quotes the user verbatim and does not let their quotes break out', () => {
    const p = buildRenderPrompt({
      name: 'x',
      scenePriority: null,
      mustPreserve: ['the "UFO" lights'],
      style: 'faithful',
      aspectRatio: '21:9',
      sources,
    });
    expect(p).toContain(`"the 'UFO' lights"`);
  });

  it('a move correction asks only for the leftover to be removed', () => {
    const p = buildCorrectionPrompt({
      mode: 'move',
      instruction: 'align the sun with the existing reflection; keep the harbor unchanged',
      mustPreserve: [],
      evidence: [{ kind: 'photo', name: 'IMG_3102.jpeg' }],
    });
    expect(p).toMatch(/Image 1 = EDIT TARGET/);
    expect(p).toMatch(/Image 2 = GUIDE/);
    expect(p).toMatch(/Image 3 = EVIDENCE: the photo "IMG_3102.jpeg"/);
    expect(p).toMatch(/remove the leftover inside the red circle/);
    expect(p).toMatch(/Do not move, resize or remove the copy outside the circle/);
    expect(p).toMatch(/NO|circles, arrows or any markings/);
  });

  it('a text correction has no guide image', () => {
    const p = buildCorrectionPrompt({
      mode: 'text',
      instruction: 'remove the second boat',
      mustPreserve: ['the ferry wake'],
      evidence: [{ kind: 'photo', name: 'a.jpg' }],
    });
    expect(p).not.toMatch(/GUIDE/);
    expect(p).toMatch(/Image 2 = EVIDENCE/);
    expect(p).toMatch(/Keep unchanged: "the ferry wake"/);
  });
});

describe('state machine', () => {
  const t = (s: string, at = '2026-10-06T10:00:00Z') => ({ status: s as never, created_at: at });
  const src = (id: string, kind: 'photo' | 'video' | 'frame', status: 'pending' | 'uploaded', parent: string | null = null) => ({
    id,
    kind,
    status,
    parent_source_id: parent,
  });

  it('walks draft → uploading → preparing → ready_to_generate', () => {
    expect(groupStatusFrom([], [], false)).toBe('draft');
    expect(groupStatusFrom([src('a', 'photo', 'pending')], [], false)).toBe('uploading');
    expect(groupStatusFrom([src('v', 'video', 'uploaded')], [], false)).toBe('preparing');
    expect(
      groupStatusFrom([src('v', 'video', 'uploaded'), src('f', 'frame', 'uploaded', 'v')], [], false),
    ).toBe('ready_to_generate');
  });

  it('mirrors the newest active job, then settles on complete once a version exists', () => {
    const photos = [src('a', 'photo', 'uploaded')];
    expect(groupStatusFrom(photos, [t('generating')], false)).toBe('generating');
    expect(groupStatusFrom(photos, [t('complete'), t('review', '2026-10-06T11:00:00Z')], true)).toBe('review');
    expect(groupStatusFrom(photos, [t('complete'), t('failed', '2026-10-06T11:00:00Z')], true)).toBe('complete');
    expect(groupStatusFrom(photos, [t('failed')], false)).toBe('failed');
  });

  it('has no way back out of a terminal state', () => {
    for (const end of ['complete', 'failed', 'cancelled'] as const) {
      for (const to of ['queued', 'generating', 'review', 'complete', 'failed', 'cancelled'] as const) {
        expect(canTransition(end, to)).toBe(false);
      }
    }
    expect(allowedFrom('failed').sort()).toEqual(['generating', 'queued']);
    expect(allowedFrom('cancelled')).toEqual(['queued']);
  });

  it('maps provider queue states', () => {
    expect(jobStatusForProvider('IN_QUEUE')).toBe('queued');
    expect(jobStatusForProvider('IN_PROGRESS')).toBe('generating');
    expect(jobStatusForProvider('COMPLETED')).toBe('completed');
    expect(jobStatusForProvider('FAILED')).toBe('failed');
  });
});

describe('review verdict', () => {
  it('flags failures, uncertainty and missing preserved details; passes only clean reviews', () => {
    const pass = [{ status: 'pass' as const }];
    expect(verdictFor(pass, [{ status: 'preserved' }], [])).toBe('pass');
    expect(verdictFor(pass, [], [{ severity: 'low' }])).toBe('pass');
    expect(verdictFor([{ status: 'uncertain' }], [], [])).toBe('flag');
    expect(verdictFor(pass, [{ status: 'missing' }], [])).toBe('flag');
    expect(verdictFor(pass, [], [{ severity: 'high' }])).toBe('flag');
  });
});

describe('storage paths', () => {
  it('only accepts paths inside the caller’s own group tree', () => {
    const p = compositePath('u1', 'g1', 'renders', 'v.png');
    expect(p).toBe('u1/composites/g1/renders/v.png');
    expect(isOwnCompositePath(p, 'u1', 'g1')).toBe(true);
    expect(isOwnCompositePath(p, 'u2', 'g1')).toBe(false);
    expect(isOwnCompositePath(p, 'u1', 'g2')).toBe(false);
    expect(isOwnCompositePath('u1/composites/g1/../../u2/x', 'u1', 'g1')).toBe(false);
    expect(isOwnCompositePath(null, 'u1', 'g1')).toBe(false);
  });
});

describe('provider failures', () => {
  // Verbatim shape of the 2026-10-06 live failure: fal echoes the whole prompt.
  const live =
    'fal result failed: 422 {"detail":[{"loc":["prompt"],"msg":"Could not generate images with the given prompts and images. ' +
    'Please try again with different inputs.","type":"invalid_request","input":{"prompt":"Use case: compositing\\nInputs: image 1 = anchor photo"}}]}';

  it('turns the live "could not generate" 422 into one plain sentence and allows one retry', () => {
    const f = classifyProviderError(live);
    expect(f.retry).toBe(true);
    expect(f.message).not.toMatch(/Use case|422|detail|\{/);
    expect(f.message).toMatch(/could not produce a composite/);
  });

  it('never retries what will fail the same way again', () => {
    expect(classifyProviderError('422 content_policy_violation').retry).toBe(false);
    expect(classifyProviderError('422 image_too_large').retry).toBe(false);
    expect(classifyProviderError('fal status failed: 503').retry).toBe(true);
    expect(classifyProviderError('something unheard of').retry).toBe(false);
  });
});
