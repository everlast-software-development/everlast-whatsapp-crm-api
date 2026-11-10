// Single source of truth for turning a Template + Customer into the arguments
// sendWhatsAppMessage expects, plus the JSON blob the app stores as a message's
// content.
//
// This exists so a test send and a real campaign send are built by the SAME
// code. If the two ever drift, a test send stops being evidence about the real
// one — which is the whole point of having a test send.

const AppError = require("./AppError");
const { buildTemplateParams, resolveNamedVars, fillInsOf, FILL_INS, STORE_VARS } = require("./templateVars");
const { groupButtons } = require("./templateValidation");

// A personalised link ends with one placeholder ({{first_name}}…): the value
// goes into the URL, so it is percent-encoded ("Sarah Ahmed" → Sarah%20Ahmed).
const VAR_AT_END_RE = /\{\{\s*[a-z_]+\s*\}\}$/i;
const END_VAR_NAME_RE = /\{\{\s*([a-z_]+)\s*\}\}$/i;
// A store link ({{cart_url}}, {{tracking_url}}… — website templates) arrives as
// a full address; the button's fixed part is its start, so only the rest is
// sent, slashes kept: https://everlastwellness.com/{{cart_url}} with
// "https://everlastwellness.com/cart/restore/8f2k1" → "cart/restore/8f2k1".
const linkSuffix = (url, value) => {
  const base = String(url || "").replace(VAR_AT_END_RE, "");
  const v = String(value ?? "").trim();
  return (base && v.startsWith(base) ? v.slice(base.length) : v).replace(/ /g, "%20");
};
const isStoreLink = (url) => Boolean(STORE_VARS[(String(url || "").match(END_VAR_NAME_RE)?.[1] || "").toLowerCase()]?.link);
const linkValue = (url, customer, agent, fields) => {
  if (!VAR_AT_END_RE.test(url || "")) return null;
  const value = buildTemplateParams(url, customer, agent, fields)[0] ?? "";
  return isStoreLink(url) ? linkSuffix(url, value) : encodeURIComponent(value);
};

// The buttons as this patient gets them — in the order Meta approved them
// (Quick Replies grouped), links filled in — plus the per-button values an
// approved template needs at send time: a personalised link's ending and a
// Copy code button's code. Each value names its button by position.
const buildButtons = (buttons, customer, agent, fields) => {
  const ordered = groupButtons(Array.isArray(buttons) ? buttons : []);
  const resolved = ordered.map((b) => {
    const value = b.type === "URL" ? linkValue(b.url, customer, agent, fields) : null;
    return value === null ? b : { ...b, url: b.url.replace(VAR_AT_END_RE, value) };
  });
  const params = [];
  ordered.forEach((b, i) => {
    if (b.type === "URL") {
      const value = linkValue(b.url, customer, agent, fields);
      if (value !== null) params.push({ type: "button", sub_type: "url", index: String(i), parameters: [{ type: "text", text: value }] });
    } else if (b.type === "COPY_CODE" && b.code) {
      params.push({ type: "button", sub_type: "copy_code", index: String(i), parameters: [{ type: "coupon_code", coupon_code: b.code }] });
    }
  });
  return { resolved, params };
};

// ── Is this template ready to send? ─────────────────────────────────────────
//
// A template imported from Meta (utils/templateImport.js) can arrive in a state
// the send code cannot fill in: positional {{1}} variables nobody has said the
// meaning of, or a media header whose only file is Meta's own sample link —
// those expire, and a send whose header link is dead fails at Meta. Both are
// refused here, in the one function every send path goes through.

const POSITIONAL_VAR_RE = /\{\{\s*\d+\s*\}\}/;
const MEDIA_HEADERS = ["IMAGE", "VIDEO", "DOCUMENT"];

