// What the verifier refuses, which is the half of the login that cannot be
// tested against the real service from here — and, as it happens, the half
// `tools/mock_oidc.py` cannot test either: it hardcodes `acr: "strong"` and
// never checks a `code_verifier`, so every assertion below is signed locally.
//
// Runs against the BUILT dist, like every test here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
} from "jose";
import { createVerifier } from "../dist/auth/verify.js";

const ISSUER = "https://tic-auth.ort.edu.ar";
const AUDIENCE = "tic-campus";

const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const jwk = await exportJWK(publicKey);
jwk.kid = "test-1";
jwk.alg = "RS256";
jwk.use = "sig";
const keySource = createLocalJWKSet({ keys: [jwk] });

const verify = createVerifier({
  issuer: ISSUER,
  audience: AUDIENCE,
  keySource,
});

/** A token tic-auth would mint, with whatever this test wants to change. */
function sign(claims = {}, { issuer = ISSUER, audience = AUDIENCE } = {}) {
  return new SignJWT({ acr: "strong", roles: ["student"], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("49928297")
    .setIssuedAt()
    .setExpirationTime("900s")
    .sign(privateKey);
}

test("a real token verifies and keeps its claims", async () => {
  const claims = await verify(
    await sign({ email: "alumno@est.ort.edu.ar", given_name: "Ana" }),
  );
  assert.equal(claims.sub, "49928297");
  assert.equal(claims.email, "alumno@est.ort.edu.ar");
  assert.deepEqual(claims.roles, ["student"]);
});

// The deprecated campus relay mints this, and it must never open an app that was
// not written for it. Two values and deliberately not a ladder, so the check is
// an equality and never a comparison.
test("acr=campus is refused, and so is a token with no acr at all", async () => {
  const relayed = await sign({ acr: "campus" });
  await assert.rejects(() => verify(relayed), /acr/);
  const silent = await sign({ acr: undefined });
  await assert.rejects(() => verify(silent), /acr/);
});

test("alg:none is refused", async () => {
  const unsecured = new UnsecuredJWT({
    acr: "strong",
    sub: "1",
    iss: ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  }).encode();
  await assert.rejects(() => verify(unsecured));
});

// The other half of the same defence: HS256 asks the verifier to treat the RSA
// public key — published at a URL, to everybody — as an HMAC secret.
test("an HS256 token signed with the published key is refused", async () => {
  const secret = new TextEncoder().encode(JSON.stringify(jwk));
  const token = await new SignJWT({ acr: "strong" })
    .setProtectedHeader({ alg: "HS256", kid: "test-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("1")
    .setIssuedAt()
    .setExpirationTime("900s")
    .sign(secret);
  await assert.rejects(() => verify(token));
});

test("a token for another audience, or another issuer, is refused", async () => {
  const forMev = await sign({}, { audience: "mev" });
  await assert.rejects(() => verify(forMev));
  const forged = await sign({}, { issuer: "https://evil.test" });
  await assert.rejects(() => verify(forged));
});

test("an expired token is refused, and 60s of skew is not", async () => {
  const stale = await new SignJWT({ acr: "strong" })
    .setProtectedHeader({ alg: "RS256", kid: "test-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("1")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
    .sign(privateKey);
  await assert.rejects(() => verify(stale));

  // Lab machines are frozen images whose clocks are set by whatever they last
  // synced with, so this one has to pass.
  const skewed = await new SignJWT({ acr: "strong" })
    .setProtectedHeader({ alg: "RS256", kid: "test-1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("1")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 30)
    .sign(privateKey);
  assert.equal((await verify(skewed)).sub, "1");
});
