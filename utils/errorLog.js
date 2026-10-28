// The admin-visible error log (model ErrorLog, Audit Log → Errors).
//
// Call logError() wherever something fails that nobody is looking at — a
// webhook, a delivery Meta refused, a flow run, a background job, a 500. It
// never throws and never waits on the caller's path: logging must not be able
// to break the thing that failed a second time.
//
// The same problem repeating is grouped: while an entry is unresolved and was
// last seen within GROUP_WINDOW_MS, a new occurrence bumps its count instead of
// adding a row. The fingerprint is source + code + the message with numbers
// taken out, so "recipient 812 failed" and "recipient 813 failed" are one entry.

const prisma = require("../config/prisma");
const safeError = require("./safeError");

const GROUP_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGE = 500;

// Phone numbers never sit in the log in full; the last four digits are enough
// to tell entries apart (same rule as the audit log's maskPhone).
// Digits and spaces only, so dates (2026-10-27) and times stay readable.
const PHONE_RE = /\+?\d[\d ]{8,16}\d/g;
const maskPhones = (s) => s.replace(PHONE_RE, (m) => `…${m.replace(/\D/g, "").slice(-4)}`);

// Details are stored as JSON: strings masked, long ones cut, and the depth
// bounded so a huge payload can't bloat the table.
function clean(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return maskPhones(value).slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      // Never a credential, whatever an error object happened to carry.
      if (/token|authorization|secret|password|cookie/i.test(k)) continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

const fingerprintOf = (source, code, message) =>
  `${source}|${code || ""}|${message.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200)}`;

/**
 * @param {object} e
 * @param {string} e.source   webhook | delivery | send | flow | campaign | api | job | templates | number | system
 * @param {string} e.message  one line, written for an admin
 * @param {string|number} [e.code]  Meta's error code or ours
 * @param {Error} [e.error]   the caught error — its message, code, stack and Meta's answer are kept (never its request/config)
 * @param {object} [e.details] anything else worth seeing (ids, the Meta error body…)
 * @param {number} [e.conversationId] @param {number} [e.campaignId] @param {number} [e.flowRunId] @param {number} [e.numberId]
 */
function logError({ source, message, code, error, details, conversationId, campaignId, flowRunId, numberId }) {
  const msg = maskPhones(String(message || error?.message || "Unknown error")).slice(0, MAX_MESSAGE);
  const codeStr = code === undefined || code === null || code === "" ? null : String(code).slice(0, 60);
  const data = clean({ ...(details || {}), ...(error ? { error: safeError(error) } : {}) });
  const links = {
    conversationId: Number.isInteger(conversationId) ? conversationId : null,
    campaignId: Number.isInteger(campaignId) ? campaignId : null,
    flowRunId: Number.isInteger(flowRunId) ? flowRunId : null,
    whatsappNumberId: Number.isInteger(numberId) ? numberId : null,
  };
  const fingerprint = fingerprintOf(source, codeStr, msg);

  return (async () => {
    const now = new Date();
    const open = await prisma.errorLog.findFirst({
      where: { fingerprint, resolvedAt: null, lastSeenAt: { gte: new Date(now.getTime() - GROUP_WINDOW_MS) } },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true },
    });
    if (open) {
      // The latest occurrence's details and links, so the newest example is what you open.
      await prisma.errorLog.update({
        where: { id: open.id },
        data: { count: { increment: 1 }, lastSeenAt: now, message: msg, details: data, ...links },
      });
    } else {
      await prisma.errorLog.create({
        data: { source, code: codeStr, message: msg, fingerprint, details: data, ...links },
      });
    }
  })().catch((err) => console.error("Error log write failed:", err.message));
}

// For the many `catch (err) => console.error("[Job] what failed:", err.message)`
// sites: the same console line as before, plus an error-log entry.
function reportError(source, label, err, extra = {}) {
  const why = err?.response?.data?.error?.message || err?.message || String(err);
  console.error(`${label}:`, why);
  logError({ source, message: `${label.replace(/^\[[^\]]+\]\s*/, "")}: ${why}`, error: err, ...extra });
}

// Housekeeping: resolved entries go after 30 days, everything after 90.
async function pruneErrorLog() {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const { count } = await prisma.errorLog.deleteMany({
    where: {
      OR: [
        { resolvedAt: { lt: new Date(now - 30 * day) } },
        { lastSeenAt: { lt: new Date(now - 90 * day) } },
      ],
    },
  });
  return count;
}

module.exports = { logError, reportError, pruneErrorLog };
