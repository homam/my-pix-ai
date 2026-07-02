import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AllPhotosGallery } from "@/components/AllPhotosGallery";
import type { GeneratedImage } from "@/types";

export default async function PhotosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: images }, { data: models }] = await Promise.all([
    supabase
      .from("generated_images")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("models").select("id, name").eq("user_id", user.id),
  ]);

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">All photos</h1>
        <p className="text-gray-400 text-sm">
          Everything you&apos;ve generated and edited, across all models and
          studio tools.
        </p>
      </div>

      <AllPhotosGallery
        images={(images as GeneratedImage[]) ?? []}
        models={models ?? []}
      />
    </div>
  );
}
