# ══════════════════════════════════════════════════════════════════════════════
#  Dockerfile — JeCréeMaBoutique / Next.js OG Backend
#  Build multi-stage : deps → builder → runner
#  Image finale ~200MB grâce à output:'standalone' dans next.config.mjs
#
#  Build :  docker build -t jecreemaboutique-og .
#  Run   :  docker run -p 4000:4000 --env-file .env.local jecreemaboutique-og
# ══════════════════════════════════════════════════════════════════════════════

# ── Stage 1 : installation des dépendances ───────────────────────────────────
FROM node:20-alpine AS deps

# libc6-compat requis pour certains modules natifs (sharp, bcrypt…)
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copier uniquement les fichiers de lock pour profiter du cache Docker
COPY package.json package-lock.json* ./

# Installation en mode production pour réduire la taille
RUN npm ci

# ── Stage 2 : build Next.js ──────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Désactiver la télémétrie Next.js
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Variables d'environnement minimales pour le build
# (les vraies valeurs sont injectées au runtime via --env-file)
ARG NEXT_PUBLIC_BASE_URL=https://easyorder-backend-wnku.onrender.com
ARG FRONTEND_URL=https://www.jecreemaboutique.com

ENV NEXT_PUBLIC_BASE_URL=${NEXT_PUBLIC_BASE_URL}
ENV FRONTEND_URL=${FRONTEND_URL}

RUN npm run build

# ── Stage 3 : image de production (standalone) ───────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=4000

# Utilisateur non-root pour la sécurité
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Copier uniquement ce qui est nécessaire au runtime
# output:'standalone' crée un .next/standalone avec toutes les deps bundlées
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone    ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static        ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public              ./public

USER nextjs

EXPOSE 4000

# Healthcheck intégré (endpoint /api/health créé dans ce projet)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "server.js"]
