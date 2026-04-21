import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import { Model, GeneratedImage } from "@/types";
import { GenerateSection } from "@/components/GenerateSection";
import { ModelStatusBadge } from "@/components/ModelStatusBadge";
import { getBalance } from "@/lib/credits";
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
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-8 text-center">
          <div className="w-12 h-12 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h2 className="text-lg font-medium mb-2">Training in progress</h2>
          <p className="text-gray-400 text-sm">
            Your model is being trained. This usually takes 10–15 minutes.
            You&apos;ll receive an email when it&apos;s ready.
          </p>
        </div>
      ) : (model as Model).status === "failed" ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-8 text-center">
          <h2 className="text-lg font-medium text-red-300 mb-2">
            Training failed
          </h2>
          <p className="text-gray-400 text-sm">
            Something went wrong during training. Your credits have been
            refunded. Please try again or contact support.
          </p>
        </div>
      ) : (
        <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center">
          <p className="text-gray-400 text-sm">
            Model is queued for training. This may take a moment to start.
          </p>
        </div>
      )}
    </div>
  );
}
