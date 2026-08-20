/**
 * ENGINE IDENTITY — the boundary between "a row the caller can write" and
 * "the person whose face we are about to render".
 *
 * ---------------------------------------------------------------------------
 * The failure mode this exists to prevent
 * ---------------------------------------------------------------------------
 * A trained model is only a row: `mypix.models` stores the person's likeness as
 * `astria_tune_id` (Astria) or `fal_lora_url` (fal). The render routes used to
 * load that row by (id, user_id, status) — which proves the ROW belongs to the
 * caller — and then hand the engine identifier straight to Astria/fal without
 * ever asking whether the TUNE belongs to the caller. Those are not the same
 * question, and a face-model product's entire safety story rests on the second
 * one.
 *
 * Both halves of the row are reachable by the user over PostgREST with the anon
 * key (NEXT_PUBLIC_*, shipped in every client bundle) plus their own session
 * JWT — no UI needed:
 *
 *   - UPDATE of `astria_tune_id` was possible until platform migration 0022
 *     narrowed the grant to {cover_image_url, updated_at}.
 *   - INSERT still writes ALL ELEVEN COLUMNS. `authenticated` holds a
 *     table-level INSERT grant on mypix.models and the RLS policy
 *     ("Users can manage their own models", FOR ALL USING auth.uid() = user_id)
 *     only constrains `user_id`. So the caller can create a row that is born
 *     `status='ready'` with `astria_tune_id` pointing at ANOTHER user's tune —
 *     proved against the live project on 2026-08-20 in a rolled-back
 *     transaction, acting as the real `authenticated` role:
 *
 *         UPDATE own row, astria_tune_id := victim tune  ->  DENIED 42501
 *         INSERT own row, astria_tune_id := victim tune  ->  OK rows=1
 *         SELECT exactly as /api/generate does           ->  victim's tune id
 *
 *     0022 closed a door and left the window open. The grant was never a
 *     sufficient defence, and one that "nobody is watching" is not a defence at
 *     all.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * An engine identifier may be used on behalf of a user only if NO OTHER USER's
 * row claims it. That check is not circular:
 *
 *   - the victim's row is written by the SERVER (lib/training.ts, service-role
 *     client) when their training run completes;
 *   - the attacker cannot alter it (no UPDATE grant on those columns) and
 *     cannot delete it (DELETE was never granted to `authenticated`).
 *
 * So the victim's row is attacker-immutable evidence of who owns the tune, and
 * "is anyone else already claiming this identifier?" is a question answered by
 * data the caller cannot write. The lookup runs with the SERVICE-ROLE client on
 * purpose: an RLS client only ever sees the caller's own rows, which would make
 * the check silently vacuous.
 *
 * RESIDUAL GAP (known, deliberately documented rather than hidden): if the
 * victim DELETES their model row, the tune still exists on Astria for ~30 days
 * with nothing left to claim it, and a forged INSERT naming that tune would
 * pass. Closing that needs the INSERT grant narrowed to the five columns
 * POST /api/models actually writes — written as platform migration 0023
 * (product-image-tools/supabase/migrations), NOT yet applied.
 *
 * ---------------------------------------------------------------------------
 * Why the checks cannot be forgotten
 * ---------------------------------------------------------------------------
 * A check that a future route can omit is a check that a future route WILL
 * omit. So the verified identifiers are branded types that only this module can
 * mint, and every engine entry point that identifies a resource — Astria's
 * `tuneId` params and its `<lora:…>` / `<faceid:…>` prompt tokens, fal's
 * `loras[].path` and training request id — takes the branded type. Passing a
 * raw `models.astria_tune_id` straight from a row is a COMPILE ERROR, not a
 * review comment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

declare const brandKey: unique symbol;
type Branded<T, K extends string> = T & { readonly [brandKey]: K };

/** An Astria tune id whose ownership has been established (or a server constant). */
export type TuneId = Branded<number, "astria_tune">;
/** A fal LoRA weights URL whose ownership + host have been established. */
export type LoraUrl = Branded<string, "fal_lora">;
/** A fal training request id whose ownership has been established. */
export type FalRequestId = Branded<string, "fal_request">;

