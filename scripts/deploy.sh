#!/usr/bin/env bash
# Deploy EVERY brand of MyPix AI (product `mypix`) to AWS App Runner.
#
# Brands share one codebase and one feature set — a deploy rolls out ALL brand
# deployments listed in deploy/brands/*.env so they never drift. Each brand file
# sets BRAND_KEY / ECR_TAG / SERVICE_NAME / APP_URL / AUTO_DEPLOY; the brand's
# copy + packs + colors live in the lib/brand.ts registry. To restrict to
# specific brands (emergency only — drifting brands violates the sync rule),
# pass their keys: `scripts/deploy.sh glowshot`.
#
# Builds linux/amd64 (App Runner is x86_64; arm64 images fail the health check
# with no logs). Secrets stay runtime-only on the services, never in the image.
# Mirrors the other 3 product repos' scripts/deploy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=178269041738
REGION=eu-central-1
REPO=my-pix-ai
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

set -a; [ -f .env.local ] && . ./.env.local; set +a
SB_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SB_ANON="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR"

service_arn() {
  aws apprunner list-services --region "$REGION" \
    --query "ServiceSummaryList[?ServiceName=='$1'].ServiceArn | [0]" --output text
}

want() {
  local k=$1; shift
  [ $# -eq 0 ] && return 0
  for w in "$@"; do [ "$w" = "$k" ] && return 0; done
  return 1
}

DEPLOYED=()
for f in deploy/brands/*.env; do
  key=$(basename "$f" .env)
  want "$key" "$@" || { echo "── skipping $key"; continue; }
  BRAND_KEY= ECR_TAG= SERVICE_NAME= APP_URL= AUTO_DEPLOY=true
  # shellcheck disable=SC1090
  . "$f"
  IMG="$ECR/$REPO:$ECR_TAG"
  echo "══ building $BRAND_KEY → $IMG"
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
  DEPLOYED+=("$SERVICE_NAME|$APP_URL|${BRAND_NAME:-}")
done

echo "══ waiting for rollouts"
for entry in "${DEPLOYED[@]}"; do
  IFS='|' read -r svc url bname <<< "$entry"
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
  echo "   $svc: $status · smoke $code · $url"
  # Auto-deploy can race a just-pushed tag and roll out the previous digest
  # (seen 2026-07-04 on glowshot). Served content can also LAG the SUCCEEDED
  # operation by a minute or two while App Runner shifts traffic (two false
  # "STILL failing" alarms on aioc-web, 2026-07-05), so poll the page — before
  # and after the one forced redeploy — instead of checking once.
  if [ -n "$bname" ]; then
    ok=""
    for _ in 1 2 3 4 5 6; do
      if curl -s "$url" | grep -q "$bname"; then ok=1; break; fi
      sleep 20
    done
    if [ -z "$ok" ]; then
      echo "   $svc: page does not mention '$bname' — forcing start-deployment (stale-digest race)"
      aws apprunner start-deployment --region "$REGION" --service-arn "$arn" >/dev/null
      until [ "$(aws apprunner describe-service --region "$REGION" --service-arn "$arn" --query 'Service.Status' --output text)" != "OPERATION_IN_PROGRESS" ]; do
        sleep 20
      done
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        if curl -s "$url" | grep -q "$bname"; then ok=1; break; fi
        sleep 30
      done
      if [ -n "$ok" ]; then
        echo "   $svc: brand check OK after redeploy"
      else
        echo "   $svc: STILL failing brand check — investigate the image build" >&2
        exit 1
      fi
    fi
  fi
done
