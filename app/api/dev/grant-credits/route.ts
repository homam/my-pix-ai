import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { addCredits } from "@/lib/credits";

// Dev-only: grant yourself credits. Disabled when DEV_GRANT_CREDITS is "false".
export async function POST() {
  if (process.env.DEV_GRANT_CREDITS === "false") {
    return NextResponse.json({ error: "Disabled" }, { status: 403 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = await createServiceClient();
  await addCredits(service, user.id, 500, null, "Dev grant (+500)");

  return NextResponse.json({ ok: true, granted: 500 });
}
