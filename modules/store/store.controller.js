const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { getSetting, saveSetting } = require("../../utils/appSettings");
const numbers = require("../../utils/whatsappNumbers");
const store = require("../../utils/storeEvents");
const { listPlaceholders, STORE_VARS } = require("../../utils/templateVars");
const { STARTER_TEMPLATES } = require("../../utils/storeStarterTemplates");
const { createTemplate, updateTemplate, submitForApproval, deleteTemplate } = require("../templates/template.controller");

// ─── POST /api/webhooks/store ────────────────────────────────────────────────
// A message the online store sends first (utils/storeEvents.js). Public:
// signed with the shared secret instead of a login. Answers within the
// store's 10 seconds with WhatsApp's message id.
// The last requests the CRM turned away (wrong secret, bad body…), kept in
// memory so the Website tab can say why a test from the store didn't show up.
// Never the body: an unsigned request is anyone's.
const refused = [];
const noteRefused = (req, status, error) => {
  refused.unshift({ at: new Date().toISOString(), status, error, messageId: req.get("X-Everlast-Message-Id") || null });
  refused.length = Math.min(refused.length, 10);
};

const receiveStoreMessage = async (req, res, next) => {
  try {
    const why = store.verifySignature(req.rawBody, req.get("X-Everlast-Signature"));
    if (why) {
      noteRefused(req, 401, why);
      return res.status(401).json({ error: why });
    }
    // Switched off: real messages are refused (the store tries again later),
    // but a test is still captured — it's never sent to a customer.
    if (!store.settings().enabled && req.body?.test !== true) {
      noteRefused(req, 503, "Switched off in Templates → Website");
      return res.status(503).json({ error: "The CRM isn't taking store messages right now (switched off in Templates → Website)" });
    }
    const { status, body } = await store.receiveStoreMessage(req.body);
    res.status(status).json(body);
  } catch (err) {
    if (err instanceof store.StoreInputError) {
      noteRefused(req, 400, err.message);
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
};

// ─── Admin: the connection ───────────────────────────────────────────────────

const endpointUrl = (req) => `${req.get("X-Forwarded-Proto") || req.protocol}://${req.get("host")}/api/webhooks/store`;
const maskKey = (k) => (k ? `${k.slice(0, 5)}…${k.slice(-4)}` : null);

async function connectionOut(req) {
  const s = store.settings();
  const number = await store.storeNumber();
  return {
    enabled: s.enabled,
    secret: s.secret,
    numberId: s.numberId,
    linkBase: s.linkBase,
    apiBase: s.apiBase,
    apiKeyHint: maskKey(s.apiKey),
    endpoint: endpointUrl(req),
    line: number ? { id: number.id, label: number.label, displayPhoneNumber: number.displayPhoneNumber || null } : null,
  };
}

// GET /api/store/settings
const getStoreSettings = async (req, res, next) => {
  try {
    res.json({ success: true, data: await connectionOut(req), kinds: store.STORE_KINDS, variables: STORE_VARS, refused });
  } catch (err) {
    next(err);
  }
};

// PUT /api/store/settings { enabled?, numberId?, linkBase?, apiBase?, apiKey? }
const updateStoreSettings = async (req, res, next) => {
  try {
    const { enabled, numberId, linkBase, apiBase, apiKey } = req.body || {};
    if (numberId !== undefined && numberId !== null && numberId !== "") {
      const n = await numbers.getById(Number(numberId)).catch(() => null);
      if (!n) return next(new AppError("That WhatsApp line doesn't exist", 400));
    }
    const hide = (s) => ({ ...s, secret: s.secret ? "set" : null, apiKey: s.apiKey ? "set" : null });
    const before = hide(store.settings());
    await saveSetting("storeWebhook", { enabled, numberId, linkBase, apiBase, apiKey }, req.user);
    logAudit({ action: "SETTINGS_UPDATED", actor: req.user, targetType: "Setting", targetId: 0, details: { key: "storeWebhook", before, after: hide(store.settings()) } });
    res.json({ success: true, data: await connectionOut(req) });
  } catch (err) {
    next(err);
  }
};

// POST /api/store/settings/rotate — a new signing secret; the old one stops at once.
const rotateStoreSecret = async (req, res, next) => {
  try {
    const had = Boolean(store.settings().secret);
    await store.rotateSecret(req.user);
    logAudit({ action: "SETTINGS_UPDATED", actor: req.user, targetType: "Setting", targetId: 0, details: { key: "storeWebhook", secret: had ? "replaced" : "created" } });
    res.json({ success: true, data: await connectionOut(req) });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: what the store sent ──────────────────────────────────────────────

// GET /api/store/messages?test=1|0&kind=&status=&page=
const listStoreMessages = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const where = {};
    if (req.query.test === "1") where.test = true;
    if (req.query.test === "0") where.test = false;
    if (store.STORE_KINDS[req.query.kind]) where.kind = req.query.kind;
    if (["CAPTURED", "SENDING", "SENT", "FAILED", "UNCONFIRMED"].includes(req.query.status)) where.status = req.query.status;
    const [rows, total] = await Promise.all([
      prisma.storeMessage.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { template: { select: { id: true, name: true } } },
      }),
      prisma.storeMessage.count({ where }),
    ]);
    res.json({ success: true, data: rows, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: one template per kind × language ─────────────────────────────────

// GET /api/store/overview — for each kind × language: the latest text the
// store sent (from any message, tests included), its templates, and whether
// store messages can go out right now.
const getStoreOverview = async (req, res, next) => {
  try {
    const number = await store.storeNumber();
    const templates = number
      ? await prisma.template.findMany({ where: { isActive: true, websiteEvent: { not: null }, wabaId: number.wabaId }, orderBy: { createdAt: "asc" } })
      : [];
    const latest = await prisma.$queryRaw`
      SELECT DISTINCT ON (kind, language) kind, language, "templateText", variables, category, "receivedAt"
      FROM "StoreMessage" WHERE "templateText" IS NOT NULL
      ORDER BY kind, language, "receivedAt" DESC`;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const counts = await prisma.storeMessage.groupBy({ by: ["kind", "language", "status"], where: { receivedAt: { gte: since }, test: false }, _count: { _all: true } });
    const cells = [];
    for (const kind of store.KIND_KEYS) {
      for (const language of Object.keys(store.LANGUAGES)) {
        const seen = latest.find((l) => l.kind === kind && l.language === language) || null;
        const mine = templates.filter((t) => t.websiteEvent === kind && store.languageOf(t) === language).map(shape);
        const match = seen ? await store.matchTemplate({ kind, language, templateText: seen.templateText }) : null;
        cells.push({
          kind,
          language,
          storeText: seen?.templateText ?? null,
          storeCategory: seen?.category ?? null,
          lastValues: seen?.variables ?? null,
          lastSeenAt: seen?.receivedAt ?? null,
          templates: mine,
          ready: match ? Boolean(match.template) : false,
          why: match ? match.why ?? null : "the store hasn't sent this message yet",
          last30Days: Object.fromEntries(counts.filter((c) => c.kind === kind && c.language === language).map((c) => [c.status, c._count._all])),
        });
      }
    }
    res.json({ success: true, data: cells });
  } catch (err) {
    next(err);
  }
};

// The regular handlers answer with res.json; this runs one on the store's line.
const run = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    handler(req, res, (err) => (err ? reject(err) : reject(new Error("handler did not answer"))));
  });

async function onStoreLine(req, body) {
  const number = await store.storeNumber();
  if (!number) throw new AppError("Add a WhatsApp line first", 400);
  return { ...req, number, numberId: number.id, allowedVars: ["first_name", ...store.STORE_VAR_KEYS], ...(body ? { body } : {}) };
}

const BODY_MAX = 800;

// A website template's content, checked before the regular checks run.
function cleanInput(body, existing = null) {
  const merged = { ...(existing || {}), ...body };
  const kind = merged.websiteEvent;
  const def = store.STORE_KINDS[kind];
  if (!def) throw new AppError("Choose which store message it's for", 400);
  const language = merged.language === "ar" || merged.language === "en" ? merged.language : null;
  if (!language) throw new AppError("Choose English or Arabic", 400);
  const name = String(merged.name || "").trim();
  if (!name) throw new AppError("Give it a name", 400);
  if (name.length > 60) throw new AppError("The name can be at most 60 characters", 400);
  const text = String(merged.body || "").trim();
  if (!text) throw new AppError("Write the message", 400);
  if (text.length > BODY_MAX) throw new AppError(`The message can be at most ${BODY_MAX} characters`, 400);
  // Only the values the store sends with this kind.
  const allowed = def.vars;
  const used = [text, merged.headerType === "TEXT" ? merged.header || "" : "", ...(Array.isArray(merged.buttons) ? merged.buttons.map((b) => b.url || "") : [])].flatMap((x) => listPlaceholders(x));
  const unknown = used.filter((v) => !allowed.includes(v.toLowerCase()));
  if (unknown.length) throw new AppError(`{{${unknown[0]}}} isn't sent with ${def.label}. It sends: ${allowed.join(", ")}`, 400);
  if (listPlaceholders(merged.footer || "").length) throw new AppError("The footer can't have blanks", 400);
  if (/^\{\{[^{}]+\}\}/.test(text) || /\{\{[^{}]+\}\}[.!?]?$/.test(text)) {
    throw new AppError("WhatsApp doesn't accept a message that starts or ends with a blank — add a word before or after it", 400);
  }
  // The store decides the category ("a gift arrived" is a service message even
  // though it says "gift"); WhatsApp has the last word when it approves it, and
  // if it files it as marketing, opt-outs apply (isMarketing reads Meta's verdict).
  const category = merged.storeCategory === "utility" || merged.storeCategory === "marketing" ? merged.storeCategory : def.category;
  return {
    template: {
      name,
      body: text,
      language: store.LANGUAGES[language],
      category: category === "marketing" ? "CAMPAIGN" : "UTILITY",
      headerType: merged.headerType || "NONE",
      header: merged.header ?? null,
      headerMediaUrl: merged.headerMediaUrl ?? null,
      footer: String(merged.footer || "").trim() || null,
      buttons: Array.isArray(merged.buttons) && merged.buttons.length ? merged.buttons : null,
    },
    kind,
    config: { active: merged.active !== false },
  };
}

function shape(t) {
  return { ...t, websiteConfig: store.configOf(t), storeLanguage: store.languageOf(t), kind: store.isMarketing(t) ? "MARKETING" : "UTILITY", storeVars: store.storeVarsUsed(t) };
}

async function findWebsiteTemplate(id) {
  const t = await prisma.template.findFirst({ where: { id: parseInt(id), isActive: true, websiteEvent: { not: null } } });
  if (!t) throw new AppError("Website template not found", 404);
  return t;
}

// POST /api/store/templates { websiteEvent, language, name, body, header…, buttons, storeCategory }
const createWebsiteTemplate = async (req, res, next) => {
  try {
    const clean = cleanInput(req.body || {});
    const out = await run(createTemplate, await onStoreLine(req, clean.template));
    const t = await prisma.template.update({ where: { id: out.payload.data.id }, data: { websiteEvent: clean.kind, websiteConfig: clean.config } });
    logAudit({ action: "template.created", actor: req.user, targetType: "Template", targetId: t.id, details: { name: t.name, websiteEvent: clean.kind } });
    res.status(201).json({ success: true, data: shape(t) });
  } catch (err) {
    next(err);
  }
};

// POST /api/store/templates/starter — a draft for every kind × language that
// has no template yet, from the store's texts (utils/storeStarterTemplates.js),
// each link as a button on the store address. Existing templates are left alone.
async function makeStarterDrafts(req) {
    const number = await store.storeNumber();
    if (!number) throw new AppError("Add a WhatsApp line first", 400);
    const { linkBase } = store.settings();
    const existing = await prisma.template.findMany({
      where: { isActive: true, websiteEvent: { not: null }, wabaId: number.wabaId },
      select: { websiteEvent: true, language: true },
    });
    const has = new Set(existing.map((t) => `${t.websiteEvent}|${t.language}`));
    const created = [];
    const skipped = [];
    const failed = [];
    for (const s of STARTER_TEMPLATES) {
      const def = store.STORE_KINDS[s.kind];
      for (const language of ["en", "ar"]) {
        const label = `${def.label} (${language === "ar" ? "Arabic" : "English"})`;
        if (has.has(`${s.kind}|${store.LANGUAGES[language]}`)) {
          skipped.push(label);
          continue;
        }
        try {
          const clean = cleanInput({
            websiteEvent: s.kind,
            language,
            storeCategory: def.category,
            name: label,
            body: s[language].body,
            buttons: [{ id: "b0", type: "URL", title: s[language].button, url: `${linkBase}{{link}}` }],
          });
          const out = await run(createTemplate, await onStoreLine(req, clean.template));
          await prisma.template.update({ where: { id: out.payload.data.id }, data: { websiteEvent: clean.kind, websiteConfig: clean.config } });
          created.push(label);
        } catch (err) {
          failed.push({ template: label, error: err.message });
        }
      }
    }
    if (created.length) logAudit({ action: "template.created", actor: req.user || null, targetType: "Template", targetId: 0, details: { websiteStarterDrafts: created } });
    return { created, skipped, failed };
}

const createStarterDrafts = async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await makeStarterDrafts(req) });
  } catch (err) {
    next(err);
  }
};

