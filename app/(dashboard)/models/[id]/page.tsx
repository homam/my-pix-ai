import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import { Model, GeneratedImage } from "@/types";
import { GenerateSection } from "@/components/GenerateSection";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { TrainingProgress } from "@/components/TrainingProgress";
import { RetryTrainingButton } from "@/components/RetryTrainingButton";
import { RetrainPanel } from "@/components/RetrainPanel";
import { DeleteModelButton } from "@/components/DeleteModelButton";
import { ModelThumbs } from "@/components/ModelThumbs";
import { getBalance } from "@/lib/credits";
import { listModelImages } from "@/lib/storage";
import { isFalConfigured } from "@/lib/fal";
import { CREDIT_COSTS } from "@/types";
import { RefreshCw } from "lucide-react";

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

  const m = model as Model;
  const balance = await getBalance(supabase, user.id);
  const currentProvider = m.provider === "fal" ? "fal" : "astria";
  const ultraAvailable = isFalConfigured();

  // Stored photos back the "reuse photos" retrain option and the failed/expired
  // thumbnails. No need to list them while training is in flight.
  const uploadedImages =
    m.status !== "training" ? await listModelImages(supabase, user.id, id) : [];
  const storedPhotoCount = uploadedImages.length;

  return (
    <div className="p-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold">{m.name}</h1>
            <ModelStatusBadge status={m.status} />
          </div>
          <p className="text-gray-400 text-sm">
            Created{" "}
            {new Date(m.created_at).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <DeleteModelButton modelId={m.id} modelName={m.name} />
      </div>

      {m.status === "ready" ? (
        <div className="space-y-8">
          <GenerateSection
            model={m}
            generatedImages={(images as GeneratedImage[]) ?? []}
            creditBalance={balance}
            creditCost={CREDIT_COSTS.GENERATION}
          />

          {/* Retrain a healthy model: re-roll, swap engine, or refresh photos. */}
          <details className="border-t border-white/10 pt-6">
            <summary className="cursor-pointer select-none text-sm font-medium text-gray-300 hover:text-white flex items-center gap-2">
              <RefreshCw className="w-4 h-4" />
              Retrain{ultraAvailable ? " or switch engine" : ""}
            </summary>
            <div className="mt-4 max-w-xl">
              <p className="text-sm text-gray-400 mb-4">
                Re-run training to refresh this model
                {ultraAvailable ? ", switch engine," : ""} or replace its photos.
                It goes offline until training finishes.
              </p>
              <RetrainPanel
                modelId={m.id}
                currentProvider={currentProvider}
                storedPhotoCount={storedPhotoCount}
                ultraAvailable={ultraAvailable}
                creditBalance={balance}
              />
            </div>
          </details>
        </div>
      ) : m.status === "training" ? (
        <TrainingProgress modelId={m.id} startedAt={m.updated_at} />
      ) : m.status === "failed" ? (
        <div className="space-y-6">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-6">
            <h2 className="text-lg font-medium text-red-300 mb-2">
              Training failed
            </h2>
            <p className="text-gray-400 text-sm">
              Something went wrong during training and your credits were refunded.
              Retrain below — reuse the same photos or upload a fresh set.
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

          <div className="max-w-xl">
            <RetrainPanel
              modelId={m.id}
              currentProvider={currentProvider}
              storedPhotoCount={storedPhotoCount}
              ultraAvailable={ultraAvailable}
              creditBalance={balance}
            />
          </div>
        </div>
      ) : m.status === "expired" ? (
        <div className="space-y-6">
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-6">
            <h2 className="text-lg font-medium text-amber-300 mb-2">
              This model has expired
            </h2>
            <p className="text-gray-400 text-sm">
              Trained models are kept by our image provider for about 30 days.
              This one&apos;s training data was removed, so it can&apos;t generate
              new photos until it&apos;s retrained. Retrain below — your uploaded
              photos are still here. Photos you already generated stay in your
              library.
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

          <div className="max-w-xl">
            <RetrainPanel
              modelId={m.id}
              currentProvider={currentProvider}
              storedPhotoCount={storedPhotoCount}
              ultraAvailable={ultraAvailable}
              creditBalance={balance}
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
              <RetryTrainingButton modelId={m.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
