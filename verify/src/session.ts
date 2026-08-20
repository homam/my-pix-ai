/**
 * Password-free session minting, and the browser cookie that goes with it.
 *
 * Accounts on this project are owner-provisioned (there is no self-serve signup
 * UI), so a test suite must not depend on a password living in CI. Instead:
 *
 *   1. service role → POST /auth/v1/admin/generate_link {type: magiclink}
 *      returns a `hashed_token` without sending mail,
 *   2. anon key     → POST /auth/v1/verify {type: magiclink, token_hash}
 *      exchanges it for a real user session.
 *
 * The resulting JWT carries the `authenticated` role — the same one the browser
 * client uses — which is what makes the RLS/grant checks meaningful.
 *
 * GOTCHA: this project's service key is a `sb_secret_…` key, not a JWT, so it
 * must be sent in BOTH `apikey` and `Authorization`; Bearer alone → 403 bad_jwt.
 */
import { createServerClient } from '@supabase/ssr';
import type { Creds } from './rest';

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
}

export class SessionError extends Error {}

export async function mintSession(creds: Creds, email: string): Promise<Session> {
  const linkRes = await fetch(`${creds.supabaseUrl}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: creds.serviceKey,
      authorization: `Bearer ${creds.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const link = (await linkRes.json().catch(() => null)) as {
    hashed_token?: string;
    msg?: string;
  } | null;
  if (!linkRes.ok || !link?.hashed_token) {
    throw new SessionError(
      `admin/generate_link failed for ${email}: HTTP ${linkRes.status}${link?.msg ? ` · ${link.msg}` : ''}`,
    );
  }

  const verifyRes = await fetch(`${creds.supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: creds.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.hashed_token }),
  });
  const session = (await verifyRes.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string };
    msg?: string;
  } | null;
  if (!verifyRes.ok || !session?.access_token || !session.user?.id) {
    throw new SessionError(
      `auth/verify failed for ${email}: HTTP ${verifyRes.status}${session?.msg ? ` · ${session.msg}` : ''}`,
    );
  }
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? '',
    userId: session.user.id,
    email,
  };
}

/**
 * The `Cookie` header a real signed-in browser would send to this app.
 *
 * Built by handing the session to @supabase/ssr's own `createServerClient` with
 * an in-memory cookie jar and reading back what it writes — rather than by
 * re-implementing the `sb-<ref>-auth-token` / `base64-…` / 3180-byte-chunk
 * encoding here. The app parses these cookies with the very same library
 * version, so the format cannot drift out from under the smoke: an upgrade that
 * changed the encoding would change both sides at once.
 *
 * This matters because middleware.ts + the (dashboard) layout authenticate from
 * cookies only — there is no bearer-token path into the app — and "does an
 * authenticated page actually render" is exactly the assertion that was missing
 * when the whole signed-in area was 500ing.
 */
export async function sessionCookieHeader(creds: Creds, session: Session): Promise<string> {
  const jar = new Map<string, string>();
  const client = createServerClient(creds.supabaseUrl, creds.anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list: { name: string; value: string }[]) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  if (error) throw new SessionError(`could not build a session cookie: ${error.message}`);
  if (jar.size === 0) throw new SessionError('@supabase/ssr wrote no auth cookie');
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}
