import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeProvider } from "@/lib/composite/config";
import { badRequest, compositeCaller, failure, readJson, unauthorized } from "@/lib/composite/http";
import { CompositeError, findJobByKey, loadOwnedGroup, loadSources, startJob } from "@/lib/composite/jobs";
import { buildRenderPrompt, type PromptSource } from "@/lib/composite/prompt";
import { renderSchema } from "@/lib/composite/schemas";
import { isOwnCompositePath } from "@/lib/composite/storage";
import { publicJob } from "@/lib/composite/view";
import type { CompositeSource } from "@/lib/composite/types";

// POST /api/composites/[id]/render — queue one composite render from the
// group's selected sources. Returns immediately; poll /api/composites/jobs/[id].
//
// The body carries an idempotency key: a retried click returns the job the
// first one created and is never charged twice.

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/[id]/render");
  const { id: groupId } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const parsed = renderSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(log, "Invalid request", parsed.error.flatten());
  const { serviceClient, user } = caller;

  try {
    const profile = compositeProvider();
    if (!profile) throw new CompositeError("Composites are not enabled on this server", 503, "composite_disabled");
    const group = await loadOwnedGroup(serviceClient, user.id, groupId);
    const retried = await findJobByKey(serviceClient, user.id, parsed.data.idempotencyKey);
    if (retried) {
      if (retried.group_id !== groupId) {
        throw new CompositeError("That request id was already used for another composite", 409, "idempotency_conflict");
      }
      return NextResponse.json({ job: publicJob(retried), duplicate: true, reqId: log.reqId });
    }
    const sources = await loadSources(serviceClient, groupId);
    const byId = new Map(sources.map((s) => [s.id, s]));

    const { data: active } = await serviceClient
      .from("composite_jobs")
      .select("id")
      .eq("group_id", groupId)
      .in("status", ["queued", "generating", "review"]);
    if (active?.length) {
      throw new CompositeError("This composite is already rendering", 409, "job_running");
    }
    if (sources.some((s) => s.status === "pending")) {
      throw new CompositeError("Some files are still uploading", 409, "uploads_pending");
    }

    const chosen = sources.filter(
      (s) =>
        s.selected &&
        s.kind !== "video" &&
        s.status === "uploaded" &&
        isOwnCompositePath(s.reference_path, user.id, groupId)
    );
    if (chosen.length < 2) {
      throw new CompositeError("Select at least two photos or frames to combine", 400, "too_few_references");
    }
    if (chosen.length > profile.maxReferences) {
      throw new CompositeError(
        `At most ${profile.maxReferences} photos or frames can be sent — ${chosen.length} are selected`,
        400,
        "too_many_references"
      );
    }
    // Anchor first (the user's choice, or the first selected), then sequence order.
    const anchor = chosen.find((s) => s.id === group.anchor_source_id) ?? chosen[0]!;
    const ordered = [anchor, ...chosen.filter((s) => s !== anchor)];

    const toPrompt = (s: CompositeSource): PromptSource =>
      s.kind === "frame"
        ? {
            kind: "frame",
            name: s.original_name,
            videoName: byId.get(s.parent_source_id ?? "")?.original_name,
            timeS: s.frame_time_s ?? undefined,
          }
        : { kind: "photo", name: s.original_name };

    const prompt = buildRenderPrompt({
      name: group.name,
      scenePriority: group.scene_priority,
      mustPreserve: group.must_preserve,
      style: group.style,
      aspectRatio: group.aspect_ratio,
      sources: ordered.map(toPrompt),
    });

    const { job, duplicate } = await startJob(
      serviceClient,
      {
        kind: "render",
        group,
        userId: user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        prompt,
        referenceSourceIds: ordered.map((s) => s.id),
        description: `Composite: ${group.name}`,
        prepare: async () => ({
          inputPaths: ordered.map((s) => s.reference_path!),
          aspectRatio: group.aspect_ratio,
        }),
      },
      log
    );
    return NextResponse.json({ job: publicJob(job), duplicate, reqId: log.reqId }, { status: duplicate ? 200 : 202 });
  } catch (err) {
    return failure(log, err, "composite_render_failed", { userId: user.id, groupId });
  }
}
