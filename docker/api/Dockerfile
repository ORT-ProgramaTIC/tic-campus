# tic-campus-api. Build context is the repo root (one workspace lockfile).
FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@10.27.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile
COPY api api
RUN pnpm --filter tic-campus-api build

FROM node:24-slim
WORKDIR /repo
ENV NODE_ENV=production PORT=3000
RUN npm install -g pnpm@10.27.0
# The runtime stage installs PRODUCTION dependencies and copies `dist/`, and
# nothing else. Copying only `dist/` was enough while the api had no
# dependencies at all; the first one (`pg`) turned that into
# `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'` at boot, which typechecks,
# builds and tests green and dies on the first deploy.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --prod --filter tic-campus-api
COPY --from=build /repo/api/dist api/dist
# WORKDIR /repo/api is what makes api/package.json's "type": "module" reach
# dist/. Without it the same file is read as CommonJS and dies on the first
# `import`.
WORKDIR /repo/api
EXPOSE 3000
CMD ["node", "dist/index.js"]
