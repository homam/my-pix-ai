import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import { Model, GeneratedImage } from "@/types";
import { GenerateSection } from "@/components/GenerateSection";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { TrainingProgress } from "@/components/TrainingProgress";
import { RetryTrainingButton } from "@/components/RetryTrainingButton";
import { ModelThumbs } from "@/components/ModelThumbs";
import { getBalance } from "@/lib/credits";
import { listModelImages } from "@/lib/storage";
import { CREDIT_COSTS } from "@/types";

export default async function ModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: model }, { data: images }] = await Promise.all([
    supabase
      .from("models")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("generated_images")
      .select("*")
      .eq("model_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (!model) notFound();

  const balance = await getBalance(supabase, user.id);
  const uploadedImages =
    (model as Model).status === "pending" || (model as Model).status === "failed"
      ? await listModelImages(supabase, user.id, id)
      : [];

  return (
    <div className="p-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold">{(model as Model).name}</h1>
            <ModelStatusBadge status={(model as Model).status} />
          </div>
          <p className="text-gray-400 text-sm">
            Created{" "}
            {new Date((model as Model).created_at).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      {(model as Model).status === "ready" ? (
        <GenerateSection
          model={model as Model}
          generatedImages={(images as GeneratedImage[]) ?? []}
          creditBalance={balance}
          creditCost={CREDIT_COSTS.GENERATION}
        />
      ) : (model as Model).status === "training" ? (
        <TrainingProgress modelId={(model as Model).id} />
      ) : (model as Model).status === "failed" ? (
        <div className="space-y-6">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-6">
            <h2 className="text-lg font-medium text-red-300 mb-2">
              Training failed
            </h2>
            <p className="text-gray-400 text-sm">
              Something went wrong during training. Your credits were refunded.
              Retry with the same photos below.
            </p>
          </div>

          {uploadedImages.length > 0 && (
            <div>
              <p className="text-sm text-gray-400 mb-3">
                {uploadedImages.length} uploaded photo
                {uploadedImages.length === 1 ? "" : "s"}
              </p>
              <ModelThumbs urls={uploadedImages} limit={uploadedImages.length} />
            </div>
          )}

          <div className="flex justify-center pt-2">
            <RetryTrainingButton
              modelId={(model as Model).id}
              label="Retry training"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-white/5 border border-white/10 rounded-xl p-6 text-center">
            <p className="text-gray-400 text-sm">
              {uploadedImages.length >= 10
                ? "Photos are uploaded but training hasn't started yet. Click below to kick it off."
                : "Model hasn't finished uploading photos. Go back to the dashboard and create a new model with photos."}
            </p>
          </div>

          {uploadedImages.length > 0 && (
            <div>
              <p className="text-sm text-gray-400 mb-3">
                {uploadedImages.length} uploaded photo
                {uploadedImages.length === 1 ? "" : "s"}
              </p>
              <ModelThumbs urls={uploadedImages} limit={uploadedImages.length} />
            </div>
          )}

          {uploadedImages.length >= 10 && (
            <div className="flex justify-center pt-2">
              <RetryTrainingButton modelId={(model as Model).id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
