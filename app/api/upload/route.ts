import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createSignedUpload } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";
import { z } from "zod";
import crypto from "crypto";

const schema = z.object({
  filename: z.string().min(1),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  // training: photo set for a model (modelId required, ownership checked).
  // edit: source photos / masks for studio tools. garment: try-on garments.
  purpose: z.enum(["training", "edit", "garment"]).default("training"),
  modelId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  const log = makeLogger("api/upload");
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

  const { filename, contentType, purpose, modelId } = parsed.data;

  const ext = filename.split(".").pop() ?? "jpg";
  let path: string;

  if (purpose === "training") {
    if (!modelId) {
      return NextResponse.json(
        { error: "modelId is required for training uploads", reqId: log.reqId },
        { status: 400 }
      );
    }

    const { data: model, error: modelErr } = await supabase
      .from("models")
      .select("id, status")
      .eq("id", modelId)
      .eq("user_id", user.id)
      .single();

    if (modelErr || !model) {
      log.warn("model_lookup_failed", {
        userId: user.id,
        modelId,
        pgCode: modelErr?.code,
        pgMessage: modelErr?.message,
      });
      return NextResponse.json(
        { error: "Model not found", reqId: log.reqId },
        { status: 404 }
      );
    }

    path = `${user.id}/${modelId}/${crypto.randomUUID()}.${ext}`;
  } else {
    // Studio uploads live outside any model folder so model deletion never
    // sweeps them: {userId}/edits/... or {userId}/garments/...
    path = `${user.id}/${purpose === "garment" ? "garments" : "edits"}/${crypto.randomUUID()}.${ext}`;
  }

  try {
    const upload = await createSignedUpload(supabase, path);
    log.info("signed_upload_created", {
      userId: user.id,
      modelId,
      path,
      contentType,
      filename,
    });
    return NextResponse.json({
      signedUrl: upload.signedUrl,
      token: upload.token,
      path: upload.path,
      publicUrl: upload.publicUrl,
      reqId: log.reqId,
    });
  } catch (err) {
    log.error("signed_upload_failed", {
      userId: user.id,
      modelId,
      path,
      ...errInfo(err),
    });
    return NextResponse.json(
      {
        error: `Failed to create upload URL: ${errInfo(err).message}`,
        reqId: log.reqId,
      },
      { status: 500 }
    );
  }
}
