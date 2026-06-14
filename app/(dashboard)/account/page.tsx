import Link from "next/link";
import { redirect } from "next/navigation";
import { Coins } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBalance } from "@/lib/credits";
import { CreditTransaction } from "@/types";
import { SharesList, ShareRow } from "@/components/SharesList";
import { DeleteAccountButton } from "@/components/DeleteAccountButton";

const TYPE_LABELS: Record<CreditTransaction["type"], string> = {
  purchase: "Purchase",
  training: "Training",
  generation: "Generation",
  refund: "Refund",
};

export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [balance, { data: txns }, { data: shares }] = await Promise.all([
    getBalance(supabase, user.id),
    supabase
      .from("credit_transactions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("shares")
      .select("slug, prompt, image_ids, view_count, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const transactions = (txns as CreditTransaction[]) ?? [];

  // Build a thumbnail for each share from its first image.
  const shareRows: ShareRow[] = [];
  const shareList =
    (shares as { slug: string; prompt: string; image_ids: string[]; view_count: number; created_at: string }[]) ??
    [];
  const firstIds = shareList
    .map((s) => s.image_ids?.[0])
    .filter((id): id is string => Boolean(id));
  const thumbById = new Map<string, string>();
  if (firstIds.length > 0) {
    const { data: imgs } = await supabase
      .from("generated_images")
      .select("id, url")
      .in("id", firstIds);
    for (const img of (imgs as { id: string; url: string }[]) ?? []) {
      thumbById.set(img.id, img.url);
    }
  }
  for (const s of shareList) {
    shareRows.push({
      slug: s.slug,
      prompt: s.prompt,
      view_count: s.view_count,
      created_at: s.created_at,
      thumbUrl: thumbById.get(s.image_ids?.[0]) ?? null,
    });
  }

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">Account</h1>
      <p className="text-gray-400 text-sm mb-8">
        Manage your credits, history, and share links.
      </p>

      {/* Profile + balance */}
      <section className="bg-white/3 border border-white/8 rounded-2xl p-6 mb-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs text-gray-500">Signed in as</p>
            <p className="text-sm font-medium">{user.email}</p>
          </div>
          <Link
            href="/pricing"
            className="inline-flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/15 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Coins className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-purple-300">
                {balance} credits
              </span>
            </span>
            <span className="text-xs text-purple-400">Get more</span>
          </Link>
        </div>
      </section>

      {/* Credit history */}
      <section className="mb-8">
        <h2 className="font-semibold mb-3">Credit history</h2>
        {transactions.length === 0 ? (
          <p className="text-sm text-gray-500">No transactions yet.</p>
        ) : (
          <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-white/8">
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Description</th>
                  <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id} className="border-b border-white/5 last:border-b-0">
                    <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">
                      {new Date(t.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-gray-300">
                      {TYPE_LABELS[t.type] ?? t.type}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400 max-w-xs truncate">
                      {t.description}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono ${
                        t.amount >= 0 ? "text-green-400" : "text-gray-300"
                      }`}
                    >
                      {t.amount >= 0 ? `+${t.amount}` : t.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* My shares */}
      <section className="mb-8">
        <h2 className="font-semibold mb-3">My shares</h2>
        <SharesList shares={shareRows} />
      </section>

      {/* Danger zone */}
      <section className="border border-red-500/20 rounded-2xl p-6">
        <h2 className="font-semibold text-red-300 mb-1">Danger zone</h2>
        <p className="text-sm text-gray-400 mb-4">
          Permanently delete your account and all associated data.
        </p>
        <DeleteAccountButton email={user.email ?? ""} />
      </section>
    </div>
  );
}
