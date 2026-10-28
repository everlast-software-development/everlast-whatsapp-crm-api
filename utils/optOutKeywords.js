// What a patient writes to stop (or restart) marketing messages, in English and
// Arabic. Used by the inbound webhook (modules/webhooks/webhook.controller.js).
//
// A message counts only when, once tidied up, it IS one of the phrases below —
// optionally with a "please" / "thanks" around it. Anything longer is a normal
// message: "I want to stop the pain" or "stop the treatment?" never opts out.
//
// Deliberately NOT here: CANCEL / END / QUIT, and Arabic «إلغاء» on its own. At
// a clinic those almost always mean an appointment; treating them as an opt-out
// would silently stop every future campaign to that patient. «إلغاء الاشتراك»
// (unsubscribe) is clear and is here.

// Arabic letters that are written several ways are folded to one, so «إيقاف»,
// «ايقاف» and «أيقاف» all match; diacritics and tatweel are dropped.
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "") // harakat, superscript alef, tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // punctuation and emoji
    .replace(/\s+/g, " ")
    .trim();
}

// Polite words around the keyword that don't change what it means.
const FILLERS = [
  "please", "pls", "plz", "thanks", "thank you", "thx", "now",
  "من فضلك", "لو سمحت", "لو سمحتي", "شكرا", "شكرا لك", "الان", "حالا", "رجاء", "يا ريت",
];

// Stop on THIS line (the number the patient wrote to).
const OPT_OUT = [
  // English
  "stop", "unsubscribe", "opt out", "optout", "stop promotions", "stop promotion",
  "stop messages", "stop messaging", "stop sending", "stop offers", "remove me",
  "no more messages", "no more offers",
  // Arabic
  "توقف", "اوقف", "ايقاف", "وقف", "ستوب",
  "الغاء الاشتراك", "الغي الاشتراك", "الغاء اشتراكي",
  "ايقاف الرسايل", "ايقاف الرسائل", "اوقف الرسائل", "اوقفوا الرسائل", "وقف الرسائل",
  "ايقاف العروض", "ايقاف العروض الترويجيه", "اوقف العروض",
  "لا اريد رسائل", "لا اريد عروض", "لا ارغب في الرسائل", "لا ترسلوا رسائل", "لا ترسل رسائل",
  "مش عايز رسايل", "مش عاوز رسايل", "مش عايزه رسايل",
];

// Stop on EVERY line.
const OPT_OUT_ALL = ["stopall", "stop all", "unsubscribe all", "ايقاف الكل", "الغاء الاشتراك من الكل", "اوقف الكل"];

// Start again.
const OPT_IN = [
  "start", "unstop", "subscribe", "resume", "resume promotions", "opt in", "optin",
  "اشتراك", "اشترك", "ابدا", "تفعيل", "استيناف", "رجوع الاشتراك", "اعاده الاشتراك",
];

const toSet = (list) => new Set(list.map(normalize));
const SETS = { OUT: toSet(OPT_OUT), OUT_ALL: toSet(OPT_OUT_ALL), IN: toSet(OPT_IN) };
const FILLER_RE = new RegExp(
  `(^| )(${FILLERS.map(normalize).sort((a, b) => b.length - a.length).join("|")})(?= |$)`,
  "g",
);

/**
 * "OUT_ALL" (stop every line), "OUT" (stop this line), "IN" (start again) or
 * null for an ordinary message.
 */
function detectOptIntent(content) {
  const text = normalize(content);
  if (!text || text.split(" ").length > 6) return null;
  const core = text.replace(FILLER_RE, " ").replace(/\s+/g, " ").trim();
  for (const candidate of [text, core]) {
    if (!candidate) continue;
    if (SETS.OUT_ALL.has(candidate)) return "OUT_ALL";
    if (SETS.OUT.has(candidate)) return "OUT";
    if (SETS.IN.has(candidate)) return "IN";
  }
  return null;
}

// Arabic script anywhere → answer in Arabic.
const isArabic = (text) => /[؀-ۿ]/.test(String(text || ""));

// What the patient is told once it's recorded. Plain text inside the 24-hour
// window they just opened, so it's free and needs no template.
function confirmationText(intent, content) {
  const ar = isArabic(content);
  if (intent === "IN") {
    return ar
      ? "تم تفعيل الاشتراك ✅ ستصلك عروضنا وأخبارنا من جديد. لإيقافها أرسل «توقف»."
      : "You're subscribed again ✅ You'll receive our offers and news. Reply STOP to unsubscribe.";
  }
  if (intent === "OUT_ALL") {
    return ar
      ? "تم إلغاء اشتراكك من جميع أرقامنا ✅ لن تصلك رسائل ترويجية بعد الآن. لإعادة الاشتراك أرسل «اشتراك»."
      : "You've been unsubscribed from all our numbers ✅ You won't receive promotional messages any more. Reply START to subscribe again.";
  }
  return ar
    ? "تم إلغاء اشتراكك ✅ لن تصلك رسائل ترويجية بعد الآن، وما زال بإمكانك مراسلتنا في أي وقت. لإعادة الاشتراك أرسل «اشتراك»."
    : "You've been unsubscribed ✅ You won't receive promotional messages any more — you can still message us any time. Reply START to subscribe again.";
}

// Exact forms for the marketing report's SQL (UPPER(TRIM(content)) IN (...)),
// which credits an opt-out to the campaign whose message the patient answered.
const EXACT_OPT_OUT_WORDS = [...new Set([...OPT_OUT, ...OPT_OUT_ALL].flatMap((w) => [w.toUpperCase(), w]))];

module.exports = { detectOptIntent, confirmationText, normalize, EXACT_OPT_OUT_WORDS };
