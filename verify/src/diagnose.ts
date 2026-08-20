/**
 * Turning a probe response into a verdict + an operator-actionable sentence.
 *
 * Split out of the specs so the *classification* of the incidents this suite was
 * built for can itself be unit-tested (see diagnose.unit.test.ts). "It would have
 * caught it" is a claim worth pinning to a test.
 */
import { explain, type ProbeResult } from './rest';

export type Verdict = { ok: true } | { ok: false; reason: string };

export interface TableSite {
  schema: string;
  table: string;
  role: string;
  /** `file:line` of the first place the code touches it. */
  site: string;
}

/** SELECT probe against one table, as one role. */
export function diagnoseTableProbe(p: ProbeResult, at: TableSite): Verdict {
  if (p.code === '42501' && /schema/i.test(p.message ?? '')) {
    return {
      ok: false,
      reason:
        `permission denied for schema "${at.schema}" as ${at.role} — every RLS-client query in ` +
        `the app fails with 42501 and the UI shows nothing at all. Fix: ` +
        `grant usage on schema ${at.schema} to ${at.role}; (${explain(p)})`,
    };
  }
  if (p.code === '42501') {
    return {
      ok: false,
      reason: `${at.role} lacks privileges on ${at.schema}.${at.table} — used at ${at.site} (${explain(p)})`,
    };
  }
  if (p.code === '42P01' || p.code === 'PGRST205') {
    return {
      ok: false,
      reason:
        `relation ${at.schema}.${at.table} does not exist — used at ${at.site}. Every client in ` +
        `this app is built with db:{schema:"mypix"}, so a bare .from("${at.table}") means ` +
        `mypix.${at.table}; cross-schema reads must say .schema("core") explicitly (${explain(p)})`,
    };
  }
  if (p.code === 'PGRST106') {
    return {
      ok: false,
      reason: `schema "${at.schema}" is not exposed through PostgREST (${explain(p)})`,
    };
  }
  if (!p.ok) {
    return { ok: false, reason: `${at.schema}.${at.table} as ${at.role}: ${explain(p)}` };
  }
  return { ok: true };
}

/**
 * RPC probe. Anything that is not "no such function" or "no EXECUTE" counts as
 * success: the function's own raised error (UNKNOWN_BRAND, a bad cast) proves
 * both that it exists and that the role is allowed to call it, without the probe
 * having to supply real arguments — which is what keeps it side-effect free.
 */
export function diagnoseRpcProbe(
  p: ProbeResult,
  at: { schema: string; fn: string; args: string[]; role: string; site: string },
): Verdict {
  if (p.code === 'PGRST202' || p.code === 'PGRST203') {
    return {
      ok: false,
      reason:
        `no function ${at.schema}.${at.fn}(${at.args.join(', ')}) — called from ${at.site}. ` +
        `PostgREST matches an overload by argument NAME, so a renamed parameter reads as a ` +
        `missing function (${explain(p)})`,
    };
  }
  if (p.code === '42501') {
    return {
      ok: false,
      reason:
        `${at.role} has no EXECUTE on ${at.schema}.${at.fn} — called from ${at.site} ` +
        `(${explain(p)})`,
    };
  }
  if (p.status >= 500) {
    return { ok: false, reason: `${at.schema}.${at.fn} probe failed in transport: ${explain(p)}` };
  }
  return { ok: true };
}

/**
 * The inverse assertion for a privileged RPC: it must NOT be callable by a
 * browser-reachable role. `core.ensure_wallet`/`spend_credits`/`grant_credits`/
 * `settle_payment`/`bind_entity` are SECURITY DEFINER, take the target user as a
 * parameter and carry no authorization check of their own, so an anon or
 * authenticated key with EXECUTE could mint unlimited credits for any user on any
 * product. Platform migration 0021 revoked them from PUBLIC; this keeps them that
 * way.
 */
export function diagnoseRpcMustBeDenied(
  p: ProbeResult,
  at: { schema: string; fn: string; role: string },
): Verdict {
  if (p.code === '42501' || p.code === 'PGRST202' || p.status === 404) return { ok: true };
  return {
    ok: false,
    reason:
      `${at.role} can reach ${at.schema}.${at.fn} — these wallet RPCs are SECURITY DEFINER with ` +
      `no internal authorization check, so any holder of the anon key could grant themselves ` +
      `credits. Fix: revoke execute on function ${at.schema}.${at.fn}(…) from public, anon, ` +
      `authenticated; (probe answered ${explain(p)})`,
  };
}

/** Bucket existence. */
export function diagnoseBucketProbe(
  p: ProbeResult,
  at: { bucket: string; sites: string[] },
): Verdict {
  if (p.ok) return { ok: true };
  return {
    ok: false,
    reason:
      `bucket "${at.bucket}" does not exist on this project — every upload/download at ` +
      `${at.sites.join(', ')} fails with NoSuchBucket. Storage answers 200 [] when you LIST a ` +
      `missing bucket, so this is invisible to any check that does not ask for the bucket ` +
      `itself (${explain(p)})`,
  };
}

/**
 * Bucket visibility. The app hands `getPublicUrl(...)` links to Astria, which
 * fetches them with no credentials — a private bucket breaks training silently.
 */
export function diagnoseBucketVisibility(
  bucket: { public?: boolean },
  at: { bucket: string; needsPublic: boolean; sites: string[] },
): Verdict {
  if (!at.needsPublic) return { ok: true };
  if (bucket.public === true) return { ok: true };
  return {
    ok: false,
    reason:
      `bucket "${at.bucket}" is PRIVATE, but the code builds unauthenticated public URLs from ` +
      `it at ${at.sites.join(', ')} — Astria fetches training photos over those URLs with no ` +
      `credentials, so every training job would fail to read its inputs`,
  };
}

/** Throw when the verdict is a failure — one clear reason, no stack noise. */
export function assertOk(v: Verdict): void {
  if (!v.ok) throw new Error(v.reason);
}
