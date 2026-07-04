import { SupabaseClient } from "@supabase/supabase-js";
import { createPlatformAdmin, InsufficientCreditsError } from "@aionized/platform-client/server";
import { CREDIT_COSTS } from "@/types";
import { BRAND } from "@/lib/brand";

/**
 * MyPix's credit wallet lives in the shared aionized platform (core.wallets, brand = "mypix"),
 * not a MyPix-only table. `supabase` must be a service-role client (see
 * lib/supabase/server.ts createServiceClient) — these RPCs are SECURITY DEFINER and require an
 * explicit user id.
 */
function platform(supabase: SupabaseClient<any, any, any>) {
  return createPlatformAdmin(supabase, BRAND.key);
}

export async function getBalance(
  supabase: SupabaseClient<any, any, any>,
  userId: string
): Promise<number> {
  return platform(supabase).ensureWallet(userId);
}

/**
 * Atomically deducts `CREDIT_COSTS[type] * count` credits. On insufficient balance, returns
 * `success: false` with the user's actual current balance (so callers can show "you have X,
 * need Y") rather than a sentinel.
 */
export async function deductCredits(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  type: keyof typeof CREDIT_COSTS,
  description: string,
  count = 1
): Promise<{ success: boolean; balance: number }> {
  const cost = CREDIT_COSTS[type] * count;
  const p = platform(supabase);

  try {
    const balance = await p.spendCredits(userId, cost, type.toLowerCase(), description);
    return { success: true, balance };
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      return { success: false, balance: await p.ensureWallet(userId) };
    }
    throw e;
  }
}

/** Grants credits from any source — purchase (stripeSessionId set) or refund/promo/admin
 * (stripeSessionId omitted). `description` becomes the ledger's `reason`. */
export async function addCredits(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  amount: number,
  stripeSessionId: string | null,
  description: string
): Promise<void> {
  await platform(supabase).grantCredits(userId, amount, description, stripeSessionId ?? undefined);
}
