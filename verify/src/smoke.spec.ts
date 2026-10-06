/**
 * LAYER 2 — AUTHENTICATED JOURNEY SMOKE.
 *
 * Runs the critical user journeys end to end against a real deployment and
 * asserts on OUTCOMES, not status codes.
 *
 * Every failure that reached users on this product presented as a page that
 * still "worked" from the outside, so status codes are explicitly not evidence
 * here. In particular:
 *
 *   - the whole signed-in area 500'd for days while `/` returned 200 and the
 *     deploy gate said OK, so step 2 signs in with a REAL browser cookie and
 *     asserts the dashboard renders (not a redirect to /login, not an error);
 *   - /account rendered "No transactions yet" because it swallowed a query
 *     error, so step 4 first reads the ledger directly and then insists the page
 *     shows what the ledger actually holds;
 *   - every upload 404'd NoSuchBucket, so step 5 does the real signed-upload
 *     round trip THROUGH the app's own /api/upload route.
 *
 *   npm run smoke                                           # localhost
 *   VERIFY_TARGET=https://wy7kp3ie3e.eu-central-1.awsapprunner.com npm run smoke
 *
 * Uses an owner-provisioned account and a password-free session (session.ts).
 * Everything it writes is deleted in afterAll. The account MUST belong to the
 * brand's entity — see BRAND_TEST_USERS in config.ts.
 */
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CREDIT_COSTS } from '@/types';
import { COMPOSITE_BUCKET } from '@/lib/composite/storage';
import { MOCK_FAIL_MARKER, MOCK_FAIL_ONCE_MARKER } from '@/lib/composite/provider';
import { defaultScanOptions, scanInventory } from './inventory';
import { describe as describeConfig, loadConfig } from './config';
import { BRAND } from './env-contract';
import {
  callRpc,
  createSignedUploadUrl,
  explain,
  fetchPublicObject,
  putToSignedUrl,
  query,
  removeObject,
  write,
  type Creds,
} from './rest';
import { mintSession, sessionCookieHeader, type Session } from './session';

const cfg = loadConfig();
const creds: Creds = {
  supabaseUrl: cfg.supabaseUrl,
  anonKey: cfg.anonKey,
  serviceKey: cfg.serviceKey,
};
const inventory = scanInventory(defaultScanOptions(cfg.scanRoot));

/** A token no page would contain by accident, so finding it proves a real round trip. */
const SENTINEL = `mypix-verify-${Date.now()}`;

const state: {
  session: Session | null;
  cookie: string;
  modelId: string | null;
  objects: { bucket: string; path: string }[];
  composite: {
    mode: 'off' | 'mock' | 'paid';
    renders: boolean;
    groupId: string | null;
    sourceIds: string[];
    versionIds: string[];
  };
} = {
  session: null,
  cookie: '',
  modelId: null,
  objects: [],
  composite: { mode: 'off', renders: false, groupId: null, sourceIds: [], versionIds: [] },
};

function session(): Session {
  if (!state.session) throw new Error('no session — the sign-in step must run first');
  return state.session;
}

/** A request to the APP as a signed-in browser would make it (cookie auth only —
 *  middleware.ts and the (dashboard) layout have no bearer-token path). */
function page(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${cfg.target}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      cookie: state.cookie,
      'user-agent': 'mypix-verify/1.0',
      ...(init.headers as Record<string, string>),
    },
  });
}

/** PostgREST as the signed-in user: exactly the path the browser client takes. */
function asUser(schema: string, path: string) {
  return query(creds, 'authenticated', schema, path, session().accessToken);
}

beforeAll(() => {
  console.log(`\n  smoke · ${describeConfig(cfg)}\n`);
});

