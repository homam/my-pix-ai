import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";
import { Model } from "@/types";
import { ModelCard } from "@/components/ModelCard";
import { listModelImages } from "@/lib/storage";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: models } = await supabase
    .from("models")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const modelList = (models as Model[]) ?? [];
  const thumbsByModel = Object.fromEntries(
    await Promise.all(
      modelList
        .filter((m) => !m.cover_image_url)
        .map(async (m) => [m.id, await listModelImages(supabase, user.id, m.id)] as const)
    )
  );

  const params = await searchParams;
  const paymentSuccess = params.payment === "success";

  return (
    <div className="p-8">
      {paymentSuccess && (
        <div className="mb-6 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 text-sm text-green-300">
          Payment successful! Credits have been added to your account.
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">My Models</h1>
          <p className="text-gray-400 text-sm mt-1">
            Train a personal AI model on your likeness, then generate photos.
          </p>
        </div>
        <Link
          href="/models/new"
          className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          New model
        </Link>
      </div>

      {modelList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-purple-500/10 rounded-2xl flex items-center justify-center mb-4">
            <Sparkles className="w-8 h-8 text-purple-400" />
          </div>
          <h2 className="text-xl font-semibold mb-2">No models yet</h2>
          <p className="text-gray-400 text-sm mb-6 max-w-sm">
            Create your first AI model by uploading 15–25 photos of yourself.
            Training takes about 10 minutes.
          </p>
          <Link
            href="/models/new"
            className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white px-6 py-3 rounded-xl font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create your first model
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {modelList.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              thumbnailUrls={thumbsByModel[model.id] ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}
