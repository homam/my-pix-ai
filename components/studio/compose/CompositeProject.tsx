"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Crosshair, Eraser, Layers, Loader2, MapPin, RotateCcw, Trash2, Wand2 } from "lucide-react";
import type { ComposeClientConfig } from "@/lib/composite/config";
import { composeApi, newIdempotencyKey, versionMediaUrl } from "@/lib/composite/client/api";
import { formatDims } from "@/lib/composite/dimensions";
import { formatTimestamp } from "@/lib/composite/selection";
import { isActiveJob } from "@/lib/composite/states";
import type { CorrectionMarks, ReviewIssue } from "@/lib/composite/types";
import type { GroupView, PublicJob, SourceView, VersionView } from "@/lib/composite/view";
import { MarkableImage } from "@/components/studio/compose/MarkableImage";
import { DownloadLinks, ReviewPanel, SourceTile, StatusBadge } from "@/components/studio/compose/parts";

const DEFAULT_R = 0.05;

export function CompositeProject({
  initial,
  config,
  creditBalance,
  initialVersion,
}: {
  initial: GroupView;
  config: ComposeClientConfig;
  creditBalance: number;
  initialVersion?: number;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const { group, sources, versions } = view;
  const latest = versions[versions.length - 1] ?? null;
  const [viewing, setViewing] = useState<string | null>(
    versions.find((v) => v.version_number === initialVersion)?.id ?? latest?.id ?? null
  );
  const current = versions.find((v) => v.id === viewing) ?? latest;
  const activeJob = view.jobs.find((j) => isActiveJob(j.status)) ?? null;
  const lastJob = view.jobs[0] ?? null;
  const [spent, setSpent] = useState(0);
  // A fresh server balance (router.refresh) already includes earlier charges.
  useEffect(() => setSpent(0), [creditBalance]);
  const balance = creditBalance - spent;

  // Correction form.
  const [instruction, setInstruction] = useState("");
  const [marks, setMarks] = useState<CorrectionMarks>({});
  const [marking, setMarking] = useState<"what" | "where" | null>(null);
  const [evidence, setEvidence] = useState<string[]>(() =>
    group.anchor_source_id ? [group.anchor_source_id] : []
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const stills = sources.filter((s) => s.kind !== "video" && s.status === "uploaded");
  const video = sources.find((s) => s.kind === "video");
  const mode = marks.what && marks.where ? "move" : marks.what ? "area" : "text";

  const refresh = useCallback(async () => {
    const next = await composeApi.getGroup(group.id);
    setView(next);
    return next;
  }, [group.id]);

  // Poll the active job; when it settles, reload the project and show the result.
  const activeId = activeJob?.id;
  useEffect(() => {
    if (!activeId) return;
    let stop = false;
    let seen: string | null = null;
    (async () => {
      while (!stop) {
        try {
          const r = await composeApi.job(activeId);
          if (stop) return;
          const changed = r.job.status !== seen;
          seen = r.job.status;
          if (changed && (!isActiveJob(r.job.status) || r.job.status === "review")) {
            const next = await refresh();
            if (r.job.version_id) setViewing(r.job.version_id);
            if (r.job.status === "failed") {
              setSpent((s) => s - r.job.cost_credits);
              router.refresh(); // the sidebar balance shows the refund
            }
            if (!next.jobs.some((j) => isActiveJob(j.status))) return;
          }
        } catch (err) {
          setError((err as Error).message);
        }
        await new Promise((res) => setTimeout(res, 4000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [activeId, refresh, router]);

  function label(s: SourceView): string {
    if (s.kind === "frame") return `Frame ${formatTimestamp(s.frame_time_s ?? 0)}`;
    return s.original_name;
  }

  function onMark(kind: "what" | "where", x: number, y: number) {
    setMarks((m) => (kind === "what" ? { ...m, what: { x, y, r: m.what?.r ?? DEFAULT_R } } : { ...m, where: { x, y } }));
    setMarking(kind === "what" ? "where" : null);
  }

  function fixIssue(issue: ReviewIssue) {
    setInstruction(issue.suggestedInstruction);
    setMarks({
      ...(issue.element ? { what: { ...issue.element, r: DEFAULT_R } } : {}),
      ...(issue.element && issue.target ? { where: issue.target } : {}),
    });
    setMarking(null);
    document.getElementById("correction")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function submitCorrection(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setError(null);
    setBusy("Starting correction…");
    const key = pendingKey ?? newIdempotencyKey();
    setPendingKey(key);
    try {
      const { duplicate } = await composeApi.correct(current.id, {
        idempotencyKey: key,
        instruction: instruction.trim(),
        mode,
        marks: mode === "text" ? null : marks,
        evidenceSourceIds: evidence.slice(0, config.maxEvidence),
      });
      if (!duplicate) setSpent((s) => s + config.cost);
      setPendingKey(null);
      setInstruction("");
      setMarks({});
      await refresh();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function renderAgain() {
    setError(null);
    setBusy("Starting render…");
    const key = pendingKey ?? newIdempotencyKey();
    setPendingKey(key);
    try {
      const { duplicate } = await composeApi.render(group.id, key);
      if (!duplicate) setSpent((s) => s + config.cost);
      setPendingKey(null);
      await refresh();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleSource(s: SourceView) {
    if (activeJob) return;
    try {
      setView(await composeApi.patchGroup(group.id, { selection: [{ id: s.id, selected: !s.selected, pinned: !s.selected }] }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function makeAnchor(s: SourceView) {
    if (activeJob) return;
    try {
      setView(
        await composeApi.patchGroup(group.id, {
          anchorSourceId: s.id,
          ...(s.selected ? {} : { selection: [{ id: s.id, selected: true, pinned: true }] }),
        })
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function cancel(job: PublicJob) {
    try {
      await composeApi.cancel(job.id);
      setSpent((s) => s - job.cost_credits);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Delete “${group.name}”, its uploads and all ${versions.length} version(s)? This can't be undone.`)) return;
    try {
      await composeApi.deleteGroup(group.id);
      router.push("/studio?tool=compose");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function lineage(v: VersionView): string {
    const used = v.reference_source_ids.map((id) => byId.get(id)).filter((s): s is SourceView => Boolean(s)).map(label);
    if (v.kind === "render") return `Rendered from ${used.length} source${used.length === 1 ? "" : "s"}: ${used.join(", ")}`;
    const parent = versions.find((p) => p.id === v.parent_version_id);
    return `Correction of v${parent?.version_number ?? "?"}: “${v.instruction ?? ""}”${used.length ? ` · evidence: ${used.join(", ")}` : ""}`;
  }

  const canCorrect = !!current && !activeJob && !busy && instruction.trim().length >= 3 && balance >= config.cost;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/studio?tool=compose" className="text-gray-400 hover:text-white flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Compose
        </Link>
        <h1 className="text-2xl font-bold flex-1 min-w-0 truncate">{group.name}</h1>
        <StatusBadge status={activeJob?.status ?? group.status} />
        <button type="button" onClick={remove} disabled={!!activeJob} className="text-gray-500 hover:text-red-300 disabled:opacity-40" title="Delete this composite">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {error && <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3">{error}</p>}

      {activeJob && (
        <div className="flex items-center gap-3 bg-brand-500/10 border border-brand-500/30 rounded-xl p-3 text-sm text-brand-100">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="flex-1">
            {activeJob.kind === "correction" ? "Applying your correction" : "Rendering"} —{" "}
            {activeJob.status === "review" ? "checking the result against your photos…" : "usually under a minute."}
          </span>
          {activeJob.status === "queued" && (
            <button type="button" onClick={() => cancel(activeJob)} className="text-xs text-gray-300 hover:text-white">
              Cancel
            </button>
          )}
        </div>
      )}
      {!activeJob && lastJob?.status === "failed" && (
        <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
          The last {lastJob.kind} failed: {lastJob.error ?? "unknown error"}.{" "}
          {lastJob.refunded_at ? `${lastJob.cost_credits} credits were refunded.` : ""}
        </p>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-8">
        <div className="space-y-5">
          {current?.previewUrl ? (
            <MarkableImage src={current.previewUrl} alt={`${group.name} v${current.version_number}`} marks={marks} marking={marking} onMark={onMark} />
          ) : (
            <div className="aspect-video rounded-xl border border-white/10 bg-black/30 flex flex-col items-center justify-center text-gray-500 text-sm gap-2">
              <Layers className="w-8 h-8" />
              {activeJob ? "Your composite will appear here." : "No version yet."}
            </div>
          )}

          {versions.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setViewing(v.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs border flex items-center gap-1.5 ${
                    v.id === current?.id ? "bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/50" : "text-gray-400 hover:text-white"
                  }`}
                  title={lineage(v)}
                >
                  v{v.version_number}
                  {v.kind === "correction" && <Wand2 className="w-3 h-3" />}
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      v.review_status === "passed" ? "bg-emerald-400" : v.review_status === "flagged" ? "bg-amber-400" : v.review_status === "pending" ? "bg-gray-500" : "bg-gray-600"
                    }`}
                  />
                </button>
              ))}
            </div>
          )}

          {current && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">{lineage(current)}</p>
              <ReviewPanel status={current.review_status} review={current.review} onFix={activeJob ? undefined : fixIssue} />
            </div>
          )}

          {current && (
            <form id="correction" onSubmit={submitCorrection} className="space-y-3 bg-white/[0.03] border border-white/10 rounded-2xl p-4">
              <p className="text-sm font-medium">Fix something in v{current.version_number}</p>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="e.g. the sun and its reflection don't line up — move the sun above the reflection, keep the harbor unchanged"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-brand-500/50"
              />
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <button
                  type="button"
                  onClick={() => setMarking(marking === "what" ? null : "what")}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border ${marking === "what" ? "border-red-400 text-red-200 bg-red-500/10" : "border-white/10 text-gray-300 hover:text-white"}`}
                >
                  <Crosshair className="w-3.5 h-3.5" /> {marks.what ? "Re-mark what's wrong" : "Mark what's wrong"}
                </button>
                <button
                  type="button"
                  disabled={!marks.what}
                  onClick={() => setMarking(marking === "where" ? null : "where")}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border disabled:opacity-40 ${marking === "where" ? "border-emerald-400 text-emerald-200 bg-emerald-500/10" : "border-white/10 text-gray-300 hover:text-white"}`}
                >
                  <MapPin className="w-3.5 h-3.5" /> {marks.where ? "Re-mark where it goes" : "Where should it go? (optional)"}
                </button>
                {marks.what && (
                  <label className="flex items-center gap-2 text-gray-400">
                    size
                    <input
                      type="range"
                      min={0.015}
                      max={0.2}
                      step={0.005}
                      value={marks.what.r}
                      onChange={(e) => setMarks((m) => (m.what ? { ...m, what: { ...m.what, r: Number(e.target.value) } } : m))}
                    />
                  </label>
                )}
                {(marks.what || marks.where) && (
                  <button type="button" onClick={() => { setMarks({}); setMarking(null); }} className="flex items-center gap-1 text-gray-400 hover:text-white">
                    <Eraser className="w-3.5 h-3.5" /> Clear marks
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                {marking
                  ? marking === "what"
                    ? "Click the image on the thing that is wrong."
                    : "Click the image where it should be."
                  : mode === "move"
                    ? "Move: the marked element is placed exactly where you pointed, then the old spot is cleaned up. Most reliable for things in the wrong place."
                    : mode === "area"
                      ? "Only the area inside the red circle may change."
                      : "No marks: the instruction applies to the whole image. For something in the wrong place, mark it and where it should go."}
              </p>

              {stills.length > 0 && (
                <div>
                  <p className="text-xs text-gray-400 mb-1.5">
                    Original photos to check against (up to {config.maxEvidence})
                  </p>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {stills.map((s) => {
                      const on = evidence.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() =>
                            setEvidence((ev) =>
                              on ? ev.filter((x) => x !== s.id) : ev.length >= config.maxEvidence ? ev : [...ev, s.id]
                            )
                          }
                          className={`shrink-0 rounded-lg overflow-hidden ${on ? "ring-2 ring-brand-500" : "ring-1 ring-white/10 opacity-60"}`}
                          title={label(s)}
                        >
                          {s.refUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={s.refUrl} alt={label(s)} className="h-16 w-12 object-cover" />
                          ) : (
                            <span className="block h-16 w-12" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={!canCorrect}
                className="flex items-center justify-center gap-2 w-full bg-brand-600 hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-4 py-2.5 text-sm font-medium"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Create v{(latest?.version_number ?? 0) + 1} from v{current.version_number}
                <span className="text-brand-200/80">· {config.cost} credits</span>
              </button>
              {balance < config.cost && <p className="text-xs text-amber-300/90">Not enough credits — you have {balance}.</p>}
            </form>
          )}
        </div>

        <aside className="space-y-6">
          {current && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">Download v{current.version_number}</p>
              <DownloadLinks versionId={current.id} plan={current.plan} />
              <a
                href={versionMediaUrl(current.id, "native")}
                target="_blank"
                rel="noreferrer"
                className="block text-xs text-gray-500 hover:text-gray-300"
              >
                Open full size in a new tab
              </a>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500">
                Sources · {stills.filter((s) => s.selected).length} of {stills.length} used
              </p>
              <button
                type="button"
                onClick={renderAgain}
                disabled={!!activeJob || !!busy || balance < config.cost || stills.filter((s) => s.selected).length < 2}
                className="text-xs text-brand-300 hover:text-brand-200 disabled:opacity-40 flex items-center gap-1"
                title={`New render from the selected sources · ${config.cost} credits`}
              >
                <RotateCcw className="w-3 h-3" /> Render again · {config.cost}
              </button>
            </div>
            {video && (
              <p className="text-[11px] text-gray-500 mb-2">
                {video.original_name} · {formatTimestamp(video.duration_s ?? 0)}
                {video.width && video.height ? ` · ${formatDims({ width: video.width, height: video.height })}` : ""}
                {video.note?.startsWith("original_not_stored") ? " · original not stored, frames kept" : ""}
              </p>
            )}
            <div className="grid grid-cols-3 gap-2">
              {stills.map((s) => (
                <SourceTile
                  key={s.id}
                  url={s.refUrl}
                  label={label(s)}
                  sublabel={s.width && s.height ? formatDims({ width: s.width, height: s.height }) : undefined}
                  isFrame={s.kind === "frame"}
                  selected={s.selected}
                  anchor={group.anchor_source_id === s.id}
                  disabled={!!activeJob}
                  onToggle={() => toggleSource(s)}
                  onAnchor={() => makeAnchor(s)}
                />
              ))}
            </div>
          </div>

          {(group.scene_priority || group.must_preserve.length > 0) && (
            <div className="text-xs text-gray-400 space-y-1">
              {group.scene_priority && <p>Scene priority: “{group.scene_priority}”</p>}
              {group.must_preserve.length > 0 && <p>Must preserve: {group.must_preserve.map((d) => `“${d}”`).join(", ")}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
