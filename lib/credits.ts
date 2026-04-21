import { SupabaseClient } from "@supabase/supabase-js";
import { CREDIT_COSTS } from "@/types";

export async function getBalance(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { data } = await supabase
    .from("user_credits")
    .select("balance")
    .eq("user_id", userId)
    .single();
  return data?.balance ?? 0;
}

export async function deductCredits(
  supabase: SupabaseClient,
  userId: string,
  type: keyof typeof CREDIT_COSTS,
  description: string
): Promise<{ success: boolean; balance: number }> {
  const cost = CREDIT_COSTS[type];

  const { data, error } = await supabase.rpc("deduct_credits", {
    p_user_id: userId,
    p_amount: cost,
    p_type: type.toLowerCase(),
    p_description: description,
  });

  if (error || !data) return { success: false, balance: 0 };
  return { success: true, balance: data };
}

export async function addCredits(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  stripeSessionId: string,
  description: string
): Promise<void> {
  await supabase.rpc("add_credits", {
    p_user_id: userId,
    p_amount: amount,
    p_stripe_session_id: stripeSessionId,
    p_description: description,
  });
}
