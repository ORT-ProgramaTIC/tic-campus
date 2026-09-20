// The renewer's three outcomes, and the single-flight.
//
// The hardest requirement in this slice is that two concurrent requests on one
// stale session make ONE `/token` call: tic-auth rotates on every use and
// answers a replay by revoking the whole family, so getting this wrong signs
// somebody out at random, under load, and never in a test. This is that test.
//
// A fake store and a fake token client, because none of what is being asserted
// is about Postgres or about HTTP.
import assert from "node:assert/strict";
import test from "node:test";
import { createRenewer } from "../dist/auth/refresh.js";
import { TokenEndpointError } from "../dist/auth/token-client.js";

const CONFIG = {
  claimsMaxAgeSeconds: 840,
  refreshRetrySeconds: 60,
};

const CLAIMS = {
  roles: ["student"],
  email: "alumno@est.ort.edu.ar",
  name: "Ana Pérez",
  givenName: "Ana",
  familyName: "Pérez",
  acr: "strong",
  amr: ["google"],
};

/** A session whose claims went stale a minute ago. */
function stale(overrides = {}) {
  const now = Date.now();
  return {
    userId: 49928297,
    claims: CLAIMS,
    refreshToken: "refresh-1",
    claimsAt: now - 900_000,
    expiresAt: now + 3_600_000,
    csrf: "csrf-1",
    ...overrides,
  };
}

function fakeStore() {
  const calls = { write: 0, destroy: 0 };
  return {
    calls,
    written: null,
    async write(_id, record) {
      calls.write += 1;
      this.written = record;
    },
    async destroy() {
      calls.destroy += 1;
    },
  };
}

function fakeTokens(answer) {
  const calls = { refresh: 0 };
  return {
    calls,
    async refresh() {
      calls.refresh += 1;
      return answer();
    },
  };
}

const verifies = async () => ({
  sub: "49928297",
  acr: "strong",
  roles: ["student"],
});

test("two concurrent requests on one stale session make ONE /token call", async () => {
  const store = fakeStore();
  let resolve;
  const held = new Promise((r) => {
    resolve = r;
  });
  const tokens = fakeTokens(async () => {
    await held;
    return {
      accessToken: "new-access",
      refreshToken: "refresh-2",
      refreshExpiresIn: 43_140,
    };
  });
  const renewer = createRenewer({
    config: CONFIG,
    store,
    tokens,
    verify: verifies,
  });

  const session = stale();
  const first = renewer.ensureFresh("id-1", session);
  const second = renewer.ensureFresh("id-1", session);
  resolve();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(
    tokens.calls.refresh,
    1,
    "un solo canje, o tic-auth revoca la familia",
  );
  assert.equal(a.refreshToken, "refresh-2");
  // Both adopt the winner's answer rather than one of them presenting a token
  // that no longer exists.
  assert.equal(b.refreshToken, "refresh-2");
  assert.equal(store.calls.destroy, 0);
});

test("fresh claims are not renewed at all", async () => {
  const tokens = fakeTokens(async () => assert.fail("no debería renovar"));
  const renewer = createRenewer({
    config: CONFIG,
    store: fakeStore(),
    tokens,
    verify: verifies,
  });
  const session = stale({ claimsAt: Date.now() - 1000 });
  assert.equal(await renewer.ensureFresh("id-1", session), session);
  assert.equal(tokens.calls.refresh, 0);
});

// An outage is not a revocation. Getting this backwards signs the whole school
// out whenever tic-auth restarts.
test("a 5xx keeps the session and records a backoff", async () => {
  const store = fakeStore();
  const tokens = fakeTokens(async () => {
    throw new TokenEndpointError("tic-auth contestó 502", true);
  });
  const renewer = createRenewer({
    config: CONFIG,
    store,
    tokens,
    verify: verifies,
  });

  const kept = await renewer.ensureFresh("id-1", stale());
  assert.ok(kept, "la sesión sobrevive a una caída de tic-auth");
  assert.ok(kept.retryAfter > Date.now(), "y no se reintenta en el acto");
  assert.equal(store.calls.destroy, 0);

  // The backoff is honoured: the next request does not try again.
  await renewer.ensureFresh("id-1", kept);
  assert.equal(tokens.calls.refresh, 1);
});

test("a replayed refresh token ends the session, and does not throw", async () => {
  const store = fakeStore();
  const tokens = fakeTokens(async () => {
    // What tic-auth answers a consumed token with: one fixed 400, every cause
    // spelled identically.
    throw new TokenEndpointError("tic-auth rechazó el pedido (400)");
  });
  const renewer = createRenewer({
    config: CONFIG,
    store,
    tokens,
    verify: verifies,
  });

  assert.equal(await renewer.ensureFresh("id-1", stale()), null);
  assert.equal(store.calls.destroy, 1);
});

test("a renewed token this build will not verify ends the session", async () => {
  const store = fakeStore();
  const tokens = fakeTokens(async () => ({
    accessToken: "acr-campus",
    refreshToken: "refresh-2",
    refreshExpiresIn: null,
  }));
  const renewer = createRenewer({
    config: CONFIG,
    store,
    tokens,
    verify: async () => {
      throw new Error("acr=campus");
    },
  });

  assert.equal(await renewer.ensureFresh("id-1", stale()), null);
  assert.equal(store.calls.destroy, 1);
});

test("the hard cap ends a session an outage cannot extend", async () => {
  const store = fakeStore();
  const tokens = fakeTokens(async () => assert.fail("no debería renovar"));
  const renewer = createRenewer({
    config: CONFIG,
    store,
    tokens,
    verify: verifies,
  });

  const expired = stale({ expiresAt: Date.now() - 1 });
  assert.equal(await renewer.ensureFresh("id-1", expired), null);
  assert.equal(store.calls.destroy, 1);
});

test("the expiry only ever tightens", async () => {
  const store = fakeStore();
  const tokens = fakeTokens(async () => ({
    accessToken: "new-access",
    refreshToken: "refresh-2",
    // tic-auth saying the grant now outlives our own cap must not extend it.
    refreshExpiresIn: 86_400,
  }));
  const renewer = createRenewer({
    config: CONFIG,
    store,
    tokens,
    verify: verifies,
  });

  const session = stale();
  const renewed = await renewer.ensureFresh("id-1", session);
  assert.equal(renewed.expiresAt, session.expiresAt);
  // And the csrf token survives, so open tabs keep working.
  assert.equal(renewed.csrf, "csrf-1");
});
