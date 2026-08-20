/**
 * Static inventory of the EXTERNAL resources this codebase depends on.
 *
 * The whole point of deriving this from source is that a hand-maintained list
 * rots: someone renames a bucket or adds a table, forgets the list, and the
 * preflight keeps reporting green while production is broken. Everything here
 * is read out of the repo at run time, so the expected-resource set can only
 * drift if the code itself changes.
 *
 * What it finds:
 *   - `x.from('t')`                    → table `t` (schema defaults to `mypix`)
 *   - `x.schema('core').from('t')`     → table `core.t`
 *   - `x.storage.from(B).upload(…)`    → bucket B, operation `upload`
 *   - `x.rpc('f', { p_a: … })`         → RPC `f` with argument names `p_a`
 *
 * Names given as constants (`STORAGE_BUCKET`, `SOME_MAP.key`) are resolved from
 * the `const` declarations in the scanned sources, so the indirection in
 * lib/storage.ts stays visible to the scanner.
 *
 * Anything it CANNOT resolve statically (a computed table/bucket name) is
 * returned in `unresolved` and the preflight FAILS on it — an unverifiable
 * dependency is treated as a defect, not as "no finding".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The Postgres role that actually issues the call at run time. */
export type Role = 'service_role' | 'authenticated';

export interface SourceRef {
  /** Repo-relative path. */
  file: string;
  line: number;
}

export interface TableRef {
  schema: string;
  table: string;
  roles: Role[];
  refs: SourceRef[];
}

export interface BucketRef {
  bucket: string;
  /** Storage operations performed, per role — e.g. `{ authenticated: ['createSignedUploadUrl'] }`. */
  ops: Record<Role, string[]>;
  refs: SourceRef[];
}

export interface RpcRef {
  schema: string;
  fn: string;
  roles: Role[];
  /**
   * Argument NAMES as written at the call site. PostgREST resolves an overload
   * by its exact named-argument set, so probing a function with a guessed
   * signature yields a false "function not found" — the real names have to come
   * from the code.
   */
  args: string[];
  refs: SourceRef[];
}

export interface UnresolvedRef {
  kind: 'table' | 'bucket' | 'rpc' | 'write-columns';
  expression: string;
  ref: SourceRef;
}

/**
 * One write against a table, with the COLUMNS it names and the role that issues
 * it. This is what lets the preflight compare a column-level grant against the
 * columns the code actually writes, instead of against a list someone has to
 * remember to update.
 */
export interface WriteRef {
  schema: string;
  table: string;
  op: 'insert' | 'update' | 'upsert';
  role: Role;
  columns: string[];
  ref: SourceRef;
}

export interface Inventory {
  tables: TableRef[];
  buckets: BucketRef[];
  rpcs: RpcRef[];
  writes: WriteRef[];
  unresolved: UnresolvedRef[];
}

/**
 * Default schema of a `.from()`/`.rpc()` with no explicit `.schema()`. Every
 * Supabase client in this repo is constructed with `db: { schema: 'mypix' }`
 * (lib/supabase/client.ts, lib/supabase/server.ts), which is exactly why
 * `.from('credit_transactions')` silently meant `mypix.credit_transactions`
 * — a relation that does not exist — until 2026-08-20.
 */
export const DEFAULT_SCHEMA = 'mypix';

/** Receivers that are JS built-ins, not Supabase clients (`Array.from(…)`). */
const RECEIVER_DENYLIST = new Set([
  'Array',
  'Object',
  'Buffer',
  'Set',
  'Map',
  'Promise',
  'Uint8Array',
  'Int8Array',
  'Float32Array',
  'Blob',
  'Date',
  'Number',
  'String',
  'Response',
  'Headers',
  'URL',
]);

const SOURCE_EXT = /\.(ts|tsx)$/;
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', '.turbo', '.git', 'build', 'vendor']);
/** The verification code itself names tables/buckets as DATA, not as dependencies. */
const SKIP_PATH = /(^|[\\/])verify[\\/]/;

