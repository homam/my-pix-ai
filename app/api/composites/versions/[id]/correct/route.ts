import { NextRequest, NextResponse } from "next/server";
import { makeLogger } from "@/lib/log";
import { compositeProvider } from "@/lib/composite/config";
import { badRequest, compositeCaller, failure, readJson, unauthorized } from "@/lib/composite/http";
import { CompositeError, findJobByKey, loadOwnedGroup, loadSources, startJob } from "@/lib/composite/jobs";
import { closestAspect } from "@/lib/composite/dimensions";
import { fullJpeg, guideImage, transplant } from "@/lib/composite/imaging";
import { buildCorrectionPrompt } from "@/lib/composite/prompt";
import { correctSchema } from "@/lib/composite/schemas";
import { compositePath, downloadObject, isOwnCompositePath, uploadObject } from "@/lib/composite/storage";
import { publicJob } from "@/lib/composite/view";
import type { CompositeVersion } from "@/lib/composite/types";

// POST /api/composites/versions/[id]/correct — ask for a targeted fix of one
// version. The version is the EDIT TARGET and is never modified: the result is
// a new child version (parent_version_id = this one), so the user can compare
// and go back.
//
//   text — instruction + original sources as evidence
//   area — the same, plus a guide image circling the only area that may change
//   move — the element is pasted at its new position HERE (lib/composite/imaging
//          transplant), and the provider only removes the leftover; the spike
//          showed this is the one approach that relocates reliably

export const maxDuration = 90;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const log = makeLogger("api/composites/versions/[id]/correct");
  const { id: versionId } = await params;
  const caller = await compositeCaller();
  if (!caller) return unauthorized(log);
  const parsed = correctSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest(log, "Invalid request", parsed.error.flatten());
  const p = parsed.data;
  const { serviceClient, user } = caller;

  try {
    const profile = compositeProvider();
    if (!profile) throw new CompositeError("Composites are not enabled on this server", 503, "composite_disabled");

    const { data: versionRow, error: vErr } = await serviceClient
      .from("composite_versions")
      .select("*")
      .eq("id", versionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (vErr) throw new Error(`reading the version failed: ${vErr.message}`);
    if (!versionRow) throw new CompositeError("Version not found", 404, "not_found");
    const version = versionRow as CompositeVersion;
    const retried = await findJobByKey(serviceClient, user.id, p.idempotencyKey);
    if (retried) {
      if (retried.target_version_id !== version.id) {
        throw new CompositeError("That request id was already used for another request", 409, "idempotency_conflict");
      }
      return NextResponse.json({ job: publicJob(retried), duplicate: true, reqId: log.reqId });
    }
    const group = await loadOwnedGroup(serviceClient, user.id, version.group_id);
    if (!isOwnCompositePath(version.native_path, user.id, group.id)) {
      throw new CompositeError("Version not found", 404, "not_found");
    }

    const sources = await loadSources(serviceClient, group.id);
    const usable = sources.filter(
      (s) => s.kind !== "video" && s.status === "uploaded" && isOwnCompositePath(s.reference_path, user.id, group.id)
    );
    let evidence = (p.evidenceSourceIds ?? [])
      .map((sid) => usable.find((s) => s.id === sid))
      .filter((s): s is (typeof usable)[number] => Boolean(s));
    if ((p.evidenceSourceIds?.length ?? 0) !== evidence.length) {
      throw new CompositeError("Evidence must be photos or frames of this composite", 400, "foreign_source");
    }
    if (evidence.length === 0) {
      const anchor = usable.find((s) => s.id === group.anchor_source_id) ?? usable.find((s) => s.selected);
      evidence = anchor ? [anchor] : [];
    }
    evidence = evidence.slice(0, profile.maxEvidence);

    const prompt = buildCorrectionPrompt({
      mode: p.mode,
      instruction: p.instruction,
      mustPreserve: group.must_preserve,
      evidence: evidence.map((s) =>
        s.kind === "frame"
          ? {
              kind: "frame" as const,
              name: s.original_name,
              videoName: sources.find((v) => v.id === s.parent_source_id)?.original_name,
              timeS: s.frame_time_s ?? undefined,
            }
          : { kind: "photo" as const, name: s.original_name }
      ),
    });
    const marks = p.mode === "text" ? null : p.marks ?? null;

    const { job, duplicate } = await startJob(
      serviceClient,
      {
        kind: "correction",
        group,
        userId: user.id,
        idempotencyKey: p.idempotencyKey,
        prompt,
        referenceSourceIds: evidence.map((s) => s.id),
        description: `Composite correction: ${group.name} v${version.version_number}`,
        mode: p.mode,
        instruction: p.instruction,
        marks,
        targetVersionId: version.id,
        prepare: async (jobId) => {
          // The edit target at full resolution, prepared per mode.
          const native = await fullJpeg(await downloadObject(serviceClient, version.native_path));
          let target = native;
          let guide: Buffer | null = null;
          if (p.mode === "move") {
            const moved = await transplant(native, { what: marks!.what!, where: marks!.where! });
            target = moved.pasted;
            guide = moved.guide;
          } else if (p.mode === "area") {
            guide = await guideImage(native, marks!.what!);
          }
          const targetPath = compositePath(user.id, group.id, "work", `${jobId}-target.jpg`);
          await uploadObject(serviceClient, targetPath, target, "image/jpeg");
          const paths = [targetPath];
          if (guide) {
            const guidePath = compositePath(user.id, group.id, "work", `${jobId}-guide.jpg`);
            await uploadObject(serviceClient, guidePath, guide, "image/jpeg");
            paths.push(guidePath);
          }
          paths.push(...evidence.map((s) => s.reference_path!));
          return {
            inputPaths: paths,
            aspectRatio: closestAspect({ width: version.native_width, height: version.native_height }),
            prepPath: targetPath,
          };
        },
      },
      log
    );
    return NextResponse.json({ job: publicJob(job), duplicate, reqId: log.reqId }, { status: duplicate ? 200 : 202 });
  } catch (err) {
    return failure(log, err, "composite_correct_failed", { userId: user.id, versionId });
  }
}
