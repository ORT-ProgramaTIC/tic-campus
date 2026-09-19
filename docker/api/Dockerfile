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
WORKDIR /app
ENV NODE_ENV=production PORT=3000
# package.json carries "type": "module" for dist/.
COPY api/package.json ./
COPY --from=build /repo/api/dist dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
