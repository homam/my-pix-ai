import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { generateImages } from "@/lib/astria";
import { deductCredits } from "@/lib/credits";
import { z } from "zod";

const schema = z.object({
  modelId: z.string().uuid(),
  prompt: z.string().min(3).max(500),
  numImages: z.number().int().min(1).max(8).default(4),
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

  const { modelId, prompt, numImages } = parsed.data;

  // Verify model belongs to user and is ready
  const { data: model } = await supabase
    .from("models")
    .select("astria_tune_id")
    .eq("id", modelId)
    .eq("user_id", user.id)
    .eq("status", "ready")
    .single();

  if (!model?.astria_tune_id) {
    return NextResponse.json(
      { error: "Model not found or not ready" },
      { status: 404 }
    );
  }

  // Deduct credits (1 per image)
  const totalCost = numImages;
  const { data: credits } = await supabase
    .from("user_credits")
    .select("balance")
    .eq("user_id", user.id)
    .single();

  if (!credits || credits.balance < totalCost) {
    return NextResponse.json({ error: "Insufficient credits" }, { status: 402 });
  }

  const { success } = await deductCredits(
    supabase,
    user.id,
    "GENERATION",
    `Generate ${numImages} image(s): ${prompt.slice(0, 50)}`
  );

  if (!success) {
    return NextResponse.json({ error: "Insufficient credits" }, { status: 402 });
  }

  try {
    const astriaPrompt = await generateImages({
      tuneId: model.astria_tune_id,
      prompt,
      numImages,
    });

    // Store generated images
    const serviceClient = await createServiceClient();
    const imageRows = astriaPrompt.images.map((url) => ({
      model_id: modelId,
      user_id: user.id,
      prompt,
      url,
      astria_image_id: String(astriaPrompt.id),
    }));

    const { data: inserted } = await serviceClient
      .from("generated_images")
      .insert(imageRows)
      .select();

    return NextResponse.json({ images: inserted ?? [] });
  } catch (err) {
    console.error("Generation failed:", err);
    return NextResponse.json(
      { error: "Image generation failed" },
      { status: 500 }
    );
  }
}
