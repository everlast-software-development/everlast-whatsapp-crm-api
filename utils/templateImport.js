// "Import from Meta": turning a template that lives in WhatsApp Manager (made
// there, or by another tool) into a CRM Template row, and the follow-up step of
// saying what its positional variables mean.
//
// Everything here is pure — no DB, no Meta — so the mapping can be checked with
// fixtures. The controller (modules/templates/template.controller.js) does the
// fetching and the writes.
//
// The rule throughout: import only what the CRM can show AND send exactly as
// Meta approved it. Anything else is skipped with a reason a person can read,
// never imported half-right.

const AppError = require("./AppError");
const { SUPPORTED_VARS, extractOrderedVars, toMetaPositionalBody } = require("./templateVars");
const { validateButtons, validateCards } = require("./templateValidation");
const { templateNeedsSetup } = require("./templateSend");

// Meta's template statuses / events → ours. Shared with utils/templateStatus.js
// (webhook + sync), so an imported template and a synced one agree.
const META_STATUS = {
  APPROVED: "APPROVED",
  REINSTATED: "APPROVED",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
  PENDING_DELETION: "DISABLED",
  DELETED: "DISABLED",
};

// For a NEW row only. Still under review at Meta = SUBMITTED here. Deleted (or
// being deleted) templates are not worth importing at all.
const importStatus = (metaStatus) => {
  if (metaStatus === "PENDING" || metaStatus === "IN_APPEAL") return "SUBMITTED";
  if (metaStatus === "DELETED" || metaStatus === "PENDING_DELETION") return null;
  return META_STATUS[metaStatus] || null;
};

// Meta's category → the CRM's. Every imported template is a real Meta
// template, so never GENERAL (GENERAL goes out as an ad-hoc message — see
// needsMetaTemplate in utils/templateSend.js). metaCategory keeps Meta's own.
const CATEGORY_FROM_META = { MARKETING: "CAMPAIGN", UTILITY: "RE_ENGAGEMENT", AUTHENTICATION: "RE_ENGAGEMENT" };

const MEDIA_FORMATS = ["IMAGE", "VIDEO", "DOCUMENT"];
const POSITIONAL_RE = /\{\{\s*(\d+)\s*\}\}/g;
const ANY_VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

