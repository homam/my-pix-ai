import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { makeLogger, errInfo } from "@/lib/log";
import { z } from "zod";
import crypto from "crypto";

const schema = z.object({
  name: z.string().min(1).max(60),
});

export async function POST(req: NextRequest) {
  const log = makeLogger("api/models");
  log.info("request_received");

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    log.warn("unauthorized", { authErr: authErr?.message });
    return NextResponse.json(
      { error: "Unauthorized", reqId: log.reqId },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    log.error("body_parse_failed", errInfo(err));
    return NextResponse.json(
      { error: "Invalid JSON body", reqId: log.reqId },
      { status: 400 }
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    log.warn("validation_failed", {
      userId: user.id,
      issues: parsed.error.flatten(),
    });
    return NextResponse.json(
      {
        error: "Invalid request",
        details: parsed.error.flatten(),
        reqId: log.reqId,
      },
      { status: 400 }
    );
  }

  const modelId = crypto.randomUUID();
  log.info("inserting_model", { userId: user.id, modelId, name: parsed.data.name });

  const { data: model, error } = await supabase
    .from("models")
    .insert({
      id: modelId,
      user_id: user.id,
      name: parsed.data.name,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    log.error("insert_failed", {
      userId: user.id,
      modelId,
      pgCode: error.code,
      pgMessage: error.message,
      pgHint: error.hint,
      pgDetails: error.details,
    });
    return NextResponse.json(
      { error: error.message, code: error.code, reqId: log.reqId },
      { status: 500 }
    );
  }

  log.info("model_created", { userId: user.id, modelId: model.id });
  return NextResponse.json({ model, reqId: log.reqId });
}
