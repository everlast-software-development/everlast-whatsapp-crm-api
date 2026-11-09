const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { findMarketingWords } = require("../../utils/marketingWords");
const { listPlaceholders, SUPPORTED_VARS, FILL_IN_KEYS } = require("../../utils/templateVars");
const { validateHeader, validateButtons } = require("../../utils/templateValidation");
const { fillInFields, templateNeedsSetup } = require("../../utils/templateSend");
const { createTemplate, updateTemplate, submitForApproval, deleteTemplate } = require("./template.controller");

// ─── /api/templates/utility ──────────────────────────────────────────────────
// The Patient messages page (supervisors, template:write_utility): simple
// patient-care templates — "Your appointment is on {{date}} at {{time}}".
// Deliberately narrow, so nothing made here can turn into marketing:
//   - always category UTILITY (Meta UTILITY). A header (text, image, video or
//     document), a footer and buttons (quick reply, link, call) are allowed,
//     under the regular editor's rules (utils/templateValidation.js) — but no
//     Copy code button (that carries an offer code) and no carousel;
//   - only the app's own blanks ({{first_name}}, {{date}}, {{time}}…);
//   - offer wording is refused on save AND again on submit, anywhere the
//     patient reads: name, header, body, footer, button labels and links
//     (utils/marketingWords.js);
//   - Meta may still re-classify one as MARKETING: the page shows it, and the
//     send paths then treat it as marketing (agents can't send it, opted-out
//     patients never get it).
// The real work is the regular template endpoints, called after these checks.

const BODY_MAX = 800; // the regular editor's limit too
const FOOTER_MAX = 60;
const ARABIC_RE = /[؀-ۿ]/;
// No Copy code: it carries an offer code.
const CARE_BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER"];

// Every piece of text the patient sees, for the offer-wording check.
const allText = (t) =>
  [
    t.name,
    t.headerType === "TEXT" ? t.header : "",
    t.body,
    t.footer,
    ...(Array.isArray(t.buttons) ? t.buttons.flatMap((b) => [b.title, b.url]) : []),
  ]
    .filter(Boolean)
    .join("\n");

const looksMarketing = (words) =>
  new AppError(
    `This reads like an offer, so it can't be a patient-care message: ${words.map((w) => `"${w}"`).join(", ")}. Remove the offer wording — offers go through Campaigns.`,
    400,
    "LOOKS_LIKE_MARKETING",
    { words },
  );

// The cleaned fields, or an AppError thrown. `partial` for edits.
function cleanInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new AppError("Give the message a name, e.g. Appointment reminder", 400);
    if (name.length > 60) throw new AppError("The name can be at most 60 characters", 400);
    out.name = name;
  }
  if (!partial || body.body !== undefined) {
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) throw new AppError("Write the message", 400);
    if (text.length > BODY_MAX) throw new AppError(`The message can be at most ${BODY_MAX} characters`, 400);
    const unknown = listPlaceholders(text).filter((v) => !SUPPORTED_VARS.includes(v.toLowerCase()));
    if (unknown.length) {
      throw new AppError(`{{${unknown[0]}}} isn't a blank the app can fill. Use the Insert buttons.`, 400);
    }
    // Meta refuses a template that starts or ends with a variable.
    if (/^\{\{[^{}]+\}\}/.test(text) || /\{\{[^{}]+\}\}[.!?]?$/.test(text)) {
      throw new AppError("WhatsApp doesn't accept a message that starts or ends with a blank — add a word before or after it", 400);
    }
    out.body = text;
    // Arabic text is submitted as Arabic, so Meta reviews it in that language.
    out.language = ARABIC_RE.test(text) ? "ar" : "en_US";
  }
  if (!partial || body.footer !== undefined) {
    const footer = typeof body.footer === "string" ? body.footer.trim() : "";
    if (footer.length > FOOTER_MAX) throw new AppError(`The footer can be at most ${FOOTER_MAX} characters`, 400);
    if (listPlaceholders(footer).length) throw new AppError("The footer can't have blanks", 400);
    out.footer = footer || null;
  }
  if (!partial || body.headerType !== undefined) {
    Object.assign(out, validateHeader(body.headerType || "NONE", body.header, body.headerMediaUrl));
  }
  if (!partial || body.buttons !== undefined) {
    const buttons = validateButtons(body.buttons);
    if (buttons?.some((b) => !CARE_BUTTON_TYPES.includes(b.type))) {
      throw new AppError("A Copy code button is for offer codes, so it can't be on a patient-care message", 400);
    }
    // A link may end with the patient's name, not with a blank the agent
    // types: links are filled in without the agent's answers.
    for (const b of buttons || []) {
      const v = b.type === "URL" ? listPlaceholders(b.url)[0] : null;
      if (v && FILL_IN_KEYS.includes(v.toLowerCase())) {
        throw new AppError(`The link on "${b.title}" can't end with {{${v}}}: only the patient's name can go into a link`, 400);
      }
    }
    out.buttons = buttons;
  }
  const words = findMarketingWords(allText(out));
  if (words.length) throw looksMarketing(words);
  return out;
}

