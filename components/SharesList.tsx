"use client";

import { useState } from "react";
import { Copy, Check, Trash2, Loader2, Eye, ExternalLink } from "lucide-react";

export interface ShareRow {
  slug: string;
  prompt: string;
  view_count: number;
  created_at: string;
  thumbUrl: string | null;
}

export function SharesList({ shares: initial }: { shares: ShareRow[] }) {
  const [shares, setShares] = useState<ShareRow[]>(initial);
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  if (shares.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        You haven&apos;t created any share links yet. Open a generated photo and hit
        Share to make one.
      </p>
    );
  }

  function shareUrl(slug: string): string {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/s/${slug}`;
  }

  async function copy(slug: string) {
    try {
      await navigator.clipboard.writeText(shareUrl(slug));
      setCopied(slug);
      setTimeout(() => setCopied((c) => (c === slug ? null : c)), 1500);
    } catch {
      // ignore — user can still open the link
    }
  }

  async function revoke(slug: string) {
    setRevoking(slug);
    try {
      const res = await fetch(`/api/shares/${slug}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setShares((prev) => prev.filter((s) => s.slug !== slug));
    } catch {
      setRevoking(null);
    }
  }

  return (
    <div className="space-y-2">
      {shares.map((s) => (
        <div
          key={s.slug}
          className="flex items-center gap-3 bg-white/3 border border-white/8 rounded-xl p-3"
        >
          <div className="w-12 h-12 rounded-lg overflow-hidden bg-white/5 shrink-0">
            {s.thumbUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={s.thumbUrl}
                alt={s.prompt}
                className="w-full h-full object-cover"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm truncate">{s.prompt}</p>
            <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
              <span className="inline-flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" />
                {s.view_count.toLocaleString()}
              </span>
              <span>
                {new Date(s.created_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <span className="font-mono text-gray-600">/s/{s.slug}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => copy(s.slug)}
              title="Copy link"
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
            >
              {copied === s.slug ? (
                <Check className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4 text-gray-300" />
              )}
            </button>
            <a
              href={`/s/${s.slug}`}
              target="_blank"
              rel="noreferrer"
              title="Open share page"
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-colors"
            >
              <ExternalLink className="w-4 h-4 text-gray-300" />
            </a>
            <button
              type="button"
              onClick={() => revoke(s.slug)}
              disabled={revoking === s.slug}
              title="Revoke link"
              className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-red-500/30 flex items-center justify-center transition-colors disabled:opacity-50"
            >
              {revoking === s.slug ? (
                <Loader2 className="w-4 h-4 animate-spin text-gray-300" />
              ) : (
                <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-400" />
              )}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
