"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers, Loader2, Plus } from "lucide-react";
import type { ComposeClientConfig } from "@/lib/composite/config";
import type { GroupCard } from "@/lib/composite/view";
import { GroupDraft, type DraftHandle, type DraftStatus } from "@/components/studio/compose/GroupDraft";
import { StatusBadge } from "@/components/studio/compose/parts";

export function ComposeTool({
  config,
  projects,
  creditBalance,
}: {
  config: ComposeClientConfig;
  projects: GroupCard[];
  creditBalance: number;
}) {
  const [drafts, setDrafts] = useState<string[]>(() => [crypto.randomUUID()]);
  const [status, setStatus] = useState<Record<string, DraftStatus>>({});
  const [spent, setSpent] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const handles = useRef(new Map<string, DraftHandle>());

  // Stable per-draft callbacks so a child's effects don't re-run every render.
  const callbacks = useMemo(() => new Map<string, {
    onStatus: (s: DraftStatus) => void;
    onHandle: (h: DraftHandle | null) => void;
  }>(), []);
  const callbacksFor = useCallback(
    (key: string) => {
      let cb = callbacks.get(key);
      if (!cb) {
        cb = {
          onStatus: (s) =>
            setStatus((prev) =>
              prev[key]?.ready === s.ready && prev[key]?.working === s.working ? prev : { ...prev, [key]: s }
            ),
          onHandle: (h) => {
            if (h) handles.current.set(key, h);
            else handles.current.delete(key);
          },
        };
        callbacks.set(key, cb);
      }
      return cb;
    },
    [callbacks]
  );
  const onCharged = useCallback((n: number) => setSpent((s) => s + n), []);
  // A fresh server balance already includes everything charged so far.
  useEffect(() => setSpent(0), [creditBalance]);

  const readyKeys = drafts.filter((k) => status[k]?.ready);
  const total = readyKeys.length * config.cost;
  const balance = creditBalance - spent;

  async function generateAll() {
    setSubmitting(true);
    try {
      // One at a time: each start() saves the group's selection, then queues it.
      for (const key of readyKeys) await handles.current.get(key)?.start();
    } finally {
      setSubmitting(false);
      router.refresh(); // the sidebar's credit balance is server-rendered
    }
  }

  if (!config.enabled) {
    return (
      <p className="text-sm text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
        Composites are not enabled on this server yet.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <div className="text-sm text-gray-400 space-y-1">
        <p>Each group becomes one composite. Make several groups and render them together.</p>
        <p className="text-xs text-gray-500">
          After it renders, every composite is checked against your photos. Ask for a specific fix in plain words
          and it is saved as a new version; earlier versions stay downloadable.
        </p>
      </div>

      {projects.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Your composites</p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {projects.map(({ group, previewUrl }) => (
              <Link
                key={group.id}
                href={`/studio/composites/${group.id}`}
                className="shrink-0 w-48 rounded-xl overflow-hidden border border-white/10 hover:border-brand-500/40 transition-colors"
              >
                <div className="h-24 bg-black/40 flex items-center justify-center">
                  {previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt={group.name} className="w-full h-full object-cover" />
                  ) : (
                    <Layers className="w-6 h-6 text-gray-600" />
                  )}
                </div>
                <div className="p-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-200 truncate">{group.name}</span>
                  <StatusBadge status={group.status} />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {drafts.map((key, i) => (
          <GroupDraft
            key={key}
            index={i}
            config={config}
            onStatus={callbacksFor(key).onStatus}
            onHandle={callbacksFor(key).onHandle}
            onCharged={onCharged}
            onRemove={() => {
              setDrafts((d) => (d.length > 1 ? d.filter((k) => k !== key) : [crypto.randomUUID()]));
              setStatus((s) => {
                const { [key]: _gone, ...rest } = s;
                return rest;
              });
            }}
          />
        ))}
        {drafts.length < 6 && (
          <button
            type="button"
            onClick={() => setDrafts((d) => [...d, crypto.randomUUID()])}
            className="w-full flex items-center justify-center gap-2 border border-dashed border-white/15 hover:border-white/30 rounded-2xl py-3 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <Plus className="w-4 h-4" /> Add another group
          </button>
        )}
      </div>

      <div className="sticky bottom-4 bg-[#111]/95 backdrop-blur border border-white/10 rounded-2xl p-4 flex items-center gap-4">
        <div className="flex-1 text-sm text-gray-400">
          {readyKeys.length === 0
            ? "Drop photos into a group to get started."
            : `${readyKeys.length} composite${readyKeys.length === 1 ? "" : "s"} · ${config.cost} credits each · ${config.providerLabel}`}
          {total > balance && <span className="block text-xs text-amber-300/90">Not enough credits — you have {balance}.</span>}
        </div>
        <button
          type="button"
          onClick={generateAll}
          disabled={readyKeys.length === 0 || submitting || total > balance}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-5 py-3 text-sm font-medium transition-colors"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
          Generate {readyKeys.length > 1 ? `${readyKeys.length} composites` : "composite"}
          {readyKeys.length > 0 && <span className="text-brand-200/80">· {total} credits</span>}
        </button>
      </div>
    </div>
  );
}