export interface ScanOptions {
  /** Repo root to scan. */
  root: string;
  /** Directories (repo-relative) to walk. */
  dirs?: string[];
  /**
   * Extra individual files outside those dirs. `middleware.ts` sits at the root,
   * and @aionized/platform-client owns every `core.*` RPC this app makes — those
   * calls are ours in practice even though they live in node_modules.
   */
  extraFiles?: string[];
}

const DEFAULT_DIRS = ['app', 'lib', 'components', 'types'];
const DEFAULT_EXTRA_FILES = [
  'middleware.ts',
  'node_modules/@aionized/platform-client/src/server.ts',
];

export function defaultScanOptions(root: string): ScanOptions {
  return { root, dirs: DEFAULT_DIRS, extraFiles: DEFAULT_EXTRA_FILES };
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
}

export function collectSourceFiles(opts: ScanOptions): string[] {
  const files: string[] = [];
  for (const d of opts.dirs ?? DEFAULT_DIRS) walk(join(opts.root, d), files);
  for (const f of opts.extraFiles ?? []) {
    const full = join(opts.root, f);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* optional */
    }
  }
  return files.filter((f) => !SKIP_PATH.test(relative(opts.root, f)));
}

/**
 * Blank out comments, preserving every byte offset and line number.
 *
 * Not cosmetic: this codebase documents itself in prose that quotes real call
 * shapes — lib/supabase/client.ts explains `db.schema: "mypix"` by writing
 * `.from("models")` in a comment, and lib/credits.ts warns that a bare
 * `.from("credit_transactions")` would resolve to the wrong schema. Scanning
 * those would invent dependencies that do not exist and fail the preflight on
 * documentation. It also stopped a real false positive: a doc comment naming
 * `listCreditHistory()` was being read as a call site with no client argument.
 *
 * Strings and template literals are respected so a `//` inside a URL survives.
 */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === ch) break;
        // An unterminated single/double quote must not swallow the rest of the file.
        if (ch !== '`' && code[j] === '\n') break;
        j++;
      }
      out += code.slice(i, Math.min(j + 1, code.length));
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Pull `const NAME = { key: 'value', … }` maps out of a source file so
 * `NAME.key` arguments elsewhere resolve to their literal.
 */
export function extractConstMaps(code: string): Record<string, Record<string, string>> {
  const maps: Record<string, Record<string, string>> = {};
  const re =
    /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\{([\s\S]*?)\}\s*as\s+const/g;
  for (const m of code.matchAll(re)) {
    const name = m[1]!;
    const entries: Record<string, string> = {};
    for (const e of m[2]!.matchAll(/(\w+)\s*:\s*['"]([^'"]*)['"]/g)) entries[e[1]!] = e[2]!;
    if (Object.keys(entries).length) maps[name] = { ...(maps[name] ?? {}), ...entries };
  }
  return maps;
}

/**
 * Pull `export const NAME = 'literal'` scalars out of a source file.
 *
 * This app names its bucket with a single exported constant
 * (`lib/storage.ts` → `STORAGE_BUCKET`), not an `as const` map, so without this
 * every `storage.from(STORAGE_BUCKET)` would land in `unresolved` and the
 * preflight would fail on the indirection rather than on the platform.
 */
export function extractConstStrings(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[\w.<>[\]| ]+)?=\s*['"]([^'"]*)['"]/g;
  for (const m of code.matchAll(re)) out[m[1]!] = m[2]!;
  return out;
}

export interface ConstIndex {
  maps: Record<string, Record<string, string>>;
  scalars: Record<string, string>;
}

