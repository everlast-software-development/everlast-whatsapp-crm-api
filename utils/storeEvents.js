// The online store → WhatsApp: messages the store sends first.
//
// The store (everlastwellness.com, Laravel) decides who gets which message and
// when — it checks consent, its budget, per-customer limits and quiet hours —
// and posts each one, every 5 minutes as they fall due, to POST
// /api/webhooks/store (the address staff enter on the store's Admin →
// Marketing → WhatsApp messages page), signed with the shared secret:
//   X-Everlast-Signature: sha256=<hex HMAC-SHA256 of the raw body>
//   { id, to, kind, category, language, text, template: { text, variables }, test? }
// `text` is the finished message; `template.text` is what staff wrote
// ("Hi {first_name}, {treatment} is still waiting…") and `template.variables`
// its values for this customer.
//
// WhatsApp only lets a business write first with a template Meta approved, so
// each kind × language has a website template (Templates → Website), made from
// the text staff wrote. A message is sent only with an approved template made
// from exactly the store's current text: if staff change it, sends fail until
// a template for the new text is approved — never the old words with new values.
//
// The answer: 2xx with { provider_message_id } once WhatsApp took it. Anything
// else and the store tries again (3 tries over 30 minutes), with the same id:
//   - sent already → the same answer again, nothing sent twice;
//   - failed (no template yet, refused…) → tried again;
//   - unconfirmed (WhatsApp didn't answer clearly: it may have arrived) →
//     never sent again.
// Then, when WhatsApp reports how it went, a delivery report goes back to the
// store with what it cost (reportDelivery).
//
// A test from the store's staff page has "test": true and id 0: it's captured
// (Website → What the store sent) and answered, but never reported, and sent
// only when the number is one of the staff test phones (Settings → Campaign
// safety) — never to anyone else.

const crypto = require("crypto");
const axios = require("axios");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const prisma = require("../config/prisma");
const { getSetting, saveSetting } = require("./appSettings");
const numbers = require("./whatsappNumbers");
const { sendWhatsAppMessage } = require("./whatsappClient");
const { buildTemplateSend, isStoreLink } = require("./templateSend");
const { STORE_VARS, STORE_VAR_KEYS, extractOrderedVars } = require("./templateVars");
const { classifySendError } = require("./campaignSendErrors");
const { countryOf, rateFor } = require("./whatsappPricing");
const { emitToNumber } = require("./socket");
const { logError } = require("./errorLog");

// The kinds the store sends (its "The messages" table), with their values.
const STORE_KINDS = {
  abandoned_cart: {
    label: "Abandoned cart",
    category: "marketing",
    vars: ["first_name", "treatment", "count", "link"],
    hint: "A signed-in customer left treatments in the cart and paid nothing since.",
  },
  points_expiring: {
    label: "Points expiring",
    category: "marketing",
    vars: ["first_name", "points", "date", "link"],
    hint: "The customer's oldest points expire soon.",
  },
  rebooking: {
    label: "Rebooking reminder",
    category: "marketing",
    vars: ["first_name", "treatment", "link"],
    hint: "Some days after a completed treatment with a rebooking reminder, unless they booked it again.",
  },
  review_request: {
    label: "Review request",
    category: "marketing",
    vars: ["first_name", "treatment", "link", "spin"],
    hint: "After a completed order the customer hasn't reviewed. Mentions Spin & Win while it's on.",
  },
  offer_announcement: {
    label: "Offer announcement",
    category: "marketing",
    vars: ["first_name", "offer", "ends", "link"],
    hint: "A running flash sale or deal, sent to a customer segment.",
  },
  gift_received: {
    label: "Gift received",
    category: "utility",
    vars: ["first_name", "sender", "link"],
    hint: "Someone bought the customer a gift.",
  },
  subscription_failed: {
    label: "Subscription payment failed",
    category: "utility",
    vars: ["first_name", "treatment", "amount", "link"],
    hint: "A renewal couldn't be charged: pay or change the card.",
  },
};
const KIND_KEYS = Object.keys(STORE_KINDS);
// The store's language codes → the template's language.
const LANGUAGES = { en: "en_US", ar: "ar" };
const LANGUAGE_NAMES = { en: "English", ar: "Arabic" };
const USD_TO_AED = 3.6725;
const REPORT_TRIES = 10;

// ── The connection ─────────────────────────────────────────────────────────

const settings = () => getSetting("storeWebhook");

async function rotateSecret(user) {
  return saveSetting("storeWebhook", { secret: crypto.randomBytes(32).toString("hex") }, user);
}

