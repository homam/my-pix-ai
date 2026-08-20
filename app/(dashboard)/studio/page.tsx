import { createClient, createServiceClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { StudioTools } from "@/components/studio/StudioTools";
import { getBalance } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import type { Model, GeneratedImage, GarmentTune } from "@/types";

const TOOL_IDS = ["faceswap", "inpaint", "outpaint", "restore", "tryon"] as const;
type ToolId = (typeof TOOL_IDS)[number];

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ tool?: string; src?: string }>;
}) {
  const { tool, src } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: models }, { data: garments }, { data: recentImages }] =
    await Promise.all([
      supabase
        .from("models")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "ready")
        .order("created_at", { ascending: false }),
      supabase
        .from("garment_tunes")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("generated_images")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(24),
    ]);

  const balance = await getBalance(await createServiceClient(), user.id);
  const initialTool = TOOL_IDS.includes(tool as ToolId)
    ? (tool as ToolId)
    : undefined;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Studio</h1>
        <p className="text-gray-400 text-sm">
          Edit photos with AI — swap faces, replace backgrounds, uncrop,
          restore old photos, try on outfits.
        </p>
      </div>

      <StudioTools
        models={(models as Model[]) ?? []}
        garments={(garments as GarmentTune[]) ?? []}
        recentImages={(recentImages as GeneratedImage[]) ?? []}
        creditBalance={balance}
        garmentCost={CREDIT_COSTS.GARMENT}
        initialTool={initialTool}
        initialSourceUrl={src}
      />
    </div>
  );
}