// At start-up, once ever: the starter drafts appear by themselves, so an admin
// only reads them and sends them for approval. Never again after that, so a
// draft someone deleted doesn't come back.
async function seedStarterDraftsOnce() {
  if (store.settings().starterSeeded) return;
  const out = await makeStarterDrafts({});
  await saveSetting("storeWebhook", { starterSeeded: true }, null);
  console.log(`[Store] starter drafts: ${out.created.length} made, ${out.skipped.length} already there, ${out.failed.length} failed`);
  for (const f of out.failed) console.error(`[Store] starter draft ${f.template} failed: ${f.error}`);
}

// PUT /api/store/templates/:id — drafts and rejected ones only.
const updateWebsiteTemplate = async (req, res, next) => {
  try {
    const existing = await findWebsiteTemplate(req.params.id);
    if (existing.approvalStatus === "SUBMITTED") return next(new AppError("It's waiting for WhatsApp's answer — it can be changed once WhatsApp replies", 400));
    if (existing.approvalStatus === "APPROVED") return next(new AppError("It's approved. Make a new one for a new text instead.", 400));
    const cfg = store.configOf(existing);
    const clean = cleanInput(req.body || {}, {
      ...existing,
      language: store.languageOf(existing),
      active: cfg.active,
      storeCategory: store.isMarketing(existing) ? "marketing" : "utility",
    });
    await run(updateTemplate, { ...(await onStoreLine(req, clean.template)), params: { id: String(existing.id) } });
    const t = await prisma.template.update({ where: { id: existing.id }, data: { websiteEvent: clean.kind, websiteConfig: clean.config } });
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    next(err);
  }
};

