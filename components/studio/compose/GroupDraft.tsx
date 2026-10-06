"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useDropzone } from "react-dropzone";
import { ArrowRight, Film, Loader2, Plus, Trash2, Upload, Wand2, X } from "lucide-react";
import type { ComposeClientConfig } from "@/lib/composite/config";
import {
  analyzePhoto,
  analyzeVideo,
  isPhoto,
  isVideo,
  putToSlot,
  rejectReason,
  videoMime,
  type Analyzed,
} from "@/lib/composite/client/media";
import { composeApi, newIdempotencyKey, type VersionDto } from "@/lib/composite/client/api";
import { autoSelect, defaultAnchor, formatTimestamp, type SelectionNote } from "@/lib/composite/selection";
import { COMPOSITE_BUCKET } from "@/lib/composite/storage";
import { formatDims } from "@/lib/composite/dimensions";
import { isActiveJob } from "@/lib/composite/states";
import { COMPOSITE_ASPECTS, type CompositeAspect, type CompositeStyle } from "@/lib/composite/types";
import type { PublicJob } from "@/lib/composite/view";
import { SourceTile, StatusBadge } from "@/components/studio/compose/parts";

interface Item {
  clientId: string;
  kind: "photo" | "video" | "frame";
  name: string;
  file?: File;
  parentClientId?: string;
  timeS?: number;
  a?: Analyzed;
  video?: { width: number; height: number; duration: number; size: number };
  sourceId?: string;
  state: "analyzing" | "uploading" | "uploaded" | "error";
  note?: string | null;
}

export interface DraftStatus {
  ready: boolean;
  working: boolean;
}

export interface DraftHandle {
  start: () => Promise<boolean>;
}

const ACCEPT = {
  "image/jpeg": [],
  "image/png": [],
  "image/webp": [],
  "video/quicktime": [".mov"],
  "video/mp4": [".mp4"],
};

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const mb = (n: number) => `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB`;

