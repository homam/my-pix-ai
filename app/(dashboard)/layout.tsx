import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { LayoutDashboard, Plus, LogOut, Coins, User, Wand2, Images } from "lucide-react";
import { getBalance } from "@/lib/credits";
import { Logo } from "@/components/brand/Logo";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Credit RPCs are service_role-only (migration 0021 revoked EXECUTE from PUBLIC),
  // so the balance read must go through the service client, never the RLS one.
  const balance = await getBalance(await createServiceClient(), user.id);

  async function signOut() {
    "use server";
    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-white/5 flex flex-col shrink-0">
        <div className="p-6 border-b border-white/5">
          <Logo size="md" href="/" />
        </div>

        <nav className="flex-1 p-4 space-y-1">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <LayoutDashboard className="w-4 h-4" />
            My Models
          </Link>
          <Link
            href="/models/new"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Model
          </Link>
          <Link
            href="/studio"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <Wand2 className="w-4 h-4" />
            Studio
          </Link>
          <Link
            href="/photos"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <Images className="w-4 h-4" />
            All Photos
          </Link>
          <Link
            href="/account"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <User className="w-4 h-4" />
            Account
          </Link>
        </nav>

        <div className="p-4 border-t border-white/5 space-y-3">
          {/* Credits */}
          <Link
            href="/pricing"
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-brand-500/10 border border-brand-500/20 hover:bg-brand-500/15 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Coins className="w-4 h-4 text-brand-400" />
              <span className="text-sm font-medium text-brand-300">
                {balance} credits
              </span>
            </div>
            <span className="text-xs text-brand-400">Get more</span>
          </Link>

          {/* User */}
          <div className="flex items-center justify-between px-3 py-2">
            <Link href="/account" className="min-w-0">
              <p className="text-xs text-gray-400 truncate hover:text-white transition-colors">
                {user.email}
              </p>
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="text-gray-600 hover:text-gray-300 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