// PUT /api/store/templates/:id/active { active } — any time.
const setWebsiteTemplateActive = async (req, res, next) => {
  try {
    const existing = await findWebsiteTemplate(req.params.id);
    const config = { ...store.configOf(existing), active: req.body?.active === true };
    const t = await prisma.template.update({ where: { id: existing.id }, data: { websiteConfig: config } });
    logAudit({ action: "template.updated", actor: req.user, targetType: "Template", targetId: t.id, details: { active: config.active } });
    res.json({ success: true, data: shape(t) });
  } catch (err) {
    next(err);
  }
};

// POST /api/store/templates/:id/submit
const submitWebsiteTemplate = async (req, res, next) => {
  try {
    const existing = await findWebsiteTemplate(req.params.id);
    // Meta's name: lowercase letters, digits and _, unique — web_<kind>_<lang>_<id>.
    if (!existing.metaTemplateName) {
      await prisma.template.update({ where: { id: existing.id }, data: { metaTemplateName: `web_${existing.websiteEvent}_${store.languageOf(existing)}_${existing.id}` } });
    }
    const out = await run(submitForApproval, { ...(await onStoreLine(req)), params: { id: String(existing.id) } });
    logAudit({ action: "template.submitted", actor: req.user, targetType: "Template", targetId: existing.id, details: { name: existing.name, websiteEvent: existing.websiteEvent } });
    res.status(out.status).json({ ...out.payload, data: shape(out.payload.data) });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/store/templates/:id
const deleteWebsiteTemplate = async (req, res, next) => {
  try {
    const existing = await findWebsiteTemplate(req.params.id);
    const out = await run(deleteTemplate, { ...(await onStoreLine(req)), params: { id: String(existing.id) } });
    logAudit({ action: "template.deleted", actor: req.user, targetType: "Template", targetId: existing.id, details: { name: existing.name, websiteEvent: existing.websiteEvent } });
    res.status(out.status).json(out.payload);
  } catch (err) {
    next(err);
  }
};

// POST /api/store/templates/:id/test-send { phone } — the approved template to a
// staff test phone, with the latest values the store sent for it (else examples).
const testSendWebsiteTemplate = async (req, res, next) => {
  try {
    const t = await findWebsiteTemplate(req.params.id);
    if (t.approvalStatus !== "APPROVED" || !t.metaTemplateName) return next(new AppError("WhatsApp has to approve it before it can be sent", 400));
    const phones = getSetting("testPhones")?.phones || [];
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!phones.includes(phone)) return next(new AppError("Pick one of the staff test numbers (Settings → Campaign safety)", 400));
    const latest = await prisma.storeMessage.findFirst({ where: { kind: t.websiteEvent, language: store.languageOf(t) }, orderBy: { receivedAt: "desc" } });
    const examples = { first_name: "Sara", ...Object.fromEntries(Object.entries(STORE_VARS).map(([k, v]) => [k, v.sample])) };
    const variables = store.withFallbacks({ ...examples, ...(latest?.variables || {}) }, store.languageOf(t));
    // A link the button can't open (a developer's test copy sends
    // http://localhost…) is swapped for an example on the store's address —
    // only here, for the staff test; a real store message is never changed.
    let swappedLink = false;
    for (const b of Array.isArray(t.buttons) ? t.buttons : []) {
      const m = b.type === "URL" ? String(b.url || "").match(/^(.*)\{\{\s*([a-z_]+)\s*\}\}$/i) : null;
      if (!m || !STORE_VARS[m[2].toLowerCase()]?.link) continue;
      const [, base, rawKey] = m;
      const key = rawKey.toLowerCase();
      if (!String(variables[key] || "").startsWith(base)) {
        variables[key] = `${base}${new URL(STORE_VARS[key].sample).pathname.replace(/^\//, "")}`;
        swappedLink = true;
      }
    }
    const problems = store.valueProblems(t, variables);
    if (problems.length) return next(new AppError(problems.join("; "), 400));
    const sent = await store.sendStoreTemplate({ template: t, phone, variables });
    logAudit({ action: "template.test_sent", actor: req.user, targetType: "Template", targetId: t.id, details: { phone, from: latest ? `store message ${latest.id}` : "examples" } });
    res.json({ success: true, data: { messageId: sent.message.id, conversationId: sent.conversationId, usedStoreValues: Boolean(latest), swappedLink } });
  } catch (err) {
    if (err.messageId) return next(new AppError(err.message, 502));
    next(err);
  }
};

module.exports = {
  receiveStoreMessage,
  getStoreSettings,
  updateStoreSettings,
  rotateStoreSecret,
  listStoreMessages,
  getStoreOverview,
  createWebsiteTemplate,
  createStarterDrafts,
  seedStarterDraftsOnce,
  updateWebsiteTemplate,
  setWebsiteTemplateActive,
  submitWebsiteTemplate,
  deleteWebsiteTemplate,
  testSendWebsiteTemplate,
};
