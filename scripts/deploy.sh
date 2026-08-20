#!/usr/bin/env bash
# Deploy EVERY brand of MyPix AI (product `mypix`) to AWS App Runner.
#
# Brands share one codebase and one feature set — a deploy rolls out ALL brand
# deployments listed in deploy/brands/*.env so they never drift. Each brand file
# sets BRAND_KEY / ECR_TAG / SERVICE_NAME / APP_URL / AUTO_DEPLOY /
# VERIFY_USER_EMAIL; the brand's copy + packs + colors live in the lib/brand.ts
# registry. To restrict to specific brands (emergency only — drifting brands
# violates the sync rule), pass their keys: `scripts/deploy.sh glowshot`.
#
# Builds linux/amd64 (App Runner is x86_64; arm64 images fail the health check
# with no logs). Secrets stay runtime-only on the services, never in the image.
# Mirrors the other 3 product repos' scripts/deploy.sh.
#
# ── VERIFICATION GATES (docs/VERIFICATION.md) ───────────────────────────────
# Until 2026-08-20 the only gate here was "HTTP 200 and the brand name appears in
# the landing-page HTML". That gate passed for days while /dashboard /studio
# /account /models/new were ALL returning 500 on both brands, while every file
# upload failed NoSuchBucket, and while /account showed "No transactions yet" to
# users who had transactions. A page that renders is not a product that works,
# so a rollout now has to clear:
#
#   BEFORE building   npm run preflight   every table/bucket/RPC/env the code
#                                         names exists and is reachable BY THE
#                                         ROLE THAT USES IT (seconds, read-only)
#   AFTER rollout     /api/health brand   the live image is the one just pushed
#                     /api/health ok      the CONTAINER can reach its deps
#                     npm run smoke       sign in → every authenticated route
#                                         renders → credit history → upload
#                                         round trip, as a real user
#
# A failed post-deploy gate prints ready-to-paste rollback commands for that
# brand, using the ECR digest captured BEFORE the push.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=178269041738
REGION=eu-central-1
REPO=my-pix-ai
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

set -a; [ -f .env.local ] && . ./.env.local; set +a
SB_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SB_ANON="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"

# ── gate 0: platform preflight, before a single byte is built ────────────────
echo "══ preflight (platform dependencies)"
if ! npm run preflight; then
  if [ "${DEPLOY_ACK_PREFLIGHT:-}" = "1" ]; then
    echo "!! preflight FAILED — continuing because DEPLOY_ACK_PREFLIGHT=1" >&2
  else
    cat >&2 <<'MSG'

!! PREFLIGHT FAILED — nothing was built or deployed.
   The platform is missing something the code depends on (see the failures above);
   shipping now would put a broken build in front of users.

   If you are deploying the fix FOR these findings, re-run with:
       DEPLOY_ACK_PREFLIGHT=1 scripts/deploy.sh
MSG
    exit 1
  fi
fi

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR"

service_arn() {
  aws apprunner list-services --region "$REGION" \
    --query "ServiceSummaryList[?ServiceName=='$1'].ServiceArn | [0]" --output text
}

image_digest() {
  aws ecr describe-images --region "$REGION" --repository-name "$REPO" \
    --image-ids imageTag="$1" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
}

