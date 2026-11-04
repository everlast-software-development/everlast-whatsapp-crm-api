const { parsePhoneNumberFromString } = require("libphonenumber-js");

// Meta per-message rates (USD), by the RECIPIENT's country and the message's
// pricing category. Meta charges on delivery.
//
// Service messages (free-form replies inside the 24-hour window, from an agent
// or a flow) are charged since October 1, 2026, at the market's utility rate —
// after each phone number's first SERVICE_FREE_PER_MONTH in a month.
//
// Meta revises these: verify against WhatsApp Manager → Billing (or Meta's
// rate-card CSV) and update here. EG: effective Jan 1, 2026. AE: July 1, 2025
// (the same values as the campaign wizard's estimate).
const RATES_USD = {
  EG: { marketing: 0.0644, utility: 0.0036, authentication: 0.0036, service: 0.0036 },
  AE: { marketing: 0.0384, utility: 0.0157, authentication: 0.0178, service: 0.0157 },
};

// Free service messages per business phone number per calendar month (Meta's
// count; unused ones don't carry over or move to another number).
const SERVICE_FREE_PER_MONTH = 1000;

// The month boundaries spend is counted in. Meta resets on the WhatsApp
// Business Account's timezone; the clinic's accounts run on Dubai time.
const BILLING_TZ = "Asia/Dubai";

const countryOf = (phone) => {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(String(phone).startsWith("+") ? phone : `+${phone}`);
  return parsed?.country || null;
};

// null when the country or category has no known rate — shown as "no rate",
// never silently counted as free.
const rateFor = (country, category) => {
  const rate = RATES_USD[country]?.[category];
  return rate === undefined ? null : rate;
};

module.exports = { RATES_USD, SERVICE_FREE_PER_MONTH, BILLING_TZ, countryOf, rateFor };
