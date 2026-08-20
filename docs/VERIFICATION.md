# Verification

> How this repo proves a deployment works, and why the proof looks the way it does.
> The implementation is `verify/`; the gates are in `scripts/deploy.sh`.

## Why this exists

On **2026-08-19/20** three defects each silently broke MyPix AI in production, and
nothing caught any of them. The only deploy gate was *"HTTP 200 and the brand name
appears in the landing-page HTML"* — a gate that a completely broken product
passes.

| # | Defect | What users saw | Why every gate stayed green |
|---|--------|----------------|-----------------------------|
| 1 | `getBalance()` was handed the RLS client instead of the service-role one. The `core.*` wallet RPCs are `SECURITY DEFINER` and were revoked from `PUBLIC` by platform migration 0021, so the call threw `42501`. It is **awaited in the `(dashboard)` layout**. | `/dashboard` `/studio` `/account` `/models/new` **all 500**, on both brands. | `/` returned 200 and contained the brand name. The gate only looked at `/`. |
| 2 | `lib/storage.ts` set `STORAGE_BUCKET = "user-uploads"`, a bucket that does not exist (the real one is `mypix`). | Every upload and download failed. | Storage answers `200 []` when you **list** a bucket that isn't there, and the client-side error was swallowed. |
| 3 | `/account` read `mypix.credit_transactions`; the ledger is `core.credit_transactions` (every client here is built with `db: { schema: "mypix" }`, so a bare `.from()` means `mypix.*`). The page ignored the Supabase `error`. | "No transactions yet", forever, for users who had transactions. | A swallowed query error is indistinguishable from an empty result. |

Fixed in `1a1f400`, `552d016`, `10bb94d`. The hole those three shared is what this
suite closes: **every one of them was invisible to a structural check** — HTTP
status, page renders, string present — because the failure was swallowed on the
way to the user.

## The layers

| Layer | Command | What it proves | Cost |
|-------|---------|----------------|------|
| **1 — preflight** | `npm run preflight` | Every table / bucket / RPC / env var the code *names* exists and is reachable **by the role that actually uses it**. Read-only. | ~12s |
| **1b — health** | `GET /api/health` | The **running container's** own view of its dependencies. 503 when one is unreachable. Never emits secret values. | instant |
| **2 — smoke** | `npm run smoke` | The critical journeys against a live target, asserting **outcomes** rather than status codes. | ~20s |
| **3 — unit** | `npm test` | Pure logic, including `diagnose.unit.test.ts`, which **pins the exact error payloads of the three incidents** so "this would have caught it" is itself under test. | <1s |
| **4 — gates** | `scripts/deploy.sh` | Preflight before building; brand identity + health + smoke after rollout; rollback commands printed on failure. | — |

```bash
npm run verify                      # preflight + smoke, against .env.local
VERIFY_TARGET=https://wy7kp3ie3e.eu-central-1.awsapprunner.com npm run smoke
NEXT_PUBLIC_BRAND_KEY=glowshot npm run preflight    # picks that brand's account
VERIFY_ROOT=/path/to/worktree npm run preflight     # scan a different checkout
```

## The design principle: anti-drift

**`verify/src/inventory.ts` derives the expected resource set by scanning the
source. It is never written down by hand.** A hand-maintained list rots — someone
renames a bucket, forgets the list, and the preflight keeps reporting green while
production is broken.

It finds:

- `x.from('t')` → table `mypix.t` (the default schema of every client here)
- `x.schema('core').from('t')` → `core.t`
- `x.storage.from(B).op(…)` → bucket `B` **and the operation**, which is what
  drives the smoke's round trip
- `x.rpc('f', { p_a: … })` → RPC `f` **with its argument names**, because
  PostgREST resolves an overload by its exact named-argument set: probing with a
  guessed signature yields a false "function not found"

and it resolves constants (`STORAGE_BUCKET`, `SOME_MAP.key`) through the
declarations in the scanned sources.

**Anything it cannot resolve statically FAILS the preflight** rather than being
skipped. `storage.from(bucketFor(user))` is not "no finding" — it is an
unverifiable dependency, and that is a defect. Put names in a `const`.

Three things it does that the `ai-all-in-one-chat` original does not, because this
codebase differs:

- **Scalar constants.** The bucket is `export const STORAGE_BUCKET = "mypix"`, not
  an `as const` map.
- **Role from the declaration, not the name.** `app/api/webhooks/astria/route.ts`
  really does call its service client `supabase`, while `lib/credits.ts` takes an
  RLS client under the same name. A name declared both ways in one file gets both
  roles, which is the conservative reading. Parameter names are the fallback for
  helper modules (`serviceClient`, `svc` → service_role).
- **Comments are stripped first.** This repo documents itself by quoting real call
  shapes — *"a bare `.from("credit_transactions")` resolves to `mypix.*`"* — which
  would otherwise be scanned as dependencies that do not exist.

## The rule each incident turned into

### 1 — the wrong client at a call site → `verify/src/credit-clients.ts`

The resource inventory cannot see incident 1: the `.rpc()` call itself lives
inside `@aionized/platform-client` and runs as whatever client it is handed. The
defect is the **role of the argument at the call site**, so that is what is read.

The set of service-role-only helpers is **derived from `lib/credits.ts`**: a
helper is service-role-only iff its body reaches `createPlatformAdmin`. Add
`refundCredits()` tomorrow and it is under the check automatically.