want() {
  local k=$1; shift
  [ $# -eq 0 ] && return 0
  for w in "$@"; do [ "$w" = "$k" ] && return 0; done
  return 1
}

# Loud, actionable failure. $1 service, $2 arn, $3 ecr tag, $4 digest deployed
# before this rollout ("None" when the tag was new), $5 what broke.
fail_rollout() {
  local svc=$1 arn=$2 tag=$3 prev=$4 why=$5
  {
    echo
    echo "╔══════════════════════════════════════════════════════════════════════"
    echo "║ ROLLOUT FAILED VERIFICATION — $svc"
    echo "║ $why"
    echo "╠══════════════════════════════════════════════════════════════════════"
    if [ -n "$prev" ] && [ "$prev" != "None" ]; then
      echo "║ ROLL BACK to the image that was live before this deploy:"
      echo "║   docker pull $ECR/$REPO@$prev"
      echo "║   docker tag $ECR/$REPO@$prev $ECR/$REPO:$tag"
      echo "║   docker push $ECR/$REPO:$tag"
      echo "║   aws apprunner start-deployment --region $REGION --service-arn $arn"
      echo "║   aws apprunner describe-service --region $REGION --service-arn $arn \\"
      echo "║     --query 'Service.Status' --output text   # wait for RUNNING"
    else
      echo "║ No previous image digest was recorded for tag '$tag' — there is nothing"
      echo "║ to roll back to. Fix forward, or pause the service:"
      echo "║   aws apprunner pause-service --region $REGION --service-arn $arn"
    fi
    echo "║ Then re-run the gates on their own:"
    echo "║   curl -s <url>/api/health | jq"
    echo "║   VERIFY_TARGET=<url> NEXT_PUBLIC_BRAND_KEY=<brand> npm run smoke"
    echo "╚══════════════════════════════════════════════════════════════════════"
    echo
  } >&2
  exit 1
}

DEPLOYED=()
for f in deploy/brands/*.env; do
  key=$(basename "$f" .env)
  want "$key" "$@" || { echo "── skipping $key"; continue; }
  BRAND_KEY= ECR_TAG= SERVICE_NAME= APP_URL= AUTO_DEPLOY=true BRAND_NAME= VERIFY_USER_EMAIL=
  # shellcheck disable=SC1090
  . "$f"
  IMG="$ECR/$REPO:$ECR_TAG"
  # Recorded BEFORE the push: the tag is mutable, so this digest is the only
  # handle on "what was live a minute ago".
  PREV_DIGEST=$(image_digest "$ECR_TAG")
  echo "══ building $BRAND_KEY → $IMG (previous digest: ${PREV_DIGEST:-none})"
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --build-arg NEXT_PUBLIC_SUPABASE_URL="$SB_URL" \
    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$SB_ANON" \
    --build-arg NEXT_PUBLIC_BRAND_KEY="$BRAND_KEY" \
    --build-arg NEXT_PUBLIC_APP_URL="$APP_URL" \
    -t "$IMG" --push .
  if [ "$AUTO_DEPLOY" != "true" ]; then
    aws apprunner start-deployment --region "$REGION" --service-arn "$(service_arn "$SERVICE_NAME")" >/dev/null
    echo "   start-deployment issued for $SERVICE_NAME (auto-deploy off)"
  fi
  DEPLOYED+=("$SERVICE_NAME|$APP_URL|${BRAND_NAME:-}|$ECR_TAG|$PREV_DIGEST|$BRAND_KEY|${VERIFY_USER_EMAIL:-}")
done

echo "══ waiting for rollouts"
for entry in "${DEPLOYED[@]}"; do
  IFS='|' read -r svc url bname tag prev bkey vuser <<< "$entry"
  arn=$(service_arn "$svc")
  n=0
  while [ "$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.Status' --output text)" = "RUNNING" ] && [ $n -lt 12 ]; do
    sleep 15; n=$((n+1))
  done
  until [ "$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.Status' --output text)" != "OPERATION_IN_PROGRESS" ]; do
    sleep 20
  done
  status=$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.Status' --output text)
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  echo "   $svc: $status · reachable $code · $url"
  [ "$status" = "RUNNING" ] || fail_rollout "$svc" "$arn" "$tag" "$prev" "App Runner status is $status, not RUNNING"

  # ── gate 1: is the served content the image we just pushed? ────────────────
  # Auto-deploy can race a just-pushed tag and roll out the previous digest
  # (seen 2026-07-04 on glowshot). Served content can also LAG the SUCCEEDED
  # operation by a minute or two while App Runner shifts traffic, so poll.
  #
  # Ask /api/health, which reports the brand the RUNNING CONTAINER was built
  # with, as JSON. That is a far better identity signal than grepping the
  # landing page for the brand NAME: the name travels through copy and markup
  # that change for reasons unrelated to which image is live, and the HTML check
  # produced two false "STILL failing brand check" alarms on the sibling product
  # (2026-07-05, 2026-08-19), each provoking a pointless second rollout.
  # Falls back to the HTML check when the live image predates /api/health.
  brand_live() {
    local body; body=$(curl -s --max-time 15 "$url/api/health" || true)
    case "$body" in
      *"\"brand\":\"$bkey\""*) return 0 ;;
      *) ;;
    esac
    [ -n "$bname" ] && curl -sL --max-time 15 "$url" | grep -q "$bname"
  }

  ok=""
  # ~5 min. App Runner reports the operation SUCCEEDED before it has finished
  # shifting traffic, so this window has to outlast the shift, not the deploy.
  for _ in $(seq 1 15); do
    if brand_live; then ok=1; break; fi
    sleep 20
  done
  if [ -z "$ok" ]; then
    echo "   $svc: not serving brand '$bkey' yet — forcing start-deployment (stale-digest race)"
    aws apprunner start-deployment --region "$REGION" --service-arn "$arn" >/dev/null
    until [ "$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.Status' --output text)" != "OPERATION_IN_PROGRESS" ]; do
      sleep 20
    done
    for _ in $(seq 1 20); do
      if brand_live; then ok=1; break; fi
      sleep 30
    done
    [ -n "$ok" ] && echo "   $svc: brand check OK after redeploy"
  fi
  [ -n "$ok" ] || fail_rollout "$svc" "$arn" "$tag" "$prev" \
    "the running container never reported brand '$bkey' — the live image is not the one just built"

  # ── gate 2: the container's own view of its dependencies ──────────────────
  health=""
  body=""
  for _ in 1 2 3 4 5 6; do
    body=$(curl -s --max-time 20 "$url/api/health" || true)
    if printf '%s' "$body" | grep -q '"ok":true'; then health=1; break; fi
    sleep 10
  done
  if [ -z "$health" ]; then
    echo "   $svc: /api/health said:" >&2
    printf '%s\n' "${body:-<no response>}" >&2
    fail_rollout "$svc" "$arn" "$tag" "$prev" \
      "the running container reports it cannot reach its dependencies (/api/health ok=false)"
  fi
  echo "   $svc: health OK"

  # ── gate 3: the journeys a user actually performs ─────────────────────────
  echo "   $svc: running authenticated smoke against $url"
  # The smoke user MUST belong to THIS brand's entity. core.bind_entity binds an
  # account on first wallet touch and every wallet RPC then raises
  # ENTITY_MISMATCH across the line, so a mypix account run against glowshot
  # fails the balance step with no numeric balance — which looks exactly like a
  # product bug and is not one. VERIFY_USER_EMAIL comes from the brand's own
  # deploy/brands/<brand>.env; verify/src/config.ts also maps brand → account so
  # an omitted variable still picks the right one.
  if ! VERIFY_TARGET="$url" VERIFY_USER_EMAIL="$vuser" NEXT_PUBLIC_BRAND_KEY="$bkey" npm run smoke; then
    fail_rollout "$svc" "$arn" "$tag" "$prev" \
      "a critical user journey failed against the new deployment (see the failing step above)"
  fi
  echo "   $svc: ✅ verified — health + critical journeys pass"
done

echo "══ all brands deployed and verified"
