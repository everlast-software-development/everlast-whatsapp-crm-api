// Template content rules, shared by the create/edit endpoints and the
// "Import from Meta" mapping (utils/templateImport.js). Pure: no DB, no Meta,
// so the import mapping can be checked against exactly what the editor allows.

const AppError = require("./AppError");
const { listPlaceholders, SUPPORTED_VARS } = require("./templateVars");

const HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"];
const BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"];
const PLACEHOLDER_RE = /\{\{\s*[a-z0-9_]+\s*\}\}/gi;
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER_RE.source, "i"); // non-global: .test() keeps no state

// Meta rejects a text header containing newlines, emojis or WhatsApp
// formatting characters. Placeholders are removed first — the underscore in
// {{customer_name}} is fine, it becomes {{1}} before Meta sees it.
const HEADER_FORBIDDEN_RE = /[\r\n*_~`]|\p{Extended_Pictographic}/u;
const headerCharError = (text) => {
  const bad = text.replace(/\{\{[^{}]*\}\}/g, "").match(HEADER_FORBIDDEN_RE);
  return bad
    ? `The header can't contain "${bad[0] === "\n" ? "a new line" : bad[0]}" — Meta doesn't allow newlines, emojis or formatting characters (* _ ~ \`) in a header`
    : null;
};

// Validate the header type/content combination. Returns the clean triple to
// persist — {headerType, header, headerMediaUrl} — so switching types never
// leaves a stale value from the previous type behind.
function validateHeader(headerType, header, headerMediaUrl) {
  const type = headerType || "NONE";
  if (!HEADER_TYPES.includes(type)) {
    throw new AppError(`Invalid headerType. Must be one of: ${HEADER_TYPES.join(", ")}`, 400);
  }
  if (type === "NONE") return { headerType: "NONE", header: null, headerMediaUrl: null };
  if (type === "TEXT") {
    const text = (header || "").trim();
    if (!text) throw new AppError("Header text is required when the header type is Text", 400);
    if (text.length > 60) throw new AppError("Header text must be 60 characters or fewer", 400);
    const charErr = headerCharError(text);
    if (charErr) throw new AppError(charErr, 400);
    // Meta allows exactly one variable in a text header.
    const vars = listPlaceholders(text);
    if (vars.length > 1) throw new AppError("A text header can have at most 1 placeholder", 400);
    if (vars.length === 1 && !SUPPORTED_VARS.includes(vars[0].toLowerCase())) {
      throw new AppError(`Unknown placeholder {{${vars[0]}}} in the header. Use one of: ${SUPPORTED_VARS.join(", ")}`, 400);
    }
    return { headerType: "TEXT", header: text, headerMediaUrl: null };
  }
  // IMAGE / VIDEO / DOCUMENT — a sample media URL is required so Meta can
  // generate the media handle needed for approval.
  const url = (headerMediaUrl || "").trim();
  if (!url) throw new AppError(`A sample ${type.toLowerCase()} URL is required for a ${type.toLowerCase()} header`, 400);
  if (!/^https?:\/\//i.test(url)) throw new AppError("Header media URL must start with http:// or https://", 400);
  return { headerType: type, header: null, headerMediaUrl: url };
}

// Meta's button rules (Cloud API template components):
// - up to 10 buttons in all: Quick Reply ≤10, URL ≤2, Call Number ≤1, Copy
//   code ≤1. WhatsApp shows two of them and folds the rest under "See all
//   options" once there are more than three;
// - Quick Reply and the other kinds can share a template, but the Quick
//   Replies must sit together (QR, QR, URL — not QR, URL, QR);
// - titles ≤25 characters, no placeholders; a URL may end with ONE
//   placeholder ({{first_name}} etc.), filled in per patient at send time;
// - a Copy code button has a fixed label and carries the code (≤15 letters
//   or digits) the patient copies.
const BUTTON_LIMITS = { total: 10, QUICK_REPLY: 10, URL: 2, PHONE_NUMBER: 1, COPY_CODE: 1 };
const COPY_CODE_TITLE = "Copy offer code";
const BUTTON_LABELS = { QUICK_REPLY: "Quick Reply", URL: "URL", PHONE_NUMBER: "Call Number", COPY_CODE: "Copy code" };

// Keeps the Quick Replies together, in the order they were added, on the side
// of whichever kind comes first — the order Meta accepts.
const groupButtons = (buttons) => {
  if (!buttons.length) return buttons;
  const isQr = (b) => b.type === "QUICK_REPLY";
  const qr = buttons.filter(isQr);
  const other = buttons.filter((b) => !isQr(b));
  return isQr(buttons[0]) ? [...qr, ...other] : [...other, ...qr];
};

const validateButtons = (buttons) => {
  if (!buttons) return null;
  if (!Array.isArray(buttons)) throw new AppError("buttons must be an array", 400);
  if (buttons.length === 0) return null;
  if (buttons.length > BUTTON_LIMITS.total) throw new AppError(`Maximum ${BUTTON_LIMITS.total} buttons allowed`, 400);

  const counts = {};
  const cleaned = buttons.map((b) => {
    const type = b?.type || "QUICK_REPLY";
    if (!BUTTON_TYPES.includes(type)) throw new AppError(`Invalid button type "${type}"`, 400);
    counts[type] = (counts[type] || 0) + 1;
    if (counts[type] > BUTTON_LIMITS[type]) {
      throw new AppError(`A template can have at most ${BUTTON_LIMITS[type]} ${BUTTON_LABELS[type]} button${BUTTON_LIMITS[type] > 1 ? "s" : ""}`, 400);
    }
    if (!b?.id) throw new AppError("Each button needs an id", 400);

    if (type === "COPY_CODE") {
      const code = String(b.code ?? "").trim();
      if (!code) throw new AppError("A Copy code button needs the code to copy", 400);
      if (!/^[A-Za-z0-9]{1,15}$/.test(code)) throw new AppError(`The offer code "${code}" must be 1–15 letters or digits, no spaces`, 400);
      return { id: b.id, type, title: COPY_CODE_TITLE, code };
    }

    const title = String(b?.title ?? "").trim();
    if (!title) throw new AppError("Each button needs a title", 400);
    if (title.length > 25) throw new AppError(`Button title "${title}" exceeds 25 characters`, 400);
    if (HAS_PLACEHOLDER.test(title)) throw new AppError("Button titles can't contain placeholders", 400);

    if (type === "PHONE_NUMBER") {
      const phoneNumber = String(b.phoneNumber ?? "").trim();
      if (!phoneNumber) throw new AppError("A phone number is required for a Call Number button", 400);
      if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) throw new AppError(`"${phoneNumber}" isn't a valid phone number`, 400);
      return { id: b.id, type, title, phoneNumber };
    }
    if (type === "URL") {
      const url = String(b.url ?? "").trim();
      if (!url) throw new AppError("A URL is required for a URL button", 400);
      if (!/^https?:\/\//i.test(url)) throw new AppError("Button URL must start with http:// or https://", 400);
      if (url.length > 2000) throw new AppError("A button URL can be at most 2000 characters", 400);
      const vars = listPlaceholders(url);
      if (vars.length > 1) throw new AppError("A URL button can have at most 1 placeholder", 400);
      if (vars.length === 1) {
        if (!SUPPORTED_VARS.includes(vars[0].toLowerCase())) {
          throw new AppError(`Unknown placeholder {{${vars[0]}}} in "${title}". Use one of: ${SUPPORTED_VARS.join(", ")}`, 400);
        }
        if (!/\{\{[^{}]*\}\}$/.test(url)) throw new AppError(`The placeholder in "${title}"'s link must be at the very end of the URL (Meta's rule)`, 400);
      }
      return { id: b.id, type, title, url };
    }
    return { id: b.id, type: "QUICK_REPLY", title };
  });

  return groupButtons(cleaned);
};

// Carousel cards, validated against Meta's media-card carousel rules: 2–10
// cards, every card the SAME shape (same media type, same button types in the
// same order — Meta rejects a carousel whose cards differ), card text ≤160
// characters, 1–2 buttons per card (Quick Reply and/or URL). Button ids are
// normalized to their position (b0, b1): a tap on card 3's first button is
// then "card 2, b0" everywhere — at send time, in flows, in the inbox.
const CARD_MEDIA_TYPES = ["IMAGE", "VIDEO"];
const CARD_BUTTON_TYPES = ["QUICK_REPLY", "URL"];
const CARD_BODY_MAX = 160;

function validateCards(cards) {
  if (cards === undefined || cards === null) return null;
  if (!Array.isArray(cards)) throw new AppError("cards must be an array", 400);
  if (cards.length < 2 || cards.length > 10) throw new AppError("A carousel needs between 2 and 10 cards", 400);

  const shape = (c) => `${c.mediaType}|${(c.buttons || []).map((b) => b.type || "QUICK_REPLY").join(",")}`;
  const cleaned = cards.map((c, i) => {
    const n = i + 1;
    const mediaType = c?.mediaType || "IMAGE";
    if (!CARD_MEDIA_TYPES.includes(mediaType)) throw new AppError(`Card ${n}: media must be an image or a video`, 400);
    const mediaUrl = String(c?.mediaUrl || "").trim();
    if (!/^https?:\/\//i.test(mediaUrl)) throw new AppError(`Card ${n} needs its ${mediaType.toLowerCase()}`, 400);
    const body = String(c?.body || "").trim();
    if (!body) throw new AppError(`Card ${n} needs some text`, 400);
    if (body.length > CARD_BODY_MAX) throw new AppError(`Card ${n}'s text is ${body.length} characters — the limit is ${CARD_BODY_MAX}`, 400);
    if (HAS_PLACEHOLDER.test(body)) throw new AppError(`Card ${n}: placeholders aren't supported in card text`, 400);
    const buttons = Array.isArray(c?.buttons) ? c.buttons : [];
    if (buttons.length < 1 || buttons.length > 2) throw new AppError(`Card ${n} needs 1 or 2 buttons`, 400);
    return {
      mediaType,
      mediaUrl,
      body,
      buttons: buttons.map((b, j) => {
        const type = b?.type || "QUICK_REPLY";
        if (!CARD_BUTTON_TYPES.includes(type)) throw new AppError(`Card ${n}: buttons can be Quick Reply or URL`, 400);
        const title = String(b?.title || "").trim();
        if (!title) throw new AppError(`Card ${n}: every button needs a title`, 400);
        if (title.length > 25) throw new AppError(`Card ${n}: button "${title}" exceeds 25 characters`, 400);
        if (HAS_PLACEHOLDER.test(title)) throw new AppError("Button titles can't contain placeholders", 400);
        if (type === "URL") {
          const url = String(b?.url || "").trim();
          if (!/^https?:\/\//i.test(url)) throw new AppError(`Card ${n}: "${title}" needs a link starting with https://`, 400);
          if (HAS_PLACEHOLDER.test(url)) throw new AppError(`Card ${n}: placeholders aren't supported in card links`, 400);
          return { id: `b${j}`, type, title, url };
        }
        return { id: `b${j}`, type, title };
      }),
    };
  });
  const first = shape(cleaned[0]);
  const odd = cleaned.findIndex((c) => shape(c) !== first);
  if (odd !== -1) {
    throw new AppError(
      `Card ${odd + 1} is laid out differently from card 1 — every card needs the same media type and the same buttons in the same order`,
      400,
    );
  }
  return cleaned;
}

module.exports = {
  HEADER_TYPES,
  BUTTON_TYPES,
  PLACEHOLDER_RE,
  headerCharError,
  validateHeader,
  validateButtons,
  groupButtons,
  validateCards,
  BUTTON_LIMITS,
  COPY_CODE_TITLE,
};