export function GroupDraft({
  index,
  config,
  onStatus,
  onHandle,
  onRemove,
  onCharged,
}: {
  index: number;
  config: ComposeClientConfig;
  onStatus: (s: DraftStatus) => void;
  onHandle: (h: DraftHandle | null) => void;
  onRemove: () => void;
  onCharged: (credits: number) => void;
}) {
  const [name, setName] = useState(`Composite ${index + 1}`);
  const [scenePriority, setScenePriority] = useState("");
  const [mustPreserve, setMustPreserve] = useState<string[]>([]);
  const [preserveDraft, setPreserveDraft] = useState("");
  const [aspect, setAspect] = useState<CompositeAspect>("16:9");
  const [style, setStyle] = useState<CompositeStyle>("faithful");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, SelectionNote>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<PublicJob | null>(null);
  const [version, setVersion] = useState<VersionDto | null>(null);
  const idemKey = useRef<string | null>(null);
  const groupIdRef = useRef<string | null>(null);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  const stills = items.filter((i) => i.kind !== "video");
  const ready =
    !!groupId &&
    !busy &&
    !job &&
    stills.length > 0 &&
    items.every((i) => i.state === "uploaded") &&
    stills.filter((i) => selected.has(i.clientId)).length >= 2;
  const working = !!busy || (!!job && isActiveJob(job.status));

  useEffect(() => onStatus({ ready, working }), [ready, working, onStatus]);

  // Object URLs are ours to free.
  useEffect(
    () => () => {
      for (const i of itemsRef.current) if (i.a) URL.revokeObjectURL(i.a.previewUrl);
    },
    []
  );

  const patchItem = (clientId: string, patch: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.clientId === clientId ? { ...i, ...patch } : i)));

  const ensureGroup = useCallback(async (): Promise<string> => {
    if (groupIdRef.current) return groupIdRef.current;
    const { group } = await composeApi.createGroup({ name: name.trim() || `Composite ${index + 1}`, aspectRatio: aspect, style });
    groupIdRef.current = group.id;
    setGroupId(group.id);
    return group.id;
  }, [name, index, aspect, style]);

  /** Re-run automatic selection over every still, honouring anchor and keeps. */
  const reselect = useCallback(
    (all: Item[], keep: Set<string>, currentAnchor: string | null) => {
      const cands = all
        .filter((i) => i.kind !== "video" && i.a && i.state !== "error")
        .map((i, n) => ({
          id: i.clientId,
          kind: i.kind as "photo" | "frame",
          sequence: n,
          sharpness: i.a!.sharpness,
          phash: i.a!.phash,
          pinned: keep.has(i.clientId),
        }));
      const anchorId = currentAnchor && cands.some((c) => c.id === currentAnchor) ? currentAnchor : defaultAnchor(cands);
      const res = autoSelect(cands, { target: config.targetReferences, max: config.maxReferences, anchorId });
      setAnchor(anchorId);
      setSelected(new Set(res.selected));
      setNotes(res.notes);
    },
    [config.maxReferences, config.targetReferences]
  );

  const onDrop = useCallback(
    async (files: File[]) => {
      const problems: string[] = [];
      const accepted: File[] = [];
      for (const f of files) {
        const why = rejectReason(f);
        if (why) problems.push(why);
        else accepted.push(f);
      }
      const photos = accepted.filter(isPhoto).sort((a, b) => natural.compare(a.name, b.name));
      const videos = accepted.filter((f) => !isPhoto(f) && isVideo(f));
      const havePhotos = itemsRef.current.filter((i) => i.kind === "photo").length;
      const haveVideo = itemsRef.current.some((i) => i.kind === "video");
      if (havePhotos + photos.length > config.maxPhotosPerGroup) {
        problems.push(`A composite takes at most ${config.maxPhotosPerGroup} photos.`);
        photos.splice(Math.max(0, config.maxPhotosPerGroup - havePhotos));
      }
      if (videos.length + (haveVideo ? 1 : 0) > 1) {
        problems.push("A composite takes one video — make another group for a second clip.");
        videos.splice(haveVideo ? 0 : 1);
      }
      for (const p of [...photos]) {
        if (p.size > config.maxPhotoBytes) {
          problems.push(`${p.name} is larger than ${mb(config.maxPhotoBytes)}.`);
          photos.splice(photos.indexOf(p), 1);
        }
      }
      setErrors(problems);
      if (!photos.length && !videos.length) return;

      const fresh: Item[] = [
        ...photos.map((f) => ({ clientId: crypto.randomUUID(), kind: "photo" as const, name: f.name, file: f, state: "analyzing" as const })),
        ...videos.map((f) => ({ clientId: crypto.randomUUID(), kind: "video" as const, name: f.name, file: f, state: "analyzing" as const })),
      ];
      setItems((prev) => [...prev, ...fresh]);

      try {
        const gid = await ensureGroup();

        // 1. Look at everything locally first.
        const analyzed: Item[] = [];
        let n = 0;
        for (const it of fresh.filter((i) => i.kind === "photo")) {
          setBusy(`Reading photos… ${++n} of ${photos.length}`);
          try {
            const a = await analyzePhoto(it.file!, config.referenceLongEdge);
            patchItem(it.clientId, { a });
            analyzed.push({ ...it, a });
          } catch (err) {
            patchItem(it.clientId, { state: "error", note: (err as Error).message });
            setErrors((e) => [...e, (err as Error).message]);
          }
        }
        for (const it of fresh.filter((i) => i.kind === "video")) {
          const f = it.file!;
          setBusy(`Extracting frames from ${f.name}…`);
          try {
            const v = await analyzeVideo(f, config.referenceLongEdge, (d, t) =>
              setBusy(`Extracting frames from ${f.name}… ${d} of ${t}`)
            );
            if (v.duration > config.maxVideoDurationS) {
              throw new Error(`${f.name} is longer than ${Math.round(config.maxVideoDurationS / 60)} minutes`);
            }
            const video = { width: v.width, height: v.height, duration: v.duration, size: f.size };
            const frames: Item[] = v.frames.map((fr) => ({
              clientId: crypto.randomUUID(),
              kind: "frame",
              name: `Frame ${formatTimestamp(fr.timeS)}`,
              parentClientId: it.clientId,
              timeS: fr.timeS,
              a: fr,
              state: "analyzing",
            }));
            patchItem(it.clientId, { video });
            setItems((prev) => [...prev, ...frames]);
            analyzed.push({ ...it, video }, ...frames);
          } catch (err) {
            patchItem(it.clientId, { state: "error", note: (err as Error).message });
            setErrors((e) => [...e, (err as Error).message]);
          }
        }
        if (!analyzed.length) return;

        // 2. Register, then upload to the signed slots.
        setBusy("Preparing upload…");
        const offset = itemsRef.current.filter((i) => i.sourceId).length;
        const payload = analyzed.map((i, k) => {
          const sequence = offset + k;
          if (i.kind === "photo") {
            return {
              kind: "photo", clientId: i.clientId, originalName: i.name, mimeType: i.file!.type,
              byteSize: i.file!.size, width: i.a!.width, height: i.a!.height, sequence,
              sharpness: i.a!.sharpness, phash: i.a!.phash,
            };
          }
          if (i.kind === "video") {
            return {
              kind: "video", clientId: i.clientId, originalName: i.name, mimeType: videoMime(i.file!),
              byteSize: i.file!.size, width: i.video!.width, height: i.video!.height,
              durationS: i.video!.duration, sequence,
            };
          }
          return {
            kind: "frame", clientId: i.clientId, originalName: `${itemsRef.current.find((p) => p.clientId === i.parentClientId)?.name ?? "video"} @ ${formatTimestamp(i.timeS ?? 0)}`,
            mimeType: "image/jpeg", byteSize: i.a!.reference.size, width: i.a!.width, height: i.a!.height,
            frameTimeS: i.timeS ?? 0, parentClientId: i.parentClientId, sequence,
            sharpness: i.a!.sharpness, phash: i.a!.phash,
          };
        });
        const { sources, uploads } = await composeApi.registerSources(gid, payload);
        const byClient = new Map(uploads.map((u) => [u.clientId, u]));
        const notesById = new Map(sources.map((s) => [s.id, s.note]));
        for (const i of analyzed) {
          const slot = byClient.get(i.clientId);
          patchItem(i.clientId, { sourceId: slot?.id, state: "uploading", note: slot ? notesById.get(slot.id) ?? null : null });
        }

        type Task = { clientId: string; slot: { path: string; token: string }; body: Blob; type: string };
        const tasks: Task[] = [];
        for (const i of analyzed) {
          const slot = byClient.get(i.clientId);
          if (!slot) continue;
          if (i.kind === "photo") {
            if (slot.original) tasks.push({ clientId: i.clientId, slot: slot.original, body: i.file!, type: i.file!.type });
            if (slot.reference) tasks.push({ clientId: i.clientId, slot: slot.reference, body: i.a!.reference, type: "image/jpeg" });
          } else if (i.kind === "video") {
            if (slot.original) tasks.push({ clientId: i.clientId, slot: slot.original, body: i.file!, type: videoMime(i.file!) });
          } else if (slot.original) {
            tasks.push({ clientId: i.clientId, slot: slot.original, body: i.a!.reference, type: "image/jpeg" });
          }
        }
        const total = tasks.reduce((s, t) => s + t.body.size, 0) || 1;
        const loaded = new Map<number, number>();
        const report = () =>
          setBusy(`Uploading… ${Math.round(([...loaded.values()].reduce((s, v) => s + v, 0) / total) * 100)}% of ${mb(total)}`);
        let next = 0;
        const failedClients = new Set<string>();
        const worker = async () => {
          while (next < tasks.length) {
            const k = next++;
            const t = tasks[k]!;
            try {
              await putToSlot(process.env.NEXT_PUBLIC_SUPABASE_URL!, COMPOSITE_BUCKET, t.slot, t.body, t.type, (l) => {
                loaded.set(k, l);
                report();
              });
              loaded.set(k, t.body.size);
            } catch (err) {
              failedClients.add(t.clientId);
              setErrors((e) => [...e, `${analyzed.find((a) => a.clientId === t.clientId)?.name}: ${(err as Error).message}`]);
            }
            report();
          }
        };
        await Promise.all([worker(), worker(), worker()]);

        const done = analyzed.filter((i) => byClient.get(i.clientId) && !failedClients.has(i.clientId));
        const res = await composeApi.completeSources(gid, done.map((i) => byClient.get(i.clientId)!.id));
        const missing = new Set(res.missing);
        for (const i of analyzed) {
          const sid = byClient.get(i.clientId)?.id;
          const bad = !sid || failedClients.has(i.clientId) || missing.has(sid);
          patchItem(i.clientId, { state: bad ? "error" : "uploaded" });
        }
        reselect(
          itemsRef.current.map((i) => {
            const sid = byClient.get(i.clientId)?.id;
            return sid && (failedClients.has(i.clientId) || missing.has(sid)) ? { ...i, state: "error" } : i;
          }),
          pinned,
          anchor
        );
      } catch (err) {
        setErrors((e) => [...e, (err as Error).message]);
        for (const it of fresh) {
          if (itemsRef.current.find((i) => i.clientId === it.clientId)?.state !== "uploaded") {
            patchItem(it.clientId, { state: "error" });
          }
        }
      } finally {
        setBusy(null);
      }
    },
    [anchor, config, ensureGroup, pinned, reselect]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT,
    disabled: !!busy || !!job,
  });

  function toggle(clientId: string) {
    const on = !selected.has(clientId);
    const stillsSelected = stills.filter((i) => selected.has(i.clientId)).length;
    if (on && stillsSelected >= config.maxReferences) {
      setErrors([`At most ${config.maxReferences} photos or frames can go into one render.`]);
      return;
    }
    const nextSel = new Set(selected);
    const nextPin = new Set(pinned);
    if (on) {
      nextSel.add(clientId);
      nextPin.add(clientId); // explicitly kept: automatic re-selection must not drop it
    } else {
      nextSel.delete(clientId);
      nextPin.delete(clientId);
      if (anchor === clientId) setAnchor(null);
    }
    setSelected(nextSel);
    setPinned(nextPin);
  }

  function makeAnchor(clientId: string) {
    setAnchor(clientId);
    if (!selected.has(clientId)) toggle(clientId);
  }

  function addPreserve() {
    const v = preserveDraft.trim();
    if (!v || mustPreserve.length >= 8) return;
    setMustPreserve([...mustPreserve, v.slice(0, 200)]);
    setPreserveDraft("");
  }

  /** Save settings + selection, then queue the render. Returns false on failure. */
  const start = useCallback(async (): Promise<boolean> => {
    const gid = groupIdRef.current;
    if (!gid) return false;
    setErrors([]);
    setBusy("Starting render…");
    try {
      const all = itemsRef.current;
      const idFor = (c: string | null) => all.find((i) => i.clientId === c)?.sourceId ?? null;
      await composeApi.patchGroup(gid, {
        name: name.trim() || `Composite ${index + 1}`,
        scenePriority: scenePriority.trim() || null,
        mustPreserve,
        style,
        aspectRatio: aspect,
        anchorSourceId: idFor(anchor),
        selection: all
          .filter((i) => i.kind !== "video" && i.sourceId && i.state === "uploaded")
          .map((i) => ({ id: i.sourceId!, selected: selected.has(i.clientId), pinned: pinned.has(i.clientId) })),
      });
      idemKey.current ??= newIdempotencyKey();
      const { job: j, duplicate } = await composeApi.render(gid, idemKey.current);
      if (!duplicate) onCharged(config.cost);
      idemKey.current = null;
      setJob(j);
      return true;
    } catch (err) {
      setErrors([(err as Error).message]);
      return false;
    } finally {
      setBusy(null);
    }
  }, [anchor, aspect, config.cost, index, mustPreserve, name, onCharged, pinned, scenePriority, selected, style]);

  useEffect(() => {
    onHandle({ start });
    return () => onHandle(null);
  }, [onHandle, start]);

  // Poll the job. Each poll also advances it on the server.
  const jobId = job?.id;
  const jobActive = job ? isActiveJob(job.status) : false;
  useEffect(() => {
    if (!jobId || !jobActive) return;
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const r = await composeApi.job(jobId);
          if (stop) return;
          setJob(r.job);
          if (r.version) setVersion(r.version);
          if (!isActiveJob(r.job.status)) {
            if (r.job.status === "failed") onCharged(-r.job.cost_credits);
            return;
          }
        } catch (err) {
          setErrors([(err as Error).message]);
        }
        await new Promise((res) => setTimeout(res, 4000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [jobId, jobActive, onCharged]);

  async function removeDraft() {
    if (groupIdRef.current && !job) {
      await composeApi.deleteGroup(groupIdRef.current).catch(() => {});
    }
    onRemove();
  }

  const selectedCount = stills.filter((i) => selected.has(i.clientId)).length;
  const videoItem = items.find((i) => i.kind === "video");
  const locked = !!job;

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-5 space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={locked}
          maxLength={120}
          className="flex-1 bg-transparent text-base font-medium border-b border-white/10 focus:border-brand-500/50 focus:outline-none py-1"
          aria-label="Composite name"
        />
        {job && <StatusBadge status={job.status} />}
        {!working && (
          <button type="button" onClick={removeDraft} className="text-gray-500 hover:text-red-300" title="Remove this group">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {!locked && (
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
            isDragActive ? "border-brand-500/60 bg-brand-500/5" : "border-white/10 hover:border-white/20"
          }`}
        >
          <input {...getInputProps()} />
          {busy ? (
            <p className="text-sm text-gray-300 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-brand-400" /> {busy}
            </p>
          ) : (
            <>
              <Upload className="w-5 h-5 mx-auto mb-2 text-gray-500" />
              <p className="text-sm text-gray-300">
                {items.length ? "Add more photos" : "Drop photos of one scene"} — optionally one video
              </p>
              <p className="text-xs text-gray-500 mt-1">
                JPEG, PNG or WebP · MOV or MP4 · up to {config.maxPhotosPerGroup} photos
              </p>
            </>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <ul className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3 space-y-1">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      {videoItem && (
        <p className="text-xs text-gray-400 flex items-center gap-2 flex-wrap">
          <Film className="w-3.5 h-3.5 text-sky-300" />
          {videoItem.name}
          {videoItem.video && (
            <>
              {" · "}
              {formatTimestamp(videoItem.video.duration)} · {formatDims(videoItem.video)} · {mb(videoItem.video.size)}
            </>
          )}
          {videoItem.note?.startsWith("original_not_stored") && (
            <span className="text-amber-300/80">
              · original not stored (larger than {mb(config.maxStoredVideoBytes)}); its frames are kept
            </span>
          )}
          {videoItem.state === "error" && <span className="text-red-300">· {videoItem.note}</span>}
        </p>
      )}

      {stills.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400">
              {selectedCount} of {stills.length} selected · max {config.maxReferences} per render ·{" "}
              <Star /> marks the anchor
            </p>
            {!locked && (
              <button
                type="button"
                onClick={() => reselect(items, pinned, anchor)}
                className="text-xs text-brand-300 hover:text-brand-200 flex items-center gap-1"
                disabled={!!busy}
              >
                <Wand2 className="w-3 h-3" /> Auto-pick
              </button>
            )}
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {stills.map((i) => (
              <SourceTile
                key={i.clientId}
                url={i.a?.previewUrl ?? null}
                label={i.kind === "frame" ? i.name : i.name}
                sublabel={
                  i.state === "error"
                    ? i.note ?? "failed"
                    : i.a
                      ? i.kind === "frame"
                        ? `${videoItem?.name ?? "video"} · ${formatDims(i.a)}`
                        : formatDims(i.a)
                      : "reading…"
                }
                isFrame={i.kind === "frame"}
                selected={selected.has(i.clientId)}
                anchor={anchor === i.clientId}
                note={notes[i.clientId]}
                busy={i.state === "analyzing" || i.state === "uploading"}
                disabled={locked || i.state === "error" || !!busy}
                onToggle={() => toggle(i.clientId)}
                onAnchor={() => makeAnchor(i.clientId)}
              />
            ))}
          </div>
        </div>
      )}

      {stills.length > 0 && !locked && (
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Scene priority (optional)</label>
            <input
              type="text"
              value={scenePriority}
              onChange={(e) => setScenePriority(e.target.value)}
              maxLength={500}
              placeholder="e.g. keep the harbor geometry"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-brand-500/50"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Must preserve (optional)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={preserveDraft}
                onChange={(e) => setPreserveDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPreserve();
                  }
                }}
                maxLength={200}
                placeholder="e.g. the two light spots above the sun"
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-brand-500/50"
              />
              <button type="button" onClick={addPreserve} className="px-3 rounded-xl border border-white/10 hover:bg-white/5" title="Add">
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {mustPreserve.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {mustPreserve.map((d, i) => (
                  <span key={i} className="text-xs bg-brand-500/15 border border-brand-500/30 text-brand-200 rounded-full px-2 py-0.5 flex items-center gap-1">
                    {d}
                    <button type="button" onClick={() => setMustPreserve(mustPreserve.filter((_, k) => k !== i))}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400">Shape</span>
            {COMPOSITE_ASPECTS.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAspect(a)}
                className={`px-2.5 py-1 rounded-lg text-xs border ${
                  aspect === a ? "bg-brand-500/20 border-brand-500/40 text-brand-200" : "border-white/10 text-gray-400 hover:text-white"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400">Look</span>
            {(["faithful", "polished"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStyle(s)}
                className={`px-2.5 py-1 rounded-lg text-xs border ${
                  style === s ? "bg-brand-500/20 border-brand-500/40 text-brand-200" : "border-white/10 text-gray-400 hover:text-white"
                }`}
                title={s === "faithful" ? "Colors and light exactly as photographed" : "Careful exposure and color refinement"}
              >
                {s === "faithful" ? "Faithful to photos" : "Polished"}
              </button>
            ))}
          </div>
        </div>
      )}

      {job && (
        <div className="flex items-center gap-4 bg-white/5 border border-white/10 rounded-xl p-3">
          {version?.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={version.previewUrl} alt={name} className="h-20 rounded-lg" />
          ) : (
            <div className="h-20 w-36 rounded-lg bg-black/40 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
            </div>
          )}
          <div className="flex-1 min-w-0 text-sm">
            {job.status === "failed" ? (
              <p className="text-red-300">
                {job.error ?? "The render failed"}. Your {job.cost_credits} credits were refunded.
              </p>
            ) : job.status === "complete" ? (
              <p className="text-gray-300">
                {version ? `${formatDims({ width: version.native_width, height: version.native_height })} native · ` : ""}
                {version?.review_status === "passed"
                  ? "automatic check passed"
                  : version?.review_status === "flagged"
                    ? "the automatic check flagged something — open it to review and fix"
                    : "check it closely before using it"}
              </p>
            ) : (
              <p className="text-gray-400">
                {job.status === "review" ? "Checking the result against your photos…" : "Rendering — usually under a minute. You can leave this page."}
              </p>
            )}
          </div>
          {groupId && (
            <Link
              href={`/studio/composites/${groupId}`}
              className="shrink-0 inline-flex items-center gap-1 text-sm text-brand-300 hover:text-brand-200"
            >
              Open <ArrowRight className="w-4 h-4" />
            </Link>
          )}
        </div>
      )}

      {!job && groupId && items.length > 0 && !busy && (
        <div className="flex justify-between items-center text-xs text-gray-500">
          <span>
            {ready ? "Ready to render." : selectedCount < 2 ? "Select at least two photos or frames." : "Waiting for uploads…"}
          </span>
          <button type="button" onClick={removeDraft} className="flex items-center gap-1 hover:text-red-300">
            <Trash2 className="w-3 h-3" /> Discard group
          </button>
        </div>
      )}
    </div>
  );
}

function Star() {
  return <span className="text-brand-300">★</span>;
}
