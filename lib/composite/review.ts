// Automatic review of a composite version. Server-only.
//
// "A composite is not finished merely because it looks attractive": the first
// coastline render in the 2026-10-06 session was polished and still put the sun
// 8% of the frame away from its own reflection. So every version gets a vision
// review against the sources before it is presented as final, checking the
// relationships that must stay physically coherent, whether each user-marked
// detail survived, and — for a correction — whether it was actually applied.
//
// The review never blocks a version: it labels it "passed", "flagged" (with
// findings the UI turns into one-click corrections) or "unavailable" (the review
// could not run — the user is told to check it themselves).
//
// Env-gated: on when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set, or when
// COMPOSITE_REVIEW=on (local `ant auth login` profiles); COMPOSITE_REVIEW=off
// disables it.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import type {
  CheckId,
  CompositeReview,
  CorrectionMode,
  PreserveCheck,
  ReviewCheck,
  ReviewIssue,
} from "@/lib/composite/types";

export const REVIEW_MODEL = "claude-opus-5-5";

export function reviewerEnabled(): boolean {
  const flag = (process.env.COMPOSITE_REVIEW ?? "").toLowerCase();
  if (flag === "off") return false;
  return flag === "on" || Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const CHECK_IDS = [
  "duplicate_elements",
  "seams",
  "horizon",
  "light_reflection",
  "geometry",
  "invented_content",
  "correction_applied",
] as const satisfies readonly CheckId[];

const Point = z.object({ x: z.number(), y: z.number() });
const ReviewOutput = z.object({
  checks: z.array(
    z.object({
      id: z.enum(CHECK_IDS),
      status: z.enum(["pass", "fail", "uncertain"]),
      note: z.string(),
    })
  ),
  mustPreserve: z.array(
    z.object({
      detail: z.string(),
      status: z.enum(["preserved", "missing", "uncertain"]),
      note: z.string(),
    })
  ),
  issues: z.array(
    z.object({
      summary: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      element: Point.nullable(),
      target: Point.nullable(),
      suggestedInstruction: z.string(),
    })
  ),
});

const SYSTEM = `You are the quality reviewer for an app that merges several travel photos (and stills from a video) of one scene into a single wide composite image. You look at a finished composite next to the original photos it was made from and decide whether it can be presented as final.

Check each of these and report pass, fail or uncertain, with a short note in plain language:
- duplicate_elements: anything that appears more times than it really exists — a second sun or moon, extra wings or engines, repeated buildings, boats, people or landmarks.
- seams: visible stitching lines, abrupt changes in exposure, colour or texture, or misaligned edges where inputs were joined.
- horizon: the horizon or waterline stays continuous and level-consistent across the frame (no steps, kinks or double horizons).
- light_reflection: light sources agree with what they light — the sun sits above its own glint or reflection on water, shadows point away from the light, the bright part of the sky matches the lit areas below.
- geometry: foreground objects (for example an aircraft wing or engine) have plausible shape and perspective.
- invented_content: objects, coastlines or landmarks that appear in none of the source photos.
- correction_applied: only when the request says this version is a correction — whether the requested change was made AND everything the user did not ask to change stayed the same. Otherwise pass with the note "not a correction".

Then report, for each detail the user asked to preserve, whether the composite still shows it (preserved / missing / uncertain). Quote the user's words as the detail. Describe what you see neutrally — never name a cause for an optical effect (do not call marks "lens flare", "reflections in the window", "UFOs" and so on) unless the user did.

List every problem as an issue the user could fix with one plain-language request:
- summary: one sentence in plain language.
- severity: high (an obvious physical error a viewer would notice), medium, low.
- element: where the wrong thing is, as {x, y} fractions of the COMPOSITE's width and height measured from its top-left corner (0–1). null when there is no single place.
- target: for something in the wrong place, where it should be instead (same coordinates); otherwise null. For a sun that is not above its reflection, the target is directly above the reflection at the sun's current height.
- suggestedInstruction: the request the user would send, e.g. "Move the sun so it sits directly above the bright reflection on the water; keep the harbor and coastline unchanged."

Use uncertain when you cannot tell from the images. Do not report taste or style preferences as issues. If everything passes, return an empty issues list.`;

export interface ReviewImage {
  label: string;
  jpeg: Buffer;
}

export interface ReviewInput {
  composite: Buffer; // JPEG, long edge ≤ 1568
  sources: ReviewImage[]; // JPEGs, long edge ≤ 1024
  mustPreserve: string[];
  scenePriority: string | null;
  correction?: {
    mode: CorrectionMode;
    instruction: string;
    previous: Buffer; // the version that was corrected
  };
}

function image(jpeg: Buffer): Anthropic.Beta.BetaImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
  };
}

function clampPoint(p: { x: number; y: number } | null) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

/** pass only when nothing failed, nothing is uncertain and no real issue remains. */
export function verdictFor(
  checks: Pick<ReviewCheck, "status">[],
  preserve: Pick<PreserveCheck, "status">[],
  issues: Pick<ReviewIssue, "severity">[]
): "pass" | "flag" {
  if (checks.some((c) => c.status !== "pass")) return "flag";
  if (preserve.some((p) => p.status !== "preserved")) return "flag";
  if (issues.some((i) => i.severity !== "low")) return "flag";
  return "pass";
}

export async function reviewComposite(input: ReviewInput): Promise<CompositeReview> {
  const client = new Anthropic({ timeout: 85_000, maxRetries: 0 });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: "Image 1 — the composite to review:" },
    image(input.composite),
  ];
  let n = 2;
  if (input.correction) {
    content.push({ type: "text", text: `Image ${n++} — the previous version, before the correction:` });
    content.push(image(input.correction.previous));
  }
  for (const s of input.sources) {
    content.push({ type: "text", text: `Image ${n++} — source: ${s.label}` });
    content.push(image(s.jpeg));
  }
  const ask: string[] = [];
  ask.push(
    input.mustPreserve.length
      ? `Details the user asked to preserve: ${input.mustPreserve.map((d) => `"${d}"`).join("; ")}.`
      : "The user did not list details to preserve; return an empty mustPreserve list."
  );
  if (input.scenePriority) ask.push(`The user's scene priority: "${input.scenePriority}".`);
  if (input.correction) {
    ask.push(
      `This version is a CORRECTION of image 2. The user asked: "${input.correction.instruction}". ` +
        "Check correction_applied, and check that nothing else changed."
    );
  } else {
    ask.push("This version is a first render from the sources (not a correction).");
  }
  ask.push("Review image 1 now.");
  content.push({ type: "text", text: ask.join("\n") });

  const response = await client.beta.messages.parse({
    model: REVIEW_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: {
      effort: (process.env.COMPOSITE_REVIEW_EFFORT as "low" | "medium" | "high" | undefined) ?? "medium",
      format: betaZodOutputFormat(ReviewOutput),
    },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `the reviewer declined (${response.stop_details?.category ?? "no category"})`
    );
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`the reviewer returned no structured result (stop: ${response.stop_reason})`);

  // The model occasionally emits a placeholder issue with no text; it is not a finding.
  const issues: ReviewIssue[] = parsed.issues
    .filter((i) => i.summary.trim())
    .map((i) => ({
      ...i,
      suggestedInstruction: i.suggestedInstruction.trim() || i.summary,
      element: clampPoint(i.element),
      target: clampPoint(i.target),
    }));
  return {
    verdict: verdictFor(parsed.checks, parsed.mustPreserve, issues),
    checks: parsed.checks,
    mustPreserve: parsed.mustPreserve,
    issues,
    model: response.model,
    reviewedAt: new Date().toISOString(),
  };
}
