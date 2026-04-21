import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createCheckoutSession,
  isStripeConfigured,
} from "@/lib/stripe";
import { z } from "zod";

const schema = z.object({ packId: z.string() });

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Payments are not enabled on this deployment." },
      { status: 503 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid pack" }, { status: 400 });
  }

  try {
    const url = await createCheckoutSession(
      parsed.data.packId,
      user.id,
      user.email
    );
    return NextResponse.json({ url });
  } catch (err) {
    console.error("Checkout session creation failed:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