// The line website messages go out on: the one chosen, else the default.
async function storeNumber() {
  const { numberId } = settings();
  if (numberId) {
    const n = await numbers.getById(numberId).catch(() => null);
    if (n) return n;
  }
  return numbers.getDefault();
}

/** null when the signature is right, else why not (said to the store). */
function verifySignature(rawBody, signatureHeader) {
  const { secret } = settings();
  if (!secret) return "The CRM has no signing secret yet";
  const given = String(signatureHeader || "").replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(given)) return "Missing X-Everlast-Signature (sha256=<hex>)";
  const expected = crypto.createHmac("sha256", secret).update(rawBody || Buffer.alloc(0)).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex")) ? null : "Signature doesn't match the shared signing secret";
}

// ── Reading a message ──────────────────────────────────────────────────────

class StoreInputError extends Error {}

const normalisePhone = (raw) => {
  const p = parsePhoneNumberFromString(String(raw || "").trim(), "AE");
  return p && p.isValid() ? p.number.replace("+", "") : null;
};

// The staff's text as a template body: {first_name} → {{first_name}}.
const toTemplateBody = (text) => String(text || "").replace(/(?<!\{)\{\s*([a-z_]+)\s*\}(?!\})/gi, (_m, k) => `{{${k.toLowerCase()}}}`);
// Two texts are the same message when only spacing differs.
const sameText = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();

function readMessage(body) {
  if (!body || typeof body !== "object") throw new StoreInputError("The body must be JSON");
  const test = body.test === true;
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 0 || (!test && id === 0)) throw new StoreInputError("id must be the message's number (0 only for a test)");
  const kind = String(body.kind || "");
  if (!STORE_KINDS[kind]) throw new StoreInputError(`kind must be one of: ${KIND_KEYS.join(", ")}`);
  const language = String(body.language || "");
  if (!LANGUAGES[language]) throw new StoreInputError('language must be "en" or "ar"');
  const category = String(body.category || STORE_KINDS[kind].category);
  if (!["marketing", "utility"].includes(category)) throw new StoreInputError('category must be "marketing" or "utility"');
  const phone = normalisePhone(body.to);
  if (!phone) throw new StoreInputError("to must be a valid phone number with its country code, e.g. +971501234567");
  const text = String(body.text || "").trim();
  if (!text) throw new StoreInputError("text is required");
  const tpl = body.template && typeof body.template === "object" ? body.template : {};
  const variables = {};
  for (const [k, v] of Object.entries(tpl.variables && typeof tpl.variables === "object" ? tpl.variables : {})) {
    const key = String(k).trim().toLowerCase();
    if (/^[a-z_]{1,40}$/.test(key) && v !== null && v !== undefined && typeof v !== "object") variables[key] = String(v).slice(0, 1000);
  }
  return { storeId: test ? null : id, test, kind, category, language, phone, text, templateText: tpl.text ? String(tpl.text) : null, variables };
}

// ── Templates ──────────────────────────────────────────────────────────────

const configOf = (t) => {
  const c = t.websiteConfig && typeof t.websiteConfig === "object" ? t.websiteConfig : {};
  return { active: c.active !== false, sourceText: typeof c.sourceText === "string" ? c.sourceText : null };
};
const languageOf = (t) => (t.language === "ar" ? "ar" : "en");
const isMarketing = (t) => (t.metaCategory ? t.metaCategory === "MARKETING" : t.category !== "UTILITY" && t.category !== "GENERAL");

// The store values a template uses (body, text header, link buttons).
function storeVarsUsed(t) {
  const texts = [t.body, t.headerType === "TEXT" ? t.header : "", ...(Array.isArray(t.buttons) ? t.buttons.map((b) => b.url || "") : [])];
  return [...new Set(texts.flatMap((x) => extractOrderedVars(x)))];
}

// What's missing or wrong in the store's values for this template — [] when fine.
function valueProblems(t, variables) {
  const problems = [];
  const missing = storeVarsUsed(t).filter((k) => !String(variables[k] ?? "").trim());
  if (missing.length) problems.push(`the store didn't send ${missing.join(", ")}`);
  for (const b of Array.isArray(t.buttons) ? t.buttons : []) {
    if (b.type !== "URL" || !isStoreLink(b.url)) continue;
    const key = b.url.match(/\{\{\s*([a-z_]+)\s*\}\}$/i)[1].toLowerCase();
    const base = b.url.replace(/\{\{\s*[a-z_]+\s*\}\}$/i, "");
    const value = String(variables[key] ?? "").trim();
    if (value && !value.startsWith(base)) problems.push(`${key} must start with ${base} (the "${b.title}" button)`);
  }
  return problems;
}