/**
 * Mint a verified identifier for a value the SERVER owns — a build-time
 * constant (FLUX_BASE_TUNE_ID) or an id an engine just returned to us inside
 * this request. NEVER call this on a value read from a `mypix.*` row: that is
 * exactly the input this module exists to distrust.
 */
export function serverOwnedTuneId(id: number): TuneId {
  return id as TuneId;
}

/**
 * Hosts a fal LoRA may be fetched from. `fal_lora_url` is handed to fal as
 * `loras[].path`, i.e. an arbitrary URL a third party will fetch and load as
 * model weights, so a forged row must not be able to point it anywhere.
 * Overridable because fal owns this CDN and could move it — an allowlist that
 * causes an outage teaches people to delete allowlists.
 */
const FAL_LORA_HOSTS = ["fal.media", "fal.ai", "fal.run"];

function allowedLoraHosts(): string[] {
  const override = (process.env.FAL_LORA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return override.length > 0 ? override : FAL_LORA_HOSTS;
}

/** True when `url` is an https URL on a host fal serves trained weights from. */
export function isFalHostedLora(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return allowedLoraHosts().some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * The caller asked us to render with an engine identifier that is not theirs.
 * Routes turn this into a 403 and log it at error level — it is an attempted
 * identity misuse, not a user mistake, and should page someone if it ever fires
 * in production.
 */
export class ForeignIdentityError extends Error {
  readonly code = "foreign_identity";
  constructor(
    /** Which column carried the offending value. */
    readonly field: string,
    /** The row the caller presented. */
    readonly rowId: string,
    /** The user id that legitimately claims the identifier, when known. */
    readonly claimedBy: string | null,
    reason: string
  ) {
    super(`${field} on row ${rowId} is not the caller's: ${reason}`);
    this.name = "ForeignIdentityError";
  }

  /** Structured, secret-free fields for the log line. */
  info(): Record<string, unknown> {
    return {
      field: this.field,
      rowId: this.rowId,
      claimedBy: this.claimedBy,
      reason: this.message,
    };
  }
}

/** Raised when the ownership check itself could not be completed. Fail closed. */
export class IdentityCheckError extends Error {
  readonly code = "identity_check_failed";
}

/** The subset of a `mypix.models` row that carries engine identity. */
export interface ModelIdentityRow {
  id: string;
  user_id?: string | null;
  astria_tune_id?: number | null;
  fal_lora_url?: string | null;
  fal_request_id?: string | null;
}

/** Engine identifiers cleared for use on behalf of one user. */
export interface VerifiedIdentity {
  astriaTuneId: TuneId | null;
  falLoraUrl: LoraUrl | null;
  falRequestId: FalRequestId | null;
}

interface Claimant {
  id: string;
  user_id: string;
}

/**
 * Any OTHER user's model row claiming the same engine identifier.
 *
 * Service-role client, deliberately: RLS would hide precisely the row that
 * proves the theft. Never swallows the Postgres error — a check that cannot run
 * must not read as "nobody else claims it".
 */
async function foreignModelClaim(
  serviceClient: SupabaseClient<any, any, any>,
  column: "astria_tune_id" | "fal_lora_url" | "fal_request_id",
  value: string | number,
  userId: string
): Promise<Claimant | null> {
  const { data, error } = await serviceClient
    .from("models")
    .select("id, user_id")
    .eq(column, value)
    .neq("user_id", userId)
    .limit(1);
  if (error) {
    throw new IdentityCheckError(
      `ownership check on models.${column} failed: ${error.message} (${error.code})`
    );
  }
  return (data?.[0] as Claimant | undefined) ?? null;
}

/** Same question for a virtual try-on garment tune. */
async function foreignGarmentClaim(
  serviceClient: SupabaseClient<any, any, any>,
  tuneId: number,
  userId: string
): Promise<Claimant | null> {
  const { data, error } = await serviceClient
    .from("garment_tunes")
    .select("id, user_id")
    .eq("astria_tune_id", tuneId)
    .neq("user_id", userId)
    .limit(1);
  if (error) {
    throw new IdentityCheckError(
      `ownership check on garment_tunes.astria_tune_id failed: ${error.message} (${error.code})`
    );
  }
  return (data?.[0] as Claimant | undefined) ?? null;
}

/**
 * Clear a model row's engine identifiers for use on behalf of `userId`.
 *
 * Only the fields actually present (non-null) on `model` are checked, so a
 * render path that needs the tune does not pay for a fal lookup it will not
 * use. Throws ForeignIdentityError (403) or IdentityCheckError (500) — there is
 * no "carry on anyway" branch by design.
 */
export async function verifyModelIdentity(args: {
  serviceClient: SupabaseClient<any, any, any>;
  userId: string;
  model: ModelIdentityRow;
}): Promise<VerifiedIdentity> {
  const { serviceClient, userId, model } = args;

  // The row itself. Every caller already filters on user_id, but the whole
  // point of this module is not to trust that the caller remembered to.
  if (model.user_id != null && model.user_id !== userId) {
    throw new ForeignIdentityError(
      "user_id",
      model.id,
      model.user_id,
      "the row belongs to another user"
    );
  }

  const tune = model.astria_tune_id ?? null;
  const lora = model.fal_lora_url ?? null;
  const request = model.fal_request_id ?? null;

  // A LoRA URL is fetched by fal as model weights. Check the host before the
  // ownership lookup so an off-CDN URL is refused even if nobody else claims it.
  if (lora != null && !isFalHostedLora(lora)) {
    throw new ForeignIdentityError(
      "fal_lora_url",
      model.id,
      null,
      "weights URL is not on a fal-hosted origin (see FAL_LORA_HOSTS in lib/identity.ts)"
    );
  }

  const [tuneClaim, loraClaim, requestClaim] = await Promise.all([
    tune == null ? null : foreignModelClaim(serviceClient, "astria_tune_id", tune, userId),
    lora == null ? null : foreignModelClaim(serviceClient, "fal_lora_url", lora, userId),
    request == null
      ? null
      : foreignModelClaim(serviceClient, "fal_request_id", request, userId),
  ]);

  if (tuneClaim) {
    throw new ForeignIdentityError(
      "astria_tune_id",
      model.id,
      tuneClaim.user_id,
      `tune is already claimed by model ${tuneClaim.id}`
    );
  }
  if (loraClaim) {
    throw new ForeignIdentityError(
      "fal_lora_url",
      model.id,
      loraClaim.user_id,
      `LoRA is already claimed by model ${loraClaim.id}`
    );
  }
  if (requestClaim) {
    throw new ForeignIdentityError(
      "fal_request_id",
      model.id,
      requestClaim.user_id,
      `training job is already claimed by model ${requestClaim.id}`
    );
  }

  return {
    astriaTuneId: tune == null ? null : (tune as TuneId),
    falLoraUrl: lora == null ? null : (lora as LoraUrl),
    falRequestId: request == null ? null : (request as FalRequestId),
  };
}

/**
 * Clear a garment tune for use on behalf of `userId`.
 *
 * `mypix.garment_tunes` has the same shape of hole as `mypix.models` and it is
 * NOT narrowed by migration 0022: `authenticated` holds a table-level INSERT
 * grant covering all seven columns, so a hand-rolled PostgREST insert can mint
 * a "garment" whose `astria_tune_id` is another user's FACE tune. /api/edit
 * then composes `<faceid:…>` from it, which is an identity injection, not a
 * shirt.
 */
export async function verifyGarmentTuneId(args: {
  serviceClient: SupabaseClient<any, any, any>;
  userId: string;
  garmentId: string;
  tuneId: number;
}): Promise<TuneId> {
  const { serviceClient, userId, garmentId, tuneId } = args;

  const [garmentClaim, modelClaim] = await Promise.all([
    foreignGarmentClaim(serviceClient, tuneId, userId),
    // A garment tune id that is really somebody's FACE tune is the whole point
    // of the attack, so check both tables.
    foreignModelClaim(serviceClient, "astria_tune_id", tuneId, userId),
  ]);

  if (garmentClaim) {
    throw new ForeignIdentityError(
      "astria_tune_id",
      garmentId,
      garmentClaim.user_id,
      `tune is already claimed by garment ${garmentClaim.id}`
    );
  }
  if (modelClaim) {
    throw new ForeignIdentityError(
      "astria_tune_id",
      garmentId,
      modelClaim.user_id,
      `tune is another user's face model (${modelClaim.id}), not a garment`
    );
  }

  return tuneId as TuneId;
}
