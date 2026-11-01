// Simple shared-password admin auth. The password lives in the
// ADMIN_PASSWORD env var (see .env.example); there's no user table because
// this app is meant for a single household/admin on a home server.
// Session state is a signed cookie (cookie-session), so no server-side
// session store is needed either.

const crypto = require('crypto');

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid leaking length via
    // timing, then return false.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD || 'changeme';
  return timingSafeEqual(candidate || '', expected);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { checkPassword, requireAdmin };
