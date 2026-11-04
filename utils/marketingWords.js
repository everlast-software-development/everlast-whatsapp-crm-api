// Offer wording that makes a template marketing. Patient-care (UTILITY)
// templates are refused when they contain any of it: Meta re-classifies such a
// template as MARKETING (it then costs more, and opted-out patients can't get
// it), and a "reminder" with an offer in it is exactly what an opted-out
// patient must not receive. The frontend keeps the same list
// (everlast-crm/lib/marketingWords.ts) to warn while typing.

// English: whole words / phrases, case-insensitive.
const EN = [
  "offer", "offers", "discount", "discounts", "sale", "sales", "promo", "promotion", "promotions",
  // Not "free" alone ("feel free to call us") or "save" ("save the date").
  "deal", "deals", "coupon", "voucher", "for free", "free consultation", "free session", "free of charge",
  "gift", "cashback", "bonus", "savings",
  "% off", "off on", "limited time", "limited offer", "special price", "special offer", "best price",
  "lowest price", "exclusive", "flash sale", "black friday", "anniversary", "celebrate", "hurry",
  "don't miss", "dont miss", "last chance", "book now and", "buy", "package", "packages",
];
// Arabic: substrings (words take prefixes like ال / و / ب).
const AR = [
  "عرض", "عروض", "خصم", "خصومات", "تخفيض", "تخفيضات", "مجان", "هدية", "هدايا", "كوبون", "قسيمة",
  "لفترة محدودة", "سعر خاص", "أفضل سعر", "اقل سعر", "أقل سعر", "حصري", "باقة", "باقات", "احتفال",
  "لا تفوت", "فرصة", "توفير", "وفر",
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EN_RE = EN.map((w) => [w, new RegExp(`(^|[^a-z])${escape(w)}(?=$|[^a-z])`, "i")]);

/** The offer words found in `text` (as written in the list), [] when none. */
function findMarketingWords(text) {
  const t = String(text || "").replace(/\{\{[^{}]*\}\}/g, " ");
  const found = new Set();
  for (const [w, re] of EN_RE) if (re.test(t)) found.add(w);
  for (const w of AR) if (t.includes(w)) found.add(w);
  // "20%" / "٪20" — a percentage is almost always a discount.
  if (/\d\s*[%٪]|[%٪]\s*\d/.test(t)) found.add("%");
  return [...found];
}

module.exports = { findMarketingWords };
