// Provider prompts for composites and corrections. Pure (unit-tested).
//
// The render prompt follows the contract from the 2026-10-06 session
// (docs/MULTI_SOURCE_COMPOSITES_HANDOFF.md): say which input is the anchor and
// which are supporting photos / timestamped video frames, name what must be
// preserved in the user's own words, keep it faithful, and list the artifacts
// that broke earlier renders. User text is quoted verbatim — the product must
// preserve what the user points at without naming its cause.

import { formatTimestamp } from "@/lib/composite/selection";
import type {
  CompositeAspect,
  CompositeStyle,
  CorrectionMode,
} from "@/lib/composite/types";

export interface PromptSource {
  kind: "photo" | "frame";
  name: string;
  // Frames: the video they came from and where.
  videoName?: string;
  timeS?: number;
}

export function describeSource(s: PromptSource): string {
  if (s.kind === "frame") {
    const at = s.timeS != null ? ` at ${formatTimestamp(s.timeS)}` : "";
    return `a still frame from the video "${s.videoName ?? s.name}"${at}`;
  }
  return `the photo "${s.name}"`;
}

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim().replace(/"/g, "'")}"`;

const AVOID_RENDER =
  "seams or visible stitching, repeated landmarks, duplicated subjects (a second sun, " +
  "extra wings or engines, repeated buildings, people or boats), invented objects, text, watermark";

export interface RenderPromptInput {
  name: string;
  scenePriority: string | null;
  mustPreserve: string[];
  style: CompositeStyle;
  aspectRatio: CompositeAspect;
  // In provider order; sources[0] is the anchor.
  sources: PromptSource[];
}

export function buildRenderPrompt(p: RenderPromptInput): string {
  if (p.sources.length === 0) throw new Error("a composite needs at least one source");
  const lines: string[] = ["Use case: compositing"];
  const hasFrames = p.sources.some((s) => s.kind === "frame");
  lines.push(
    `Inputs: image 1 = anchor ${p.sources[0]!.kind === "frame" ? "frame" : "photo"}` +
      (p.sources.length > 1
        ? `; images 2–${p.sources.length} = supporting ${hasFrames ? "photos or timestamped video frames" : "photos"}`
        : "")
  );
  p.sources.forEach((s, i) => lines.push(`  Image ${i + 1}: ${describeSource(s)}`));
  if (hasFrames) {
    lines.push(
      "Video frames are supporting evidence of the same scene from moments in the clip; use them for " +
        "coverage and light, not as separate scenes."
    );
  }
  const shape = p.aspectRatio === "1:1" ? "square" : "wide";
  lines.push(
    `Create one seamless, ${shape} (${p.aspectRatio}), photographic view of the scene these inputs show ` +
      `(the user calls it ${quote(p.name)}). It must read as one real photograph taken from one viewpoint.`
  );
  if (p.scenePriority?.trim()) lines.push(`Scene priority: ${quote(p.scenePriority)}.`);
  const preserve = [
    ...p.mustPreserve.filter((d) => d.trim()).map(quote),
    "the real geography, landmarks and the direction of the light",
    "the geometry of anything in the foreground (for example an aircraft wing or engine)",
  ];
  lines.push(`Preserve: ${preserve.join("; ")}.`);
  if (p.mustPreserve.length) {
    lines.push(
      "Each quoted detail is something the user saw in the photos. Keep it exactly as it appears " +
        "there (same count, colour and position relative to its surroundings); do not explain, remove or " +
        "multiply it."
    );
  }
  lines.push(
    p.style === "faithful"
      ? "Keep the viewpoint and colors faithful to the inputs. Do not stylize or dramatize."
      : "Keep the viewpoint, geography and light faithful to the inputs; you may refine exposure, " +
          "clarity and color balance as a careful photographer would."
  );
  lines.push(`Avoid: ${AVOID_RENDER}.`);
  return lines.join("\n");
}

export interface CorrectionPromptInput {
  mode: CorrectionMode;
  instruction: string;
  mustPreserve: string[];
  // Original sources sent after the target (and the guide, when there is one).
  evidence: PromptSource[];
}

export function buildCorrectionPrompt(p: CorrectionPromptInput): string {
  const lines: string[] = ["Use case: targeted correction of an existing composite"];
  const guide = p.mode !== "text";
  const firstEvidence = guide ? 3 : 2;
  lines.push("Image 1 = EDIT TARGET: the current composite. Edit this image; do not recompose it.");
  if (guide) {
    lines.push(
      "Image 2 = GUIDE: the same image with a RED circle marking the only area that may change."
    );
  }
  p.evidence.forEach((s, i) =>
    lines.push(`Image ${firstEvidence + i} = EVIDENCE: ${describeSource(s)} (an original of this scene)`)
  );

  const asked = quote(p.instruction);
  if (p.mode === "move") {
    lines.push(
      `The user asked: ${asked}. The marked element has already been placed at its corrected ` +
        "position, so image 1 now shows it twice: at the new position and, as a leftover, inside " +
        "the red circle."
    );
    lines.push(
      "Change only this: remove the leftover inside the red circle and repaint that circular area " +
        "with what would naturally be behind it, continuing the surrounding texture and light so it " +
        "blends seamlessly. Do not move, resize or remove the copy outside the circle."
    );
  } else if (p.mode === "area") {
    lines.push(`Change only this, and only inside the red circle: ${asked}.`);
  } else {
    lines.push(`Change only this: ${asked}.`);
  }
  if (p.evidence.length) {
    lines.push("Use the evidence photos to decide what is physically correct.");
  }
  const keep = [
    ...p.mustPreserve.filter((d) => d.trim()).map(quote),
    "everything not named above",
    "the framing, crop and colors of image 1",
  ];
  lines.push(`Keep unchanged: ${keep.join("; ")}.`);
  lines.push(
    "Avoid: a second copy of the corrected element, seams, circles, arrows or any markings, text, watermark."
  );
  return lines.join("\n");
}