async function findOwn(req) {
  const t = await prisma.template.findFirst({
    where: { id: parseInt(req.params.id), wabaId: req.number.wabaId, isActive: true, category: "UTILITY" },
  });
  if (!t) throw new AppError("Message not found", 404);
  return t;
}

// The regular handlers answer with res.json; this runs one and hands back
// what it answered, so the caller can add to it (or pass its error on).
const run = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    handler(req, res, (err) => (err ? reject(err) : reject(new Error("handler did not answer"))));
  });

const shape = (t) => ({
  ...t,
  needsSetup: templateNeedsSetup(t),
  fillIns: fillInFields(t),
  // Meta decided it is marketing after all: agents can't use it as care.
  classedMarketing: t.metaCategory === "MARKETING",
});

// GET /api/templates/utility
const listUtilityTemplates = async (req, res, next) => {
  try {
    const templates = await prisma.template.findMany({
      where: { wabaId: req.number.wabaId, isActive: true, category: "UTILITY" },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ success: true, data: templates.map(shape) });
  } catch (err) {
    next(err);
  }
};

// POST /api/templates/utility { name, body, footer?, headerType?, header?, headerMediaUrl?, buttons? }
const createUtilityTemplate = async (req, res, next) => {
  try {
    const clean = cleanInput(req.body || {});
    const out = await run(createTemplate, { ...req, body: { ...clean, category: "UTILITY" } });
    logAudit({ action: "template.created", actor: req.user, targetType: "Template", targetId: out.payload.data.id, details: { name: clean.name, category: "UTILITY" } });
    res.status(out.status).json({ ...out.payload, data: shape(out.payload.data) });
  } catch (err) {
    next(err);
  }
};

// PUT /api/templates/utility/:id { name?, body?, footer?, headerType?, header?,
// headerMediaUrl?, buttons? } — drafts and rejected ones.
const updateUtilityTemplate = async (req, res, next) => {
  try {
    const existing = await findOwn(req);
    if (existing.approvalStatus === "SUBMITTED") return next(new AppError("It's waiting for WhatsApp's answer — it can be changed once WhatsApp replies", 400));
    if (existing.approvalStatus === "APPROVED") return next(new AppError("It's approved and in use. Make a new message instead of changing this one.", 400));
    // What isn't sent stays as it was; the header's three fields go together.
    const header = req.body?.headerType !== undefined
      ? {}
      : { headerType: existing.headerType, header: existing.header, headerMediaUrl: existing.headerMediaUrl };
    const clean = cleanInput({ name: existing.name, body: existing.body, footer: existing.footer, buttons: existing.buttons, ...header, ...req.body });
    const out = await run(updateTemplate, { ...req, body: { ...clean, category: "UTILITY" } });
    res.status(out.status).json({ ...out.payload, data: shape(out.payload.data) });
  } catch (err) {
    next(err);
  }
};

// POST /api/templates/utility/:id/submit — to Meta for approval.
const submitUtilityTemplate = async (req, res, next) => {
  try {
    const existing = await findOwn(req);
    // Again here: a draft saved before a word was added to the list.
    const words = findMarketingWords(allText(existing));
    if (words.length) return next(looksMarketing(words));
    // Meta's template name: lowercase English letters, digits and _. An Arabic
    // name would come out empty, and a deleted name stays reserved at Meta
    // for 30 days — so ours is care_<words>_<id>, always valid and unique.
    if (!existing.metaTemplateName) {
      const slug = existing.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
      await prisma.template.update({
        where: { id: existing.id },
        data: { metaTemplateName: `care_${slug ? `${slug}_` : ""}${existing.id}` },
      });
    }
    const out = await run(submitForApproval, req);
    logAudit({ action: "template.submitted", actor: req.user, targetType: "Template", targetId: existing.id, details: { name: existing.name, category: "UTILITY" } });
    res.status(out.status).json({ ...out.payload, data: shape(out.payload.data) });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/templates/utility/:id
const deleteUtilityTemplate = async (req, res, next) => {
  try {
    const existing = await findOwn(req);
    const out = await run(deleteTemplate, req);
    logAudit({ action: "template.deleted", actor: req.user, targetType: "Template", targetId: existing.id, details: { name: existing.name, category: "UTILITY" } });
    res.status(out.status).json(out.payload);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listUtilityTemplates,
  createUtilityTemplate,
  updateUtilityTemplate,
  submitUtilityTemplate,
  deleteUtilityTemplate,
};
