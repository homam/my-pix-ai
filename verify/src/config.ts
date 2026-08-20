/**
 * Environment + target resolution for the verification layers.
 *
 * Secrets are read but NEVER printed: everything that leaves this module is
 * either a boolean ("is it set?") or a redacted fingerprint. `describe()` is the
 * only formatter the specs are allowed to log.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root — verify/src/… → ../.. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Minimal .env parser (no dependency). `KEY=value  # comment` supported. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Effective env: process.env wins (CI and scripts/deploy.sh inject per-brand
 * values), `.env.local` fills the gaps (developer laptop). Never written back
 * into process.env.
 */
export function loadEnv(root = REPO_ROOT): Record<string, string> {
  const file = join(root, '.env.local');
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const merged: Record<string, string> = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v) merged[k] = v;
  return merged;
}

/**
 * Default smoke account PER BRAND.
 *
 * Accounts never cross entities (`core.bind_entity` binds a user on first wallet
 * touch and every wallet RPC then raises ENTITY_MISMATCH across the line), so
 * running the glowshot deployment's smoke with a mypix account fails in a way
 * that looks exactly like a product bug and is not one. Keeping the mapping here
 * means the operator cannot get it wrong by forgetting an env var.
 */
export const BRAND_TEST_USERS: Record<string, string> = {
  mypix: 'demo@mobilesparkcreations.com', // entity1
  glowshot: 'verify+glowshot@mobilesparkcreations.com', // entity2
};

export interface VerifyConfig {
  root: string;
  /**
   * Checkout whose source is scanned for the resource inventory. Defaults to
   * `root`; set VERIFY_ROOT to preflight a DIFFERENT tree (a `git worktree` of
   * the commit that is actually deployed, which is the honest thing to check
   * before a rollback — and how this suite was proven against the three
   * pre-fix commits, see docs/VERIFICATION.md).
   */
  scanRoot: string;
  env: Record<string, string>;
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  /** Base URL of the app under test (localhost dev server or a deployed brand). */
  target: string;
  brandKey: string;
  /** Account used for authenticated checks — must belong to this brand's entity. */
  testUserEmail: string;
}

export function loadConfig(root = REPO_ROOT): VerifyConfig {
  const env = loadEnv(root);
  const brandKey = env.NEXT_PUBLIC_BRAND_KEY ?? 'mypix';
  return {
    root,
    scanRoot: env.VERIFY_ROOT ?? root,
    env,
    supabaseUrl: (env.VERIFY_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, ''),
    anonKey: env.VERIFY_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    target: (env.VERIFY_TARGET ?? env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:4871').replace(
      /\/$/,
      '',
    ),
    brandKey,
    testUserEmail:
      env.VERIFY_USER_EMAIL || BRAND_TEST_USERS[brandKey] || BRAND_TEST_USERS.mypix!,
  };
}

/** Supabase project ref, e.g. `jrzaobtnunduxkzkgtbx`. Also the auth-cookie name prefix. */
export function projectRef(supabaseUrl: string): string {
  return /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(supabaseUrl)?.[1] ?? '';
}

/** Safe one-line summary for test output — no secret material. */
export function describe(cfg: VerifyConfig): string {
  return [
    `target=${cfg.target}`,
    `brand=${cfg.brandKey}`,
    `supabase-project=${projectRef(cfg.supabaseUrl) || '(unset)'}`,
    `anon-key=${cfg.anonKey ? 'set' : 'MISSING'}`,
    `service-key=${cfg.serviceKey ? 'set' : 'MISSING'}`,
    `test-user=${cfg.testUserEmail}`,
  ].join(' · ');
}