The security half of the same fact is asserted too: **`core.*` wallet RPCs must
NOT be executable by `anon` or `authenticated`.** They are `SECURITY DEFINER`,
take the target user as a parameter and carry no authorization check of their
own, so a browser-reachable `EXECUTE` grant would let any holder of the anon key
mint credits for any user on any product. Without this half, incident 1 could be
"fixed" by re-granting.

### 2 — a resource name must be statically resolvable, and asked for directly

`POST /object/list/<bucket>` answers `200 []` for a bucket that does not exist.
Only the **bucket endpoint** tells the truth, so that is what both the preflight
and `/api/health` call. The bucket's `public` flag is asserted too, because
`getPublicUrl` hands Astria unauthenticated URLs — a bucket flipped private would
break training with no error in any log of ours.

### 3 — never ignore a Supabase `error`

Every 2026 outage on this platform presented as "nothing happens". Read the error
back and surface it (`lib/credits.ts listCreditHistory` now throws). The smoke's
counterpart: read the ledger **directly first**, then insist `/account` renders
what it actually holds — an empty state is not evidence, because a working page
and a broken page produce the same one.

### New journey → new Layer 2 step

Preflight only proves reachability per role; write paths and rendering are covered
functionally in `verify/src/smoke.spec.ts`.

## Layer 2 specifics

The smoke signs in **without a password** (`admin/generate_link` → `auth/verify`,
service role → anon) and then drives the app with a **real `@supabase/ssr` session
cookie**, built by handing the session to the library's own `createServerClient`
with an in-memory jar and reading back what it writes. Not by re-implementing the
`sb-<ref>-auth-token` / `base64-…` / 3180-byte-chunk encoding: the app parses these
cookies with the same library version, so the format cannot drift out from under
the suite.

This matters because `middleware.ts` and the `(dashboard)` layout authenticate
from cookies only — there is **no bearer-token path into this app** — and *"does an
authenticated page render at all"* is precisely the assertion that was missing.

> **GOTCHA.** `SUPABASE_SERVICE_ROLE_KEY` here is a new-style `sb_secret_…` key,
> not a JWT. It must be sent in **both** `apikey` and `Authorization`; `Bearer`
> alone answers `403 bad_jwt`.

## Test accounts are per brand

Brands belong to legal **entities** and **user accounts never cross them**:
`core.bind_entity` binds a user on first wallet touch, and every wallet RPC then
raises `ENTITY_MISMATCH` across the line. A `mypix` account run against `glowshot`
fails the balance step — which looks exactly like a product bug and is not one.

| Brand | Entity | Smoke account |
|-------|--------|---------------|
| `mypix` | entity1 | `demo@mobilesparkcreations.com` |
| `glowshot` | entity2 | `verify+glowshot@mobilesparkcreations.com` |

The mapping lives in **both** `verify/src/config.ts` (`BRAND_TEST_USERS`) and
`deploy/brands/<brand>.env` (`VERIFY_USER_EMAIL`), so it cannot be got wrong by
forgetting an env var. To provision another:

```bash
curl -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'content-type: application/json' \
  -d '{"email":"verify+<brand>@…","email_confirm":true}'
# then, as postgres:
select core.grant_credits('<uid>'::uuid, '<brand>', 500, 'demo_provision', 'verify-suite');
```

Never point a smoke gate at a real user's account.

## Deploy gates

`scripts/deploy.sh`:

0. **`npm run preflight` before a single byte is built.** Overridable only by an
   explicit `DEPLOY_ACK_PREFLIGHT=1`, for the case where you are shipping the fix
   *for* a preflight finding.
1. **Brand identity from `/api/health`, not from page HTML.** The endpoint reports
   the brand the running container was built with, as JSON. Grepping the landing
   page for the brand *name* produced two false `ROLLOUT FAILED` alarms on the
   sibling product, because that string travels through copy and markup that
   change for reasons unrelated to which image is live. Falls back to the HTML
   check for images that predate `/api/health`.
2. **`/api/health` reports `ok:true`.**
3. **`npm run smoke`, as an account from THAT brand's entity.**

The ECR digest that was live is captured **before** the push (the tag is mutable,
so it is the only handle on "what was live a minute ago"), and any failed gate
prints ready-to-paste rollback commands.

## Proof that it catches the three incidents

Run against the commit *before* each fix, using a `git worktree` and `VERIFY_ROOT`
(Layer 1) / a dev server from that worktree (Layer 2). Reproduce with:

```bash
git worktree add /tmp/pre-bug1 042b235   # before the getBalance fix
VERIFY_ROOT=/tmp/pre-bug1 npm run preflight
```

| State | Layer 1 | Layer 2 |
|-------|---------|---------|
| `042b235` — before fix 1 | `credit-client call sites` fails, listing all **5** call sites with file:line and the consequence | step 2 fails: `/dashboard /studio /account /models/new → HTTP 500` |
| `1a1f400` — before fix 2 | `bucket "user-uploads" does not exist`, naming all 14 call sites | step 5 fails: `POST /api/upload → 500` |
| `552d016` — before fix 3 | `relation mypix.credit_transactions does not exist`, naming the call site and the default-schema trap | step 4 fails: the ledger holds transactions but `/account` renders the empty state |
| current `main` | 47 passed, 1 skipped | 10 passed |
