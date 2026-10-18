const AppError = require("../utils/AppError");

// CSRF guard for the cookie-authenticated API. Every state-changing request
// must carry `X-Requested-With: XMLHttpRequest`. A custom header can't be sent
// cross-site without a CORS preflight, and CORS only allows FRONTEND_URL — so
// a form post or fetch from another site, which would otherwise ride the
// browser's auth cookie, is rejected here. lib/api.ts adds it to every call.
//
// Webhooks (Meta) are exempt: they carry no cookie and are gated by their
// HMAC signature instead. Safe methods are exempt because they change nothing.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const csrfGuard = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.path.startsWith("/webhooks/")) return next();
  if (req.get("X-Requested-With") === "XMLHttpRequest") return next();
  next(new AppError("Request blocked (missing CSRF header)", 403, "CSRF"));
};

module.exports = csrfGuard;