// "summer_offer_2" → "Summer offer 2"
const toHumanName = (metaName) => {
  const s = String(metaName || "").replace(/_+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Imported template";
};

// Unique positional numbers in order of first appearance: "{{2}} {{1}} {{2}}" → [2, 1]
const positionalOrder = (text) => {
  const seen = [];
  for (const m of String(text || "").matchAll(POSITIONAL_RE)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
};

// The CRM sends parameter values in order of FIRST APPEARANCE (templateVars.js),
// and fills each with a distinct named variable. So a positional text it can
// handle has its variables appear as {{1}}, {{2}}, … in that order, and no more
// of them than the CRM has variables to fill them with.
function positionalProblem(text, where, max) {
  const order = positionalOrder(text);
  if (order.length > max) {
    return `its ${where} has ${order.length} variables — the CRM can fill at most ${max} (${SUPPORTED_VARS.join(", ")})`;
  }
  const outOfOrder = order.findIndex((n, i) => n !== i + 1);
  if (outOfOrder !== -1) {
    return `its ${where} variables don't appear in order ({{${order[outOfOrder]}}} comes where {{${outOfOrder + 1}}} should) — the CRM sends values in the order they appear`;
  }
  return null;
}

const BUTTON_SKIP_REASONS = {
  OTP: "it has a one-time-password button (authentication) — the CRM can't send verification codes",
  COPY_CODE: "it has a copy-code button — the CRM can't fill in a code",
  FLOW: "it has a WhatsApp Flow button — not supported in the CRM",
  CATALOG: "it has a catalog button — not supported in the CRM",
  MPM: "it's a multi-product (catalog) message — not supported in the CRM",
  SPM: "it's a single-product (catalog) message — not supported in the CRM",
};

// Meta buttons → the CRM's { id, type, title, url?, phoneNumber? }. Returns
// { buttons } or { reason }. Ids follow the editor's btn_<n> pattern.
function mapButtons(metaButtons, idPrefix) {
  const out = [];
  for (const [i, b] of (metaButtons || []).entries()) {
    const type = String(b?.type || "").toUpperCase();
    if (BUTTON_SKIP_REASONS[type]) return { reason: BUTTON_SKIP_REASONS[type] };
    const id = `${idPrefix}${i}`;
    if (type === "QUICK_REPLY") out.push({ id, type, title: b.text });
    else if (type === "PHONE_NUMBER") out.push({ id, type, title: b.text, phoneNumber: b.phone_number });
    else if (type === "URL") {
      // A dynamic link needs its own value at send time, which the CRM
      // doesn't model (see the TEMPLATE case in utils/whatsappClient.js).
      if (/\{\{/.test(b.url || "")) return { reason: `its "${b.text}" button has a personalised link ({{1}} in the URL) — the CRM can't fill that in` };
      out.push({ id, type, title: b.text, url: b.url });
    } else return { reason: `it has a ${type ? type.toLowerCase().replace(/_/g, " ") : "unknown"} button — not supported in the CRM` };
  }
  return { buttons: out };
}

const reasonFrom = (err, prefix = "") => `${prefix}${err?.message ? err.message.charAt(0).toLowerCase() + err.message.slice(1) : "it doesn't fit the CRM's template rules"}`;

// Meta carousel component → CRM cards, or { reason }.
function mapCarousel(component) {
  const cards = [];
  for (const [i, card] of (component.cards || []).entries()) {
    const parts = Object.fromEntries((card.components || []).map((c) => [String(c.type || "").toUpperCase(), c]));
    const header = parts.HEADER;
    const format = String(header?.format || "").toUpperCase();
    if (!["IMAGE", "VIDEO"].includes(format)) return { reason: `carousel card ${i + 1} has no image or video — the CRM's carousels need one per card` };
    const mapped = mapButtons(parts.BUTTONS?.buttons, "b");
    if (mapped.reason) return { reason: `carousel card ${i + 1}: ${mapped.reason}` };
    cards.push({
      mediaType: format,
      mediaUrl: header.example?.header_handle?.[0] || "",
      body: parts.BODY?.text || "",
      buttons: mapped.buttons,
    });
  }
  try {
    return { cards: validateCards(cards) };
  } catch (err) {
    return { reason: reasonFrom(err, "carousel: ") };
  }
}

/**
 * One Meta template (from GET /{waba}/message_templates) → the fields of a new
 * CRM Template row (without wabaId), or a reason it can't be imported.
 *
 * @returns {{ data: object, needsSetup: string[] } | { reason: string }}
 */
function mapMetaTemplate(meta) {
  const status = importStatus(meta.status);
  if (!status) {
    return { reason: meta.status === "DELETED" || meta.status === "PENDING_DELETION" ? "it's deleted at Meta" : `Meta's status "${meta.status}" isn't one the CRM tracks` };
  }

  const data = {
    name: toHumanName(meta.name),
    metaTemplateName: meta.name,
    metaTemplateId: meta.id != null ? String(meta.id) : null,
    metaCategory: meta.category || null,
    category: CATEGORY_FROM_META[meta.category] || "CAMPAIGN",
    approvalStatus: status,
    rejectionReason: status === "REJECTED" && meta.rejected_reason && meta.rejected_reason !== "NONE" ? meta.rejected_reason : null,
    language: meta.language || "en_US",
    headerType: "NONE",
    header: null,
    headerMediaUrl: null,
    body: null,
    footer: null,
    buttons: null,
    cards: null,
  };

  for (const c of meta.components || []) {
    const type = String(c.type || "").toUpperCase();
    if (type === "HEADER") {
      const format = String(c.format || "").toUpperCase();
      if (format === "TEXT") {
        data.headerType = "TEXT";
        data.header = c.text || "";
      } else if (MEDIA_FORMATS.includes(format)) {
        data.headerType = format;
        // Meta's sample file. Kept so the card can show it, but it expires and
        // isn't ours: needsSetup flags "media" until a real file is chosen.
        const sample = c.example?.header_handle?.[0];
        data.headerMediaUrl = /^https?:\/\//i.test(sample || "") ? sample : null;
      } else {
        return { reason: `its header is a ${format ? format.toLowerCase() : "kind"} the CRM can't send (only text, image, video or document)` };
      }
    } else if (type === "BODY") {
      data.body = c.text || "";
    } else if (type === "FOOTER") {
      data.footer = c.text || null;
    } else if (type === "BUTTONS") {
      const mapped = mapButtons(c.buttons, "btn_");
      if (mapped.reason) return { reason: mapped.reason };
      try {
        data.buttons = validateButtons(mapped.buttons);
      } catch (err) {
        return { reason: reasonFrom(err, "buttons: ") };
      }
    } else if (type === "CAROUSEL") {
      const mapped = mapCarousel(c);
      if (mapped.reason) return { reason: mapped.reason };
      data.cards = mapped.cards;
    } else if (type === "LIMITED_TIME_OFFER") {
      return { reason: "it's a limited-time offer template — not supported in the CRM" };
    } else {
      return { reason: `it has a ${type.toLowerCase().replace(/_/g, " ")} part the CRM can't show` };
    }
  }

  if (!data.body) return { reason: "it has no message body" };

  // Variables. Meta's NAMED format ({{customer_name}}) must be sent with each
  // value labelled by name; the CRM's send path sends positional values only,
  // and the Template row has nowhere to record which format a template uses.
  // Sending one positionally would be refused by Meta, so such templates are
  // skipped unless they have no variables at all.
  const texts = [data.body, data.header || ""];
  const allVars = texts.flatMap((t) => [...t.matchAll(ANY_VAR_RE)].map((m) => m[1]));
  if (meta.parameter_format === "NAMED" || allVars.some((v) => !/^\d+$/.test(v))) {
    if (allVars.length) {
      const names = [...new Set(allVars)].map((v) => `{{${v}}}`).join(", ");
      return { reason: `it uses named variables (${names}) — WhatsApp expects those sent by name, which the CRM doesn't support yet. Recreate it in the CRM, or in Meta with numbered variables` };
    }
  }
  const bodyProblem = positionalProblem(data.body, "message", SUPPORTED_VARS.length);
  if (bodyProblem) return { reason: bodyProblem };
  const headerProblem = data.headerType === "TEXT" ? positionalProblem(data.header, "header", 1) : null;
  if (headerProblem) return { reason: headerProblem };
  if (data.cards && (data.headerType !== "NONE" || data.footer || data.buttons)) {
    return { reason: "it's a carousel with a header, footer or buttons above the cards — the CRM's carousels have only text above the cards" };
  }

  return { data, needsSetup: templateNeedsSetup(data) };
}

// Meta keeps one template per name AND language; the CRM keeps one per name
// (its unique key is [wabaId, metaTemplateName]). So one language version is
// chosen per name: the one a CRM row already has, else English, else Arabic,
// else whatever comes first. The rest are reported, not silently dropped.
const LANGUAGE_PREFERENCE = [/^en_US$/i, /^en$/i, /^en_/i, /^ar$/i, /^ar_/i];
const languageRank = (lang) => {
  const i = LANGUAGE_PREFERENCE.findIndex((re) => re.test(lang || ""));
  return i === -1 ? LANGUAGE_PREFERENCE.length : i;
};

/**
 * @param metaTemplates  Meta's data[] rows
 * @param existingLanguageByName  Map metaTemplateName → language of the CRM row
 * @returns {{ chosen: object[], otherLanguages: object[] }}
 */
function chooseLanguageVersions(metaTemplates, existingLanguageByName = new Map()) {
  const byName = new Map();
  for (const t of metaTemplates) {
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name).push(t);
  }
  const chosen = [];
  const otherLanguages = [];
  for (const [name, versions] of byName) {
    const existingLang = existingLanguageByName.get(name);
    const pick =
      versions.find((v) => existingLang && v.language === existingLang) ||
      [...versions].sort((a, b) => languageRank(a.language) - languageRank(b.language))[0];
    chosen.push(pick);
    for (const v of versions) if (v !== pick) otherLanguages.push(v);
  }
  return { chosen, otherLanguages };
}

/**
 * Says what each positional variable of a template means, in the CRM's copy
 * only (Meta's approved template is unchanged — what Meta receives at send time
 * is still values for {{1}}, {{2}}, … in order).
 *
 * @param template  { body, header, headerType }
 * @param mapping        body: { "1": "first_name", "2": "agent_name" }
 * @param headerMapping  text header (its own numbering, at most {{1}}): { "1": "customer_name" }
 * @returns {{ body: string, header: string|null }}  throws AppError(400)
 *
 * A template whose variables were set up before can be set up again: its
 * named variables are turned back into {{1}}, {{2}} first — the same
 * conversion submit uses, so it reproduces Meta's text exactly.
 */
function applyVariableMapping(template, mapping, headerMapping) {
  const headerText = template.headerType === "TEXT" && template.header ? template.header : null;
  const parts = [
    { key: "body", label: "message", text: template.body || "", map: mapping, max: SUPPORTED_VARS.length },
    { key: "header", label: "header", text: headerText || "", map: headerMapping, max: 1 },
  ];
  const out = { body: template.body, header: template.header ?? null };
  let total = 0;

  for (const p of parts) {
    if (!p.text) continue;
    if (positionalOrder(p.text).length && extractOrderedVars(p.text).length) {
      throw new AppError(`The ${p.label} mixes numbered and named variables — it can't be set up here`, 400);
    }
    const positional = toMetaPositionalBody(p.text);
    const order = positionalOrder(positional);
    if (order.length === 0) {
      if (p.map && Object.keys(p.map).length) throw new AppError(`The ${p.label} has no variables to set up`, 400);
      continue;
    }
    total += order.length;
    const problem = positionalProblem(positional, p.label, p.max);
    if (problem) throw new AppError(`This template can't be set up: ${problem}`, 400);

    const map = p.map && typeof p.map === "object" && !Array.isArray(p.map) ? p.map : {};
    for (const key of Object.keys(map)) {
      if (!/^\d+$/.test(key) || !order.includes(Number(key))) {
        throw new AppError(`{{${key}}} isn't a variable in the ${p.label}`, 400);
      }
    }
    const names = order.map((n) => {
      const name = String(map[String(n)] ?? "").trim().toLowerCase();
      if (!name) throw new AppError(`Choose what {{${n}}} in the ${p.label} means`, 400);
      if (!SUPPORTED_VARS.includes(name)) {
        throw new AppError(`"${name}" isn't something the CRM can fill in. Use one of: ${SUPPORTED_VARS.join(", ")}`, 400);
      }
      return name;
    });
    // The CRM sends one value per DISTINCT name; two numbers meaning the same
    // thing would send fewer values than Meta expects.
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) {
      throw new AppError(`Each variable in the ${p.label} needs a different meaning — "${dup}" is chosen twice. WhatsApp expects one value per number.`, 400);
    }
    out[p.key] = positional.replace(POSITIONAL_RE, (_full, n) => `{{${names[Number(n) - 1]}}}`);
  }

  if (total === 0) throw new AppError("This template has no variables to set up", 400);
  // Belt and braces: what the send path will now produce must line up with
  // Meta's numbering ({{1}} gets the first value, and so on).
  for (const p of parts) {
    if (!out[p.key] || (p.key === "header" && !headerText)) continue;
    if (toMetaPositionalBody(out[p.key]) !== toMetaPositionalBody(p.text)) {
      throw new AppError(`The ${p.label}'s variables wouldn't line up with Meta's numbering`, 400);
    }
  }
  return out;
}

module.exports = {
  META_STATUS,
  CATEGORY_FROM_META,
  importStatus,
  toHumanName,
  positionalOrder,
  mapMetaTemplate,
  chooseLanguageVersions,
  applyVariableMapping,
};
