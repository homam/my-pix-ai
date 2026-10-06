// Provider failures, in words a user can act on. Pure (unit-tested).
//
// Raw provider errors are for the log: fal's 422 body echoes the entire prompt
// back, which is what the first live run showed the user. A job stores only the
// sentence below; the UI adds "your credits were refunded".
//
// `retry`: the 2026-10-06 live run hit nano-banana-pro's "Could not generate
// images with the given prompts and images" on an input set that rendered fine
// in the spike — the model sometimes returns no image. Those get ONE free
// resubmission (lib/composite/jobs.ts); anything that will fail the same way
// again (content policy, an oversized input) does not.

export interface ProviderFailure {
  retry: boolean;
  message: string;
}

export function classifyProviderError(raw: string): ProviderFailure {
  const s = raw.toLowerCase();
  if (/content.?policy|safety|nsfw|moderation|blocked/.test(s)) {
    return { retry: false, message: "The image provider declined these inputs on content grounds" };
  }
  if (/image_too_large|decompression|too large/.test(s)) {
    return { retry: false, message: "One of the photos is too large for the image provider" };
  }
  if (/could not generate|no image|returned no image/.test(s)) {
    return {
      retry: true,
      message:
        "The image model could not produce a composite from these inputs. Try again, or change the anchor or which photos are selected",
    };
  }
  if (/timed? ?out|timeout|econnreset|socket|overloaded|rate.?limit|\b429\b|\b5\d\d\b/.test(s)) {
    return { retry: true, message: "The image provider was unavailable" };
  }
  return { retry: false, message: "The image provider could not render this composite" };
}
