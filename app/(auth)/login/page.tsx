"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { BRAND } from "@/lib/brand";
import { Logo } from "@/components/brand/Logo";

const canPassword = BRAND.auth.methods.includes("password");
const canMagic = BRAND.auth.methods.includes("magic_link");

export default function LoginPage() {
  const [mode, setMode] = useState<"magic" | "password" | "reset">(canMagic ? "magic" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();

    if (mode === "password") {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) {
        setLoading(false);
        setError(error?.message ?? "Sign-in failed.");
        return;
      }
      // Full navigation so the server components pick up the new session cookies.
      window.location.assign("/dashboard");
      return;
    }

    if (mode === "reset") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      setLoading(false);
      if (error) setError(error.message);
      else setSent(true);
      return;
    }

    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <Logo href="/" className="justify-center mb-10" />

        {sent ? (
          <div className="bg-white/3 border border-white/10 rounded-2xl p-8 text-center">
            <div className="w-14 h-14 bg-brand-500/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">✉️</span>
            </div>
            <h2 className="text-xl font-semibold mb-2">Check your email</h2>
            <p className="text-gray-400 text-sm">
              {mode === "reset" ? (
                <>
                  We sent a password-reset link to{" "}
                  <span className="text-white">{email}</span>. Open it to choose
                  a new password.
                </>
              ) : (
                <>
                  We sent a magic link to{" "}
                  <span className="text-white">{email}</span>. Click it to sign in —
                  no password needed.
                </>
              )}
            </p>
            <button
              onClick={() => { setSent(false); setEmail(""); }}
              className="mt-6 text-sm text-brand-400 hover:text-brand-300"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <div className="bg-white/3 border border-white/10 rounded-2xl p-8">
            <h1 className="text-2xl font-bold mb-1">
              {mode === "reset" ? "Reset your password" : "Welcome back"}
            </h1>
            <p className="text-gray-400 text-sm mb-8">
              {mode === "reset"
                ? "Enter your email and we'll send you a link to choose a new password."
                : mode === "password"
                  ? "Sign in with the email and password you were given."
                  : "Sign in or create an account — it's the same form."}
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium mb-2"
                >
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
                />
              </div>

              {mode === "password" && (
                <div>
                  <label
                    htmlFor="password"
                    className="block text-sm font-medium mb-2"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
                  />
                </div>
              )}

              {error && (
                <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !email || (mode === "password" && !password)}
                className="w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 px-6 rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {mode === "password" ? "Sign in" : mode === "reset" ? "Send reset link" : "Send magic link"}
              </button>
            </form>

            {mode === "password" && (
              <p className="text-sm text-gray-500 text-center mt-4">
                <button
                  type="button"
                  onClick={() => { setMode("reset"); setError(null); }}
                  className="text-gray-400 hover:text-white"
                >
                  Forgot password?
                </button>
              </p>
            )}

            {mode === "reset" ? (
              <p className="text-sm text-gray-500 text-center mt-4">
                <button
                  type="button"
                  onClick={() => { setMode("password"); setError(null); }}
                  className="text-brand-400 hover:text-brand-300"
                >
                  Back to sign in
                </button>
              </p>
            ) : (
              canPassword &&
              canMagic && (
                <p className="text-sm text-gray-500 text-center mt-4">
                  {mode === "magic" ? (
                    <button
                      type="button"
                      onClick={() => { setMode("password"); setError(null); }}
                      className="text-brand-400 hover:text-brand-300"
                    >
                      Have a password? Sign in with it
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setMode("magic"); setError(null); }}
                      className="text-brand-400 hover:text-brand-300"
                    >
                      Email me a magic link instead
                    </button>
                  )}
                </p>
              )
            )}

            <p className="text-xs text-gray-600 text-center mt-6">
              By continuing, you agree to our{" "}
              <Link href="/terms" className="text-gray-400 hover:text-white">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-gray-400 hover:text-white">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
