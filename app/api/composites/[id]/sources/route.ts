import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeLimits } from "@/lib/composite/config";
import { compositeCaller, failure, readJson, unauthorized } from "@/lib/composite/http";
import { CompositeError, loadOwnedGroup, loadSources, syncGroupStatus } from "@/lib/composite/jobs";
import { registerSourcesSchema, type RegisterSourceInput } from "@/lib/composite/schemas";
import { compositePath, extFor, signUpload, type UploadSlot } from "@/lib/composite/storage";
import type { CompositeSource } from "@/lib/composite/types";

// POST /api/composites/[id]/sources — register photos, a video and its frames,
// and get a signed upload slot for each file to store.
//
// Unsupported or oversized media is rejected HERE, before anything is uploaded
// and long before any credit is charged. Paths are built from the session user
// id and the group id; nothing in the request names where a file lands.

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/[id]/sources");
  const { id: groupId } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const parsed = registerSourcesSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    // A discriminated-union miss on mimeType is the "unsupported media" case.
    return NextResponse.json(
      {
        error: "Unsupported or invalid media. Photos: JPEG, PNG or WebP. Video: MOV or MP4.",
        details: parsed.error.flatten(),
        reqId: log.reqId,
      },
      { status: 415 }
    );
  }
  const { serviceClient, user } = caller;
  const limits = compositeLimits();

  try {
    await loadOwnedGroup(serviceClient, user.id, groupId);
    const existing = await loadSources(serviceClient, groupId);
    const incoming = parsed.data.sources;

    const count = (k: CompositeSource["kind"]) =>
      existing.filter((s) => s.kind === k).length + incoming.filter((s) => s.kind === k).length;
    if (count("photo") > limits.maxPhotosPerGroup) {
      throw new CompositeError(`A composite takes at most ${limits.maxPhotosPerGroup} photos`, 413, "too_many_photos");
    }
    if (count("video") > limits.maxVideosPerGroup) {
      throw new CompositeError("A composite takes at most one video", 413, "too_many_videos");
    }
    for (const s of incoming) {
      if (s.kind === "photo" && s.byteSize > limits.maxPhotoBytes) {
        throw new CompositeError(`${s.originalName} is larger than ${limits.maxPhotoBytes / 1048576} MB`, 413, "photo_too_large");
      }
      if (s.kind === "video" && s.byteSize > limits.maxVideoBytes) {
        throw new CompositeError(`${s.originalName} is too large`, 413, "video_too_large");
      }
      if (s.kind === "video" && s.durationS > limits.maxVideoDurationS) {
        throw new CompositeError(
          `${s.originalName} is longer than ${Math.round(limits.maxVideoDurationS / 60)} minutes`,
          413,
          "video_too_long"
        );
      }
    }

    // Videos first, so frames in the same batch can point at their new ids.
    const order = [...incoming].sort((a, b) => rank(a) - rank(b));
    const newIds = new Map<string, string>();
    const videos = new Map(existing.filter((s) => s.kind === "video").map((s) => [s.id, s]));
    const rows: Partial<CompositeSource>[] = [];
    const slots: { clientId: string; id: string; original?: UploadSlot; reference?: UploadSlot }[] = [];

    for (const s of order) {
      const sid = crypto.randomUUID();
      newIds.set(s.clientId, sid);
      const base = {
        id: sid,
        group_id: groupId,
        user_id: user.id,
        kind: s.kind,
        original_name: s.originalName,
        mime_type: s.mimeType,
        byte_size: s.byteSize,
        width: s.width,
        height: s.height,
        sequence: s.sequence,
        selected: s.kind !== "video" && (s.selected ?? false),
        pinned: s.pinned ?? false,
        status: "pending" as const,
      };

      if (s.kind === "photo") {
        rows.push({
          ...base,
          storage_path: compositePath(user.id, groupId, "originals", `${sid}.${extFor(s.mimeType)}`),
          reference_path: compositePath(user.id, groupId, "refs", `${sid}.jpg`),
          sharpness: s.sharpness ?? null,
          phash: s.phash ?? null,
        });
      } else if (s.kind === "video") {
        const stored = s.byteSize <= limits.maxStoredVideoBytes;
        const row = {
          ...base,
          duration_s: s.durationS,
          storage_path: stored ? compositePath(user.id, groupId, "originals", `${sid}.${extFor(s.mimeType)}`) : null,
          reference_path: null,
          // Nothing to upload when the original is not kept: it is "uploaded"
          // in the sense that everything we keep of it has arrived (its frames
          // arrive as their own sources).
          status: stored ? ("pending" as const) : ("uploaded" as const),
          note: stored
            ? null
            : `original_not_stored: ${Math.round(s.byteSize / 1048576)} MB exceeds the ${Math.round(limits.maxStoredVideoBytes / 1048576)} MB storage limit; its frames are kept`,
        };
        rows.push(row);
        videos.set(sid, row as CompositeSource);
      } else {
        const parentId = s.parentClientId ? newIds.get(s.parentClientId) : s.parentSourceId;
        const parent = parentId ? videos.get(parentId) : undefined;
        if (!parentId || !parent) {
          throw new CompositeError(`${s.originalName}: frame does not belong to a video of this composite`, 400, "orphan_frame");
        }
        if (parent.duration_s != null && s.frameTimeS > parent.duration_s + 0.5) {
          throw new CompositeError(`${s.originalName}: frame time is past the end of the video`, 400, "bad_frame_time");
        }
        const frames =
          existing.filter((e) => e.parent_source_id === parentId).length +
          rows.filter((r) => r.parent_source_id === parentId).length;
        if (frames >= limits.maxFramesPerVideo) {
          throw new CompositeError(`At most ${limits.maxFramesPerVideo} frames per video`, 413, "too_many_frames");
        }
        const path = compositePath(user.id, groupId, "frames", `${sid}.jpg`);
        rows.push({
          ...base,
          parent_source_id: parentId,
          frame_time_s: s.frameTimeS,
          storage_path: path,
          reference_path: path,
          sharpness: s.sharpness ?? null,
          phash: s.phash ?? null,
        });
      }
    }

    const { data: inserted, error } = await serviceClient.from("composite_sources").insert(rows).select("*");
    if (error || !inserted) throw new Error(`registering sources failed: ${error?.message}`);

    for (const row of inserted as CompositeSource[]) {
      const clientId = [...newIds.entries()].find(([, v]) => v === row.id)![0];
      const slot: (typeof slots)[number] = { clientId, id: row.id };
      if (row.status === "pending" && row.storage_path) slot.original = await signUpload(serviceClient, row.storage_path);
      if (row.kind === "photo" && row.reference_path) slot.reference = await signUpload(serviceClient, row.reference_path);
      slots.push(slot);
    }
    await syncGroupStatus(serviceClient, groupId);
    log.info("composite_sources_registered", {
      userId: user.id,
      groupId,
      photos: incoming.filter((s) => s.kind === "photo").length,
      videos: incoming.filter((s) => s.kind === "video").length,
      frames: incoming.filter((s) => s.kind === "frame").length,
    });
    return NextResponse.json({ sources: inserted, uploads: slots, reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composite_sources_failed", { userId: user.id, groupId });
  }
}

function rank(s: RegisterSourceInput): number {
  return s.kind === "video" ? 0 : s.kind === "photo" ? 1 : 2;
}
