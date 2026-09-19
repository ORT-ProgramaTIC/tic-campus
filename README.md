# tic-campus

`api/` (TypeScript, Node) and `web/` (TypeScript), one pnpm workspace.

```sh
pnpm install
pnpm build          # both
pnpm typecheck
pnpm format         # prettier
```

## Deploy

On the VM, as root, from `/opt/tic-campus` — see `../DEPLOY-CONVENTIONS.md`:

```sh
make deploy
```

`tic-campus-web` (nginx) serves the frontend at `/` and proxies `/api/` to
`tic-campus-api`. tic-proxy reaches it over `tic-campus-edge`.
