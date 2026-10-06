// Shared plumbing for the /api/composites routes: who is calling, and how a
// failure is reported. Server-only.

import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { errInfo, type Logger } from "@/lib/log";
import { CompositeError } from "@/lib/composite/jobs";

export async function compositeCaller() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  // Service client: the composite tables grant `authenticated` SELECT only, so
  // every write goes through it — with user_id taken from the session above.
  const serviceClient = await createServiceClient();
  return { supabase, serviceClient, user };
}

export function unauthorized(log: Logger) {
  return NextResponse.json({ error: "Unauthorized", reqId: log.reqId }, { status: 401 });
}

export function badRequest(log: Logger, error: string, details?: unknown) {
  return NextResponse.json({ error, details, reqId: log.reqId }, { status: 400 });
}

/** CompositeError → its status and code; anything else is a logged 500. */
export function failure(log: Logger, err: unknown, event: string, fields: Record<string, unknown> = {}) {
  if (err instanceof CompositeError) {
    log.warn(event, { ...fields, code: err.code, message: err.message });
    const job = (err as CompositeError & { job?: unknown }).job;
    return NextResponse.json(
      { error: err.message, code: err.code, ...(job ? { job } : {}), reqId: log.reqId },
      { status: err.status }
    );
  }
  log.error(event, { ...fields, ...errInfo(err) });
  return NextResponse.json(
    { error: errInfo(err).message || "Something went wrong", reqId: log.reqId },
    { status: 500 }
  );
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
