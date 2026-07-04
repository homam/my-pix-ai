# Container build for AWS App Runner (or any Docker host).
# NEXT_PUBLIC_* values are baked in at build time — pass them as build args.

FROM node:22-alpine AS deps
WORKDIR /app
# vendor/ holds a vendored tarball of @aionized/platform-client (a sibling-repo `file:` dep in
# dev, which the Docker build context can't reach — see platform-client/README.md).
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_BRAND_KEY=mypix
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_BRAND_KEY=$NEXT_PUBLIC_BRAND_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
USER node
EXPOSE 8080
# HOSTNAME must be set here, not via ENV: App Runner injects its own HOSTNAME
# (the instance host) at runtime, which would make Next.js bind the wrong
# interface and fail health checks.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 node server.js"]
