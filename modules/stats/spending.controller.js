const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { RATES_USD, SERVICE_FREE_PER_MONTH, BILLING_TZ, countryOf, rateFor } = require("../../utils/whatsappPricing");

// ─── GET /api/stats/spending?month=YYYY-MM ──────────────────────────────────
// What WhatsApp is costing, per line, for one calendar month: every message we
// sent (agents, flows, campaigns) that Meta delivered, priced by the patient's
// country and the message's category.
//
// - Meta's verdict (the status webhook's pricing block: billable / category /
//   type, stored on each message) decides templates: one Meta marked free
//   (billable false, or a "free_…" type) costs nothing.
// - Service messages (free-form replies in the 24-hour window) get each line's
//   first SERVICE_FREE_PER_MONTH free, counted here in send order, then the
//   rate — see the note in the loop on why Meta's flag isn't enough.
// - A message Meta hasn't priced yet is estimated from its kind (a template
//   whose category isn't known yet stays "not priced yet", never guessed).
// Everything here is an estimate of Meta's invoice; WhatsApp Manager → Billing
// is the authority.

const CHARGED_STATUSES = ["DELIVERED", "READ"];
const CATEGORIES = ["service", "utility", "marketing", "authentication"];

// Minutes the billing timezone is ahead of UTC at `date` (Dubai: +240).
function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - date.getTime()) / 60000);
}
// 00:00 on the 1st of (year, month0) in the billing timezone, as a Date.
function monthStart(year, month0) {
  const guess = new Date(Date.UTC(year, month0, 1));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, BILLING_TZ) * 60000);
}
// "YYYY-MM-DD" of a moment, in the billing timezone.
const dayKey = (date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: BILLING_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const emptyCategory = () => ({ delivered: 0, charged: 0, free: 0, costUsd: 0 });
const emptyBucket = () => ({
  delivered: 0,
  costUsd: 0,
  unpriced: 0, // delivered, but Meta hasn't said what it is yet
  noRate: 0, // billable, but no rate for that country in whatsappPricing.js
  byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, emptyCategory()])),
  // Service messages by who sent them — the part flows can drive up.
  serviceByAgent: 0,
  serviceByFlow: 0,
});
const round = (n) => Number(n.toFixed(4));

