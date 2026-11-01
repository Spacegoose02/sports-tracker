// Single sign-on through any OpenID Connect provider. Built for Tinyauth
// (which is an OpenID Certified provider since v5), but Authentik, Authelia,
// Pocket ID, Keycloak and the rest work the same way.
//
// Standard authorization-code flow with PKCE:
//   1. /auth/sso/login sends the browser to the provider's authorize URL
//      with a random state and a PKCE challenge kept in the signed session.
//   2. The provider sends the browser back to /auth/sso/callback with a code.
//   3. The server swaps the code for an access token (server to server,
//      client_secret_basic) and reads the user from the userinfo endpoint.
//
// Configure with SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET (see
// .env.example). The callback URL to register with the provider is
// <PUBLIC_URL>/auth/sso/callback.

const crypto = require('crypto');
const fetch = require('node-fetch');

function ssoConfig(env = process.env) {
  const issuer = (env.SSO_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = (env.SSO_CLIENT_ID || '').trim();
  const clientSecret = (env.SSO_CLIENT_SECRET || '').trim();
  return {
    enabled: !!(issuer && clientId && clientSecret),
    issuer,
    clientId,
    clientSecret,
    label: (env.SSO_LABEL || 'Tinyauth').trim(),
    scopes: (env.SSO_SCOPES || 'openid profile email').trim(),
  };
}

// Discovery documents rarely change; keep one per issuer for an hour.
const discoveryCache = new Map();
async function discover(issuer, fetchImpl = fetch) {
  const hit = discoveryCache.get(issuer);
  if (hit && hit.expires > Date.now()) return hit.doc;
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { timeout: 10000 });
  if (!res.ok) throw new Error(`SSO discovery failed: ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new Error('SSO discovery document is missing endpoints');
  }
  discoveryCache.set(issuer, { doc, expires: Date.now() + 60 * 60 * 1000 });
  return doc;
}

function randomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Returns { url, pending } where pending goes into the session until the
// callback.
async function startLogin(cfg, redirectUri, fetchImpl) {
  const doc = await discover(cfg.issuer, fetchImpl);
  const pending = { state: randomString(), verifier: randomString(48), nonce: randomString(), redirectUri };
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scopes,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: pkceChallenge(pending.verifier),
    code_challenge_method: 'S256',
  });
  return { url: `${doc.authorization_endpoint}?${params.toString()}`, pending };
}

// Swaps the code for tokens and returns the provider's userinfo claims.
async function finishLogin(cfg, pending, code, fetchImpl = fetch) {
  const doc = await discover(cfg.issuer, fetchImpl);
  const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
  const tokenRes = await fetchImpl(doc.token_endpoint, {
    method: 'POST',
    timeout: 10000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}`, Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }).toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) {
    throw new Error(`SSO token exchange failed: ${tokens.error || tokenRes.status}`);
  }
  const infoRes = await fetchImpl(doc.userinfo_endpoint, {
    timeout: 10000,
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const claims = await infoRes.json().catch(() => ({}));
  if (!infoRes.ok || !claims.sub) throw new Error('SSO userinfo request failed');
  return claims;
}

module.exports = { ssoConfig, discover, startLogin, finishLogin, pkceChallenge, discoveryCache };