/** Every object under a storage prefix, one folder level deep (the composite layout). */
async function listUnder(prefix: string): Promise<string[]> {
  const list = async (p: string) => {
    const res = await fetch(`${creds.supabaseUrl}/storage/v1/object/list/${COMPOSITE_BUCKET}`, {
      method: 'POST',
      headers: { apikey: creds.serviceKey, authorization: `Bearer ${creds.serviceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: p, limit: 1000 }),
    });
    return ((await res.json().catch(() => [])) as { name: string; id: string | null }[]) ?? [];
  };
  const out: string[] = [];
  for (const e of await list(prefix)) {
    if (e.id === null) for (const f of await list(`${prefix}/${e.name}`)) out.push(`${prefix}/${e.name}/${f.name}`);
    else out.push(`${prefix}/${e.name}`);
  }
  return out;
}

afterAll(async () => {
  if (state.composite.groupId && state.session) {
    // A failed run must not leave a project (or its private media) behind. The
    // app's DELETE refuses while a job runs, so fall back to the service role.
    const groupId = state.composite.groupId;
    const del = await page(`/api/composites/${groupId}`, { method: 'DELETE' }).catch(() => null);
    if (del?.status !== 200) {
      for (const path of await listUnder(`${state.session.userId}/composites/${groupId}`).catch(() => [])) {
        await removeObject(creds, 'service_role', COMPOSITE_BUCKET, path).catch(() => {});
      }
      await write(creds, 'service_role', 'mypix', `composite_groups?id=eq.${groupId}`, 'DELETE').catch(() => {});
    }
  }
  if (state.modelId) {
    await write(creds, 'service_role', 'mypix', `models?id=eq.${state.modelId}`, 'DELETE').catch(
      () => {},
    );
  }
  for (const o of state.objects) {
    await removeObject(creds, 'service_role', o.bucket, o.path).catch(() => {});
  }
});

// ── 1. sign in ───────────────────────────────────────────────────────────────
it('1 · signs in and builds the cookie a real browser would carry', async () => {
  state.session = await mintSession(creds, cfg.testUserEmail);
  expect(state.session.userId, 'session has no user id').toBeTruthy();
  expect(state.session.refreshToken, 'no refresh token — the app cookie needs one').toBeTruthy();
  state.cookie = await sessionCookieHeader(creds, state.session);
  expect(state.cookie.length, 'empty auth cookie').toBeGreaterThan(0);
});

// ── 2. the signed-in app shell actually renders ──────────────────────────────
// THE assertion that was missing on 2026-08-19. The dashboard layout awaits
// getBalance(); when that threw 42501 the whole authenticated area 500'd, and
// every gate we had kept passing because `/` was fine.
it('2 · every authenticated route renders for a signed-in user', async () => {
  const routes = ['/dashboard', '/studio', '/account', '/models/new'];
  const broken: string[] = [];
  for (const route of routes) {
    const res = await page(route);
    if (res.status === 200) continue;
    const body = await res.text().catch(() => '');
    const location = res.headers.get('location');
    // A Next.js error page is 40KB of chunk preloads with the actual cause only
    // in the server log, so quoting it drowns the finding. Say what it is.
    const detail = /__next_error__/.test(body)
      ? ' · server-side render threw (Next.js error page); the cause is in the container log'
      : res.status >= 500
        ? ` · ${body.slice(0, 200).replace(/\s+/g, ' ')}`
        : '';
    broken.push(`${route} → HTTP ${res.status}${location ? ` → ${location}` : ''}${detail}`);
  }
  expect(
    broken,
    'signed-in routes that do not render. A 3xx to /login means the session cookie was rejected; ' +
      'a 500 means server-side rendering threw — the dashboard LAYOUT reads the credit balance, ' +
      'so one bad client there takes out every route at once',
  ).toEqual([]);
});

it('3 · the dashboard shows this user credit balance, not a placeholder', async () => {
  const wallet = await callRpc(creds, 'service_role', 'core', 'ensure_wallet', {
    p_user: session().userId,
    p_brand: BRAND.key,
  });
  expect(
    typeof wallet.body,
    `core.ensure_wallet(${BRAND.key}) did not return a balance: ${explain(wallet)}` +
      (/ENTITY_MISMATCH/.test(wallet.message ?? '')
        ? ` — ${cfg.testUserEmail} belongs to a different entity than this brand; accounts never cross entities`
        : ''),
  ).toBe('number');

  const html = await (await page('/dashboard')).text();
  expect(
    html,
    'the dashboard rendered without the credits chip — the balance read failed and the UI ' +
      'swallowed it',
  ).toMatch(/credit/i);
  expect(
    html,
    `the dashboard does not show the wallet balance (${wallet.body}) the platform reports`,
  ).toContain(String(wallet.body));
});

// ── 4. credit history ────────────────────────────────────────────────────────
// The ledger lives in core.credit_transactions, filtered by brand. Reading it
// directly first means the page assertion is against REAL data rather than an
// empty state that both a working and a broken page would produce.
it('4 · /account renders the credit history the ledger actually holds', async () => {
  const ledger = await asUser(
    'core',
    `credit_transactions?select=id,delta,reason,ref,created_at&user_id=eq.${session().userId}` +
      `&brand=eq.${BRAND.key}&order=created_at.desc&limit=5`,
  );
  expect(
    ledger.status,
    `reading core.credit_transactions as authenticated: ${explain(ledger)} — the ` +
      'credit_tx_select_own policy plus a SELECT grant is what makes /account work',
  ).toBe(200);
  const rows = ledger.body as { delta: number; reason: string | null }[];

  const html = await (await page('/account')).text();
  if (rows.length === 0) {
    console.log('  account · ledger is empty for this user; the empty state is the correct render');
    return;
  }
  expect(
    html,
    `the ledger holds ${rows.length} transaction(s) for ${cfg.testUserEmail} on brand ` +
      `${BRAND.key}, but /account renders the empty state — a swallowed query error looks ` +
      'exactly like "no transactions", which is how this hid for a week',
  ).not.toMatch(/no transactions yet/i);
  // A signed amount from the newest row must appear in the rendered table.
  const newest = rows[0]!;
  const amount = newest.delta >= 0 ? `+${newest.delta}` : String(newest.delta);
  expect(html, `the newest ledger row (${amount}) is not on the page`).toContain(amount);
});

// ── 5. storage round trip through the app own route ──────────────────────────
// /api/upload → signed URL → PUT → anonymous public read → delete. This is the
// real mechanism (no bytes pass through the server) and it is the one that was
// broken by a bucket name that did not exist.
it('5 · uploads a file through /api/upload and reads it back anonymously', async () => {
  const res = await page('/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: `${SENTINEL}.png`,
      contentType: 'image/png',
      purpose: 'edit',
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    path?: string;
    token?: string;
    publicUrl?: string;
    error?: string;
  } | null;
  expect(
    res.status,
    `POST /api/upload → ${res.status} ${JSON.stringify(body)} — this is where a wrong bucket ` +
      'name surfaces: either NoSuchBucket, or "new row violates row-level security policy" ' +
      'because the storage.objects policies are written against the real bucket id',
  ).toBe(200);
  expect(body?.path, 'no upload path returned').toBeTruthy();
  expect(body?.publicUrl, 'no public URL returned').toBeTruthy();

  const bucket = inventory.buckets[0]!.bucket;
  expect(
    body!.path!.split('/')[0],
    'the upload path does not start with the user id — the storage.objects policies key on ' +
      '(storage.foldername(name))[1] = auth.uid(), so this object would be unreadable by its owner',
  ).toBe(session().userId);
  state.objects.push({ bucket, path: body!.path! });

  const payload = `${SENTINEL} payload`;
  const put = await putToSignedUrl(
    creds,
    `object/upload/sign/${bucket}/${body!.path}?token=${body!.token}`,
    payload,
    'text/plain',
  );
  expect(put.ok, `PUT to the signed upload URL failed: ${explain(put)}`).toBe(true);

  // Astria fetches training photos over exactly this URL, with no credentials.
  const anon = await fetchPublicObject(creds, bucket, body!.path!);
  expect(
    anon.ok,
    `the public URL is not readable without credentials (HTTP ${anon.status}) — Astria could ` +
      'not fetch training photos',
  ).toBe(true);
  expect(anon.text, 'bytes read back do not match what was written').toBe(payload);

  const gone = await removeObject(creds, 'service_role', bucket, body!.path!);
  expect(gone.ok, `service role could not delete the object: ${explain(gone)}`).toBe(true);
  state.objects = state.objects.filter((o) => o.path !== body!.path);
});

// ── 6. the user own rows are visible under RLS, and on the page ──────────────
it('6 · a model row the user owns is readable under RLS and listed on /dashboard', async () => {
  const created = await write(creds, 'service_role', 'mypix', 'models', 'POST', {
    user_id: session().userId,
    name: SENTINEL,
    status: 'pending',
  });
  expect(created.ok, `could not create a probe model row: ${explain(created)}`).toBe(true);
  state.modelId = (created.body as { id: string }[])[0]!.id;

  const mine = await asUser('mypix', `models?select=id,name&id=eq.${state.modelId}`);
  expect(mine.status, `reading own models as authenticated: ${explain(mine)}`).toBe(200);
  expect(
    (mine.body as unknown[]).length,
    'the model is invisible to its own owner under RLS — the dashboard would show an empty state',
  ).toBe(1);

  const html = await (await page('/dashboard')).text();
  expect(html, 'the model the user owns is not rendered on /dashboard').toContain(SENTINEL);
});

it('7 · another user rows stay invisible under RLS', async () => {
  const others = await asUser(
    'mypix',
    `models?select=id&user_id=neq.${session().userId}&limit=1`,
  );
  expect(others.status, `RLS probe: ${explain(others)}`).toBe(200);
  expect(
    (others.body as unknown[]).length,
    'the signed-in user can read models belonging to someone else — the mypix RLS policies are ' +
      'not scoping on auth.uid()',
  ).toBe(0);
});

it('8 · deletes the probe model as the service role (cleanup path)', async () => {
  const del = await write(
    creds,
    'service_role',
    'mypix',
    `models?id=eq.${state.modelId}`,
    'DELETE',
  );
  expect(del.ok, `deleting the probe model: ${explain(del)}`).toBe(true);
  const after = await asUser('mypix', `models?select=id&id=eq.${state.modelId}`);
  expect((after.body as unknown[]).length, 'the probe model survived its own delete').toBe(0);
  state.modelId = null;
});

// ── 9. public surfaces still serve signed-out visitors ───────────────────────
it('9 · the landing and pricing pages serve signed-out visitors', async () => {
  for (const path of ['/', '/pricing', '/login']) {
    const res = await fetch(`${cfg.target}${path}`, { redirect: 'manual' });
    expect(res.status, `GET ${path} signed-out → ${res.status}`).toBe(200);
  }
});

// A suite that quietly covers nothing is worse than no suite at all.
it('10 · actually covered the storage buckets the code uses', () => {
  expect(
    inventory.buckets.map((b) => b.bucket),
    'the scan found no buckets, so step 5 asserted nothing',
  ).not.toEqual([]);
});

// ── 11–18. multi-source composites ───────────────────────────────────────────
// upload → owner-only media → queued job (idempotent, charged once) → result in
// All photos → correction → two versions, the first still downloadable → a
// failed job refunds exactly once → delete.
//
// Rendering is free only with the MOCK engine (local dev / CI against a dev
// server: COMPOSITE_PROVIDER=mock). Against a deployment with the paid provider
// the upload, privacy and validation steps run and the render steps are
// skipped, unless VERIFY_COMPOSITE_RENDER=1 asks for a real (≈$1) run.

async function wallet(): Promise<number> {
  const r = await callRpc(creds, 'service_role', 'core', 'ensure_wallet', {
    p_user: session().userId,
    p_brand: BRAND.key,
  });
  if (typeof r.body !== 'number') throw new Error(`ensure_wallet: ${explain(r)}`);
  return r.body;
}

async function appJson(path: string, init: RequestInit = {}) {
  const res = await page(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

async function pollJob(jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await appJson(`/api/composites/jobs/${jobId}`);
    expect(r.status, `GET /api/composites/jobs/${jobId} → ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    const job = r.body!.job as { status: string; version_id: string | null; error: string | null };
    if (!['queued', 'generating', 'review'].includes(job.status)) return r.body!;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.status} after ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 2000));
  }
}

