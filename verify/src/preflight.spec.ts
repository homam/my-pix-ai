/**
 * LAYER 1 — PLATFORM PREFLIGHT.
 *
 * Asserts that every external resource the code depends on exists AND is
 * reachable *by the role that actually uses it*. Read-only; safe against
 * production; finishes in seconds.
 *
 * It exists because on 2026-08-19/20 three defects each broke this product in
 * production and NOTHING caught them — the deploy gate was "HTTP 200 + the brand
 * name appears in the HTML", which is exactly what a broken app returns:
 *
 *   1. `getBalance()` was handed the RLS client instead of the service-role one.
 *      The wallet RPCs are service_role-only, and the call is awaited in the
 *      (dashboard) LAYOUT, so /dashboard /studio /account /models/new all 500'd
 *      on both brands while `/` kept answering 200.
 *   2. `STORAGE_BUCKET` named "user-uploads", a bucket that does not exist (the
 *      real one is `mypix`). Every upload/download failed NoSuchBucket.
 *   3. /account read `mypix.credit_transactions` (the ledger is
 *      `core.credit_transactions`) and swallowed the error, so it rendered
 *      "No transactions yet" forever.
 *
 * Each is one assertion below: (1) `credit-client call sites`, (2) `storage
 * buckets`, (3) `tables`.
 *
 * The expected-resource list is DERIVED from the source (see inventory.ts), so it
 * cannot rot the way a hand-written checklist does. Anything the scanner cannot
 * resolve statically FAILS rather than being skipped.
 *
 *   npm run preflight                          # against the env in .env.local
 *   VERIFY_TARGET=https://… npm run preflight  # + the deployed runtime's /api/health
 *   VERIFY_ROOT=/path/to/worktree npm run preflight   # scan a different checkout
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultScanOptions, scanInventory } from './inventory';
import { scanCreditCallSites, describeViolation } from './credit-clients';
import { describe as describeConfig, loadConfig } from './config';
import {
  BRAND,
  REQUIRED_ENV,
  disabledFeatures,
  packEnvMatrix,
  stripeEnabled,
  unsellablePacks,
} from './env-contract';
import { authSettings, callRpc, explain, getBucket, selectOne, type Creds } from './rest';
import {
  assertOk,
  diagnoseBucketProbe,
  diagnoseBucketVisibility,
  diagnoseRpcMustBeDenied,
  diagnoseRpcProbe,
  diagnoseTableProbe,
} from './diagnose';
import { mintSession, type Session } from './session';

const cfg = loadConfig();
const creds: Creds = {
  supabaseUrl: cfg.supabaseUrl,
  anonKey: cfg.anonKey,
  serviceKey: cfg.serviceKey,
};
const scan = defaultScanOptions(cfg.scanRoot);
const inventory = scanInventory(scan);
const credit = scanCreditCallSites(scan);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** A brand key that cannot exist, so every core.* RPC aborts with UNKNOWN_BRAND
 * before touching a wallet — proves EXECUTE without a side effect. */
const UNKNOWN_BRAND = '__mypix_preflight_no_such_brand__';

/** Synthesize a harmless value for an RPC argument, keyed off its name. */
function probeValue(arg: string): unknown {
  if (/brand/.test(arg)) return UNKNOWN_BRAND;
  if (/slug|ref|reason|provider|pack|currency/.test(arg)) return '__mypix_preflight__';
  if (/user|model|image/.test(arg)) return NIL_UUID;
  if (/cost|amount|cents|count|delta/.test(arg)) return 1;
  return null;
}

/** The privileged wallet RPCs, taken from the inventory rather than a hand list. */
const PRIVILEGED_RPCS = inventory.rpcs.filter((r) => r.schema === 'core');

let session: Session | null = null;
let sessionError: string | null = null;

beforeAll(async () => {
  console.log(`\n  preflight · ${describeConfig(cfg)}`);
  console.log(
    `  inventory · ${inventory.tables.length} tables · ${inventory.buckets.length} buckets · ` +
      `${inventory.rpcs.length} rpcs · ${credit.sites.length} credit call sites\n`,
  );
  if (!creds.supabaseUrl || !creds.anonKey || !creds.serviceKey) return;
  try {
    session = await mintSession(creds, cfg.testUserEmail);
  } catch (e) {
    sessionError = String(e);
  }
});

