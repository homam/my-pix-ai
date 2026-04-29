import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { makeLogger, errInfo } from "@/lib/log";

const schema = z.object({
  imageIds: z.array(z.string().uuid()).min(1).max(20),
  prompt: z.string().min(1).max(1000),
});

// 8 chars from URL-safe alphabet → ~2.8 trillion combinations. Plenty of room.
const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
function makeSlug(): string {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export async function POST(req: NextRequest) {
  const log = makeLogger("api/shares");
  log.info("request_received");

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    log.warn("unauthorized");
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
    log.warn("validation_failed", { issues: parsed.error.flatten() });
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten(), reqId: log.reqId },
      { status: 400 }
    );
  }
  const { imageIds, prompt } = parsed.data;

  // Verify the user owns every image and they all belong to the same model.
  const { data: imgs, error: imgsErr } = await supabase
    .from("generated_images")
    .select("id, model_id, user_id")
    .in("id", imageIds);

  if (imgsErr) {
    log.error("images_fetch_failed", { pgCode: imgsErr.code, pgMessage: imgsErr.message });
    return NextResponse.json(
      { error: "Failed to verify images", reqId: log.reqId },
      { status: 500 }
    );
  }
  if (!imgs || imgs.length !== imageIds.length) {
    log.warn("images_not_found", { requested: imageIds.length, found: imgs?.length ?? 0 });
    return NextResponse.json(
      { error: "Some images not found or not yours", reqId: log.reqId },
      { status: 404 }
    );
  }
  const otherUser = imgs.find((i) => i.user_id !== user.id);
  if (otherUser) {
    log.warn("foreign_image_in_share", { userId: user.id });
    return NextResponse.json(
      { error: "You can only share your own images", reqId: log.reqId },
      { status: 403 }
    );
  }
  const modelIds = new Set(imgs.map((i) => i.model_id));
  if (modelIds.size !== 1) {
    return NextResponse.json(
      { error: "All images in a share must come from the same model", reqId: log.reqId },
      { status: 400 }
    );
  }
  const modelId = imgs[0].model_id;

  // Use service client for the insert so it bypasses any column-level
  // hardening; RLS still gates ownership via the with-check policy.
  const svc = await createServiceClient();
  // Try a few times in the astronomically unlikely event of a slug collision.
  let slug = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    slug = makeSlug();
    const { error } = await svc.from("shares").insert({
      slug,
      user_id: user.id,
      model_id: modelId,
      image_ids: imageIds,
      prompt,
    });
    if (!error) break;
    if (error.code === "23505") continue; // unique violation → try again
    log.error("share_insert_failed", { pgCode: error.code, pgMessage: error.message });
    return NextResponse.json(
      { error: "Failed to create share", reqId: log.reqId },
      { status: 500 }
    );
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    `https://${req.headers.get("host")}`;
  const url = `${origin}/s/${slug}`;
  log.info("share_created", { userId: user.id, slug, imageCount: imageIds.length });
  return NextResponse.json({ slug, url, reqId: log.reqId });
}
