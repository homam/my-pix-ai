import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { makeLogger } from "@/lib/log";
import { advanceJob, verifyWebhookSignature } from "@/lib/composite/jobs";

// POST /api/webhooks/fal-composite?job=<id>&sig=<hmac> — fal calls this when a
// composite render finishes, so the version is saved and reviewed even if the
// user closed the tab.
//
// The payload is IGNORED. The webhook is only a nudge: advanceJob re-reads the
// job's state from fal with our own key, exactly as a browser poll does, so a
// forged call can at most cause one extra status check. The HMAC (keyed on
// COMPOSITE_WEBHOOK_SECRET, falling back to ASTRIA_WEBHOOK_SECRET) keeps random
// job ids from even getting that far.

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const log = makeLogger("api/webhooks/fal-composite");
  const jobId = req.nextUrl.searchParams.get("job") ?? "";
  const sig = req.nextUrl.searchParams.get("sig") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !verifyWebhookSignature(jobId, sig)) {
    log.warn("bad_signature", { jobId });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const serviceClient = await createServiceClient();
    const job = await advanceJob(serviceClient, jobId, log, { budgetMs: 100_000 });
    log.info("webhook_advanced", { jobId, status: job.status });
    return NextResponse.json({ ok: true, status: job.status });
  } catch (err) {
    log.error("webhook_failed", { jobId, message: err instanceof Error ? err.message : String(err) });
    // 200 anyway: fal retries on 5xx, and polling recovers the job regardless.
    return NextResponse.json({ ok: false });
  }
}
