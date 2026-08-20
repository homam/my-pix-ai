/**
 * LAYER 3 — the scanner the whole preflight rests on.
 *
 * If `extractRefs` misses a call, the preflight reports green for a resource
 * nobody checked; if it mis-attributes a role, it checks the wrong thing. Both
 * failure modes are silent, so the parser is unit-tested against the exact
 * shapes this codebase actually writes.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEMA,
  declaredClientRoles,
  extractConstMaps,
  extractConstStrings,
  extractRefs,
  readObjectKeys,
  resolveArg,
  roleFromName,
  scanInventory,
  stripComments,
  defaultScanOptions,
  type ConstIndex,
} from './inventory';
import { REPO_ROOT } from './config';

const NO_CONSTS: ConstIndex = { maps: {}, scalars: {} };

describe('constant resolution', () => {
  it('resolves the exported bucket-name scalar this repo uses', () => {
    const consts: ConstIndex = {
      maps: {},
      scalars: extractConstStrings('export const STORAGE_BUCKET = "mypix";'),
    };
    expect(resolveArg('STORAGE_BUCKET', consts)).toBe('mypix');
  });

  it('resolves an `as const` map member too', () => {
    const consts: ConstIndex = {
      maps: extractConstMaps("export const BUCKETS = { uploads: 'mypix' } as const"),
      scalars: {},
    };
    expect(resolveArg('BUCKETS.uploads', consts)).toBe('mypix');
  });

  it('returns null for a computed name so the preflight can fail on it', () => {
    expect(resolveArg('bucketFor(user)', NO_CONSTS)).toBeNull();
    expect(resolveArg('`${prefix}-uploads`', NO_CONSTS)).toBeNull();
    expect(resolveArg('UNKNOWN_CONST', NO_CONSTS)).toBeNull();
  });
});

describe('table references', () => {
  it('defaults to the mypix schema — the trap that hid the ledger bug', () => {
    const [ref] = extractRefs('await supabase.from("credit_transactions").select("*")', NO_CONSTS);
    expect(ref!.kind).toBe('table');
    expect(ref!.schema).toBe(DEFAULT_SCHEMA);
    expect(ref!.name).toBe('credit_transactions');
  });

  it('honours an explicit .schema("core") across line breaks', () => {
    const refs = extractRefs(
      'const { data } = await supabase\n  .schema("core")\n  .from("credit_transactions")\n  .select("*")',
      NO_CONSTS,
    );
    expect(refs[0]!.schema).toBe('core');
  });

  it('ignores JS built-ins that also have .from()', () => {
    const refs = extractRefs(
      'Buffer.from(x); Array.from({length: 3}); const u = Uint8Array.from(y);',
      NO_CONSTS,
    );
    expect(refs).toEqual([]);
  });
});

describe('role attribution', () => {
  it('reads the role from the declaration, even when the name says otherwise', () => {
    // app/api/webhooks/astria/route.ts
    const code = 'const supabase = await createServiceClient();\nawait supabase.from("models").select()';
    expect(declaredClientRoles(code).supabase).toEqual(['service_role']);
    expect(extractRefs(code, NO_CONSTS)[0]!.roles).toEqual(['service_role']);
  });

  it('marks the RLS client as authenticated', () => {
    const code = 'const supabase = await createClient();\nawait supabase.from("models").select()';
    expect(extractRefs(code, NO_CONSTS)[0]!.roles).toEqual(['authenticated']);
  });

  it('falls back to the parameter name for helper modules', () => {
    // lib/storage.ts / lib/training.ts take the client as an argument.
    expect(roleFromName('serviceClient')).toBe('service_role');
    expect(roleFromName('svc')).toBe('service_role');
    expect(roleFromName('supabase')).toBe('authenticated');
  });

  it('records BOTH roles when a name is declared each way in one file', () => {
    const code =
      'function a(){ const supabase = await createClient(); }\n' +
      'function b(){ const supabase = await createServiceClient(); supabase.from("models") }';
    expect(extractRefs(code, NO_CONSTS)[0]!.roles.sort()).toEqual([
      'authenticated',
      'service_role',
    ]);
  });
});

describe('storage references', () => {
  const consts: ConstIndex = { maps: {}, scalars: { STORAGE_BUCKET: 'mypix' } };

  it('separates a storage bucket from a table of the same name', () => {
    const refs = extractRefs(
      'supabase.storage.from(STORAGE_BUCKET).createSignedUploadUrl(path);\n' +
        'supabase.from("models").select();',
      consts,
    );
    expect(refs.map((r) => r.kind)).toEqual(['bucket', 'table']);
    expect(refs[0]!.name).toBe('mypix');
  });

  it('records the storage OPERATION, which drives the smoke round trip', () => {
    const refs = extractRefs(
      'const { data } = await supabase.storage\n  .from(STORAGE_BUCKET)\n  .createSignedUploadUrl(path);',
      consts,
    );
    expect(refs[0]!.op).toBe('createSignedUploadUrl');
  });

  it('sees getPublicUrl, which is what makes the bucket have to be public', () => {
    const refs = extractRefs('supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)', consts);
    expect(refs[0]!.op).toBe('getPublicUrl');
  });
});

describe('rpc references', () => {
  it('captures the argument names, because PostgREST matches overloads by name', () => {
    const refs = extractRefs('void svc.rpc("increment_share_view", { p_slug: slug });', NO_CONSTS);
    expect(refs[0]).toMatchObject({
      kind: 'rpc',
      schema: 'mypix',
      name: 'increment_share_view',
      args: ['p_slug'],
      roles: ['service_role'],
    });
  });

  it('follows the `const core = () => admin.schema("core")` alias for schema AND role', () => {
    const refs = extractRefs(
      'const core = () => admin.schema("core");\n' +
        "const { data } = await core().rpc('spend_credits', { p_user: userId, p_brand: brand, p_cost: cost });",
      NO_CONSTS,
    );
    expect(refs[0]).toMatchObject({
      schema: 'core',
      name: 'spend_credits',
      roles: ['service_role'],
    });
    expect(refs[0]!.args).toEqual(['p_user', 'p_brand', 'p_cost']);
  });

  it('does not leak keys out of a nested argument object', () => {
    expect(readObjectKeys('{ p_user: id, p_meta: { inner: 1 }, p_brand: b })')).toEqual([
      'p_user',
      'p_meta',
      'p_brand',
    ]);
  });
});

describe('the live repo scan', () => {
  const inv = scanInventory(defaultScanOptions(REPO_ROOT));

  it('finds the mypix product tables and the shared core ledger', () => {
    const names = inv.tables.map((t) => `${t.schema}.${t.table}`);
    expect(names).toContain('mypix.models');
    expect(names).toContain('mypix.generated_images');
    expect(names).toContain('core.credit_transactions');
  });

  it('finds the single product bucket, resolved through STORAGE_BUCKET', () => {
    expect(inv.buckets.map((b) => b.bucket)).toEqual(['mypix']);
  });

  it('finds the core wallet RPCs through @aionized/platform-client', () => {
    const fns = inv.rpcs.filter((r) => r.schema === 'core').map((r) => r.fn);
    expect(fns).toContain('ensure_wallet');
    expect(fns).toContain('spend_credits');
    expect(fns).toContain('grant_credits');
  });

  it('leaves nothing unresolved in the current tree', () => {
    expect(
      inv.unresolved.map((u) => `${u.ref.file}:${u.ref.line} ${u.kind}(${u.expression})`),
    ).toEqual([]);
  });
});

describe('comment stripping', () => {
  it('does not invent a dependency out of prose that quotes a call', () => {
    // lib/supabase/client.ts really documents itself this way.
    const code = '// every `.from("models")` call now targets mypix.*\nconst x = 1;';
    expect(extractRefs(code, NO_CONSTS)).toEqual([]);
  });

  it('keeps a // inside a string literal', () => {
    const kept = stripComments('const u = "https://example.com/x"; // trailing');
    expect(kept).toContain('https://example.com/x');
    expect(kept).not.toContain('trailing');
  });

  it('preserves line numbers so failures still point at the right line', () => {
    const code = '/* a\n   b */\nsupabase.from("models")';
    const refs = extractRefs(code, NO_CONSTS);
    expect(refs[0]!.line).toBe(3);
  });

  it('blanks a block comment that quotes a table name', () => {
    const code = '/**\n * a bare supabase.from("credit_transactions") means mypix.*\n */\nconst y = 2;';
    expect(extractRefs(code, NO_CONSTS)).toEqual([]);
  });
});