const getSpending = async (req, res, next) => {
  try {
    const now = new Date();
    let year;
    let month0;
    if (req.query.month) {
      const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month));
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return next(new AppError("month must look like 2026-11", 400));
      year = Number(m[1]);
      month0 = Number(m[2]) - 1;
    } else {
      const [y, mo] = dayKey(now).split("-").map(Number);
      year = y;
      month0 = mo - 1;
    }
    const from = monthStart(year, month0);
    const to = monthStart(month0 === 11 ? year + 1 : year, (month0 + 1) % 12);

    const [lines, rows, awaitingDelivery] = await Promise.all([
      prisma.whatsAppNumber.findMany({
        select: { id: true, label: true, displayPhoneNumber: true, isActive: true, isDefault: true },
        // The main (default) line first.
        orderBy: [{ isDefault: "desc" }, { id: "asc" }],
      }),
      prisma.message.findMany({
        where: {
          senderType: { in: ["AGENT", "BOT"] },
          status: { in: CHARGED_STATUSES },
          createdAt: { gte: from, lt: to },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          createdAt: true,
          senderType: true,
          messageType: true,
          billable: true,
          pricingCategory: true,
          pricingType: true,
          conversation: { select: { whatsappNumberId: true, customer: { select: { phone: true } } } },
        },
      }),
      prisma.message.count({
        where: { senderType: { in: ["AGENT", "BOT"] }, status: "SENT", createdAt: { gte: from, lt: to } },
      }),
    ]);

    const perLine = new Map(lines.map((l) => [l.id, emptyBucket()]));
    const serviceUsed = new Map(); // line id → service messages counted so far (allowance)
    const total = emptyBucket();
    const daily = new Map(); // day → { delivered, costUsd }

    for (const m of rows) {
      const lineId = m.conversation?.whatsappNumberId;
      if (!perLine.has(lineId)) perLine.set(lineId, emptyBucket());
      const bucket = perLine.get(lineId);
      const country = countryOf(m.conversation?.customer?.phone);
      // Meta's category when it has said; otherwise a free-form message is a
      // service message by definition, and a template is not known yet.
      const category = m.pricingCategory || (m.messageType !== "TEMPLATE" ? "service" : null);
      const metaSaysFree = m.billable === false || /^free/i.test(m.pricingType || "");

      let cost = 0;
      let charged = false;
      if (category === "service") {
        if (/entry_point/i.test(m.pricingType || "")) {
          // Opened from an ad or a Page button: free, outside the allowance.
          charged = false;
        } else {
          const used = (serviceUsed.get(lineId) || 0) + 1;
          serviceUsed.set(lineId, used);
          // Meta kept reporting service messages as "free_customer_service,
          // billable false" after the October 2026 change, so its flag can't
          // be trusted to show the 1,001st as charged: the allowance is counted
          // here. Never under-reports; Meta billing one inside it still counts.
          charged = m.billable === true || used > SERVICE_FREE_PER_MONTH;
        }
      } else if (category) {
        // Templates are charged unless Meta marked them free (e.g. an entry
        // point from an ad). Not yet priced by Meta: charged, as they almost
        // always are.
        charged = !metaSaysFree;
      }

      for (const b of [bucket, total]) {
        b.delivered++;
        if (!category) {
          b.unpriced++;
          continue;
        }
        const c = b.byCategory[category] || (b.byCategory[category] = emptyCategory());
        c.delivered++;
        if (category === "service") {
          if (m.senderType === "BOT") b.serviceByFlow++;
          else b.serviceByAgent++;
        }
        if (!charged) {
          c.free++;
          continue;
        }
        c.charged++;
        const rate = rateFor(country, category);
        if (rate === null) {
          b.noRate++;
          continue;
        }
        if (b === bucket) cost = rate;
        c.costUsd += rate;
        b.costUsd += rate;
      }

      const day = dayKey(m.createdAt);
      const d = daily.get(day) || { delivered: 0, costUsd: 0 };
      d.delivered++;
      d.costUsd += cost;
      daily.set(day, d);
    }

    const shape = (b) => ({
      ...b,
      costUsd: round(b.costUsd),
      byCategory: Object.fromEntries(
        Object.entries(b.byCategory).map(([k, v]) => [k, { ...v, costUsd: round(v.costUsd) }]),
      ),
    });

    // A straight-line projection for the month in progress.
    const isCurrent = now >= from && now < to;
    const elapsed = isCurrent ? (now - from) / (to - from) : 1;
    const projectedUsd = isCurrent && elapsed > 0.02 ? round(total.costUsd / elapsed) : round(total.costUsd);

    res.status(200).json({
      success: true,
      data: {
        month: `${year}-${String(month0 + 1).padStart(2, "0")}`,
        from,
        to,
        timeZone: BILLING_TZ,
        isCurrentMonth: isCurrent,
        freeServicePerLine: SERVICE_FREE_PER_MONTH,
        rates: RATES_USD,
        total: { ...shape(total), projectedUsd, awaitingDelivery },
        lines: [...perLine.entries()].map(([id, b]) => {
          const line = lines.find((l) => l.id === id);
          const serviceDelivered = b.byCategory.service.delivered;
          return {
            id,
            label: line?.label ?? "Removed line",
            phone: line?.displayPhoneNumber ?? null,
            isActive: line?.isActive ?? false,
            isDefault: line?.isDefault ?? false,
            freeServiceUsed: Math.min(serviceDelivered, SERVICE_FREE_PER_MONTH),
            freeServiceLeft: Math.max(0, SERVICE_FREE_PER_MONTH - serviceDelivered),
            ...shape(b),
          };
        }),
        daily: [...daily.entries()].map(([date, d]) => ({ date, delivered: d.delivered, costUsd: round(d.costUsd) })),
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getSpending };
