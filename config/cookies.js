// The one set of auth-cookie options, used wherever the cookie is set or
// cleared (login, logout, protect(), a password change re-issuing it).
// clearCookie must be passed the same options the cookie was set with, or the
// browser keeps re-sending a dead token.
//
// COOKIE_SAMESITE=none when the app and the API are on different sites (e.g.
// two *.up.railway.app addresses) — browsers don't send a "lax" cookie across
// sites. Same-site subdomains (crm.… + api.…) keep the safer "lax".
const SAME_SITE = ["lax", "strict", "none"].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : "lax";

const COOKIE_OPTIONS = {
  httpOnly: true,
  // Browsers reject SameSite=None without Secure.
  secure: process.env.NODE_ENV === "production" || SAME_SITE === "none",
  sameSite: SAME_SITE,
  maxAge: 8 * 60 * 60 * 1000, // 8 hours in ms
};

module.exports = { COOKIE_OPTIONS };
