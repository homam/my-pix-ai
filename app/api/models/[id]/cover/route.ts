import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { makeLogger, errInfo } from "@/lib/log";

const schema = z.object({ imageId: z.string().uuid() });

// Sets a generated image as the model's cover (shown on dashboard cards).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const log = makeLogger("api/models/[id]/cover");
  const { id } = await params;

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
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten(), reqId: log.reqId },
      { status: 400 }
    );
  }

  // The image must belong to this user and this model.
  const { data: image, error: imgErr } = await supabase
    .from("generated_images")
    .select("id, url, model_id")
    .eq("id", parsed.data.imageId)
    .eq("user_id", user.id)
    .single();

  if (imgErr || !image || image.model_id !== id) {
    log.warn("image_not_eligible", { userId: user.id, modelId: id, imageId: parsed.data.imageId });
    return NextResponse.json(
      { error: "Image not found for this model", reqId: log.reqId },
      { status: 404 }
    );
  }

  // models RLS (for all) lets the owner update their own row.
  const { error: updErr } = await supabase
    .from("models")
    .update({ cover_image_url: image.url, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (updErr) {
    log.error("cover_update_failed", {
      userId: user.id,
      modelId: id,
      pgCode: updErr.code,
      pgMessage: updErr.message,
    });
    return NextResponse.json(
      { error: "Failed to set cover", reqId: log.reqId },
      { status: 500 }
    );
  }

  log.info("cover_set", { userId: user.id, modelId: id, imageId: image.id });
  return NextResponse.json({ ok: true, coverUrl: image.url, reqId: log.reqId });
}
