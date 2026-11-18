# CodeLens: single-container build (API + built frontend served by the backend).
#   docker build -t codelens .
#   docker run -p 8080:8080 -e ANTHROPIC_API_KEY=... codelens
# Supabase login is optional; pass its public values at build time:
#   docker build --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=... -t codelens .

FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_API_URL=""
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM node:22-bookworm-slim
# git is required to clone the repositories being analyzed
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/ ./
COPY --from=frontend /build/frontend/dist /app/frontend/dist
RUN mkdir -p /data/repo && chown -R node:node /data
ENV NODE_ENV=production \
    PORT=8080 \
    SERVE_FRONTEND=/app/frontend/dist \
    CODELENS_TMP_DIR=/data/repo
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
