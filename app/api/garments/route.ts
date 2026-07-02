import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createGarmentTune, getTune } from "@/lib/astria";
import { deductCredits } from "@/lib/credits";
import { storagePathFromUrl } from "@/lib/storage";
import { makeLogger, errInfo } from "@/lib/log";
import { CREDIT_COSTS } from "@/types";
import { z } from "zod";

export const maxDuration = 60;

const createSchema = z.object({
  title: z.string().min(2).max(80),
  imageUrl: z.string().url(),
});

export async function GET() {
  const log = makeLogger("api/garments");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized", reqId: log.reqId }, { status: 401 });
  }

  const { data: garments, error } = await supabase
    .from("garment_tunes")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    log.error("garments_list_failed", { userId: user.id, pgMessage: error.message });
    return NextResponse.json({ error: error.message, reqId: log.reqId }, { status: 500 });
  }

  // Faceid tunes finish fast but not instantly — refresh any still pending.
  const refreshed = await Promise.all(
    (garments ?? []).map(async (g) => {
      if (g.status !== "pending" || !g.astria_tune_id) return g;
      try {
        const tune = await getTune(g.astria_tune_id);
        if (tune.trained_at) {
          const serviceClient = await createServiceClient();
          await serviceClient
            .from("garment_tunes")
            .update({ status: "ready" })
            .eq("id", g.id);
          return { ...g, status: "ready" };
        }
      } catch (err) {
        log.warn("garment_refresh_failed", { garmentId: g.id, ...errInfo(err) });
      }
      return g;
    })
  );

  return NextResponse.json({ garments: refreshed, reqId: log.reqId });
}

export async function POST(req: NextRequest) {
  const log = makeLogger("api/garments");
  log.info("request_received");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized", reqId: log.reqId }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", reqId: log.reqId }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten(), reqId: log.reqId },
      { status: 400 }
    );
  }

  const { title, imageUrl } = parsed.data;

  // Garment photos must come from the caller's own storage folder.
  const path = storagePathFromUrl(imageUrl);
  if (!path || !path.startsWith(`${user.id}/`)) {
    log.warn("disallowed_garment_url", { userId: user.id, imageUrl });
    return NextResponse.json(
      { error: "Image URL not allowed", reqId: log.reqId },
      { status: 400 }
    );
  }

  const { success } = await deductCredits(
    supabase,
    user.id,
    "GARMENT",
    `Garment fine-tune: ${title}`
  );
  if (!success) {
    return NextResponse.json(
      { error: "Insufficient credits", reqId: log.reqId },
      { status: 402 }
    );
  }

  const refund = async (reason: string) => {
    const serviceClient = await createServiceClient();
    await serviceClient.rpc("add_credits", {
      p_user_id: user.id,
      p_amount: CREDIT_COSTS.GARMENT,
      p_stripe_session_id: null,
      p_description: `Refund (${reason})`,
    });
  };

  try {
    const tune = await createGarmentTune({ title, imageUrl });
    const { data: inserted, error: insertErr } = await supabase
      .from("garment_tunes")
      .insert({
        user_id: user.id,
        title,
        astria_tune_id: tune.id,
        status: tune.trained_at ? "ready" : "pending",
        image_url: imageUrl,
      })
      .select()
      .single();

    if (insertErr) {
      log.error("garment_insert_failed", { userId: user.id, pgMessage: insertErr.message });
      await refund("failed to save garment");
      return NextResponse.json(
        { error: `Failed to save garment: ${insertErr.message}`, reqId: log.reqId },
        { status: 500 }
      );
    }

    log.info("garment_created", { userId: user.id, garmentId: inserted.id, tuneId: tune.id });
    return NextResponse.json({ garment: inserted, reqId: log.reqId });
  } catch (err) {
    const info = errInfo(err);
    log.error("garment_create_failed", { userId: user.id, ...info });
    await refund("garment_create_failed");
    return NextResponse.json(
      { error: info.message || "Garment creation failed", reqId: log.reqId },
      { status: 500 }
    );
  }
}
