# Backend image (NestJS API). Build context: the repository root.   docker build -t support-ai-api .
FROM node:24-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable
# Manifests first, so the dependency layer is cached until a dependency changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter api...
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @support-ai/contracts build && pnpm --filter api build
# Drop dev dependencies in place; workspace links (contracts + its dist) stay valid.
RUN CI=true pnpm install --frozen-lockfile --prod --filter api...

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production PORT=4000 KNOWLEDGE_BASE_DIR=/app/knowledge-base
WORKDIR /app/apps/api
COPY --from=builder --chown=node:node /repo/node_modules /app/node_modules
COPY --from=builder --chown=node:node /repo/packages /app/packages
COPY --from=builder --chown=node:node /repo/apps/api /app/apps/api
COPY --chown=node:node knowledge-base /app/knowledge-base
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are a controlled deploy step (see docs/deployment.md), not something every instance runs on boot.
CMD ["node", "--enable-source-maps", "dist/main.js"]
