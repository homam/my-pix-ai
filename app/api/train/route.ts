import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createTune } from "@/lib/astria";
import { deductCredits } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import { z } from "zod";

const schema = z.object({
  modelId: z.string().uuid(),
  imageUrls: z.array(z.string().url()).min(10).max(40),
  modelName: z.string().min(1).max(60),
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
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { modelId, imageUrls, modelName } = parsed.data;

  // Verify model ownership and pending status
  const { data: model } = await supabase
    .from("models")
    .select("*")
    .eq("id", modelId)
    .eq("user_id", user.id)
    .eq("status", "pending")
    .single();

  if (!model) {
    return NextResponse.json(
      { error: "Model not found or not in pending state" },
      { status: 404 }
    );
  }

  // Deduct credits
  const { success, balance } = await deductCredits(
    supabase,
    user.id,
    "TRAINING",
    `Train model: ${modelName}`
  );

  if (!success) {
    return NextResponse.json({ error: "Insufficient credits" }, { status: 402 });
  }

  try {
    // Only register webhook if a publicly-reachable URL is configured.
    // In local dev (no ngrok), we rely on the polling endpoint instead.
    const publicUrl = process.env.ASTRIA_WEBHOOK_PUBLIC_URL;
    const webhookUrl = publicUrl
      ? `${publicUrl}/api/webhooks/astria?secret=${process.env.ASTRIA_WEBHOOK_SECRET}`
      : undefined;

    const tune = await createTune({
      title: modelName,
      imageUrls,
      webhookUrl,
    });

    // Update model with Astria tune ID and training status
    const serviceClient = await createServiceClient();
    await serviceClient
      .from("models")
      .update({
        status: "training",
        astria_tune_id: tune.id,
        name: modelName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", modelId);

    // Store uploaded image URLs
    const imageRows = imageUrls.map((url) => ({
      model_id: modelId,
      url,
    }));
    await serviceClient.from("model_images").insert(imageRows);

    return NextResponse.json({ tuneId: tune.id, balance });
  } catch (err) {
    console.error("Training submission failed:", err);

    // Refund credits on failure
    const serviceClient = await createServiceClient();
    await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.TRAINING,
      p_stripe_session_id: null,
      p_description: `Refund for failed training: ${modelName}`,
    });

    return NextResponse.json(
      { error: "Failed to start training" },
      { status: 500 }
    );
  }
}
