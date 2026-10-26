// Template content rules, shared by the create/edit endpoints and the
// "Import from Meta" mapping (utils/templateImport.js). Pure: no DB, no Meta,
// so the import mapping can be checked against exactly what the editor allows.

const AppError = require("./AppError");
const { listPlaceholders, SUPPORTED_VARS } = require("./templateVars");

const HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"];
const BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER"];
const PLACEHOLDER_RE = /\{\{\s*[a-z0-9_]+\s*\}\}/gi;

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

// Validate buttons against WhatsApp's real rules: max 3 total, titles ≤25
// chars with no placeholders, and Quick Reply buttons can't be mixed with
// Call/URL buttons — it's one or the other, matching Meta's own constraint.
const validateButtons = (buttons) => {
  if (!buttons) return null;
  if (!Array.isArray(buttons)) throw new AppError("buttons must be an array", 400);
  if (buttons.length === 0) return null;
  if (buttons.length > 3) throw new AppError("Maximum 3 buttons allowed", 400);

  const types = new Set();
  let urlCount = 0;
  let phoneCount = 0;

  const cleaned = buttons.map((b) => {
    const title = String(b?.title ?? "").trim();
    if (!b?.id || !title) throw new AppError("Each button needs an id and a title", 400);
    if (title.length > 25) throw new AppError(`Button title "${title}" exceeds 25 characters`, 400);
    if (PLACEHOLDER_RE.test(title)) throw new AppError("Button titles can't contain placeholders", 400);

    const type = b.type || "QUICK_REPLY";
    if (!BUTTON_TYPES.includes(type)) throw new AppError(`Invalid button type "${type}"`, 400);
    types.add(type);

    if (type === "PHONE_NUMBER") {
      phoneCount++;
      const phoneNumber = String(b.phoneNumber ?? "").trim();
      if (!phoneNumber) throw new AppError("A phone number is required for a Call Number button", 400);
      if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) throw new AppError(`"${phoneNumber}" isn't a valid phone number`, 400);
      return { id: b.id, type, title, phoneNumber };
    }
    if (type === "URL") {
      urlCount++;
      const url = String(b.url ?? "").trim();
      if (!url) throw new AppError("A URL is required for a URL button", 400);
      if (!/^https?:\/\//i.test(url)) throw new AppError("Button URL must start with http:// or https://", 400);
      const placeholders = url.match(PLACEHOLDER_RE) || [];
      if (placeholders.length > 1) throw new AppError("A URL button can have at most 1 placeholder", 400);
      return { id: b.id, type, title, url };
    }
    return { id: b.id, type: "QUICK_REPLY", title };
  });

  if (types.has("QUICK_REPLY") && types.size > 1) {
    throw new AppError("Buttons can't mix Quick Reply with Call Number/URL buttons — use one or the other", 400);
  }
  if (phoneCount > 1) throw new AppError("Only 1 Call Number button is allowed per template", 400);
  if (urlCount > 2) throw new AppError("A maximum of 2 URL buttons is allowed per template", 400);

  return cleaned;
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
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER_RE.source, "i"); // non-global: .test() keeps no state

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
  validateCards,
};