/**
 * The approved template to send this kind × language × text with, or why there isn't one.
 * @returns { template } | { why }
 */
async function matchTemplate({ kind, language, templateText }) {
  const number = await storeNumber();
  if (!number) return { why: "no WhatsApp line to send from" };
  const all = await prisma.template.findMany({
    where: { isActive: true, websiteEvent: kind, language: LANGUAGES[language], wabaId: number.wabaId },
    orderBy: { id: "desc" },
  });
  const what = `${STORE_KINDS[kind].label} (${LANGUAGE_NAMES[language]})`;
  if (!all.length) return { why: `there's no website template for ${what} yet` };
  const forText = all.filter((t) => sameText(configOf(t).sourceText, templateText));
  if (!forText.length) return { why: `the store's text for ${what} changed — make a template from the new text` };
  const on = forText.filter((t) => configOf(t).active);
  if (!on.length) return { why: `the template for ${what} is switched off` };
  const approved = on.find((t) => t.approvalStatus === "APPROVED" && t.metaTemplateName);
  if (!approved) return { why: `the template for ${what} isn't approved by WhatsApp yet` };
  return { template: approved };
}

// ── Sending ────────────────────────────────────────────────────────────────

/**
 * Send one website template to a phone with these values (the store's
 * messages and the "test to my phone" button both come here).
 * @returns { message, conversationId, whatsappMessageId }
 */
async function sendStoreTemplate({ template, phone, variables }) {
  const number = await storeNumber();
  const credentials = await numbers.getCredentials(number.id);
  const name = variables.first_name || null;

  const customer = await prisma.customer.upsert({ where: { phone }, update: {}, create: { phone, name } });
  if (!customer.name && name) await prisma.customer.update({ where: { id: customer.id }, data: { name } }).catch(() => {});
  const existed = await prisma.conversation.findUnique({
    where: { customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: number.id } },
    select: { id: true },
  });
  const conversation = await prisma.conversation.upsert({
    where: { customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: number.id } },
    update: {},
    create: { customerId: customer.id, whatsappNumberId: number.id, status: "OPEN", unreadCount: 0 },
  });

  // {{first_name}} is the store's first name for them.
  const { resolvedBody, templateContent, sendArgs } = buildTemplateSend(template, { ...customer, name: name || customer.name }, null, { fields: variables });
  let message = await prisma.message.create({
    data: { conversationId: conversation.id, senderType: "AGENT", senderId: null, content: templateContent, messageType: sendArgs.messageType, status: "PENDING" },
  });
  const announce = () => {
    if (!existed) emitToNumber(number.id, "conversation.created", { conversationId: conversation.id });
    emitToNumber(number.id, "message.created", { message, conversationId: conversation.id });
    emitToNumber(number.id, "conversation.updated", { conversationId: conversation.id });
  };

  let whatsappMessageId;
  try {
    ({ whatsappMessageId } = await sendWhatsAppMessage({ number: credentials, to: phone, ...sendArgs }));
  } catch (err) {
    const verdict = classifySendError(err);
    message = await prisma.message.update({ where: { id: message.id }, data: { status: "FAILED" } });
    announce();
    const e = new Error(verdict.reason);
    e.unconfirmed = verdict.kind === "AMBIGUOUS";
    e.messageId = message.id;
    e.conversationId = conversation.id;
    throw e;
  }
  message = await prisma.message.update({ where: { id: message.id }, data: { whatsappMessageId, status: "SENT" } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessage: resolvedBody, lastMessageAt: new Date(), lastSenderType: "AGENT" } });
  announce();
  return { message, conversationId: conversation.id, whatsappMessageId };
}

// Why this customer mustn't get it, or null. The store checks consent itself;
// this is the CRM's own record (they said STOP here), checked again.
async function optedOutHere(phone, category) {
  if (category !== "marketing") return null;
  const number = await storeNumber();
  const customer = await prisma.customer.findUnique({ where: { phone }, select: { id: true, optedOut: true } });
  if (!customer) return null;
  if (customer.optedOut) return "the customer opted out of marketing messages in the CRM";
  const line = await prisma.customerOptOut.findUnique({
    where: { customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: number.id } },
    select: { id: true },
  });
  return line ? "the customer opted out of marketing messages on this line" : null;
}

// ── Receiving ──────────────────────────────────────────────────────────────

