"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/brand/Logo";

/**
 * Landing page for the password-recovery email. The link goes through
 * /auth/callback?next=/reset-password, which exchanges the code for a session —
 * so by the time we render, a valid link means we have a signed-in user and
 * updateUser({ password }) works. No session = expired/invalid link.
 */
export default function ResetPasswordPage() {
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getSession()
      .then(({ data: { session } }) => {
        // Non-anonymous only: other apps on the shared Supabase project may have minted
        // an anonymous session for this domain, and that user must not get a password.
        setHasSession(!!session?.user && !session.user.is_anonymous);
        setChecking(false);
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await createClient().auth.updateUser({ password });
    if (error) {
      setLoading(false);
      setError(error.message);
      return;
    }
    // Recovery session is now a normal session — continue into the app.
    window.location.assign("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Logo href="/" className="justify-center mb-10" />

        <div className="bg-white/3 border border-white/10 rounded-2xl p-8">
          {checking ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
            </div>
          ) : !hasSession ? (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-2">Link expired</h1>
              <p className="text-gray-400 text-sm mb-6">
                This password-reset link is invalid or has expired. Request a
                new one from the sign-in page.
              </p>
              <Link
                href="/login"
                className="text-sm text-brand-400 hover:text-brand-300"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold mb-1">Choose a new password</h1>
              <p className="text-gray-400 text-sm mb-8">
                Enter a new password for your account.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="password"
                    className="block text-sm font-medium mb-2"
                  >
                    New password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
                  />
                  <p className="text-xs text-gray-600 mt-2">At least 8 characters.</p>
                </div>

                {error && (
                  <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading || password.length < 8}
                  className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 px-6 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  Set new password
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
