// The first website templates (Templates → Website → "Create the drafts"):
// one per kind × language, from the texts the store's staff wrote, made fit
// for WhatsApp:
//   - the {link} becomes a button (the store sends it; buttons are built on
//     the store address in Website settings), so ": {link}" leaves the text;
//   - a template can't end with a blank, so {spin} moves inside the text and
//     the offer gets a closing line.
// They're drafts: an admin reads them, then sends each for approval.

const STARTER_TEMPLATES = [
  {
    kind: "abandoned_cart",
    en: { body: "Hi {{first_name}}, {{treatment}} is still waiting in your Everlast Wellness cart. Book it before your spot is gone.", button: "Book now" },
    ar: { body: "مرحبًا {{first_name}}، ما زال {{treatment}} في سلتك في إيفرلاست ويلنس. احجزه قبل أن يُحجز موعدك.", button: "احجز الآن" },
  },
  {
    kind: "points_expiring",
    en: { body: "Hi {{first_name}}, {{points}} of your Everlast Wellness points expire on {{date}}. Use them on your next treatment.", button: "Use my points" },
    ar: { body: "مرحبًا {{first_name}}، تنتهي {{points}} من نقاطك في إيفرلاست ويلنس في {{date}}. استخدمها في علاجك القادم.", button: "استخدم نقاطي" },
  },
  {
    kind: "rebooking",
    en: { body: "Hi {{first_name}}, it’s time for your next {{treatment}}. Book your session at Everlast Wellness.", button: "Book my session" },
    ar: { body: "مرحبًا {{first_name}}، حان موعد جلسة {{treatment}} القادمة. احجز جلستك في إيفرلاست ويلنس.", button: "احجز جلستي" },
  },
  {
    kind: "review_request",
    en: { body: "Hi {{first_name}}, how was your {{treatment}}? {{spin}} Tell us in a quick review.", button: "Write a review" },
    ar: { body: "مرحبًا {{first_name}}، كيف كانت جلسة {{treatment}}؟ {{spin}} أخبرنا في تقييم سريع.", button: "اكتب تقييمًا" },
  },
  {
    kind: "offer_announcement",
    en: { body: "Hi {{first_name}}, {{offer}} is on at Everlast Wellness until {{ends}}. Tap below to see the offers.", button: "See the offers" },
    ar: { body: "مرحبًا {{first_name}}، عرض {{offer}} متاح الآن في إيفرلاست ويلنس حتى {{ends}}. اضغط أدناه لمشاهدة العروض.", button: "شاهد العروض" },
  },
  {
    kind: "gift_received",
    en: { body: "Hi {{first_name}}, {{sender}} sent you a gift at Everlast Wellness! Tap below to see it.", button: "See my gift" },
    ar: { body: "مرحبًا {{first_name}}، أرسل لك {{sender}} هدية في إيفرلاست ويلنس! اضغط أدناه لمشاهدتها.", button: "شاهد هديتي" },
  },
  {
    kind: "subscription_failed",
    en: { body: "Hi {{first_name}}, we couldn’t take the {{amount}} payment for your {{treatment}} subscription. Pay or change your card below.", button: "Pay or change card" },
    ar: { body: "مرحبًا {{first_name}}، لم نتمكن من تحصيل مبلغ {{amount}} لاشتراكك في {{treatment}}. ادفع أو غيّر بطاقتك من الزر أدناه.", button: "ادفع أو غيّر البطاقة" },
  },
];

module.exports = { STARTER_TEMPLATES };
