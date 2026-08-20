/**
 * COLUMN-LEVEL WRITE PRIVILEGES — what `authenticated` may actually UPDATE.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Layer 1 proves a role can SELECT from the tables the code reads. It is blind
 * to write privileges, so the whole of the following was invisible to it:
 *
 *   0020  grant insert, update on mypix.models to authenticated;
 *
 * A table-level UPDATE grant is all eleven columns, including `astria_tune_id`
 * — the handle that says whose FACE a render is of. /api/generate loaded the
 * row by (id, user_id, status) and rendered with that column, so a user could
 * point their own row at another user's tune and generate images of that
 * person. Platform migration 0022 narrowed the grant to exactly
 * {cover_image_url, updated_at}, the two columns the one RLS-client UPDATE in
 * the app writes (app/api/models/[id]/cover/route.ts).
 *
 * Nothing watches that. A later migration, a scaffold copy into the next
 * product, or someone "fixing" a mysterious 42501 by re-running
 * `grant update on … to authenticated` re-opens identity misuse in one line,
 * silently, and every gate we have stays green. (The application-layer defence
 * in lib/identity.ts is the real fix; this is the tripwire on the layer that
 * was mistaken for one.)
 *
 * ---------------------------------------------------------------------------
 * Derived, not listed
 * ---------------------------------------------------------------------------
 * docs/VERIFICATION.md's rule is that an expectation must come from the source
 * or from the database, never from a checklist someone has to remember to
 * update. So neither side of the comparison is hand-written:
 *
 *   needed   = the columns RLS-client code actually writes, read out of the
 *              repo by the inventory scanner (`Inventory.writes`)
 *   granted  = what the live database lets the `authenticated` role update,
 *              measured column by column
 *
 * and the assertion is that they are equal. Add an RLS-client UPDATE of a new
 * column and the failure tells you to grant that column; widen a grant and the
 * failure names the columns nothing in the code writes. Neither drifts.
 *
 * ---------------------------------------------------------------------------
 * Why measured, not read from information_schema.column_privileges
 * ---------------------------------------------------------------------------
 * The catalog view is the honest source and is what the migration was verified
 * against by hand — but it is not reachable from here. PostgREST exposes only
 * `public, graphql_public, core, pixby, pdftools, mypix` (authenticator's
 * pgrst.db_schemas), `information_schema` is not among them, and this suite has
 * no Postgres connection string: the whole point is that it runs with exactly
 * the three credentials the app itself has.
 *
 * The probe below is in any case the stronger question. Privileges are a UNION
 * of the table-level and column-level grants, and 0022's own file records that
 * running its `grant update (…)` line WITHOUT the preceding table-level
 * `revoke` leaves the wide privilege fully in place while the statement reports
 * success. Reading a catalog can be misread; asking Postgres "may this role
 * update this column?" through the same PostgREST surface the browser uses
 * cannot.
 *
 * It writes nothing: every probe filters on the nil UUID, so zero rows match.
 * Postgres checks column privileges at executor start, before any row is
 * touched, so an ungranted column answers 42501 and a granted one answers 204
 * with nothing written. Verified against the live project on 2026-08-20:
 * cover_image_url/updated_at → 204, the other nine → 403 42501.
 *
 * NOTE it measures the GRANT, not the RLS policy: with zero rows matched a
 * missing policy also answers 204. Row-boundary behaviour is the smoke's job.
 */
import type { Creds } from './rest';
import type { Role, WriteRef } from './inventory';

/** Matches nothing, in any table keyed by a uuid. */
export const NO_SUCH_ROW = '00000000-0000-0000-0000-000000000000';

function headers(creds: Creds, role: Role | 'anon', jwt?: string): Record<string, string> {
  const apikey = role === 'service_role' ? creds.serviceKey : creds.anonKey;
  const bearer = role === 'service_role' ? creds.serviceKey : (jwt ?? creds.anonKey);
  return { apikey, authorization: `Bearer ${bearer}` };
}

export interface TableShape {
  table: string;
  columns: string[];
  /** Format of the `id` column per PostgREST, used to build a no-match filter. */
  idFormat: string | null;
}

/**
 * Every table in `schema` with its columns, straight out of the database.
 *
 * PostgREST publishes its own schema cache as OpenAPI at the API root. Only the
 * service-role key may read it ("Only the `service_role` API key can be used
 * for this endpoint"), which is fine — this suite already holds that key, and
 * the alternative (a hand-written column list) is the thing being avoided.
 */
export async function tableShapes(creds: Creds, schema: string): Promise<TableShape[]> {
  const res = await fetch(`${creds.supabaseUrl}/rest/v1/`, {
    headers: {
      ...headers(creds, 'service_role'),
      'accept-profile': schema,
      accept: 'application/openapi+json',
    },
  });
  if (!res.ok) {
    throw new Error(
      `could not read the PostgREST schema for "${schema}": HTTP ${res.status} — without it the ` +
        'column list would have to be hand-maintained, which is the drift this check exists to stop',
    );
  }
  const spec = (await res.json()) as {
    definitions?: Record<string, { properties?: Record<string, { format?: string }> }>;
  };
  return Object.entries(spec.definitions ?? {}).map(([table, def]) => ({
    table,
    columns: Object.keys(def.properties ?? {}),
    idFormat: def.properties?.id?.format ?? null,
  }));
}