// The answer to the store: status + JSON.
const answer = (status, body) => ({ status, body });
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// A message being sent right now, by store id: a retry that arrives meanwhile
// waits for it instead of sending again.
const inFlight = new Map();

/** Handle one message from the store. @returns { status, body } */
async function receiveStoreMessage(body) {
  const m = readMessage(body);
  if (m.test) return receiveTest(m, body);
  if (inFlight.has(m.storeId)) return inFlight.get(m.storeId);
  const run = receiveReal(m, body).finally(() => inFlight.delete(m.storeId));
  inFlight.set(m.storeId, run);
  return run;
}

async function receiveReal(m, payload) {
  let row = await prisma.storeMessage.findUnique({ where: { storeId: m.storeId } });
  if (row?.status === "SENT") return answer(200, { provider_message_id: row.whatsappMessageId, duplicate: true });
  if (row?.status === "UNCONFIRMED" || row?.status === "SENDING") {
    return answer(409, { error: "This message was sent before but WhatsApp didn't confirm it. It may have arrived, so it isn't sent again." });
  }
  const fields = {
    kind: m.kind, category: m.category, language: m.language, phone: m.phone, text: m.text, templateText: m.templateText,
    variables: m.variables, payload, status: "SENDING", reason: null,
  };
  if (row) {
    row = await prisma.storeMessage.update({ where: { id: row.id }, data: { ...fields, attempts: { increment: 1 } } });
  } else {
    try {
      row = await prisma.storeMessage.create({ data: { storeId: m.storeId, ...fields } });
    } catch (err) {
      if (err.code === "P2002") return receiveReal(m, payload); // the same id at the same moment
      throw err;
    }
  }
  const fail = async (why, status = 422) => {
    await prisma.storeMessage.update({ where: { id: row.id }, data: { status: "FAILED", reason: capitalise(why) } });
    return answer(status, { error: capitalise(why) });
  };

  const match = await matchTemplate(m);
  if (!match.template) return fail(match.why);
  const t = match.template;
  await prisma.storeMessage.update({ where: { id: row.id }, data: { templateId: t.id } });
  const problems = valueProblems(t, m.variables);
  if (problems.length) return fail(problems.join("; "));
  const out = await optedOutHere(m.phone, m.category);
  if (out) return fail(out);

  try {
    const sent = await sendStoreTemplate({ template: t, phone: m.phone, variables: m.variables });
    await prisma.storeMessage.update({
      where: { id: row.id },
      data: { status: "SENT", whatsappMessageId: sent.whatsappMessageId, messageId: sent.message.id, conversationId: sent.conversationId },
    });
    return answer(200, { provider_message_id: sent.whatsappMessageId });
  } catch (err) {
    logError({ source: "send", message: `A store message wasn't sent: ${err.message}`, error: err, details: { storeId: m.storeId, kind: m.kind } });
    await prisma.storeMessage.update({
      where: { id: row.id },
      data: {
        status: err.unconfirmed ? "UNCONFIRMED" : "FAILED",
        reason: err.unconfirmed ? `Not confirmed by WhatsApp (${err.message}) — not sent again, it may have arrived` : `WhatsApp refused it: ${err.message}`,
        messageId: err.messageId ?? null,
        conversationId: err.conversationId ?? null,
      },
    });
    return answer(502, { error: err.unconfirmed ? "WhatsApp didn't confirm the send; it won't be sent again" : `WhatsApp refused it: ${err.message}` });
  }
}

// A test from the store's staff page: kept with what would have happened;
// sent only to a staff test phone.
async function receiveTest(m, payload) {
  const match = await matchTemplate(m);
  let status = "CAPTURED";
  let reason;
  let sent = null;
  const staff = (getSetting("testPhones")?.phones || []).includes(m.phone);
  if (!match.template) reason = `Captured. Would not be sent: ${match.why}`;
  else {
    const problems = valueProblems(match.template, m.variables);
    if (problems.length) reason = `Captured. Would not be sent: ${problems.join("; ")}`;
    else if (!staff) reason = `Captured. Would be sent with "${match.template.name}". Not sent: test messages go only to staff test phones`;
    else {
      try {
        sent = await sendStoreTemplate({ template: match.template, phone: m.phone, variables: m.variables });
        status = "SENT";
        reason = `Test sent to the staff phone with "${match.template.name}"`;
      } catch (err) {
        status = "FAILED";
        reason = `Test not sent: ${err.message}`;
      }
    }
  }
  const row = await prisma.storeMessage.create({
    data: {
      storeId: null, test: true, kind: m.kind, category: m.category, language: m.language, phone: m.phone, text: m.text,
      templateText: m.templateText, variables: m.variables, payload, status, reason, templateId: match.template?.id ?? null,
      whatsappMessageId: sent?.whatsappMessageId ?? null, messageId: sent?.message.id ?? null, conversationId: sent?.conversationId ?? null,
    },
  });
  return answer(200, { provider_message_id: sent?.whatsappMessageId ?? null, test: true, captured: row.id, note: reason });
}

