/**
 * LAYER 3 — pins the exact error signatures of the 2026-08-19/20 incidents.
 *
 * The claim "this suite would have caught it" is only as good as the classifier
 * that turns a probe response into a failure. If these stop being recognised the
 * preflight quietly loses the ability to catch them again, and nothing else in
 * the suite would notice. No network, no credentials.
 */
import { describe, expect, it } from 'vitest';
import {
  diagnoseBucketProbe,
  diagnoseBucketVisibility,
  diagnoseRpcMustBeDenied,
  diagnoseRpcProbe,
  diagnoseTableProbe,
} from './diagnose';
import {
  firstArgument,
  helperContracts,
  roleOfClientExpression,
  describeViolation,
} from './credit-clients';

// ── incident 1 — getBalance() was handed the RLS client ──────────────────────
// Real shape: app/(dashboard)/layout.tsx did
//   const balance = await getBalance(supabase, user.id)   // supabase = createClient()
// which reached core.ensure_wallet under the authenticated role, which migration
// 0021 had revoked → 42501 → the layout threw → /dashboard /studio /account
// /models/new all 500'd on both brands, while / stayed 200.
describe('incident 1 — the credit helper was passed the RLS client', () => {
  const CREDITS = `
    import { createPlatformAdmin } from "@aionized/platform-client/server";
    function platform(supabase: SupabaseClient<any, any, any>) {
      return createPlatformAdmin(supabase, BRAND.key);
    }
    export async function getBalance(supabase: SupabaseClient<any, any, any>, userId: string) {
      return platform(supabase).ensureWallet(userId);
    }
    export async function listCreditHistory(supabase: SupabaseClient<any, any, any>, userId: string) {
      const { data } = await supabase.schema("core").from("credit_transactions").select("*");
      return data;
    }
    export function creditHistoryRow(tx: CreditTransaction) { return tx; }
  `;

  it('derives which helpers need the service-role client from lib/credits.ts itself', () => {
    const contracts = helperContracts(CREDITS);
    expect(contracts.find((c) => c.name === 'getBalance')?.requires).toBe('service_role');
    expect(contracts.find((c) => c.name === 'listCreditHistory')?.requires).toBe('authenticated');
    // A pure reshaper takes no client and must not be treated as a call-site contract.
    expect(contracts.map((c) => c.name)).not.toContain('creditHistoryRow');
  });

  it('reads the role out of an inline `await createClient()` argument', () => {
    expect(roleOfClientExpression('await createClient()', {})).toBe('authenticated');
    expect(roleOfClientExpression('await createServiceClient()', {})).toBe('service_role');
  });

  it('reads the role out of a local variable declaration, not its name', () => {
    // app/api/webhooks/astria/route.ts really does name its service client `supabase`.
    expect(roleOfClientExpression('supabase', { supabase: ['service_role'] })).toBe('service_role');
    expect(roleOfClientExpression('supabase', { supabase: ['authenticated'] })).toBe(
      'authenticated',
    );
  });

  it('refuses to guess when a name is declared both ways in one file', () => {
    expect(roleOfClientExpression('supabase', { supabase: ['authenticated', 'service_role'] })).toBe(
      null,
    );
  });

  it('takes the first argument only, across a multi-line call', () => {
    expect(firstArgument('(\n  await createServiceClient(),\n  user.id\n)')).toBe(
      'await createServiceClient()',
    );
    expect(firstArgument('(supabase, user.id)')).toBe('supabase');
    expect(firstArgument('(supabase)')).toBe('supabase');
  });

  it('names the file, the helper and the consequence in the failure', () => {
    const reason = describeViolation({
      helper: 'getBalance',
      requires: 'service_role',
      because: 'it calls the core.* wallet RPCs, which are SECURITY DEFINER',
      passed: 'authenticated',
      expression: 'supabase',
      ref: { file: 'app/(dashboard)/layout.tsx', line: 22 },
    });
    expect(reason).toContain('app/(dashboard)/layout.tsx:22');
    expect(reason).toContain('getBalance');
    expect(reason).toContain('authenticated');
    expect(reason).toContain('service_role');
  });

  it('classifies the resulting 42501 as a missing EXECUTE grant, naming the call site', () => {
    const v = diagnoseRpcProbe(
      { status: 403, ok: false, code: '42501', message: 'permission denied for function ensure_wallet' },
      {
        schema: 'core',
        fn: 'ensure_wallet',
        args: ['p_user', 'p_brand'],
        role: 'authenticated',
        site: 'app/(dashboard)/layout.tsx:22',
      },
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain('app/(dashboard)/layout.tsx:22');
  });

  it('keeps the security half: those RPCs must stay unreachable from the browser', () => {
    const denied = diagnoseRpcMustBeDenied(
      { status: 403, ok: false, code: '42501' },
      { schema: 'core', fn: 'grant_credits', role: 'anon' },
    );
    expect(denied.ok).toBe(true);
    const reachable = diagnoseRpcMustBeDenied(
      { status: 200, ok: true, body: 500 },
      { schema: 'core', fn: 'grant_credits', role: 'anon' },
    );
    expect(reachable.ok).toBe(false);
    expect(!reachable.ok && reachable.reason).toContain('revoke execute on function');
  });
});

// ── incident 2 — STORAGE_BUCKET named a bucket that does not exist ───────────
describe('incident 2 — the bucket named in code did not exist', () => {
  it('fails on the storage bucket endpoint and names every call site', () => {
    const v = diagnoseBucketProbe(
      { status: 400, ok: false, code: 'NoSuchBucket', message: 'Bucket not found' },
      { bucket: 'user-uploads', sites: ['lib/storage.ts:30', 'components/NewModelForm.tsx:120'] },
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain('lib/storage.ts:30');
    expect(!v.ok && v.reason).toContain('components/NewModelForm.tsx:120');
    // The reason has to explain why LIST could not have caught it.
    expect(!v.ok && v.reason).toContain('200 []');
  });

  it('passes for the bucket that really exists', () => {
    expect(diagnoseBucketProbe({ status: 200, ok: true }, { bucket: 'mypix', sites: [] }).ok).toBe(
      true,
    );
  });

  it('also fails a bucket flipped private while the code hands out public URLs', () => {
    const v = diagnoseBucketVisibility(
      { public: false },
      { bucket: 'mypix', needsPublic: true, sites: ['lib/storage.ts:50'] },
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain('Astria');
    expect(
      diagnoseBucketVisibility(
        { public: true },
        { bucket: 'mypix', needsPublic: true, sites: [] },
      ).ok,
    ).toBe(true);
  });
});

// ── incident 3 — /account queried mypix.credit_transactions ─────────────────
describe('incident 3 — the ledger was read from the wrong schema', () => {
  const at = {
    schema: 'mypix',
    table: 'credit_transactions',
    role: 'authenticated',
    site: 'lib/credits.ts:136',
  };

  it('reports the missing relation and explains the default-schema trap', () => {
    const v = diagnoseTableProbe(
      {
        status: 404,
        ok: false,
        code: 'PGRST205',
        message: "Could not find the table 'mypix.credit_transactions' in the schema cache",
      },
      at,
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain('mypix.credit_transactions does not exist');
    expect(!v.ok && v.reason).toContain('.schema("core")');
    expect(!v.ok && v.reason).toContain('lib/credits.ts:136');
  });

  it('treats a 42P01 the same way', () => {
    expect(diagnoseTableProbe({ status: 404, ok: false, code: '42P01' }, at).ok).toBe(false);
  });

  it('does not confuse "RLS filtered every row" with "the table is missing"', () => {
    expect(diagnoseTableProbe({ status: 200, ok: true, body: [] }, at).ok).toBe(true);
  });
});

// ── the schema-USAGE failure that hit the sibling product ───────────────────
// Not our outage, but the same platform: `authenticated` had no USAGE on the
// product schema, so every RLS query died 42501. Cheap to keep guarded.
describe('schema-grant failures stay distinguishable from table-grant failures', () => {
  const at = { schema: 'mypix', table: 'models', role: 'authenticated', site: 'x.tsx:1' };

  it('names the exact grant to run', () => {
    const v = diagnoseTableProbe(
      { status: 403, ok: false, code: '42501', message: 'permission denied for schema mypix' },
      at,
    );
    expect(!v.ok && v.reason).toContain('grant usage on schema mypix to authenticated');
  });

  it('is not confused with a table-level grant failure', () => {
    const v = diagnoseTableProbe(
      { status: 403, ok: false, code: '42501', message: 'permission denied for table models' },
      at,
    );
    expect(!v.ok && v.reason).toContain('lacks privileges on mypix.models');
    expect(!v.ok && v.reason).not.toContain('grant usage on schema');
  });
});

describe('rpc diagnosis', () => {
  const at = {
    schema: 'core',
    fn: 'spend_credits',
    args: ['p_user', 'p_brand'],
    role: 'service_role',
    site: 'y.ts:1',
  };

  it('treats a renamed parameter as a missing function, and says so', () => {
    const v = diagnoseRpcProbe({ status: 404, ok: false, code: 'PGRST202' }, at);
    expect(!v.ok && v.reason).toContain('argument NAME');
  });

  it('accepts the function own error as proof it exists and is callable', () => {
    expect(
      diagnoseRpcProbe({ status: 400, ok: false, code: 'P0001', message: 'UNKNOWN_BRAND' }, at).ok,
    ).toBe(true);
  });
});
