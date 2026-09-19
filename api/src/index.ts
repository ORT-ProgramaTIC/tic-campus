import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";

const config = loadConfig();
const pool = createPool(config);

/**
 * Can this process reach the database as `campus_svc`, and does the directory
 * contract answer?
 *
 * `directory.subject` rather than `select 1`: the connection proves the
 * password, and only a read of a view proves the grants — USAGE on the schema
 * plus SELECT on the view, which are granted separately and forgotten
 * separately (tic-auth `0005`). It deliberately does NOT touch `public.*`:
 * campus holds `REFERENCES` there and no SELECT at all, so a read would fail,
 * correctly.
 */
async function readiness(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from directory.subject",
    );
    return { ok: true, detail: `directory.subject: ${rows[0]?.n ?? "0"}` };
  } catch (cause) {
    return {
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const server = createServer((req, res) => {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // Liveness, and deliberately database-free: the healthcheck restarts this
  // container, and restarting it does not fix a database that is down.
  if (req.url === "/api/health") return json(200, { status: "ok" });
  if (req.url === "/api/readyz") {
    void readiness().then(({ ok, detail }) =>
      json(ok ? 200 : 503, { status: ok ? "ok" : "error", db: detail }),
    );
    return;
  }
  res.writeHead(404).end();
});

server.listen(config.port, () =>
  console.log(`tic-campus-api on :${config.port}`),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