function skipRender(step: string): boolean {
  if (state.composite.renders) return false;
  console.log(
    `  composite · ${step} skipped: provider is ${state.composite.mode} ` +
      '(set COMPOSITE_PROVIDER=mock on the target, or VERIFY_COMPOSITE_RENDER=1 for a paid run)',
  );
  return true;
}

it('11 · reports whether composites are enabled, and how they render', async () => {
  const res = await fetch(`${cfg.target}/api/health`, { headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => null)) as { composite?: { enabled: boolean; provider: string | null } };
  expect(body?.composite, '/api/health does not report the composite feature — stale image?').toBeTruthy();
  const c = body!.composite!;
  state.composite.mode = !c.enabled ? 'off' : c.provider === 'mock' ? 'mock' : 'paid';
  state.composite.renders = c.provider === 'mock' || (c.enabled && cfg.env.VERIFY_COMPOSITE_RENDER === '1');
  console.log(`  composite · enabled=${c.enabled} provider=${c.provider ?? '—'} renders=${state.composite.renders}`);
});

it('12 · creates a composite and uploads two photos through signed slots', async () => {
  if (state.composite.mode === 'off') return console.log('  composite · disabled on target, skipped');

  const created = await appJson('/api/composites', {
    method: 'POST',
    body: JSON.stringify({ name: SENTINEL, mustPreserve: ['the two light spots above the sun'] }),
  });
  expect(created.status, `POST /api/composites → ${JSON.stringify(created.body)}`).toBe(200);
  const groupId = created.body!.group.id as string;
  state.composite.groupId = groupId;

  // Unsupported media is refused before anything is stored or charged.
  const heic = await appJson(`/api/composites/${groupId}/sources`, {
    method: 'POST',
    body: JSON.stringify({
      sources: [{ kind: 'photo', clientId: 'h', originalName: 'x.heic', mimeType: 'image/heic', byteSize: 10, width: 1, height: 1, sequence: 0 }],
    }),
  });
  expect(heic.status, 'a HEIC photo must be rejected as unsupported media').toBe(415);

  const photos = await Promise.all(
    ['#d9772b', '#2b6fd9'].map((color, i) =>
      sharp({ create: { width: 480, height: 640, channels: 3, background: color } })
        .composite([{ input: Buffer.from(`<svg width="480" height="640"><circle cx="${140 + i * 200}" cy="200" r="60" fill="#fff"/></svg>`) }])
        .jpeg()
        .toBuffer(),
    ),
  );
  const reg = await appJson(`/api/composites/${groupId}/sources`, {
    method: 'POST',
    body: JSON.stringify({
      sources: photos.map((b, i) => ({
        kind: 'photo', clientId: `p${i}`, originalName: `${SENTINEL}-${i}.jpg`, mimeType: 'image/jpeg',
        byteSize: b.length, width: 480, height: 640, sequence: i, selected: true,
        sharpness: 100, phash: i ? 'ffffffff00000000' : '00000000ffffffff',
      })),
    }),
  });
  expect(reg.status, `register sources → ${JSON.stringify(reg.body)}`).toBe(200);
  const uploads = reg.body!.uploads as { clientId: string; id: string; original: { path: string; token: string }; reference: { path: string; token: string } }[];
  for (const u of uploads) {
    expect(u.original.path.startsWith(`${session().userId}/composites/${groupId}/`), 'upload path is outside the owner tree').toBe(true);
    const bytes = photos[Number(u.clientId.slice(1))]!;
    for (const slot of [u.original, u.reference]) {
      const put = await putToSignedUrl(creds, `object/upload/sign/${COMPOSITE_BUCKET}/${slot.path}?token=${slot.token}`, bytes, 'image/jpeg');
      expect(put.ok, `PUT ${slot.path}: ${explain(put)}`).toBe(true);
    }
  }
  state.composite.sourceIds = uploads.map((u) => u.id);
  const done = await appJson(`/api/composites/${groupId}/sources/complete`, {
    method: 'POST',
    body: JSON.stringify({ ids: state.composite.sourceIds }),
  });
  expect(done.status, `complete → ${JSON.stringify(done.body)}`).toBe(200);
  expect(done.body!.missing, 'storage does not hold files the browser said it uploaded').toEqual([]);
  expect(done.body!.status).toBe('ready_to_generate');
});

