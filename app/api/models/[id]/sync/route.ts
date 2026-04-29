import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { listPrompts } from "@/lib/astria";
import { mirrorImageToStorage } from "@/lib/storage";
import { Model } from "@/types";

// Syncing many historical prompts can take a while when mirroring images.
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: model } = await supabase
    .from("models")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  const m = model as Model;

  if (!m.astria_tune_id) {
    return NextResponse.json(
      { error: "Model has no Astria tune yet" },
      { status: 400 }
    );
  }

  const serviceClient = await createServiceClient();

  // Skip anything already in DB — dedupe on astria_source_url and on url
  // (old rows created before mirroring was added still have the Astria URL there).
  const { data: existing } = await serviceClient
    .from("generated_images")
    .select("astria_source_url, url")
    .eq("model_id", id);

  const seen = new Set<string>();
  for (const r of existing ?? []) {
    if (r.astria_source_url) seen.add(r.astria_source_url);
    if (r.url) seen.add(r.url);
  }

  // Paginate through Astria prompts. API returns up to ~20 per page by default.
  const allPrompts = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const batch = await listPrompts(m.astria_tune_id, { offset });
    if (!batch || batch.length === 0) break;
    allPrompts.push(...batch);
    if (batch.length < 20) break;
    offset += batch.length;
  }

  let imported = 0;
  let failed = 0;

  for (const p of allPrompts) {
    if (!p.images || p.images.length === 0) continue;

    const textWithoutTrigger = (p.text ?? "")
      .replace(/^sks\s+ohwx\s+person\s+/i, "")
      .trim();

    for (const sourceUrl of p.images) {
      if (seen.has(sourceUrl)) continue;

      try {
        const { publicUrl } = await mirrorImageToStorage(
          serviceClient,
          user.id,
          id,
          sourceUrl
        );

        await serviceClient.from("generated_images").insert({
          model_id: id,
          user_id: user.id,
          prompt: textWithoutTrigger || p.text || "",
          url: publicUrl,
          astria_source_url: sourceUrl,
          astria_prompt_id: p.id,
          astria_image_id: String(p.id),
          created_at: p.created_at,
        });

        seen.add(sourceUrl);
        imported++;
      } catch (err) {
        console.error("Sync mirror failed for", sourceUrl, err);
        failed++;
      }
    }
  }

  return NextResponse.json({
    scanned: allPrompts.length,
    imported,
    failed,
  });
}
