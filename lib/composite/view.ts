// What the browser sees of a composite project. Server-only.
//
// Rows are read with the caller's RLS client (`supabase`), so ownership is
// proved by the "owner reads" policies rather than by a filter someone could
// forget; signed URLs are minted with the service client afterwards, only for
// paths that sit inside the caller's own tree.

import type { SupabaseClient } from "@supabase/supabase-js";
import { exportPlan, type ExportPlan } from "@/lib/composite/dimensions";
import { isOwnCompositePath, signReads } from "@/lib/composite/storage";
import type {
  CompositeGroup,
  CompositeJob,
  CompositeSource,
  CompositeVersion,
} from "@/lib/composite/types";

// Long enough for a long editing session on the project page.
const VIEW_URL_TTL_S = 3600;

export type PublicJob = Omit<
  CompositeJob,
  "status_url" | "response_url" | "cancel_url" | "provider_request_id" | "lease_until" | "idempotency_key"
>;

export function publicJob(job: CompositeJob): PublicJob {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { status_url, response_url, cancel_url, provider_request_id, lease_until, idempotency_key, ...rest } = job;
  return rest;
}

export interface SourceView extends CompositeSource {
  refUrl: string | null;
}
export interface VersionView extends CompositeVersion {
  previewUrl: string | null;
  plan: ExportPlan;
}
export interface GroupView {
  group: CompositeGroup;
  sources: SourceView[];
  versions: VersionView[];
  jobs: PublicJob[];
}

export async function loadGroupView(
  supabase: SupabaseClient<any, any, any>,
  serviceClient: SupabaseClient<any, any, any>,
  userId: string,
  groupId: string
): Promise<GroupView | null> {
  const { data: group, error } = await supabase
    .from("composite_groups")
    .select("*")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw new Error(`reading the composite failed: ${error.message}`);
  if (!group) return null;

  const [sources, versions, jobs] = await Promise.all([
    supabase.from("composite_sources").select("*").eq("group_id", groupId).order("sequence"),
    supabase.from("composite_versions").select("*").eq("group_id", groupId).order("version_number"),
    supabase.from("composite_jobs").select("*").eq("group_id", groupId).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [sources, versions, jobs]) {
    if (r.error) throw new Error(`reading the composite failed: ${r.error.message}`);
  }
  const srcRows = (sources.data ?? []) as CompositeSource[];
  const verRows = (versions.data ?? []) as CompositeVersion[];

  const paths = [
    ...srcRows.map((s) => s.reference_path),
    ...verRows.map((v) => v.preview_path),
  ].filter((p): p is string => isOwnCompositePath(p, userId, groupId));
  const urls = await signReads(serviceClient, paths, VIEW_URL_TTL_S);

  return {
    group: group as CompositeGroup,
    sources: srcRows.map((s) => ({ ...s, refUrl: s.reference_path ? urls.get(s.reference_path) ?? null : null })),
    versions: verRows.map((v) => ({
      ...v,
      previewUrl: urls.get(v.preview_path) ?? null,
      plan: exportPlan({ width: v.native_width, height: v.native_height }),
    })),
    jobs: ((jobs.data ?? []) as CompositeJob[]).map(publicJob),
  };
}

/** Projects list with the current version's preview, newest first. */
export async function listGroupCards(
  supabase: SupabaseClient<any, any, any>,
  serviceClient: SupabaseClient<any, any, any>,
  userId: string,
  limit = 24
) {
  const { data: groups, error } = await supabase
    .from("composite_groups")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listing composites failed: ${error.message}`);
  const rows = (groups ?? []) as CompositeGroup[];
  const versionIds = rows.map((g) => g.current_version_id).filter((v): v is string => Boolean(v));
  let previews = new Map<string, string>();
  if (versionIds.length) {
    const { data: vs, error: vErr } = await supabase
      .from("composite_versions")
      .select("id, group_id, preview_path")
      .in("id", versionIds);
    if (vErr) throw new Error(`listing composite previews failed: ${vErr.message}`);
    const byVersion = new Map(((vs ?? []) as Pick<CompositeVersion, "id" | "group_id" | "preview_path">[]).map((v) => [v.id, v]));
    const urls = await signReads(
      serviceClient,
      [...byVersion.values()]
        .filter((v) => isOwnCompositePath(v.preview_path, userId, v.group_id))
        .map((v) => v.preview_path),
      VIEW_URL_TTL_S
    );
    previews = new Map(
      [...byVersion.values()].map((v) => [v.group_id, urls.get(v.preview_path) ?? ""])
    );
  }
  return rows.map((g) => ({ group: g, previewUrl: previews.get(g.id) || null }));
}

export type GroupCard = Awaited<ReturnType<typeof listGroupCards>>[number];
