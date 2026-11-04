const axios = require("axios");
const numbers = require("./whatsappNumbers");

// Meta's own count of service messages (free-form replies in the 24-hour
// window) each line sent in a period, from the WABA's pricing_analytics.
//
// The Spending page counts service messages from our Message rows, which
// undercounts as soon as messages are deleted — but Meta's free allowance
// (1,000 per line per month) is used up all the same. This is the authority
// for that allowance. A line whose token can't read its WABA (the US account)
// simply has no Meta count, and the page falls back to ours.
//
// pricing_analytics needs v21+; the send path's WHATSAPP_API_VERSION can be
// older, so this pins its own.
const ANALYTICS_API_VERSION = "v23.0";
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // `${wabaId}|${from}|${to}` → { at, counts }

const digits = (p) => String(p || "").replace(/\D/g, "");

// One WABA: phone digits → service messages. Throws on any Meta error.
async function fetchWabaServiceCounts(wabaId, accessToken, from, to) {
  const start = Math.floor(from.getTime() / 1000);
  const end = Math.floor(Math.min(to.getTime(), Date.now()) / 1000);
  const fields = `pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PHONE"])`;
  const res = await axios.get(`https://graph.facebook.com/${ANALYTICS_API_VERSION}/${wabaId}`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 8000,
  });
  const counts = new Map();
  for (const series of res.data?.pricing_analytics?.data || []) {
    for (const p of series.data_points || []) {
      if (String(p.pricing_category).toUpperCase() !== "SERVICE") continue;
      const phone = digits(p.phone_number);
      counts.set(phone, (counts.get(phone) || 0) + (Number(p.volume) || 0));
    }
  }
  return counts;
}

/**
 * Line id → Meta's service-message count for [from, to). Lines Meta couldn't
 * answer for are left out. Never throws: the page must load without Meta.
 */
async function serviceCountsByLine(lines, from, to) {
  const result = new Map();
  if (from.getTime() > Date.now()) return result;
  const byWaba = new Map();
  for (const l of lines) {
    if (!l.wabaId || !l.displayPhoneNumber) continue;
    if (!byWaba.has(l.wabaId)) byWaba.set(l.wabaId, []);
    byWaba.get(l.wabaId).push(l);
  }
  await Promise.all(
    [...byWaba.entries()].map(async ([wabaId, wabaLines]) => {
      const key = `${wabaId}|${from.toISOString()}|${to.toISOString()}`;
      let entry = cache.get(key);
      if (!entry || Date.now() - entry.at > CACHE_MS) {
        try {
          const { accessToken } = await numbers.getCredentials(wabaLines[0]);
          entry = { at: Date.now(), counts: await fetchWabaServiceCounts(wabaId, accessToken, from, to) };
        } catch (err) {
          console.warn(`metaUsage: no Meta usage for WABA ${wabaId} (${err.response?.data?.error?.message || err.message})`);
          entry = { at: Date.now(), counts: null };
        }
        cache.set(key, entry);
      }
      if (!entry.counts) return;
      for (const l of wabaLines) result.set(l.id, entry.counts.get(digits(l.displayPhoneNumber)) || 0);
    }),
  );
  return result;
}

module.exports = { serviceCountsByLine };