// ───────────────────────────────────────────────────────────────── credentials
describe('credentials', () => {
  it('has the Supabase URL, anon key and service-role key', () => {
    expect(cfg.supabaseUrl, 'NEXT_PUBLIC_SUPABASE_URL is empty').not.toBe('');
    expect(cfg.anonKey, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is empty').not.toBe('');
    expect(cfg.serviceKey, 'SUPABASE_SERVICE_ROLE_KEY is empty').not.toBe('');
  });

  it(`can mint an authenticated session for ${cfg.testUserEmail} without a password`, () => {
    expect(sessionError, sessionError ?? '').toBeNull();
    expect(session?.accessToken, 'no access token').toBeTruthy();
  });
});

// ──────────────────────────────────────────────────────────────── env contract
describe('runtime environment', () => {
  beforeAll(() => {
    const off = disabledFeatures(cfg.env);
    if (off.length) console.log(`  features · off in this environment: ${off.join(', ')}`);
  });

  for (const key of REQUIRED_ENV) {
    it(`${key} is set`, () => {
      expect(
        (cfg.env[key] ?? '').trim(),
        `${key} is required — see verify/src/env-contract.ts for why it is not optional`,
      ).not.toBe('');
    });
  }
});

// ─────────────────────────────────────────────────────────── brand ↔ deployment
/**
 * The my-pix-ai analogue of "a client is offered only what the deployment can
 * run": /pricing renders BRAND.packs, and checkout resolves each pack's
 * `priceId` through `process.env`. Advertising a pack whose price env is unset
 * gives the user a button that 500s.
 */
describe('brand offering', () => {
  beforeAll(() => {
    const rows = packEnvMatrix(cfg.env)
      .map((p) => `${p.packId}:${p.credits}cr/$${(p.priceCents / 100).toFixed(0)}(${p.envKey})`)
      .join(', ');
    console.log(
      `  packs · brand=${BRAND.key} · ${rows} · stripe=${stripeEnabled(cfg.env) ? 'on' : 'off'}`,
    );
  });

  it('the brand key this build was compiled with matches the one under test', () => {
    expect(
      BRAND.key,
      'NEXT_PUBLIC_BRAND_KEY and the resolved brand disagree — lib/brand.ts read a different key ' +
        'than the verification config did, so every brand-scoped assertion below is meaningless',
    ).toBe(cfg.brandKey);
  });

  it('every credit pack it advertises can actually be bought', () => {
    const broken = unsellablePacks(cfg.env);
    expect(
      broken.map((p) => `${p.packId} (${p.name}) needs ${p.envKey}`),
      'STRIPE_SECRET_KEY is set, so /pricing renders real checkout buttons — but lib/stripe.ts ' +
        'throws "Missing env var" for these packs, so clicking one 500s',
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── scan health
describe('resource inventory', () => {
  it('resolves every table / bucket / rpc name statically', () => {
    expect(
      inventory.unresolved.map((u) => `${u.ref.file}:${u.ref.line} ${u.kind}(${u.expression})`),
      'a computed resource name cannot be verified — hoist it into a constant so preflight can see it',
    ).toEqual([]);
  });

  it('found the resources the app is built on', () => {
    expect(
      inventory.tables.length,
      'no tables found — the scanner is broken, not the platform',
    ).toBeGreaterThan(3);
    expect(inventory.buckets.length, 'no storage buckets found — scanner broken').toBeGreaterThan(
      0,
    );
    expect(inventory.rpcs.length, 'no rpcs found — scanner broken').toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────── incident 1: credit clients
describe('credit-client call sites', () => {
  beforeAll(() => {
    for (const c of credit.contracts) {
      console.log(`  credits · ${c.name}() requires the ${c.requires} client`);
    }
  });

  it('lib/credits.ts still declares helpers to check', () => {
    expect(
      credit.contracts.map((c) => c.name),
      'no credit helpers were classified — the scanner lost sight of lib/credits.ts and this ' +
        'whole check would silently pass',
    ).not.toEqual([]);
  });

  it('is exercised by at least one call site', () => {
    expect(
      credit.sites.length,
      'no call sites found for any credit helper — the check covers nothing',
    ).toBeGreaterThan(0);
  });

  it('every call passes the client that helper requires', () => {
    const bad = credit.sites.filter((s) => s.passed !== s.requires);
    expect(
      bad.map(describeViolation),
      'a credit helper is handed the wrong Supabase client — this is the 2026-08-19 outage that ' +
        'took every authenticated route to 500 while the landing page stayed 200',
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────── schema-level access
// "permission denied for schema mypix" in one assertion per (schema, role).
const schemaRoles = new Map<string, Set<'service_role' | 'authenticated'>>();
for (const t of inventory.tables) {
  const set = schemaRoles.get(t.schema) ?? new Set();
  for (const r of t.roles) set.add(r);
  schemaRoles.set(t.schema, set);
}

describe('schema access', () => {
  for (const [schema, roles] of schemaRoles) {
    for (const role of roles) {
      const witness = inventory.tables.find((t) => t.schema === schema && t.roles.includes(role))!;
      it(`role "${role}" can use schema "${schema}"`, async () => {
        if (role === 'authenticated' && !session) throw new Error(`no session: ${sessionError}`);
        const r = await selectOne(creds, role, schema, witness.table, session?.accessToken);
        assertOk(
          diagnoseTableProbe(r, {
            schema,
            table: witness.table,
            role,
            site: `${witness.refs[0]!.file}:${witness.refs[0]!.line}`,
          }),
        );
      });
    }
  }
});

// ─────────────────────────────────────────────── incident 3: per-table access
describe('tables', () => {
  for (const t of inventory.tables) {
    for (const role of t.roles) {
      it(`${t.schema}.${t.table} is readable by ${role}`, async () => {
        if (role === 'authenticated' && !session) throw new Error(`no session: ${sessionError}`);
        const r = await selectOne(creds, role, t.schema, t.table, session?.accessToken);
        assertOk(
          diagnoseTableProbe(r, {
            schema: t.schema,
            table: t.table,
            role,
            site: `${t.refs[0]!.file}:${t.refs[0]!.line}`,
          }),
        );
      });
    }
  }
});

// ────────────────────────────────────────────── incident 2: storage buckets
describe('storage buckets', () => {
  for (const b of inventory.buckets) {
    const used = [
      b.ops.authenticated.length ? `authenticated:${b.ops.authenticated.join('/')}` : '',
      b.ops.service_role.length ? `service_role:${b.ops.service_role.join('/')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const sites = b.refs.map((x) => `${x.file}:${x.line}`);
    const needsPublic = [...b.ops.authenticated, ...b.ops.service_role].includes('getPublicUrl');

    it(`bucket "${b.bucket}" exists (${used})`, async () => {
      const r = await getBucket(creds, b.bucket);
      assertOk(diagnoseBucketProbe(r, { bucket: b.bucket, sites }));
    });

    it(`bucket "${b.bucket}" is ${needsPublic ? 'public — the code hands out unauthenticated URLs' : 'reachable'}`, async () => {
      const r = await getBucket(creds, b.bucket);
      if (!r.ok) return; // already reported by the existence assertion
      assertOk(
        diagnoseBucketVisibility(r.body as { public?: boolean }, {
          bucket: b.bucket,
          needsPublic,
          sites,
        }),
      );
    });
  }
});

// ───────────────────────────────────────────────────────────────────────── rpcs
describe('rpcs', () => {
  for (const r of inventory.rpcs) {
    for (const role of r.roles) {
      it(`${r.schema}.${r.fn}(${r.args.join(', ')}) exists and is executable by ${role}`, async () => {
        if (r.args.length === 0) {
          throw new Error(
            `could not read the argument names of ${r.schema}.${r.fn} from ` +
              `${r.refs[0]!.file}:${r.refs[0]!.line} — PostgREST resolves overloads by argument ` +
              'name, so it cannot be probed',
          );
        }
        if (role === 'authenticated' && !session) throw new Error(`no session: ${sessionError}`);
        const args = Object.fromEntries(r.args.map((a) => [a, probeValue(a)]));
        const res = await callRpc(creds, role, r.schema, r.fn, args, session?.accessToken);
        assertOk(
          diagnoseRpcProbe(res, {
            schema: r.schema,
            fn: r.fn,
            args: r.args,
            role,
            site: `${r.refs[0]!.file}:${r.refs[0]!.line}`,
          }),
        );
      });
    }
  }
});

/**
 * The security half of the same fact. Platform migration 0021 made the wallet
 * RPCs service_role-only; if that were ever reverted, incident 1 would stop
 * failing (the RLS client would "work") and the anon key would become a credit
 * printer. Both halves have to be asserted or neither means anything.
 */
describe('privileged rpcs are not browser-reachable', () => {
  it('found the core.* wallet RPCs to guard', () => {
    expect(
      PRIVILEGED_RPCS.map((r) => r.fn),
      'no core.* RPCs in the inventory — this guard covers nothing',
    ).not.toEqual([]);
  });

  for (const r of PRIVILEGED_RPCS) {
    for (const role of ['anon', 'authenticated'] as const) {
      it(`core.${r.fn} is NOT executable by ${role}`, async () => {
        if (role === 'authenticated' && !session) throw new Error(`no session: ${sessionError}`);
        const args = Object.fromEntries(r.args.map((a) => [a, probeValue(a)]));
        const res = await callRpc(creds, role, r.schema, r.fn, args, session?.accessToken);
        assertOk(diagnoseRpcMustBeDenied(res, { schema: r.schema, fn: r.fn, role }));
      });
    }
  }
});

// ─────────────────────────────────────────────────── brand ↔ platform coupling
describe('brand ↔ platform', () => {
  it(`core.brands has a row for "${BRAND.key}" (wallets cannot exist without it)`, async () => {
    if (!session) throw new Error(`no session: ${sessionError}`);
    const res = await callRpc(creds, 'service_role', 'core', 'ensure_wallet', {
      p_user: session.userId,
      p_brand: BRAND.key,
    });
    if (/UNKNOWN_BRAND/.test(res.message ?? '')) {
      throw new Error(
        `core.ensure_wallet rejects brand "${BRAND.key}" — the brand is deployed but not ` +
          'registered on the platform (one INSERT into core.brands, see PLATFORM.md)',
      );
    }
    if (/ENTITY_MISMATCH/.test(res.message ?? '')) {
      throw new Error(
        `${cfg.testUserEmail} belongs to a different entity than brand "${BRAND.key}" ` +
          `(${BRAND.entity.key}). Accounts never cross entities — use this brand's own test ` +
          'account (VERIFY_USER_EMAIL / verify/src/config.ts BRAND_TEST_USERS)',
      );
    }
    expect(res.ok, `ensure_wallet(${BRAND.key}): ${explain(res)}`).toBe(true);
    expect(typeof res.body, 'ensure_wallet should return a numeric balance').toBe('number');
  });

  it('every login method the brand advertises is enabled on the auth project', async () => {
    const res = await authSettings(creds);
    expect(res.ok, `GET /auth/v1/settings: ${explain(res)}`).toBe(true);
    const s = res.body as { external?: Record<string, boolean> };
    const enabled = (method: string): boolean =>
      method === 'magic_link' || method === 'password'
        ? s.external?.email !== false
        : s.external?.[method] === true;
    const broken = BRAND.auth.methods.filter((m) => !enabled(m));
    expect(
      broken,
      `brand "${BRAND.key}" renders these login buttons but the provider is off on the shared ` +
        'project — they 400 with "Unsupported provider" (auth providers are project-wide, so ' +
        'enabling one turns it on for every brand at once)',
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────── deployed runtime self-check
// Only runs when a target is named explicitly (scripts/deploy.sh does). Verifies
// the CONTAINER's own env/wiring, which local or CI credentials cannot speak for.
describe.runIf(Boolean(cfg.env.VERIFY_TARGET))('deployed runtime', () => {
  it(`${cfg.target}/api/health reports ok`, async () => {
    const res = await fetch(`${cfg.target}/api/health`, { headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      checks?: { name: string; ok: boolean; detail?: string }[];
    } | null;
    expect(res.status, `GET ${cfg.target}/api/health`).toBe(200);
    const failed = (body?.checks ?? []).filter((c) => !c.ok);
    expect(
      failed.map((c) => `${c.name}: ${c.detail ?? 'failed'}`),
      'the running container reports broken dependencies',
    ).toEqual([]);
    expect(body?.ok, 'health endpoint reports not-ok').toBe(true);
  });
});