/** Resolve a call argument to a literal string, or null when it is dynamic. */
export function resolveArg(expr: string, consts: ConstIndex): string | null {
  const trimmed = expr.trim();
  const literal = /^['"`]([^'"`]*)['"`]$/.exec(trimmed);
  // A template literal with an interpolation is a COMPUTED name, not a literal.
  // Accepting `` `${prefix}-uploads` `` as the string "${prefix}-uploads" would
  // hide the very thing this scanner exists to refuse.
  if (literal) return literal[1]!.includes('${') ? null : literal[1]!;
  const member = /^([A-Z][A-Z0-9_]*)\.(\w+)$/.exec(trimmed);
  if (member) return consts.maps[member[1]!]?.[member[2]!] ?? null;
  const scalar = /^([A-Z][A-Z0-9_]*)$/.exec(trimmed);
  if (scalar) return consts.scalars[scalar[1]!] ?? null;
  return null;
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/**
 * First top-level argument of `text`, which must start at the call's `(`.
 *
 * Bracket-balanced, so `.insert(rows.map((r) => ({ a: 1 })))` yields the whole
 * argument and never bleeds into the code that follows the call — which matters
 * because the column reader below looks for an object literal and would happily
 * find one three statements later.
 */
export function firstArgument(text: string): string | null {
  if (text[0] !== '(') return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return text.slice(1, i).trim();
    } else if (ch === ',' && depth === 1) return text.slice(1, i).trim();
  }
  return null;
}

/**
 * Which role a given local variable speaks as, read from its DECLARATION.
 *
 * A name heuristic alone is wrong here: `app/api/webhooks/astria/route.ts`
 * declares `const supabase = await createServiceClient()`, and `lib/credits.ts`
 * takes an RLS client in a parameter also called `supabase`. The declaration is
 * the only honest signal, so it wins; parameter names are the fallback.
 *
 * A name declared BOTH ways in one file gets both roles — the probe then has to
 * pass as either, which is the conservative reading.
 */
export function declaredClientRoles(code: string): Record<string, Role[]> {
  const out: Record<string, Role[]> = {};
  const add = (name: string, role: Role) => {
    const list = (out[name] ??= []);
    if (!list.includes(role)) list.push(role);
  };
  for (const m of code.matchAll(
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:createServiceClient|createSupabaseAdmin|createPlatformAdmin)\s*\(/g,
  )) {
    add(m[1]!, 'service_role');
  }
  for (const m of code.matchAll(
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:createClient|createBrowserClient|createServerClient)\s*\(/g,
  )) {
    add(m[1]!, 'authenticated');
  }
  return out;
}

/** Fallback for clients that arrive as a function parameter (lib/storage.ts, lib/training.ts). */
export function roleFromName(receiver: string): Role {
  return /^(svc|service|serviceClient|admin)/i.test(receiver) ? 'service_role' : 'authenticated';
}

/** Roles a receiver may speak as, declaration first, then its name. */
export function rolesFor(receiver: string, declared: Record<string, Role[]>): Role[] {
  const d = declared[receiver];
  if (d && d.length) return d;
  return [roleFromName(receiver)];
}

interface RawRef {
  kind: 'table' | 'bucket' | 'rpc';
  schema: string;
  name: string | null;
  expression: string;
  roles: Role[];
  op?: string;
  args?: string[];
  /** Columns named by a table write; `null` = a write whose argument is not a literal. */
  columns?: string[] | null;
  line: number;
}

/**
 * Top-level keys of the first `{ … }` in `text` (an RPC argument object, or the
 * column map of an insert/update). Brace-balanced so a nested object does not
 * leak its keys.
 *
 * Shorthand (`{ slug, user_id }`) counts: for a write, a missed key means the
 * preflight believes the code needs a NARROWER grant than it does, and reports
 * a grant that is legitimately in use as drift.
 */
export function readObjectKeys(text: string): string[] {
  const start = text.indexOf('{');
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = text.slice(start + 1, end);
  const keys: string[] = [];
  let d = 0;
  let token = '';
  // `{ user_id }` — a bare identifier standing alone between separators.
  const shorthand = (t: string): string | null =>
    /^[A-Za-z_$][\w$]*$/.test(t.trim()) ? t.trim() : null;
  // Only a segment that never saw a top-level `:` can be shorthand — otherwise
  // the VALUE of `p_user: userId` would be read as a second key.
  let valued = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '{' || ch === '[' || ch === '(') d++;
    else if (ch === '}' || ch === ']' || ch === ')') d--;
    if (d === 0 && ch === ',') {
      const key = valued ? null : shorthand(token);
      if (key) keys.push(key);
      token = '';
      valued = false;
      continue;
    }
    if (d === 0 && ch === ':') {
      const key = /([A-Za-z_$][\w$]*)\s*$/.exec(token)?.[1];
      if (key) keys.push(key);
      token = '';
      valued = true;
      continue;
    }
    if (d === 0) token += ch;
  }
  const last = valued ? null : shorthand(token);
  if (last) keys.push(last);
  return keys;
}

/**
 * Parse one source file. Exported for unit testing — this is the piece whose
 * correctness the whole preflight rests on.
 */
export function extractRefs(source: string, consts: ConstIndex): RawRef[] {
  const refs: RawRef[] = [];
  const code = stripComments(source);
  const declared = declaredClientRoles(code);

  // `const core = () => admin.schema('core')` — the alias platform-client uses.
  // The alias inherits BOTH the schema and the role of its base receiver.
  const schemaAliases: Record<string, { schema: string; base: string }> = {};
  for (const m of code.matchAll(
    /const\s+(\w+)\s*=\s*\(\)\s*=>\s*(\w+)\s*\.\s*schema\(\s*['"](\w+)['"]\s*\)/g,
  )) {
    schemaAliases[m[1]!] = { schema: m[3]!, base: m[2]! };
  }

  // ── tables + storage buckets ───────────────────────────────────────────────
  // receiver [.schema('s')] [.storage] .from(arg) [.op(]
  const fromRe =
    /(\w+)(?:\s*\.\s*schema\(\s*['"](\w+)['"]\s*\))?(\s*\.\s*storage)?\s*\.\s*from\(\s*([^)]*?)\s*\)/g;
  for (const m of code.matchAll(fromRe)) {
    const receiver = m[1]!;
    if (RECEIVER_DENYLIST.has(receiver) || /^[A-Z]/.test(receiver)) continue;
    const explicitSchema = m[2];
    const isStorage = Boolean(m[3]);
    const expression = m[4]!;
    if (!expression) continue;
    const name = resolveArg(expression, consts);
    const line = lineOf(code, m.index ?? 0);
    const roles = rolesFor(receiver, declared);
    if (isStorage) {
      // The first method chained after `.from(bucket)` is the operation.
      const tail = code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 160);
      const op = /^\s*\.\s*(\w+)\s*\(/.exec(tail)?.[1] ?? 'unknown';
      refs.push({ kind: 'bucket', schema: 'storage', name, expression, roles, op, line });
    } else {
      // The first method chained after `.from(table)` is the operation. Only
      // the mutating ones carry columns; everything else is a read.
      const after = (m.index ?? 0) + m[0].length;
      const chained = /^\s*\.\s*(\w+)\s*\(/.exec(code.slice(after, after + 160));
      const op = chained?.[1];
      let columns: string[] | null | undefined;
      if (op === 'insert' || op === 'update' || op === 'upsert') {
        const arg = firstArgument(code.slice(after + chained![0].length - 1, after + 8000));
        // `.update({ a, b })` → the columns. `.insert(rows)` → a variable, whose
        // columns cannot be read here; null so the caller can refuse to guess.
        const keys = arg === null ? [] : readObjectKeys(arg);
        columns = arg !== null && keys.length > 0 ? keys : null;
      }
      refs.push({
        kind: 'table',
        schema: explicitSchema ?? DEFAULT_SCHEMA,
        name,
        expression,
        roles,
        op,
        columns,
        line,
      });
    }
  }

  // ── RPCs ──────────────────────────────────────────────────────────────────
  const rpcRe =
    /(\w+)(?:\(\))?(?:\s*\.\s*schema\(\s*['"](\w+)['"]\s*\))?\s*\.\s*rpc\(\s*([^,)]*?)\s*([,)])/g;
  for (const m of code.matchAll(rpcRe)) {
    const receiver = m[1]!;
    if (RECEIVER_DENYLIST.has(receiver) || /^[A-Z]/.test(receiver)) continue;
    const expression = m[3]!;
    if (!expression) continue;
    const alias = schemaAliases[receiver];
    const name = resolveArg(expression, consts);
    const schema = m[2] ?? alias?.schema ?? DEFAULT_SCHEMA;
    const roles = rolesFor(alias?.base ?? receiver, declared);
    const rest =
      m[4] === ','
        ? code.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1200)
        : '';
    refs.push({
      kind: 'rpc',
      schema,
      name,
      expression,
      args: readObjectKeys(rest),
      roles,
      line: lineOf(code, m.index ?? 0),
    });
  }

  return refs;
}

/** Walk the repo and produce the full external-resource inventory. */
export function scanInventory(opts: ScanOptions): Inventory {
  const files = collectSourceFiles(opts);
  const sources = files.map((f) => ({ file: f, code: readFileSync(f, 'utf8') }));

  // Constant declarations are repo-global (STORAGE_BUCKET lives in lib/storage.ts
  // and is used from components/), so build the index across every file first.
  const consts: ConstIndex = { maps: {}, scalars: {} };
  for (const { code } of sources) {
    const bare = stripComments(code);
    for (const [name, entries] of Object.entries(extractConstMaps(bare))) {
      consts.maps[name] = { ...(consts.maps[name] ?? {}), ...entries };
    }
    Object.assign(consts.scalars, extractConstStrings(bare));
  }

  const tables = new Map<string, TableRef>();
  const buckets = new Map<string, BucketRef>();
  const rpcs = new Map<string, RpcRef>();
  const writes: WriteRef[] = [];
  const unresolved: UnresolvedRef[] = [];

  for (const { file, code } of sources) {
    const rel = relative(opts.root, file).split(sep).join('/');
    for (const r of extractRefs(code, consts)) {
      const at: SourceRef = { file: rel, line: r.line };
      if (!r.name) {
        unresolved.push({ kind: r.kind, expression: r.expression, ref: at });
        continue;
      }
      if (r.kind === 'table') {
        const key = `${r.schema}.${r.name}`;
        const entry = tables.get(key) ?? { schema: r.schema, table: r.name, roles: [], refs: [] };
        for (const role of r.roles) if (!entry.roles.includes(role)) entry.roles.push(role);
        entry.refs.push(at);
        tables.set(key, entry);
        const op = r.op;
        if (op === 'insert' || op === 'update' || op === 'upsert') {
          // A write whose columns cannot be read statically is only a problem
          // for the role the grants constrain; the service role bypasses them.
          if (r.columns == null) {
            if (r.roles.includes('authenticated')) {
              unresolved.push({
                kind: 'write-columns',
                expression: `${r.schema}.${r.name}.${op}(…)`,
                ref: at,
              });
            }
          } else {
            for (const role of r.roles) {
              writes.push({
                schema: r.schema,
                table: r.name,
                op,
                role,
                columns: r.columns,
                ref: at,
              });
            }
          }
        }
      } else if (r.kind === 'bucket') {
        const entry =
          buckets.get(r.name) ??
          ({ bucket: r.name, ops: { service_role: [], authenticated: [] }, refs: [] } as BucketRef);
        const op = r.op ?? 'unknown';
        for (const role of r.roles) if (!entry.ops[role].includes(op)) entry.ops[role].push(op);
        entry.refs.push(at);
        buckets.set(r.name, entry);
      } else {
        const key = `${r.schema}.${r.name}`;
        const entry = rpcs.get(key) ?? {
          schema: r.schema,
          fn: r.name,
          roles: [],
          args: [],
          refs: [],
        };
        for (const role of r.roles) if (!entry.roles.includes(role)) entry.roles.push(role);
        for (const a of r.args ?? []) if (!entry.args.includes(a)) entry.args.push(a);
        entry.refs.push(at);
        rpcs.set(key, entry);
      }
    }
  }

  const byName = (a: string, b: string) => a.localeCompare(b);
  return {
    tables: [...tables.values()].sort((a, b) =>
      byName(`${a.schema}.${a.table}`, `${b.schema}.${b.table}`),
    ),
    buckets: [...buckets.values()].sort((a, b) => byName(a.bucket, b.bucket)),
    rpcs: [...rpcs.values()].sort((a, b) => byName(`${a.schema}.${a.fn}`, `${b.schema}.${b.fn}`)),
    writes: writes.sort((a, b) =>
      byName(`${a.schema}.${a.table}.${a.op}`, `${b.schema}.${b.table}.${b.op}`),
    ),
    unresolved,
  };
}
