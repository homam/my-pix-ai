import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// Astria sends a POST to this URL when training completes
// Payload: { tune: AstriaTune } with tune.trained_at set on success
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");

  if (secret !== process.env.ASTRIA_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const tune = body?.tune ?? body;

  if (!tune?.id) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const supabase = await createServiceClient();

  // Find the model by astria_tune_id
  const { data: model } = await supabase
    .from("models")
    .select("*, user_id")
    .eq("astria_tune_id", tune.id)
    .single();

  if (!model) {
    console.warn(`No model found for tune ID ${tune.id}`);
    return NextResponse.json({ ok: true });
  }

  const isSuccess = !!tune.trained_at;
  const newStatus = isSuccess ? "ready" : "failed";

  await supabase
    .from("models")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", model.id);

  // Send email notification
  const { data: userData } = await supabase.auth.admin.getUserById(
    model.user_id
  );

  if (userData?.user?.email) {
    try {
      if (isSuccess) {
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: userData.user.email,
          subject: `Your AI model "${model.name}" is ready! ✨`,
          html: `
            <p>Great news! Your AI model <strong>${model.name}</strong> has finished training.</p>
            <p><a href="${process.env.NEXT_PUBLIC_APP_URL}/models/${model.id}">Click here to start generating photos →</a></p>
          `,
        });
      } else {
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: userData.user.email,
          subject: `Training failed for "${model.name}"`,
          html: `
            <p>Unfortunately, training your model <strong>${model.name}</strong> failed. Your credits have been refunded.</p>
            <p>Please try again or contact support at <a href="mailto:hello@mypix.ai">hello@mypix.ai</a>.</p>
          `,
        });

        // Refund credits
        await supabase.rpc("add_credits", {
          p_user_id: model.user_id,
          p_amount: 20, // CREDIT_COSTS.TRAINING
          p_stripe_session_id: null,
          p_description: `Refund for failed training: ${model.name}`,
        });
      }
    } catch (emailErr) {
      console.error("Failed to send email:", emailErr);
    }
  }

  return NextResponse.json({ ok: true });
}
