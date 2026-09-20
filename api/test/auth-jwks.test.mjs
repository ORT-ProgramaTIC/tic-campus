// The `Host` header, which is the single most load-bearing operational fact in
// this repository and the one that fails SILENTLY when it is wrong.
//
// These two tests are what stands between `undici.request` and somebody
// replacing it with global `fetch`, which drops the header and leaves nginx's
// default server answering 200 with a body that is not a key set.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import {
  assertKeySetUsable,
  createRemoteKeySource,
} from "../dist/auth/jwks.js";

const { publicKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = await exportJWK(publicKey);
jwk.kid = "test-1";
jwk.alg = "RS256";
jwk.use = "sig";

/** A stand-in for tic-proxy: it records the `Host` it was given, and answers as
 *  tic-auth only when that header says so — which is precisely how the real one
 *  behaves, and why omitting it is not an error. */
async function proxy(body) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.host);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("the probe sends the Host header, which global fetch would drop", async () => {
  const stub = await proxy({ keys: [jwk] });
  try {
    const { kids } = await assertKeySetUsable({
      url: stub.url,
      hostHeader: "tic-auth.ort.edu.ar",
    });
    assert.deepEqual(kids, ["test-1"]);
    assert.deepEqual(stub.seen, ["tic-auth.ort.edu.ar"]);
  } finally {
    await stub.close();
  }
});

test("jose's key source sends it too, not only the probe", async () => {
  const stub = await proxy({ keys: [jwk] });
  try {
    const keySource = createRemoteKeySource({
      url: stub.url,
      hostHeader: "tic-auth.ort.edu.ar",
    });
    // Any call that makes jose fetch the set will do; the fetch is the subject,
    // not whatever it then decides about this header.
    await keySource({ alg: "RS256", kid: "test-1" }, {}).catch(() => {});
    assert.deepEqual(stub.seen, ["tic-auth.ort.edu.ar"]);
  } finally {
    await stub.close();
  }
});

// The whole reason the check asserts a `kid` and never a status.
test("a 200 that is not a key set is a failure, and the message says why", async () => {
  const stub = await proxy({ hello: "soy el server por defecto de nginx" });
  try {
    await assert.rejects(
      () =>
        assertKeySetUsable({
          url: stub.url,
          hostHeader: "tic-auth.ort.edu.ar",
        }),
      /Host/,
    );
  } finally {
    await stub.close();
  }
});