it('13 · composite media and rows are owner-only, and not writable by the user', async () => {
  if (!state.composite.groupId) return;
  const [sid] = state.composite.sourceIds;
  // No cookie → no media.
  const anonMedia = await fetch(`${cfg.target}/api/composites/media/source/${sid}?variant=original`, { redirect: 'manual' });
  expect(anonMedia.status, 'composite media route answered a signed-out request').toBe(401);
  // The bucket is private: the public-object URL must not serve it.
  const path = `${session().userId}/composites/${state.composite.groupId}/originals/${sid}.jpg`;
  const pub = await fetchPublicObject(creds, COMPOSITE_BUCKET, path);
  expect(pub.ok, `the private composite bucket served ${path} publicly`).toBe(false);
  // The owner gets a short-lived signed redirect that really serves the bytes.
  const mine = await page(`/api/composites/media/source/${sid}?variant=original`);
  expect(mine.status, 'owner media request should redirect to a signed URL').toBe(302);
  const signed = await fetch(mine.headers.get('location')!);
  expect(signed.ok && (signed.headers.get('content-type') ?? '').startsWith('image/'), 'signed URL did not serve the image').toBe(true);
  // Another user's rows stay invisible.
  const others = await asUser('mypix', `composite_groups?select=id&user_id=neq.${session().userId}&limit=1`);
  expect((others.body as unknown[]).length, 'another user’s composites are visible under RLS').toBe(0);
  // And the user cannot write server-owned state directly (e.g. flip a source to selected).
  const forged = await write(creds, 'authenticated', 'mypix', `composite_sources?id=eq.${sid}`, 'PATCH', { selected: false }, session().accessToken);
  expect(forged.ok, 'authenticated can UPDATE mypix.composite_sources — every composite write must go through the app').toBe(false);
});

