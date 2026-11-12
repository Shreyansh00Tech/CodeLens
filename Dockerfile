# One image: builds the React frontend, then runs the Express API which also serves it.
FROM node:20

# git is required: the API clones the GitHub repositories it analyzes
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Public (build-time) frontend settings; Render passes env vars as build args
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

COPY frontend/package*.json frontend/
RUN cd frontend && npm ci

COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev

COPY frontend frontend
RUN cd frontend && npm run build

COPY backend backend

ENV NODE_ENV=production
WORKDIR /app/backend
EXPOSE 8080
CMD ["node", "server.js"]
