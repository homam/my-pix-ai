import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { getBalance } from "@/lib/credits";
import { CREDIT_COSTS } from "@/types";
import { NewModelForm } from "@/components/NewModelForm";
import Link from "next/link";

export default async function NewModelPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const balance = await getBalance(supabase, user.id);
  const canTrain = balance >= CREDIT_COSTS.TRAINING;

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">Create a new AI model</h1>
        <p className="text-gray-400 text-sm">
          Upload 15–25 photos of yourself. We&apos;ll train a FLUX.1 LoRA on
          your likeness in about 10 minutes.
        </p>
      </div>

      {!canTrain ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6 text-center">
          <p className="text-yellow-300 font-medium mb-2">Not enough credits</p>
          <p className="text-gray-400 text-sm mb-4">
            Training a model costs {CREDIT_COSTS.TRAINING} credits. You have{" "}
            {balance}.
          </p>
          <Link
            href="/pricing"
            className="inline-block bg-purple-600 hover:bg-purple-500 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            Buy credits
          </Link>
        </div>
      ) : (
        <NewModelForm creditBalance={balance} />
      )}
    </div>
  );
}
