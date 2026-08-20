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
import { afterAll, beforeAll, expect, it } from 'vitest';
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
} = { session: null, cookie: '', modelId: null, objects: [] };

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

afterAll(async () => {
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
