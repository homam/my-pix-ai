/**
 * Thin, dependency-free probes against the exact HTTP surfaces the app uses:
 * PostgREST (`/rest/v1`), Storage (`/storage/v1`), GoTrue (`/auth/v1`).
 *
 * Deliberately NOT supabase-js: the point is to observe the raw status + Postgres
 * SQLSTATE, because every incident this suite exists to prevent was a SWALLOWED
 * error — a `NoSuchBucket`, a `PGRST205 relation does not exist`, a `42501` — that
 * the client library reports as an ordinary `error` field which the caller then
 * ignored, so the UI showed an empty list and nothing else.
 *
 * GOTCHA (this project): SUPABASE_SERVICE_ROLE_KEY is a new-style `sb_secret_…`
 * key, not a JWT. GoTrue and PostgREST both reject it as a Bearer token unless it
 * is ALSO presented in `apikey` — `Authorization` alone answers 403 bad_jwt. Every
 * service-role request below therefore sends it in both headers.
 */

export type Role = 'service_role' | 'authenticated' | 'anon';

export interface ProbeResult {
  status: number;
  ok: boolean;
  /** Postgres SQLSTATE or PostgREST/Storage error code, when the body carries one. */
  code?: string;
  message?: string;
  body?: unknown;
}

export interface Creds {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
}

function headers(creds: Creds, role: Role, jwt?: string): Record<string, string> {
  const apikey = role === 'service_role' ? creds.serviceKey : creds.anonKey;
  const bearer = role === 'service_role' ? creds.serviceKey : (jwt ?? creds.anonKey);
  return { apikey, authorization: `Bearer ${bearer}` };
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function classify(status: number, body: unknown): ProbeResult {
  const b = body as Record<string, unknown> | null;
  const code =
    typeof b?.code === 'string'
      ? b.code
      : typeof b?.statusCode === 'string'
        ? b.statusCode
        : undefined;
  const message =
    typeof b?.message === 'string' ? b.message : typeof b?.error === 'string' ? b.error : undefined;
  return { status, ok: status >= 200 && status < 300, code, message, body };
}

/** `select … limit 1` against one table, as one role. */
export async function selectOne(
  creds: Creds,
  role: Role,
  schema: string,
  table: string,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(
    `${creds.supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`,
    { headers: { ...headers(creds, role, jwt), 'accept-profile': schema } },
  );
  return classify(res.status, await readBody(res));
}

/** Arbitrary PostgREST read as one role (filters, ordering, embedded selects). */
export async function query(
  creds: Creds,
  role: Role,
  schema: string,
  path: string,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/rest/v1/${path}`, {
    headers: { ...headers(creds, role, jwt), 'accept-profile': schema },
  });
  return classify(res.status, await readBody(res));
}

/** Write as one role — used by the smoke to create and clean up its own rows. */
export async function write(
  creds: Creds,
  role: Role,
  schema: string,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      ...headers(creds, role, jwt),
      'content-type': 'application/json',
      'content-profile': schema,
      'accept-profile': schema,
      prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return classify(res.status, await readBody(res));
}

/** Call an RPC as one role. */
export async function callRpc(
  creds: Creds,
  role: Role,
  schema: string,
  fn: string,
  args: Record<string, unknown>,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
    method: 'POST',
    headers: {
      ...headers(creds, role, jwt),
      'content-type': 'application/json',
      'content-profile': schema,
      'accept-profile': schema,
    },
    body: JSON.stringify(args),
  });
  return classify(res.status, await readBody(res));
}

/**
 * Bucket EXISTENCE (and its `public` flag).
 *
 * Note that `POST /object/list/<bucket>` answers `200 []` for a bucket that does
 * not exist — which is precisely how `STORAGE_BUCKET = "user-uploads"` stayed
 * invisible while every upload 404'd NoSuchBucket. Only the bucket endpoint gives
 * a truthful answer.
 */
export async function getBucket(creds: Creds, bucket: string): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
    headers: headers(creds, 'service_role'),
  });
  return classify(res.status, await readBody(res));
}

/**
 * A signed upload URL — the exact mechanism this app uses: the server creates it
 * with the caller's RLS client (`lib/storage.ts createSignedUpload`) and the
 * browser PUTs the bytes straight to Storage.
 */
export async function createSignedUploadUrl(
  creds: Creds,
  role: Role,
  bucket: string,
  path: string,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: { ...headers(creds, role, jwt), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  return classify(res.status, await readBody(res));
}

/** PUT bytes to a signed upload URL (`{ url }` as returned above, token in the query). */
export async function putToSignedUrl(
  creds: Creds,
  signedPath: string,
  bytes: Uint8Array | string,
  contentType = 'text/plain',
): Promise<ProbeResult> {
  const url = signedPath.startsWith('http')
    ? signedPath
    : `${creds.supabaseUrl}/storage/v1/${signedPath.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'x-upsert': 'true' },
    body: bytes as BodyInit,
  });
  return classify(res.status, await readBody(res));
}

export async function uploadObject(
  creds: Creds,
  role: Role,
  bucket: string,
  path: string,
  bytes: Uint8Array | string,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: { ...headers(creds, role, jwt), 'content-type': 'text/plain', 'x-upsert': 'true' },
    body: bytes as BodyInit,
  });
  return classify(res.status, await readBody(res));
}

export async function downloadObject(
  creds: Creds,
  role: Role,
  bucket: string,
  path: string,
  jwt?: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(`${creds.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
    headers: headers(creds, role, jwt),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

/**
 * Fetch a PUBLIC object URL with NO credentials at all.
 *
 * The mypix bucket is public on purpose: `lib/storage.ts getPublicUrl` hands
 * these URLs to Astria, which fetches them anonymously. A bucket flipped private
 * would break training with no error anywhere in our own logs.
 */
export async function fetchPublicObject(
  creds: Creds,
  bucket: string,
  path: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(`${creds.supabaseUrl}/storage/v1/object/public/${bucket}/${path}`);
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

export async function removeObject(
  creds: Creds,
  role: Role,
  bucket: string,
  path: string,
  jwt?: string,
): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
    method: 'DELETE',
    headers: headers(creds, role, jwt),
  });
  return classify(res.status, await readBody(res));
}

/** GoTrue project settings — which auth providers are actually enabled. */
export async function authSettings(creds: Creds): Promise<ProbeResult> {
  const res = await fetch(`${creds.supabaseUrl}/auth/v1/settings`, {
    headers: { apikey: creds.anonKey },
  });
  return classify(res.status, await readBody(res));
}

/** Human-readable, secret-free rendering of a failed probe. */
export function explain(p: ProbeResult): string {
  const parts = [`HTTP ${p.status}`];
  if (p.code) parts.push(`code=${p.code}`);
  if (p.message) parts.push(p.message);
  return parts.join(' · ');
}
