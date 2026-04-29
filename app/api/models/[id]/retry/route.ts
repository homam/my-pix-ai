import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createTune } from "@/lib/astria";
import { deductCredits } from "@/lib/credits";
import { listModelImages } from "@/lib/storage";
import { CREDIT_COSTS, Model } from "@/types";

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
    .in("status", ["pending", "failed"])
    .single();

  if (!model) {
    return NextResponse.json(
      { error: "Model not found or already training/ready" },
      { status: 404 }
    );
  }

  const m = model as Model;
  const imageUrls = await listModelImages(supabase, user.id, id);

  if (imageUrls.length < 10) {
    return NextResponse.json(
      { error: `Only ${imageUrls.length} uploaded images found; need at least 10.` },
      { status: 400 }
    );
  }

  const { success, balance } = await deductCredits(
    supabase,
    user.id,
    "TRAINING",
    `Train model: ${m.name}`
  );

  if (!success) {
    return NextResponse.json({ error: "Insufficient credits" }, { status: 402 });
  }

  try {
    const publicUrl = process.env.ASTRIA_WEBHOOK_PUBLIC_URL;
    const webhookUrl = publicUrl
      ? `${publicUrl}/api/webhooks/astria?secret=${process.env.ASTRIA_WEBHOOK_SECRET}`
      : undefined;

    const tune = await createTune({
      title: m.name,
      imageUrls,
      webhookUrl,
    });

    const serviceClient = await createServiceClient();
    await serviceClient
      .from("models")
      .update({
        status: "training",
        astria_tune_id: tune.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    await serviceClient.from("model_images").delete().eq("model_id", id);
    await serviceClient
      .from("model_images")
      .insert(imageUrls.map((url) => ({ model_id: id, url })));

    return NextResponse.json({ tuneId: tune.id, balance });
  } catch (err) {
    console.error("Retry training failed:", err);

    const serviceClient = await createServiceClient();
    await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.TRAINING,
      p_stripe_session_id: null,
      p_description: `Refund for failed training: ${m.name}`,
    });

    const message = err instanceof Error ? err.message : "Failed to start training";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
