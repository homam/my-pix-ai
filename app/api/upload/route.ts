import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createSignedUpload } from "@/lib/storage";
import { z } from "zod";
import crypto from "crypto";

const schema = z.object({
  filename: z.string().min(1),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  modelId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { filename, modelId } = parsed.data;

  // Verify this model belongs to the user
  const { data: model } = await supabase
    .from("models")
    .select("id")
    .eq("id", modelId)
    .eq("user_id", user.id)
    .single();

  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  const ext = filename.split(".").pop() ?? "jpg";
  const path = `${user.id}/${modelId}/${crypto.randomUUID()}.${ext}`;

  try {
    const upload = await createSignedUpload(supabase, path);
    return NextResponse.json({
      signedUrl: upload.signedUrl,
      token: upload.token,
      path: upload.path,
      publicUrl: upload.publicUrl,
    });
  } catch (err) {
    console.error("Upload URL creation failed:", err);
    return NextResponse.json(
      { error: "Failed to create upload URL" },
      { status: 500 }
    );
  }
}
