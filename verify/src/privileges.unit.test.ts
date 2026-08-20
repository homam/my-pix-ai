/**
 * Layer 3 — the pure half of the column-privilege check.
 *
 * The probe itself needs the live database (verify/src/privileges.ts, exercised
 * by the preflight). What is testable here without credentials is the part that
 * decides PASS or FAIL, and the case that matters is the regression: someone
 * re-runs `grant update on mypix.models to authenticated` and the checker must
 * refuse, naming astria_tune_id. A detector that cannot be shown failing is not
 * a detector.
 */
import { describe, expect, it } from 'vitest';
import {
  compareUpdateGrant,
  describeGrantVerdict,
  neededUpdateColumns,
  type GrantProbe,
} from './privileges';
import { defaultScanOptions, scanInventory, type WriteRef } from './inventory';
import { REPO_ROOT } from './config';

/** The eleven columns of mypix.models, i.e. what a table-level grant covers. */
const ALL_MODEL_COLUMNS = [
  'astria_tune_id',
  'cover_image_url',
  'created_at',
  'fal_lora_url',
  'fal_request_id',
  'id',
  'name',
  'provider',
  'status',
  'updated_at',
  'user_id',
];

const NARROWED: GrantProbe = {
  table: 'models',
  granted: ['cover_image_url', 'updated_at'],
  inconclusive: [],
};

const WIDENED: GrantProbe = { table: 'models', granted: ALL_MODEL_COLUMNS, inconclusive: [] };

const coverRouteWrite: WriteRef = {
  schema: 'mypix',
  table: 'models',
  op: 'update',
  role: 'authenticated',
  columns: ['cover_image_url', 'updated_at'],
  ref: { file: 'app/api/models/[id]/cover/route.ts', line: 65 },
};

/** Service-role writes bypass grants entirely and must not count as "needed". */
const trainingWrite: WriteRef = {
  schema: 'mypix',
  table: 'models',
  op: 'update',
  role: 'service_role',
  columns: ['status', 'astria_tune_id', 'name', 'updated_at'],
  ref: { file: 'lib/training.ts', line: 153 },
};

describe('needed columns come from the RLS-client writes only', () => {
  it('reads the columns of the one RLS-client UPDATE in the app', () => {
    const needed = neededUpdateColumns([coverRouteWrite, trainingWrite], 'mypix', 'models');
    expect(needed.columns).toEqual(['cover_image_url', 'updated_at']);
    expect(needed.sites).toEqual(['app/api/models/[id]/cover/route.ts:65']);
  });

  it('ignores service-role writes — they bypass grants, so they need none', () => {
    expect(neededUpdateColumns([trainingWrite], 'mypix', 'models').columns).toEqual([]);
  });

  it('ignores inserts, and other tables', () => {
    const insert: WriteRef = { ...coverRouteWrite, op: 'insert' };
    expect(neededUpdateColumns([insert], 'mypix', 'models').columns).toEqual([]);
    expect(neededUpdateColumns([coverRouteWrite], 'mypix', 'shares').columns).toEqual([]);
  });
});

describe('the grant comparison', () => {
  it('passes on the state migration 0022 left behind', () => {
    const v = compareUpdateGrant(NARROWED, neededUpdateColumns([coverRouteWrite], 'mypix', 'models'));
    expect(v.ok).toBe(true);
    expect(v.excess).toEqual([]);
    expect(v.missing).toEqual([]);
  });

  it('FAILS when the grant is widened back to table level', () => {
    const v = compareUpdateGrant(WIDENED, neededUpdateColumns([coverRouteWrite], 'mypix', 'models'));
    expect(v.ok).toBe(false);
    // The identity columns are the reason this check exists; name them.
    expect(v.excess).toContain('astria_tune_id');
    expect(v.excess).toContain('fal_lora_url');
    expect(v.excess).toContain('status');
    expect(v.excess).toContain('user_id');
    const message = describeGrantVerdict('mypix', v);
    expect(message).toMatch(/astria_tune_id/);
    expect(message).toMatch(/0022/);
  });

  it('FAILS on the narrower regression too — one extra column is enough', () => {
    const v = compareUpdateGrant(
      { table: 'models', granted: ['astria_tune_id', 'cover_image_url', 'updated_at'], inconclusive: [] },
      neededUpdateColumns([coverRouteWrite], 'mypix', 'models'),
    );
    expect(v.ok).toBe(false);
    expect(v.excess).toEqual(['astria_tune_id']);
  });

  it('FAILS the other way when a needed column is not granted', () => {
    const v = compareUpdateGrant(
      { table: 'models', granted: ['cover_image_url'], inconclusive: [] },
      neededUpdateColumns([coverRouteWrite], 'mypix', 'models'),
    );
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['updated_at']);
    expect(describeGrantVerdict('mypix', v)).toMatch(/42501/);
  });
});

describe('the live repo scan feeds the comparison', () => {
  const inventory = scanInventory(defaultScanOptions(REPO_ROOT));

  it('still finds exactly one RLS-client UPDATE on mypix.models', () => {
    const needed = neededUpdateColumns(inventory.writes, 'mypix', 'models');
    expect(
      needed.columns,
      'the set of columns the RLS client updates changed — that is fine, but the grant has to ' +
        'move with it (a new migration), and this expectation is what forces the two to be ' +
        'reconciled deliberately rather than by widening the grant until the error goes away',
    ).toEqual(['cover_image_url', 'updated_at']);
    expect(needed.sites).toEqual(['app/api/models/[id]/cover/route.ts:65']);
  });

  it('leaves no write whose columns it could not read', () => {
    expect(
      inventory.unresolved
        .filter((u) => u.kind === 'write-columns')
        .map((u) => `${u.ref.file}:${u.ref.line} ${u.expression}`),
      'an RLS-client write whose column list is not a literal cannot be checked against the ' +
        'grant — pass an object literal so the privilege stays verifiable',
    ).toEqual([]);
  });
});