// ── Delivery reports back to the store ─────────────────────────────────────

// WhatsApp's final word on a message we sent for the store: "delivered"
// (read counts) or "failed". Called from the status webhook.
async function noteDelivery(messageId, { status, pricing, error }) {
  const final = status === "DELIVERED" || status === "READ" ? "delivered" : status === "FAILED" ? "failed" : null;
  if (!final) return;
  const row = await prisma.storeMessage.findUnique({ where: { messageId } });
  if (!row || row.test || !row.storeId || row.delivery) return;
  let cost = 0;
  if (final === "delivered" && pricing?.billable === true) {
    const rate = rateFor(countryOf(row.phone), String(pricing.category || row.category).toLowerCase());
    cost = rate === null ? 0 : Math.round(rate * USD_TO_AED * 10000) / 10000;
  }
  await prisma.storeMessage.update({ where: { id: row.id }, data: { delivery: final, deliveryError: error || null, costAed: cost } });
  reportDelivery(row.id).catch(() => {});
}

// POST <store API>/api/v1/assistant/messages/{id}/status — once; the first
// final report counts on the store's side, a repeat changes nothing.
async function reportDelivery(id) {
  const row = await prisma.storeMessage.findUnique({ where: { id } });
  if (!row || !row.delivery || row.reportedAt || !row.storeId) return;
  const { apiBase, apiKey } = settings();
  if (!apiBase || !apiKey) {
    await prisma.storeMessage.update({ where: { id }, data: { reportError: "No store API address or access key in Website settings" } });
    return;
  }
  try {
    await axios.post(
      `${apiBase}/api/v1/assistant/messages/${row.storeId}/status`,
      { status: row.delivery, cost: row.delivery === "failed" ? 0 : Number(row.costAed || 0), error: row.delivery === "failed" ? row.deliveryError || "failed" : null },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 10000 },
    );
    await prisma.storeMessage.update({ where: { id }, data: { reportedAt: new Date(), reportError: null, reportTries: { increment: 1 } } });
  } catch (err) {
    const code = err.response?.status;
    const why = err.response?.data?.error || err.response?.data?.message || err.message;
    // 404 message_not_found: the store doesn't know it — nothing to retry.
    await prisma.storeMessage.update({
      where: { id },
      data: { reportError: `${code ? `${code} ` : ""}${typeof why === "string" ? why : JSON.stringify(why)}`.slice(0, 300), reportTries: { increment: 1 }, ...(code === 404 ? { reportedAt: new Date() } : {}) },
    });
  }
}

// Reports the store didn't take yet, tried again every few minutes.
async function retryReports() {
  const due = await prisma.storeMessage.findMany({
    where: { delivery: { not: null }, reportedAt: null, storeId: { not: null }, reportTries: { lt: REPORT_TRIES } },
    orderBy: { updatedAt: "asc" },
    take: 50,
    select: { id: true },
  });
  for (const d of due) await reportDelivery(d.id);
}

function startStoreJobs() {
  // A message claimed but never finished before a restart: it may have
  // reached the customer, so it's unconfirmed, never sent again.
  prisma.storeMessage
    .updateMany({ where: { status: "SENDING" }, data: { status: "UNCONFIRMED", reason: "Interrupted while sending — not sent again, it may have arrived" } })
    .catch((err) => console.error("[Store] settle failed:", err.message));
  setInterval(() => retryReports().catch((err) => console.error("[Store] reports failed:", err.message)), 5 * 60 * 1000).unref?.();
}

module.exports = {
  STORE_KINDS,
  KIND_KEYS,
  LANGUAGES,
  LANGUAGE_NAMES,
  STORE_VARS,
  STORE_VAR_KEYS,
  StoreInputError,
  settings,
  rotateSecret,
  storeNumber,
  verifySignature,
  readMessage,
  toTemplateBody,
  sameText,
  configOf,
  languageOf,
  isMarketing,
  storeVarsUsed,
  valueProblems,
  matchTemplate,
  sendStoreTemplate,
  receiveStoreMessage,
  noteDelivery,
  reportDelivery,
  startStoreJobs,
};
