import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeProvider } from "@/lib/composite/config";
import { badRequest, compositeCaller, failure, readJson, unauthorized } from "@/lib/composite/http";
import { CompositeError, loadOwnedGroup, loadSources, syncGroupStatus } from "@/lib/composite/jobs";
import { patchGroupSchema } from "@/lib/composite/schemas";
import {
  COMPOSITE_BUCKET,
  compositePrefix,
  isOwnCompositePath,
  removeCompositeMedia,
} from "@/lib/composite/storage";
import { loadGroupView } from "@/lib/composite/view";

// GET    /api/composites/[id] — project: sources, versions, jobs (+ signed previews)
// PATCH  /api/composites/[id] — settings, anchor, which sources are sent, removals
// DELETE /api/composites/[id] — the project, its media, versions and gallery rows

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/[id]");
  const { id } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  try {
    const view = await loadGroupView(caller.supabase, caller.serviceClient, caller.user.id, id);
    if (!view) return NextResponse.json({ error: "Composite not found", reqId: log.reqId }, { status: 404 });
    return NextResponse.json({ ...view, reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composite_read_failed", { userId: caller.user.id, groupId: id });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/[id]");
  const { id } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const parsed = patchGroupSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(log, "Invalid request", parsed.error.flatten());
  const p = parsed.data;
  const { serviceClient, user } = caller;

  try {
    const group = await loadOwnedGroup(serviceClient, user.id, id);
    const sources = await loadSources(serviceClient, id);
    const byId = new Map(sources.map((s) => [s.id, s]));
    const foreign = [
      ...(p.selection ?? []).map((s) => s.id),
      ...(p.removeSourceIds ?? []),
      ...(p.anchorSourceId ? [p.anchorSourceId] : []),
    ].filter((sid) => !byId.has(sid));
    if (foreign.length) {
      throw new CompositeError("Some of those sources do not belong to this composite", 400, "foreign_source");
    }

    // Removals first, so the selection count below reflects what remains.
    if (p.removeSourceIds?.length) {
      const doomed = sources.filter(
        (s) => p.removeSourceIds!.includes(s.id) || (s.parent_source_id && p.removeSourceIds!.includes(s.parent_source_id))
      );
      const paths = doomed
        .flatMap((s) => [s.storage_path, s.reference_path])
        .filter((path): path is string => isOwnCompositePath(path, user.id, id));
      if (paths.length) await serviceClient.storage.from(COMPOSITE_BUCKET).remove([...new Set(paths)]);
      const { error } = await serviceClient
        .from("composite_sources")
        .delete()
        .in("id", doomed.map((s) => s.id));
      if (error) throw new Error(`removing sources failed: ${error.message}`);
      for (const s of doomed) byId.delete(s.id);
    }

    for (const sel of p.selection ?? []) {
      const s = byId.get(sel.id);
      if (!s) continue;
      if (sel.selected && s.kind === "video") {
        throw new CompositeError("A video is never sent itself — select its frames", 400, "video_not_selectable");
      }
      const { error } = await serviceClient
        .from("composite_sources")
        .update({ selected: sel.selected, pinned: sel.pinned ?? s.pinned })
        .eq("id", s.id);
      if (error) throw new Error(`updating the selection failed: ${error.message}`);
      byId.set(s.id, { ...s, selected: sel.selected, pinned: sel.pinned ?? s.pinned });
    }

    const profile = compositeProvider();
    const selectedCount = [...byId.values()].filter((s) => s.selected && s.kind !== "video").length;
    if (profile && selectedCount > profile.maxReferences) {
      throw new CompositeError(
        `At most ${profile.maxReferences} photos or frames can be sent in one render — ${selectedCount} are selected`,
        400,
        "too_many_references"
      );
    }

    let anchor = p.anchorSourceId === undefined ? group.anchor_source_id : p.anchorSourceId;
    if (anchor && (!byId.has(anchor) || byId.get(anchor)!.kind === "video")) {
      if (p.anchorSourceId) throw new CompositeError("The anchor must be a photo or frame of this composite", 400, "bad_anchor");
      anchor = null; // the old anchor was removed
    }

    const { error } = await serviceClient
      .from("composite_groups")
      .update({
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.scenePriority !== undefined ? { scene_priority: p.scenePriority || null } : {}),
        ...(p.mustPreserve !== undefined ? { must_preserve: p.mustPreserve } : {}),
        ...(p.style !== undefined ? { style: p.style } : {}),
        ...(p.aspectRatio !== undefined ? { aspect_ratio: p.aspectRatio } : {}),
        anchor_source_id: anchor,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw new Error(`updating the composite failed: ${error.message}`);
    await syncGroupStatus(serviceClient, id);

    const view = await loadGroupView(caller.supabase, serviceClient, user.id, id);
    return NextResponse.json({ ...view, reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composite_patch_failed", { userId: user.id, groupId: id });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/[id]");
  const { id } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const { serviceClient, user } = caller;
  try {
    await loadOwnedGroup(serviceClient, user.id, id);
    const { data: active, error: activeErr } = await serviceClient
      .from("composite_jobs")
      .select("id")
      .eq("group_id", id)
      .in("status", ["queued", "generating", "review"]);
    if (activeErr) throw new Error(`checking for running jobs failed: ${activeErr.message}`);
    if (active?.length) {
      throw new CompositeError("Wait for the running render to finish before deleting", 409, "job_running");
    }
    const removed = await removeCompositeMedia(serviceClient, compositePrefix(user.id, id));
    // Versions cascade to their generated_images rows (composite_version_id).
    const { error } = await serviceClient.from("composite_groups").delete().eq("id", id).eq("user_id", user.id);
    if (error) throw new Error(`deleting the composite failed: ${error.message}`);
    log.info("composite_deleted", { userId: user.id, groupId: id, objectsRemoved: removed });
    return NextResponse.json({ ok: true, reqId: log.reqId });
  } catch (err) {
    return failure(log, err, "composite_delete_failed", { userId: user.id, groupId: id });
  }
}
