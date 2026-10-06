// Reference selection: from everything the user dropped into a group, pick a
// small, varied set of sharp stills to send to the image provider. Pure and
// shared by the browser (contact sheet) and the unit tests.
//
// The rules, from the 2026-10-06 session that this feature reproduces:
//   - near-identical frames add cost and confusion, not information → keep one;
//   - a soft (blurry) still is dropped unless the user insists;
//   - the user's anchor and anything they explicitly kept is NEVER dropped by
//     ranking, even when an automatic choice would have preferred another still;
//   - the provider's reference limit is a hard cap, enforced per provider.

export interface Candidate {
  id: string;
  kind: "photo" | "frame";
  sequence: number;
  // Variance of the Laplacian on a small greyscale copy; higher = sharper.
  sharpness: number | null;
  // 64-bit difference hash as 16 hex chars.
  phash: string | null;
  pinned: boolean;
}

export type SelectionNote =
  | { kind: "anchor" }
  | { kind: "kept" }
  | { kind: "auto" }
  | { kind: "duplicate"; of: string }
  | { kind: "soft" }
  | { kind: "over_limit" };

export interface SelectionResult {
  // Ordered as the provider should see them: anchor first, then by sequence.
  selected: string[];
  notes: Record<string, SelectionNote>;
}

// Bits that may differ between two dHashes of "the same picture". 64-bit dHash
// on a 9×8 thumbnail: re-encodes and tiny shifts land at 0–4; consecutive burst
// frames of a moving scene typically 6–12; different views 20+.
export const DUPLICATE_DISTANCE = 5;
// A still is "soft" below this fraction of the group's median sharpness.
export const SOFT_RATIO = 0.35;

const POPCOUNT = Array.from({ length: 16 }, (_, n) =>
  n.toString(2).split("").filter((b) => b === "1").length
);

/** Hamming distance between two hex dHashes; Infinity when either is missing. */
export function hammingHex(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d += POPCOUNT[parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)]!;
  }
  return d;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Default anchor: the sharpest photo (frames only if there are no photos). */
export function defaultAnchor(cands: Candidate[]): string | null {
  const pool = cands.some((c) => c.kind === "photo")
    ? cands.filter((c) => c.kind === "photo")
    : cands;
  if (pool.length === 0) return null;
  return [...pool].sort(
    (a, b) => (b.sharpness ?? 0) - (a.sharpness ?? 0) || a.sequence - b.sequence
  )[0]!.id;
}

export function autoSelect(
  cands: Candidate[],
  opts: { target: number; max: number; anchorId: string | null }
): SelectionResult {
  const notes: Record<string, SelectionNote> = {};
  const byId = new Map(cands.map((c) => [c.id, c]));
  const limit = Math.max(1, Math.min(opts.target, opts.max));

  const anchor = opts.anchorId && byId.has(opts.anchorId) ? byId.get(opts.anchorId)! : null;
  // Kept-by-the-user stills come first and are only ever cut by the HARD cap.
  const forced: Candidate[] = [];
  if (anchor) {
    forced.push(anchor);
    notes[anchor.id] = { kind: "anchor" };
  }
  for (const c of [...cands].sort((a, b) => a.sequence - b.sequence)) {
    if (c.pinned && c !== anchor) {
      if (forced.length < opts.max) {
        forced.push(c);
        notes[c.id] = { kind: "kept" };
      } else {
        notes[c.id] = { kind: "over_limit" };
      }
    }
  }

  const med = median(cands.map((c) => c.sharpness ?? 0).filter((v) => v > 0));
  const isSoft = (c: Candidate) =>
    med > 0 && c.sharpness != null && c.sharpness < med * SOFT_RATIO;

  const chosen: Candidate[] = [...forced];
  const rest = cands.filter((c) => !chosen.includes(c) && !notes[c.id]);

  // Duplicates of something already chosen, or of a sharper unchosen twin.
  const sharperFirst = [...rest].sort(
    (a, b) => (b.sharpness ?? 0) - (a.sharpness ?? 0) || a.sequence - b.sequence
  );
  const kept: Candidate[] = [];
  for (const c of sharperFirst) {
    const twin = [...chosen, ...kept].find(
      (k) => hammingHex(k.phash, c.phash) <= DUPLICATE_DISTANCE
    );
    if (twin) {
      notes[c.id] = { kind: "duplicate", of: twin.id };
    } else if (isSoft(c)) {
      notes[c.id] = { kind: "soft" };
    } else {
      kept.push(c);
    }
  }

  // Fill the remaining slots by diversity: always add the still that differs
  // most from everything chosen so far (ties → sharper, then earlier).
  const pool = [...kept];
  while (chosen.length < limit && pool.length > 0) {
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const dist = chosen.length
        ? Math.min(...chosen.map((k) => hammingHex(k.phash, c.phash)))
        : 64;
      const score = (Number.isFinite(dist) ? dist : 32) * 1e6 + (c.sharpness ?? 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const pick = pool.splice(best, 1)[0]!;
    chosen.push(pick);
    notes[pick.id] = { kind: "auto" };
  }
  for (const c of pool) notes[c.id] = { kind: "over_limit" };

  const ordered = [
    ...(anchor ? [anchor] : []),
    ...chosen.filter((c) => c !== anchor).sort((a, b) => a.sequence - b.sequence),
  ];
  return { selected: ordered.map((c) => c.id), notes };
}

/** "0:40" — timestamps on frame labels. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Candidate-frame spacing for a video of `duration` seconds: about nine stills
 * across the clip, never closer than 2 s or further apart than 10 s. An 89 s
 * clip gets the session's 10 s spacing (frames at 0.5, 10, 20 … 80 s).
 */
export function frameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const step = Math.min(10, Math.max(2, Math.round(duration / 9)));
  const out: number[] = [];
  for (let t = 0; t < duration - 0.25; t += step) out.push(t === 0 ? Math.min(0.5, duration / 2) : t);
  return out;
}