it('14 · a render is queued once, charged once, and finishes as v1', async () => {
  if (!state.composite.groupId || skipRender('render')) return;
  const groupId = state.composite.groupId;
  const sel = await appJson(`/api/composites/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ anchorSourceId: state.composite.sourceIds[0], selection: state.composite.sourceIds.map((id) => ({ id, selected: true })) }),
  });
  expect(sel.status, `PATCH selection → ${JSON.stringify(sel.body)}`).toBe(200);

  const before = await wallet();
  expect(before, `${cfg.testUserEmail} needs ${CREDIT_COSTS.COMPOSITE * 3} credits for this journey`).toBeGreaterThanOrEqual(CREDIT_COSTS.COMPOSITE * 3);
  const key = `smoke${Date.now()}`;
  const first = await appJson(`/api/composites/${groupId}/render`, { method: 'POST', body: JSON.stringify({ idempotencyKey: key }) });
  expect(first.status, `render → ${JSON.stringify(first.body)}`).toBe(202);
  const again = await appJson(`/api/composites/${groupId}/render`, { method: 'POST', body: JSON.stringify({ idempotencyKey: key }) });
  expect(again.status, 'a retried render with the same key must return the first job').toBe(200);
  expect(again.body!.job.id).toBe(first.body!.job.id);
  expect(await wallet(), 'the retried click was charged again').toBe(before - CREDIT_COSTS.COMPOSITE);

  const done = await pollJob(first.body!.job.id, state.composite.mode === 'mock' ? 45_000 : 280_000);
  expect(done.job.status, `render ended ${done.job.status}: ${done.job.error}`).toBe('complete');
  expect(done.version?.version_number).toBe(1);
  expect(done.version?.native_width, 'v1 has no native dimensions').toBeGreaterThan(0);
  state.composite.versionIds.push(done.version.id);
}, 300_000);

it('15 · the composite appears in All photos, linked back to its version', async () => {
  if (!state.composite.versionIds.length) return;
  const [v1] = state.composite.versionIds;
  const rows = await asUser('mypix', `generated_images?select=id,kind,prompt,url&composite_version_id=eq.${v1}`);
  expect(rows.status, explain(rows)).toBe(200);
  const list = rows.body as { kind: string; prompt: string; url: string }[];
  expect(list.length, 'no generated_images row for the new version — All photos would not show it').toBe(1);
  expect(list[0]!.kind).toBe('composite');
  expect(list[0]!.url).toBe(`/api/composites/media/version/${v1}`);
  const html = await (await page('/photos')).text();
  expect(html, '/photos does not render the composite').toContain(`${SENTINEL} — v1`);
});

it('16 · a correction creates v2 from v1, and v1 stays downloadable', async () => {
  if (!state.composite.versionIds.length || skipRender('correction')) return;
  const [v1] = state.composite.versionIds;
  const res = await appJson(`/api/composites/versions/${v1}/correct`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: `smokefix${Date.now()}`,
      instruction: 'align the sun with the existing reflection; keep the harbor unchanged',
      mode: 'move',
      marks: { what: { x: 0.6, y: 0.3, r: 0.05 }, where: { x: 0.4, y: 0.3 } },
    }),
  });
  expect(res.status, `correct → ${JSON.stringify(res.body)}`).toBe(202);
  const done = await pollJob(res.body!.job.id, state.composite.mode === 'mock' ? 45_000 : 280_000);
  expect(done.job.status, `correction ended ${done.job.status}: ${done.job.error}`).toBe('complete');
  expect(done.version?.version_number).toBe(2);
  expect(done.version?.parent_version_id, 'v2 does not record v1 as its parent').toBe(v1);
  state.composite.versionIds.push(done.version.id);

  const versions = await asUser('mypix', `composite_versions?select=id,version_number&group_id=eq.${state.composite.groupId}&order=version_number`);
  expect((versions.body as unknown[]).length, 'the correction did not leave two versions').toBe(2);
  const old = await page(`/api/composites/media/version/${v1}?variant=native&download=1`);
  expect(old.status, 'v1 is no longer downloadable after the correction').toBe(302);
  expect((await fetch(old.headers.get('location')!)).ok, 'v1 native file is gone').toBe(true);
}, 300_000);

it('17 · a failed job is refunded exactly once', async () => {
  if (!state.composite.versionIds.length || state.composite.mode !== 'mock') {
    return console.log('  composite · refund check needs the mock engine, skipped');
  }
  const before = await wallet();
  const res = await appJson(`/api/composites/versions/${state.composite.versionIds[0]}/correct`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: `smokefail${Date.now()}`, instruction: `please fail ${MOCK_FAIL_MARKER}`, mode: 'text' }),
  });
  expect(res.status, `correct → ${JSON.stringify(res.body)}`).toBe(202);
  expect(await wallet(), 'the correction was not charged').toBe(before - CREDIT_COSTS.COMPOSITE);
  const done = await pollJob(res.body!.job.id, 30_000);
  expect(done.job.status).toBe('failed');
  expect(done.job.refunded_at, 'failed job has no refund marker').toBeTruthy();
  // Poll it twice more: a second refund here would mint credits.
  await appJson(`/api/composites/jobs/${res.body!.job.id}`);
  await appJson(`/api/composites/jobs/${res.body!.job.id}`);
  expect(await wallet(), 'a failed job must be refunded exactly once').toBe(before);
}, 120_000);

it('17b · a transient provider failure is resubmitted once, for free', async () => {
  if (!state.composite.versionIds.length || state.composite.mode !== 'mock') {
    return console.log('  composite · retry check needs the mock engine, skipped');
  }
  const before = await wallet();
  const res = await appJson(`/api/composites/versions/${state.composite.versionIds[0]}/correct`, {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey: `smokeretry${Date.now()}`, instruction: `retry me ${MOCK_FAIL_ONCE_MARKER}`, mode: 'text' }),
  });
  expect(res.status, `correct → ${JSON.stringify(res.body)}`).toBe(202);
  const done = await pollJob(res.body!.job.id, 45_000);
  expect(done.job.status, `the resubmitted job ended ${done.job.status}: ${done.job.error}`).toBe('complete');
  expect(done.job.options.attempts, 'the job was not resubmitted').toBe(2);
  expect(done.job.refunded_at, 'a job that succeeded on its retry must not be refunded').toBeNull();
  expect(await wallet(), 'the resubmission was charged again').toBe(before - CREDIT_COSTS.COMPOSITE);
  state.composite.versionIds.push(done.version.id);
}, 120_000);

it('18 · deleting the composite removes its rows, gallery entries and private media', async () => {
  if (!state.composite.groupId) return;
  const groupId = state.composite.groupId;
  const del = await appJson(`/api/composites/${groupId}`, { method: 'DELETE' });
  expect(del.status, `DELETE → ${JSON.stringify(del.body)}`).toBe(200);
  state.composite.groupId = null;
  const gone = await asUser('mypix', `composite_groups?select=id&id=eq.${groupId}`);
  expect((gone.body as unknown[]).length, 'the composite survived its delete').toBe(0);
  for (const v of state.composite.versionIds) {
    const g = await asUser('mypix', `generated_images?select=id&composite_version_id=eq.${v}`);
    expect((g.body as unknown[]).length, 'a gallery row outlived its composite').toBe(0);
  }
  expect(await listUnder(`${session().userId}/composites/${groupId}`), 'private media outlived its composite').toEqual([]);
});
