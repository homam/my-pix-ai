import { SupabaseClient } from "@supabase/supabase-js";
import { createPlatformAdmin, InsufficientCreditsError } from "@aionized/platform-client/server";
import {
  CREDIT_COSTS,
  type CreditTransaction,
  type CreditHistoryRow,
  type CreditTransactionType,
} from "@/types";
import { BRAND } from "@/lib/brand";

/**
 * MyPix's credit wallet lives in the shared aionized platform (core.wallets, brand = "mypix"),
 * not a MyPix-only table.
 *
 * `supabase` MUST be a service-role client (lib/supabase/server.ts `createServiceClient`).
 * This is not a style preference — it is enforced by the database. The `core.*` credit RPCs
 * are SECURITY DEFINER, take the target user as a parameter, and carry no authorization check
 * of their own, so platform migration 0021 revoked EXECUTE on `ensure_wallet` /
 * `spend_credits` / `grant_credits` / `settle_payment` / `bind_entity` from PUBLIC; only
 * `service_role` may call them. Passing the RLS/anon client (`createClient`) fails with
 * `42501 permission denied for function`, and must never be re-enabled — a browser-reachable
 * key that can execute these could mint unlimited credits for any user on any product.
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

/**
 * Reshapes one raw `core.credit_transactions` row into the UI row rendered on /account.
 *
 * The ledger has no `type` column — the platform stores a signed `delta` plus free-text
 * `reason`/`ref`, and this app writes them asymmetrically (see above):
 *
 *   spend  → reason = the CREDIT_COSTS key lowercased ("training"|"generation"|"garment"),
 *            ref    = the human description ("Train model: Ada")
 *   grant  → reason = the human description ("Purchased Pro pack (400 credits)"),
 *            ref    = the Stripe checkout session id, or null for refunds/promos/admin grants
 *
 * Rows written by ops outside this app (reason "comp", "demo_provision", "starter", …) must
 * also render, so the sign of `delta` is the only thing treated as authoritative and every
 * reason lookup falls back to a generic bucket instead of dropping the row.
 */
export function creditHistoryRow(tx: CreditTransaction): CreditHistoryRow {
  const isCredit = tx.delta >= 0;
  const reason = tx.reason ?? "";

  let type: CreditTransactionType;
  if (!isCredit) {
    const spendTypes: CreditTransactionType[] = ["training", "generation", "garment"];
    type =
      spendTypes.find((t) => t === reason.toLowerCase()) ?? "spend";
  } else if (tx.ref?.startsWith("cs_")) {
    // Stripe checkout session id — the only ref addCredits() sets on a purchase.
    type = "purchase";
  } else if (/refund/i.test(reason)) {
    type = "refund";
  } else {
    type = "grant";
  }

  return {
    id: tx.id,
    created_at: tx.created_at,
    type,
    // The human-readable half lives in `ref` for spends and in `reason` for grants.
    description: (isCredit ? reason : tx.ref) || reason || "—",
    amount: tx.delta,
  };
}

/**
 * Reads this user's credit history for THIS brand from the shared platform ledger.
 *
 * Unlike the wallet RPCs above, this one takes the **RLS** client: `core.credit_transactions`
 * is a plain table with `credit_tx_select_own` (`auth.uid() = user_id`) and a SELECT grant to
 * `authenticated`, so a user-scoped read is exactly what RLS is for — no service role needed.
 *
 * It must be read out of schema `core` explicitly. Every client in this app is built with
 * `db: { schema: "mypix" }`, so a bare `.from("credit_transactions")` resolves to
 * `mypix.credit_transactions`, which does not exist. The brand filter matters too: wallets are
 * per (user, brand) and a user may hold credits on a sibling brand of another product, which
 * must never appear in this brand's history.
 */
export async function listCreditHistory(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  limit = 100
): Promise<CreditHistoryRow[]> {
  const { data, error } = await supabase
    .schema("core")
    .from("credit_transactions")
    .select("id, user_id, delta, reason, ref, created_at, brand")
    .eq("user_id", userId)
    .eq("brand", BRAND.key)
    .order("created_at", { ascending: false })
    .limit(limit);

  // Surface it. A swallowed Supabase error here reads as "No transactions yet", which is how
  // this bug (and its siblings on the other products) stayed invisible for so long.
  if (error) {
    throw new Error(
      `listCreditHistory failed (${error.code ?? "?"}): ${error.message}`
    );
  }

  return ((data as CreditTransaction[]) ?? []).map(creditHistoryRow);
}
