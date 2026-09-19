# tic-campus-web: the built frontend on nginx, plus the /api/ proxy.
# Build context is the repo root (one workspace lockfile).
FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@10.27.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile
COPY web web
RUN pnpm --filter tic-campus-web build

FROM nginx:1.27-alpine
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/web/dist /usr/share/nginx/html
EXPOSE 80
