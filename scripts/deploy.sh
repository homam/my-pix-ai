#!/usr/bin/env bash
# Deploy MyPix AI to AWS App Runner (the canonical production deployment).
#
# Builds the linux/amd64 image with production NEXT_PUBLIC_* values baked in,
# pushes to ECR; App Runner auto-deploys on push (~3-5 min rollout).
#
# Requires: docker running, aws CLI with credentials for account 178269041738.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=eu-central-1
ECR=178269041738.dkr.ecr.eu-central-1.amazonaws.com/my-pix-ai
APP_URL=https://wy7kp3ie3e.eu-central-1.awsapprunner.com
SERVICE_ARN=arn:aws:apprunner:eu-central-1:178269041738:service/my-pix-ai/5e1e4dbfbd034093b68a587a30c27366

# Public (build-time) values; secrets stay runtime-only on the service.
NEXT_PUBLIC_SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
NEXT_PUBLIC_SUPABASE_ANON_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)

echo "Building..."
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  --build-arg NEXT_PUBLIC_APP_URL="$APP_URL" \
  -t my-pix-ai:latest .

echo "Pushing to ECR (App Runner auto-deploys on push)..."
aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "${ECR%%/*}"
docker tag my-pix-ai:latest "$ECR:latest"
docker push "$ECR:latest"

echo "Waiting for App Runner rollout..."
# Give the auto-deploy pipeline up to 3 min to start, then wait for it to finish.
n=0
while [ "$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.Status' --output text)" = "RUNNING" ] && [ $n -lt 12 ]; do
  sleep 15; n=$((n+1))
done
until [ "$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.Status' --output text)" != "OPERATION_IN_PROGRESS" ]; do
  sleep 20
done

STATUS=$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.Status' --output text)
echo "Service status: $STATUS"
curl -s -o /dev/null -w "smoke test: %{http_code}\n" "$APP_URL"