// Meta's CDN hosts for the example files it shows in WhatsApp Manager. A link
// on one of them is a sample of Meta's, not a file of ours.
const META_SAMPLE_HOST_RE = /^https?:\/\/[^/?#]*(whatsapp\.net|fbcdn\.net|fbsbx\.com)(?:[/?#:]|$)/i;
const isMetaSampleUrl = (url) => META_SAMPLE_HOST_RE.test(String(url || ""));
const usableMediaUrl = (url) => /^https?:\/\//i.test(String(url || "")) && !isMetaSampleUrl(url);

// [] when ready; otherwise what is missing — "variables" and/or "media".
const templateNeedsSetup = (template) => {
  const needs = [];
  const headerText = template.headerType === "TEXT" ? template.header : null;
  if (POSITIONAL_VAR_RE.test(template.body || "") || POSITIONAL_VAR_RE.test(headerText || "")) needs.push("variables");
  const cards = Array.isArray(template.cards) ? template.cards : [];
  if (
    (MEDIA_HEADERS.includes(template.headerType) && !usableMediaUrl(template.headerMediaUrl)) ||
    cards.some((c) => !usableMediaUrl(c?.mediaUrl))
  ) {
    needs.push("media");
  }
  return needs;
};

const assertTemplateReady = (template) => {
  const needs = templateNeedsSetup(template);
  if (needs.includes("variables")) {
    throw new AppError(
      `"${template.name}" is an imported template with variables that aren't set up yet — open it in Templates and choose what each one means.`,
      409,
      "TEMPLATE_NEEDS_SETUP",
    );
  }
  if (needs.includes("media")) {
    const what = MEDIA_HEADERS.includes(template.headerType) ? template.headerType.toLowerCase() : "card media";
    throw new AppError(
      `"${template.name}" has no ${what} file of its own yet (Meta's sample links expire) — open it in Templates and choose the file to send.`,
      409,
      "TEMPLATE_NEEDS_MEDIA",
    );
  }
};

/**
 * @param template a Template row
 * @param customer a Customer row (or any { name } shape, for a sample render)
 * @param agent    the acting user, for {{agent_name}} — null in campaigns
 * @param opts.fields  what the agent typed for the template's fill-in blanks
 *   ({ date, time, … } — see FILL_INS in templateVars.js). Every blank the
 *   template uses must be given, so campaigns and flows (which have nobody
 *   to type them) can never send such a template.
 * @param opts.cardPayload  (cardIndex, button) => the payload a carousel card's
 *   quick-reply tap reports back. Default "cb:<card>:<button id>", which is how
 *   a flow's Start step tells WHICH card was tapped (titles often repeat —
 *   every card may say "Interested"). Flows pass their own run-scoped payload.
 */
const defaultCardPayload = (i, b) => `cb:${i}:${b.id}`;

const buildTemplateSend = (template, customer, agent = null, { cardPayload = defaultCardPayload, fields = null } = {}) => {
  // Every send path builds its message here, so this one check covers the
  // inbox, campaigns, test sends and flows alike.
  assertTemplateReady(template);
  const missing = fillInsOf(template).filter((k) => !String(fields?.[k] ?? "").trim());
  if (missing.length) {
    throw new AppError(
      `Fill in ${missing.map((k) => FILL_INS[k].label.toLowerCase()).join(", ")} before sending "${template.name}"`,
      400,
      "TEMPLATE_FILL_INS_MISSING",
      { missing },
    );
  }
  const resolvedBody = resolveNamedVars(template.body, customer, agent, fields);
  const resolvedHeader =
    template.headerType === "TEXT" && template.header
      ? resolveNamedVars(template.header, customer, agent, fields)
      : null;

  const hasButtons =
    template.buttons && Array.isArray(template.buttons) && template.buttons.length > 0;
  const { resolved: buttons, params: buttonParams } = buildButtons(template.buttons, customer, agent, fields);

  // A Meta-approved TEMPLATE send is the only shape that can open a new
  // conversation. Anything else goes out as an ad-hoc INTERACTIVE/TEXT
  // message, which Meta only accepts inside an open 24-hour window.
  const needsMetaTemplate =
    template.category !== "GENERAL" &&
    template.approvalStatus === "APPROVED" &&
    !!template.metaTemplateName;

  const messageType = needsMetaTemplate ? "TEMPLATE" : hasButtons ? "INTERACTIVE" : "TEXT";

  const cards = Array.isArray(template.cards) && template.cards.length ? template.cards : null;

  const templateContent = JSON.stringify({
    headerType: template.headerType,
    header: resolvedHeader || undefined,
    headerMediaUrl: template.headerMediaUrl || undefined,
    body: resolvedBody,
    footer: template.footer || undefined,
    buttons: hasButtons ? buttons : undefined,
    // Carousel: what the inbox renders as swipeable cards.
    cards: cards || undefined,
  });

  // Positional params matching the submitted Meta template (order of appearance).
  const templateVariables = buildTemplateParams(template.body, customer, agent, fields);
  // The header's own positional value (at most one), sent as a header component.
  const headerVariables =
    template.headerType === "TEXT" && template.header ? buildTemplateParams(template.header, customer, agent, fields) : [];

  return {
    resolvedBody,
    resolvedHeader,
    hasButtons,
    needsMetaTemplate,
    messageType,
    templateContent,
    templateVariables,
    headerVariables,
    // Spread straight into sendWhatsAppMessage alongside `to`.
    sendArgs: {
      content: resolvedBody,
      messageType,
      buttons: hasButtons ? buttons : null,
      buttonParams,
      headerType: template.headerType,
      header: resolvedHeader,
      headerMediaUrl: template.headerMediaUrl || null,
      footer: template.footer || null,
      templateName: template.metaTemplateName,
      language: template.language,
      templateVariables,
      headerVariables,
      // Every card's media must be sent again at send time (Meta's rule), and
      // each quick reply gets the payload its tap will report.
      carouselCards: cards
        ? cards.map((c, i) => ({
            mediaType: c.mediaType,
            mediaUrl: c.mediaUrl,
            quickReplyPayloads: c.buttons.map((b) => (b.type === "QUICK_REPLY" ? cardPayload(i, b) : null)),
          }))
        : null,
    },
  };
};

// The blanks a template needs filled at send time, as { key, label } — for
// the API's template list, so the chat's picker can ask for them.
const fillInFields = (template) => fillInsOf(template).map((key) => ({ key, label: FILL_INS[key].label }));

module.exports = { linkSuffix, isStoreLink, fillInFields, buildTemplateSend, templateNeedsSetup, assertTemplateReady, isMetaSampleUrl };
