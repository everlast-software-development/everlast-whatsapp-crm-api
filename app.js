const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const helmet = require("helmet");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");
const errorHandler = require("./middleware/errorHandler");
const csrfGuard = require("./middleware/csrf");

const app = express();

// Behind a reverse proxy / tunnel (serveo, nginx, Caddy) that sets X-Forwarded-For.
// Trust exactly ONE proxy hop so express-rate-limit can identify the real client IP.
// Do NOT use `true` (trust all) — clients could spoof X-Forwarded-For to dodge rate limits.
app.set("trust proxy", 1);

// Security headers. CSP is disabled because this process serves a JSON API
// (and Swagger UI, which needs inline assets), not first-party HTML pages.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  // The browser can only READ a response header that is explicitly exposed.
  // The client compares this echo against the number it currently has selected
  // and discards any response that arrives after a switch, so without this the
  // whole stale-response guard silently does nothing.
  exposedHeaders: ["X-WhatsApp-Number-Id"],
  // allowedHeaders is left unset on purpose: the cors package then reflects
  // whatever the preflight asks for, which includes the X-Requested-With CSRF
  // header (middleware/csrf.js) — but only for FRONTEND_URL's origin.
}));
app.use(cookieParser());
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Login brute-force guard, on POST /api/auth/login only (logout and the
// session check are never limited). Keyed by IP + username so one person
// mistyping can't lock out a whole clinic behind one office IP, and only
// failures count — a successful sign-in doesn't use up the allowance.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.username || "").toLowerCase().slice(0, 40)}`,
  message: { success: false, message: "Too many failed sign-in attempts. Please wait 15 minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Looser per-IP cap across all usernames, against password spraying.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: "Too many sign-in attempts from this network. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// No limiter on /api/webhooks: POSTs are gated by Meta's HMAC signature, and
// a burst of statuses after a campaign send would otherwise be dropped (Meta
// retries, but late). The GET verify handshake only answers a correct token.

// Only expose API docs outside production — they describe every endpoint and
// shouldn't be publicly browsable on the live server.
if (process.env.NODE_ENV !== "production") {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: { persistAuthorization: true },
  }));
}

// For the host's health check (Railway): the process is up and serving.
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// CSRF header check on every state-changing /api call except webhooks.
app.use("/api", csrfGuard);

app.post("/api/auth/login", loginIpLimiter, loginLimiter);
app.use("/api/auth", require("./modules/auth/auth.routes"));
app.use("/api/users", require("./modules/users/user.routes"));
app.use("/api/customers", require("./modules/customers/customer.routes"));
app.use("/api/lists", require("./modules/lists/list.routes"));
app.use("/api/segments", require("./modules/segments/segment.routes"));
app.use("/api/conversations", require("./modules/conversations/conversation.routes"));
app.use("/api/messages", require("./modules/messages/message.routes"));
app.use("/api/media", require("./modules/media/media.routes"));
app.use("/api/media-library", require("./modules/media-library/mediaLibrary.routes"));
app.use("/api/webhooks", require("./modules/webhooks/webhook.routes"));
app.use("/api/audit", require("./modules/audit/audit.routes"));
app.use("/api/stats", require("./modules/stats/stats.routes"));
app.use("/api/templates", require("./modules/templates/template.routes"));
app.use("/api/campaigns", require("./modules/campaigns/campaign.routes"));
app.use("/api/whatsapp", require("./modules/whatsapp-status/whatsappStatus.routes"));
app.use("/api/settings", require("./modules/settings/settings.routes"));
app.use("/api/supervision", require("./modules/supervision/supervision.routes"));
app.use("/api/booking-requests", require("./modules/bookingRequests/bookingRequest.routes"));
// Free appointment times in Dok32 (read-only).
app.use("/api/availability", require("./modules/availability/availability.routes"));
// Dev-only tools (message/cost tracker). Never mounted in production.
if (process.env.NODE_ENV !== "production") {
  app.use("/api/dev", require("./modules/dev/dev.routes"));
}

app.use(errorHandler);

module.exports = app;
