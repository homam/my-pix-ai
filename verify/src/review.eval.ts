/**
 * REVIEW EVAL — does the automatic composite review catch what it exists for?
 *
 * The handoff's acceptance bar: "the result review catches or flags duplicated
 * suns/wings, visible seams, and gross sun/reflection misalignment on a small
 * fixture set". This runs lib/composite/review.ts against real composites with
 * known defects and asserts the defect is flagged — and that clean renders keep
 * the details the user asked for.
 *
 * Costs real money (one Claude vision call per fixture, ~$0.05 each) and the
 * fixtures are users' photos, which are never committed. So it is opt-in:
 *
 *   REVIEW_FIXTURES=/path/to/manifest.json npm run eval:review
 *
 * manifest.json — paths relative to the manifest:
 *   [{
 *     "name": "coastline v1: sun not above its glint",
 *     "composite": "coastline_v1.jpg",
 *     "sources": [{ "label": "photo \"IMG_3102.jpeg\"", "path": "IMG_3102.jpg" }],
 *     "mustPreserve": [],
 *     "correction": { "instruction": "…", "previous": "before.jpg" },   // optional
 *     "expectFlagged": ["light_reflection"],     // these checks must NOT pass
 *     "expectPassed": ["duplicate_elements"],    // these checks must pass
 *     "expectPreserved": ["the two red-orange light spots above the sun"]
 *   }]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downscaleJpeg } from '@/lib/composite/imaging';
import { reviewComposite } from '@/lib/composite/review';
import type { CheckId } from '@/lib/composite/types';
import { loadEnv } from './config';

interface Fixture {
  name: string;
  composite: string;
  sources: { label: string; path: string }[];
  mustPreserve?: string[];
  scenePriority?: string;
  correction?: { instruction: string; previous: string };
  expectFlagged?: CheckId[];
  expectPassed?: CheckId[];
  expectPreserved?: string[];
}

const env = loadEnv();
for (const k of ['ANTHROPIC_API_KEY', 'COMPOSITE_REVIEW']) if (env[k] && !process.env[k]) process.env[k] = env[k];
const manifestPath = env.REVIEW_FIXTURES;
const fixtures: Fixture[] = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
const at = (p: string) => resolve(dirname(manifestPath ?? '.'), p);

describe.runIf(fixtures.length > 0)('composite review catches known defects', () => {
  for (const f of fixtures) {
    it(f.name, async () => {
      const review = await reviewComposite({
        composite: await downscaleJpeg(readFileSync(at(f.composite)), 1568, 85),
        sources: await Promise.all(
          f.sources.map(async (s) => ({ label: s.label, jpeg: await downscaleJpeg(readFileSync(at(s.path)), 1024, 82) })),
        ),
        mustPreserve: f.mustPreserve ?? [],
        scenePriority: f.scenePriority ?? null,
        correction: f.correction
          ? {
              mode: 'text',
              instruction: f.correction.instruction,
              previous: await downscaleJpeg(readFileSync(at(f.correction.previous)), 1024, 82),
            }
          : undefined,
      });
      const status = Object.fromEntries(review.checks.map((c) => [c.id, c.status]));
      console.log(
        `  ${f.name}\n    verdict=${review.verdict} · ` +
          review.checks.map((c) => `${c.id}:${c.status}`).join(' ') +
          (review.mustPreserve.length ? `\n    preserve: ${review.mustPreserve.map((p) => `${p.detail}=${p.status}`).join('; ')}` : '') +
          (review.issues.length
            ? `\n    issues: ${review.issues
                .map((i) => `[${i.severity}] ${i.summary}${i.element ? ` @(${i.element.x.toFixed(2)},${i.element.y.toFixed(2)})` : ''}${i.target ? `→(${i.target.x.toFixed(2)},${i.target.y.toFixed(2)})` : ''}`)
                .join(' | ')}`
            : ''),
      );
      for (const id of f.expectFlagged ?? []) {
        expect(status[id], `${id} should be flagged (fail or uncertain)`).not.toBe('pass');
      }
      for (const id of f.expectPassed ?? []) {
        expect(status[id], `${id} should pass`).toBe('pass');
      }
      for (const d of f.expectPreserved ?? []) {
        expect(review.mustPreserve.find((p) => p.detail.includes(d) || d.includes(p.detail))?.status, `"${d}" should be preserved`).toBe('preserved');
      }
    }, 120_000);
  }
});

it('has fixtures to run (set REVIEW_FIXTURES), or is skipped', () => {
  if (!fixtures.length) console.log('  review eval · no REVIEW_FIXTURES manifest — nothing to evaluate');
});