export type ColumnVerdict =
  | { column: string; verdict: 'granted' }
  | { column: string; verdict: 'denied' }
  | { column: string; verdict: 'inconclusive'; detail: string };

/**
 * May `authenticated` UPDATE this column? Asked by attempting an update that
 * matches no rows, so the answer costs nothing and changes nothing.
 */
export async function probeColumnUpdate(
  creds: Creds,
  schema: string,
  table: string,
  column: string,
  jwt: string,
): Promise<ColumnVerdict> {
  const res = await fetch(
    `${creds.supabaseUrl}/rest/v1/${encodeURIComponent(table)}?id=eq.${NO_SUCH_ROW}`,
    {
      method: 'PATCH',
      headers: {
        ...headers(creds, 'authenticated', jwt),
        'content-type': 'application/json',
        'content-profile': schema,
        'accept-profile': schema,
        prefer: 'return=minimal',
      },
      body: JSON.stringify({ [column]: null }),
    },
  );
  if (res.status >= 200 && res.status < 300) return { column, verdict: 'granted' };
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (body?.code === '42501') return { column, verdict: 'denied' };
  return {
    column,
    verdict: 'inconclusive',
    detail: `HTTP ${res.status}${body?.code ? ` ${body.code}` : ''}${body?.message ? ` ${body.message}` : ''}`,
  };
}

export interface GrantProbe {
  table: string;
  granted: string[];
  inconclusive: { column: string; detail: string }[];
}

/** Probe every column of one table. Serial: this is a handful of requests. */
export async function probeUpdatableColumns(
  creds: Creds,
  schema: string,
  shape: TableShape,
  jwt: string,
): Promise<GrantProbe> {
  if (shape.idFormat !== 'uuid') {
    return {
      table: shape.table,
      granted: [],
      inconclusive: shape.columns.map((column) => ({
        column,
        detail:
          `${schema}.${shape.table} has no uuid "id" column, so no filter is known that ` +
          'provably matches zero rows — refusing to probe rather than risk a write',
      })),
    };
  }
  const granted: string[] = [];
  const inconclusive: { column: string; detail: string }[] = [];
  for (const column of shape.columns) {
    const r = await probeColumnUpdate(creds, schema, shape.table, column, jwt);
    if (r.verdict === 'granted') granted.push(column);
    else if (r.verdict === 'inconclusive') inconclusive.push({ column, detail: r.detail });
  }
  return { table: shape.table, granted: granted.sort(), inconclusive };
}

// ─────────────────────────────────────────────────────────── pure comparison

/** Columns the RLS-client code UPDATEs on one table, with their call sites. */
export function neededUpdateColumns(
  writes: WriteRef[],
  schema: string,
  table: string,
): { columns: string[]; sites: string[] } {
  const relevant = writes.filter(
    (w) => w.schema === schema && w.table === table && w.op === 'update' && w.role === 'authenticated',
  );
  const columns = new Set<string>();
  for (const w of relevant) for (const c of w.columns) columns.add(c);
  return {
    columns: [...columns].sort(),
    sites: relevant.map((w) => `${w.ref.file}:${w.ref.line}`),
  };
}

export interface GrantVerdict {
  table: string;
  granted: string[];
  needed: string[];
  /** Granted but written by nothing — the regression this check exists for. */
  excess: string[];
  /** Written but not granted — the app is broken, or a grant was forgotten. */
  missing: string[];
  sites: string[];
  ok: boolean;
}

export function compareUpdateGrant(
  probe: GrantProbe,
  needed: { columns: string[]; sites: string[] },
): GrantVerdict {
  const excess = probe.granted.filter((c) => !needed.columns.includes(c));
  const missing = needed.columns.filter((c) => !probe.granted.includes(c));
  return {
    table: probe.table,
    granted: probe.granted,
    needed: needed.columns,
    excess,
    missing,
    sites: needed.sites,
    ok: excess.length === 0 && missing.length === 0,
  };
}

/**
 * The failure text. It has to carry the WHY, because the person reading it is
 * most likely the person who just widened the grant to make something work.
 */
export function describeGrantVerdict(schema: string, v: GrantVerdict): string {
  const where = `${schema}.${v.table}`;
  const lines: string[] = [];
  if (v.excess.length) {
    lines.push(
      `${where}: role "authenticated" may UPDATE {${v.excess.join(', ')}}, which NOTHING in the ` +
        'app writes through the RLS client. A user reaches this directly over PostgREST with the ' +
        'anon key (NEXT_PUBLIC_*, in every client bundle) plus their own session JWT — no UI ' +
        'involved. On mypix.models the load-bearing one is astria_tune_id / fal_lora_url: they ' +
        'name whose FACE a render is of, which is why platform migration 0022 narrowed this grant ' +
        'to exactly the two columns POST /api/models/[id]/cover writes. Re-granting UPDATE at ' +
        'table level undoes that in one line. Fix the grant, not this test.',
    );
  }
  if (v.missing.length) {
    lines.push(
      `${where}: the RLS client writes {${v.missing.join(', ')}} at ${v.sites.join(', ') || '(no site)'} ` +
        'but "authenticated" has no UPDATE privilege on those columns — that write fails with ' +
        '42501 for every signed-in user. Add them to the column-level grant (a new migration; ' +
        'note a column grant does NOT replace a table grant, so revoke first — see 0022).',
    );
  }
  return lines.join('\n');
}
