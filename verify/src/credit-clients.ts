/**
 * Which Supabase client each credit-helper CALL SITE hands over.
 *
 * This exists because of the 2026-08-19 outage that no gate caught: one call
 * site in `app/(dashboard)/layout.tsx` passed the RLS client to `getBalance()`.
 * The wallet RPCs behind it (`core.ensure_wallet` & friends) are SECURITY
 * DEFINER with no authorization check of their own, so platform migration 0021
 * revoked EXECUTE from PUBLIC — meaning that call threw 42501 for every signed-in
 * user. Because the helper is awaited in the dashboard LAYOUT, the throw took
 * down /dashboard, /studio, /account and /models/new on both brands at once,
 * while `/` kept answering 200 and the deploy gate kept saying "deployed".
 *
 * The resource inventory cannot see this: the `.rpc()` call itself lives inside
 * @aionized/platform-client and is issued through whatever client it is given.
 * The defect is the ROLE of the argument at the call site, so that is what this
 * module reads.
 *
 * Anti-drift, same rule as everywhere else in this suite:
 *   - the set of service-role-only helpers is DERIVED from lib/credits.ts (a
 *     helper is service-role-only iff its body reaches `createPlatformAdmin`),
 *     so adding `refundCredits()` tomorrow puts it under the check automatically;
 *   - a call whose client argument cannot be resolved statically is reported as
 *     UNRESOLVED and fails, rather than being skipped.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  collectSourceFiles,
  declaredClientRoles,
  roleFromName,
  stripComments,
  type Role,
  type ScanOptions,
  type SourceRef,
} from './inventory';

/** Where the credit helpers live; also the file the classification is read from. */
export const CREDITS_MODULE = 'lib/credits.ts';

export interface HelperContract {
  name: string;
  /** The role the helper's own body requires of the client it is given. */
  requires: Role;
  /** Why — quoted into the failure so the reader does not have to guess. */
  because: string;
}

export interface CreditCallSite {
  helper: string;
  requires: Role;
  because: string;
  /** Role of the client expression actually passed, or null when undecidable. */
  passed: Role | null;
  expression: string;
  ref: SourceRef;
}

/**
 * Classify the exported helpers of lib/credits.ts by the client they need.
 *
 * `platform()` in that module is `createPlatformAdmin(...)`, the wrapper around
 * the service-role-only `core.*` wallet RPCs. A helper that reaches it needs a
 * service-role client; a helper that queries a table directly (listCreditHistory
 * reads `core.credit_transactions` under the `credit_tx_select_own` policy) is
 * a user-scoped read and wants the RLS client.
 */
export function helperContracts(source: string): HelperContract[] {
  // Comments in this module quote the very call shapes being classified
  // ("it calls the core.* wallet RPCs"), and a doc block sits between two
  // functions — so classifying prose would attribute it to the wrong one.
  const creditsSource = stripComments(source);
  const out: HelperContract[] = [];
  const fnRe = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  const starts: { name: string; at: number }[] = [];
  for (const m of creditsSource.matchAll(fnRe)) starts.push({ name: m[1]!, at: m.index ?? 0 });

  for (let i = 0; i < starts.length; i++) {
    const { name, at } = starts[i]!;
    const end = starts[i + 1]?.at ?? creditsSource.length;
    const body = creditsSource.slice(at, end);
    // Only helpers that take a Supabase client as their first parameter are call
    // sites at all; the pure reshapers (creditHistoryRow) are not.
    if (!/\(\s*\w+\s*:\s*SupabaseClient/.test(body)) continue;
    if (/\bplatform\s*\(|createPlatformAdmin\s*\(/.test(body)) {
      out.push({
        name,
        requires: 'service_role',
        because:
          'it calls the core.* wallet RPCs, which are SECURITY DEFINER and were revoked from ' +
          'PUBLIC by platform migration 0021 — an RLS client gets 42501 permission denied for ' +
          'function, and because this is awaited in the (dashboard) layout that 500s EVERY ' +
          'authenticated route',
      });
    } else if (/\.schema\(\s*['"]core['"]\s*\)/.test(body)) {
      out.push({
        name,
        requires: 'authenticated',
        because:
          'it is a user-scoped read of core.credit_transactions under the credit_tx_select_own ' +
          'RLS policy — the service-role client bypasses RLS and would hide a broken policy',
      });
    }
  }
  return out;
}

/** Resolve the first argument of a helper call to the role it speaks as. */
export function roleOfClientExpression(
  expr: string,
  declared: Record<string, Role[]>,
): Role | null {
  const trimmed = expr.trim();
  // Inline construction: `await createServiceClient()` / `await createClient()`.
  if (/\bcreateServiceClient\s*\(/.test(trimmed)) return 'service_role';
  if (/\bcreateClient\s*\(/.test(trimmed)) return 'authenticated';
  // A bare identifier: prefer its declaration in this file, else its name.
  const ident = /^[A-Za-z_$][\w$]*$/.exec(trimmed)?.[0];
  if (!ident) return null;
  const d = declared[ident];
  if (d?.length === 1) return d[0]!;
  if (d?.length) return null; // declared both ways in one file — undecidable
  return roleFromName(ident);
}

/** First top-level argument of `text`, which must start at the call's `(`. */
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

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/** Every call to a credit helper in the repo, with the role it hands over. */
export function scanCreditCallSites(opts: ScanOptions): {
  contracts: HelperContract[];
  sites: CreditCallSite[];
} {
  const creditsPath = join(opts.root, CREDITS_MODULE);
  const contracts = helperContracts(readFileSync(creditsPath, 'utf8'));
  const byName = new Map(contracts.map((c) => [c.name, c]));
  const sites: CreditCallSite[] = [];

  for (const file of collectSourceFiles(opts)) {
    const rel = relative(opts.root, file).split(sep).join('/');
    if (rel === CREDITS_MODULE) continue; // the definitions, not call sites
    const code = stripComments(readFileSync(file, 'utf8'));
    const declared = declaredClientRoles(code);
    for (const contract of contracts) {
      const re = new RegExp(`\\b${contract.name}\\s*\\(`, 'g');
      for (const m of code.matchAll(re)) {
        const at = (m.index ?? 0) + m[0].length - 1;
        // An import statement is not a call site.
        const lineStart = code.lastIndexOf('\n', m.index ?? 0) + 1;
        if (/^\s*import\b/.test(code.slice(lineStart, m.index))) continue;
        const expression = firstArgument(code.slice(at, at + 4000));
        // `null` = unbalanced parens (not a call); `''` = a zero-argument
        // mention such as a re-export, which passes no client at all.
        if (expression === null || expression === '') continue;
        sites.push({
          helper: contract.name,
          requires: contract.requires,
          because: contract.because,
          passed: roleOfClientExpression(expression, declared),
          expression,
          ref: { file: rel, line: lineOf(code, m.index ?? 0) },
        });
      }
    }
  }
  void byName;
  return { contracts, sites };
}

/** Human-readable, secret-free rendering of one violating call site. */
export function describeViolation(s: CreditCallSite): string {
  const where = `${s.ref.file}:${s.ref.line}`;
  if (s.passed === null) {
    return (
      `${where} calls ${s.helper}(${s.expression}) but the client argument cannot be resolved ` +
      'statically — hoist it into a `const … = await createServiceClient()` so this is verifiable'
    );
  }
  return (
    `${where} calls ${s.helper}(${s.expression}) with the ${s.passed} client, ` +
    `but it requires the ${s.requires} client: ${s.because}`
  );
}
