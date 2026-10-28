const { Prisma } = require("@prisma/client");
const prisma = require("../../config/prisma");
const { getSetting } = require("../../utils/appSettings");
const { getTier, usedLast24hByNumber, TIER_LIMITS } = require("../../utils/messagingCapacity");
const { getQuietHoursConfig } = require("../../utils/quietHours");
const { readPeriod } = require("../supervision/report.controller");

// The Marketing dashboard: how campaigns, flows and the audience did over a
// period, and what needs a marketer's attention now. MARKETING and ADMIN
// (stats:marketing). Nothing here is about individual staff performance —
// that is stats:team.
//
// GET /api/stats/marketing?from=YYYY-MM-DD&to=YYYY-MM-DD[&numberId=]
// Days are clinic days (Asia/Dubai unless quiet hours say otherwise), both
// ends included, at most 92 days — readPeriod, shared with the supervisor
// reports. numberId narrows everything that belongs to a line; the switcher
// header is ignored.
//
// Every figure is a COUNT / GROUP BY in Postgres. Nothing loads one row per
// recipient, so it stays fast with 100k+ recipients in the period.
//
// Definitions (also shown in the dashboard's tooltips):
//   - Campaigns "in the period" are campaigns STARTED in it (startedAt), the
//     same rule as the Campaigns report. Every funnel figure counts those
//     campaigns' recipient rows, whenever the status came in.
//   - sent = recipient SENT (accepted by Meta and not failed since); delivered
//     and read are SENT rows whose message Meta reported delivered / read
//     (read counts as delivered); replied = SENT rows with a reply attributed
//     (CampaignRecipient.repliedAt, see utils/campaignAttribution.js). So
//     delivered, read and replied are never more than sent, and every rate is
//     a share of sent.
//   - failed / skipped = recipient FAILED / SKIPPED (opted out or the
//     frequency cap by the time their turn came).
//   - Opt-outs from campaigns: a line opt-out (STOP / UNSUBSCRIBE keyword,
//     WhatsApp's own "stop promotions", or staff opting them out of the line)
//     recorded within 7 days after a campaign reached the patient on that
//     line, or a STOP reply attributed to the campaign at any time. Each
//     opt-out is credited to ONE campaign — the one the STOP answered, else
//     the most recent one before it — so per-campaign opt-outs add up to the
//     total. A global "do not contact" switch has no timestamp of its own, so
//     it is not counted here.
//   - Audience performance groups the same campaigns by where their audience
//     came from (Campaign.audienceSnapshot): a segment, one contact list,
//     several lists together, or contacts picked by hand. Campaigns created
//     before lists were recorded say MANUAL, so they show as picked contacts.
//   - Flow runs "in the period" are runs STARTED in it. Dropped = expired
//     (no answer in 24 h), stopped (opted out, or replaced by a newer run), or
//     still active but idle for over an hour — the Supervision page's
//     "dropped halfway".

const DAY = 24 * 60 * 60 * 1000;
// Opt-outs this soon after a campaign reached someone are put down to it.
const OPT_OUT_WINDOW_DAYS = 7;
// An ACTIVE run idle this long has been abandoned (as on Supervision).
const STALLED_FLOW_MS = 60 * 60 * 1000;
// "Rejected back to draft recently" / "template rejected recently".
const RECENT_REJECTION_DAYS = 14;
// Line health asks Meta for each line's messaging tier (cached an hour in
// utils/messagingCapacity.js). Never wait longer than this for it.
const TIER_TIMEOUT_MS = 4000;
// Opt-out messages, exactly as typed (utils/optOutKeywords.js recognises
// more forms; this is only the tie-break for which campaign a STOP answered).
const STOP_WORDS = require("../../utils/optOutKeywords").EXACT_OPT_OUT_WORDS;

const toNum = (v) => (typeof v === "bigint" ? Number(v) : v ?? 0);
// Share of `d`, one decimal, never above 100.
const pct = (n, d) => (d ? Math.min(100, Math.round((n / d) * 1000) / 10) : null);

// "Line or all lines" in raw SQL, the same shape as supervision's responseTimes.
const lineIs = (numberId, column) =>
  Prisma.sql`(${numberId}::int IS NULL OR ${Prisma.raw(column)} = ${numberId}::int)`;

// What a failed or skipped recipient's error text says, in a few buckets.
// The texts come from the send loop (modules/campaigns/campaign.controller.js),
// Meta's errors (utils/campaignSendErrors.js) and the status webhook.
const REASON_LABEL = {
  NOT_ON_WHATSAPP: "Not on WhatsApp",
  OPTED_OUT: "Opted out",
  FREQUENCY_LIMIT: "Frequency limit",
  NOT_CONFIRMED: "Not confirmed",
  META_MARKETING_LIMIT: "Meta's marketing limit for this person",
};
const REASON_SQL = Prisma.sql`
  CASE
    WHEN r.error ILIKE '%limit is one campaign%' THEN 'FREQUENCY_LIMIT'
    WHEN r.error ILIKE 'Opted out%' OR r.error LIKE '%131050%' THEN 'OPTED_OUT'
    WHEN r.error ILIKE 'Not confirmed%' THEN 'NOT_CONFIRMED'
    WHEN r.error LIKE '%131026%' OR r.error ILIKE '%not on whatsapp%' OR r.error ILIKE '%undeliverable%' THEN 'NOT_ON_WHATSAPP'
    WHEN r.error LIKE '%131049%' THEN 'META_MARKETING_LIMIT'
    ELSE 'OTHER'
  END`;

// Templates that need a look: waiting at Meta, paused by Meta, or rejected
// recently. Shared by the attention list and the per-line counts so they agree.
const templateAttentionWhere = (since) => ({
  isActive: true,
  OR: [
    { approvalStatus: "SUBMITTED" },
    { approvalStatus: "PAUSED" },
    {
      approvalStatus: "REJECTED",
      OR: [{ statusChangedAt: { gte: since } }, { statusChangedAt: null, updatedAt: { gte: since } }],
    },
  ],
});

const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())]);

// getTier caches answers for an hour but not failures, and a line whose token
// can't read its tier would otherwise cost every dashboard load the full
// timeout. Remember "couldn't tell" for a while.
const TIER_MISS_MS = 10 * 60 * 1000;
const tierMisses = new Map(); // numberId -> when it last failed
async function tierFor(line) {
  const missed = tierMisses.get(line.id);
  if (missed && Date.now() - missed < TIER_MISS_MS) return null;
  const tier = await withTimeout(getTier(line), TIER_TIMEOUT_MS, null);
  if (tier) tierMisses.delete(line.id);
  else tierMisses.set(line.id, Date.now());
  return tier;
}

const who = (u) => (u ? u.name || u.username : null);

// ─── 1 + 2. Campaign funnel and per-campaign rows ───────────────────────────
async function campaignSection(period) {
  const { from, to, numberId } = period;
  const campaigns = await prisma.campaign.findMany({
    where: { startedAt: { gte: from, lt: to }, ...(numberId ? { whatsappNumberId: numberId } : {}) },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      category: true,
      startedAt: true,
      completedAt: true,
      deletedAt: true,
      whatsappNumberId: true,
      whatsappNumber: { select: { label: true } },
      template: { select: { name: true } },
      audienceSnapshot: true,
    },
  });
  const ids = campaigns.map((c) => c.id);
  const empty = { campaigns: [], funnel: funnelOf([]), failedReasons: [], audiencePerformance: [] };
  if (ids.length === 0) return empty;

  const idList = Prisma.join(ids);
  const [counts, optOuts, reasons] = await Promise.all([
    prisma.$queryRaw`
      SELECT r."campaignId" AS id,
        COUNT(*)::int AS recipients,
        COUNT(*) FILTER (WHERE r.status = 'SENT')::int AS sent,
        COUNT(*) FILTER (WHERE r.status = 'SENT' AND m.status IN ('DELIVERED', 'READ'))::int AS delivered,
        COUNT(*) FILTER (WHERE r.status = 'SENT' AND m.status = 'READ')::int AS read,
        COUNT(*) FILTER (WHERE r.status = 'SENT' AND r."repliedAt" IS NOT NULL)::int AS replied,
        COUNT(*) FILTER (WHERE r.status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped,
        MAX(r."sentAt") FILTER (WHERE r.status = 'SENT') AS "lastSentAt"
      FROM "CampaignRecipient" r
      LEFT JOIN "Message" m ON m.id = r."messageId"
      WHERE r."campaignId" IN (${idList})
      GROUP BY r."campaignId"`,
    // Each line opt-out, credited to one campaign (see the header). Only
    // opt-outs that can belong to a campaign started in the period are looked
    // at: on or after the period starts, at most the window after it ends —
    // except a STOP that quoted the campaign, which may come any time later.
    prisma.$queryRaw`
      SELECT x."campaignId" AS id, COUNT(*)::int AS "optOuts"
      FROM "CustomerOptOut" o
      JOIN LATERAL (
        SELECT r."campaignId"
        FROM "CampaignRecipient" r
        JOIN "Campaign" c ON c.id = r."campaignId"
        LEFT JOIN LATERAL (
          SELECT 1 AS hit FROM "Message" s
          WHERE s."campaignRecipientId" = r.id
            AND UPPER(TRIM(s.content)) IN (${Prisma.join(STOP_WORDS)})
          LIMIT 1
        ) stop ON TRUE
        WHERE r."customerId" = o."customerId"
          AND r.status = 'SENT'
          AND c."whatsappNumberId" = o."whatsappNumberId"
          AND r."sentAt" <= o."optedOutAt"
          AND (stop.hit IS NOT NULL OR r."sentAt" >= o."optedOutAt" - ${Prisma.raw(`interval '${OPT_OUT_WINDOW_DAYS} days'`)})
        ORDER BY (stop.hit IS NOT NULL) DESC, r."sentAt" DESC
        LIMIT 1
      ) x ON TRUE
      WHERE o."optedOutAt" >= ${from}
        AND ${lineIs(numberId, 'o."whatsappNumberId"')}
        AND x."campaignId" IN (${idList})
      GROUP BY x."campaignId"`,
    // Why people didn't get it. "Other" is split by Meta's error code so a new
    // problem shows up by name instead of hiding in one bucket.
    prisma.$queryRaw`
      SELECT reason, code, COUNT(*)::int AS count, MIN(error) AS example
      FROM (
        SELECT ${REASON_SQL} AS reason,
               substring(r.error from '([0-9]{3,6})') AS code,
               r.error
        FROM "CampaignRecipient" r
        WHERE r."campaignId" IN (${idList})
          AND r.status IN ('FAILED', 'SKIPPED')
      ) t
      GROUP BY reason, code
      ORDER BY count DESC`,
  ]);

  const countMap = new Map(counts.map((r) => [r.id, r]));
  const optMap = new Map(optOuts.map((r) => [r.id, toNum(r.optOuts)]));

  const lastSent = new Map();
  const rows = campaigns.map((c) => {
    const k = countMap.get(c.id) || {};
    lastSent.set(c.id, k.lastSentAt || null);
    const sent = toNum(k.sent);
    const delivered = toNum(k.delivered);
    const read = toNum(k.read);
    const replied = toNum(k.replied);
    const optOutsN = optMap.get(c.id) || 0;
    return {
      id: c.id,
      name: c.name,
      whatsappNumberId: c.whatsappNumberId,
      line: c.whatsappNumber?.label || null,
      template: c.template?.name || null,
      category: c.category,
      status: c.status,
      // Deleted after completing: kept in the figures, but there is no page to open.
      deleted: c.deletedAt !== null,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      recipients: toNum(k.recipients),
      sent,
      delivered,
      read,
      replied,
      failed: toNum(k.failed),
      skipped: toNum(k.skipped),
      optOuts: optOutsN,
      rates: {
        deliveredPct: pct(delivered, sent),
        readPct: pct(read, sent),
        repliedPct: pct(replied, sent),
        optOutPct: pct(optOutsN, sent),
      },
    };
  });

  // Top reasons. Categories merge; "Other" stays per Meta code.
  const merged = new Map();
  for (const r of reasons) {
    const key = r.reason === "OTHER" ? `OTHER:${r.code || ""}` : r.reason;
    const label =
      r.reason !== "OTHER" ? REASON_LABEL[r.reason] : r.code ? `Meta error ${r.code}` : "Other";
    const prev = merged.get(key) || { category: r.reason, label, count: 0, example: r.example || null };
    prev.count += toNum(r.count);
    merged.set(key, prev);
  }
  const failedReasons = [...merged.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((r) => ({ ...r, example: r.category === "OTHER" && r.example ? String(r.example).slice(0, 160) : null }));

  return {
    campaigns: rows,
    funnel: funnelOf(rows),
    failedReasons,
    audiencePerformance: audiencePerformanceOf(campaigns, rows, lastSent),
  };
}

// Where a campaign's audience came from, read off its frozen snapshot (see
// resolveAudience in modules/campaigns/campaign.controller.js). Campaigns
// with the same source share a key and are added up together.
function audienceOf(snapshot) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (snap.source === "SEGMENT") {
    return {
      key: `SEGMENT:${snap.segmentId ?? snap.segmentName ?? ""}`,
      kind: "SEGMENT",
      label: `Segment: ${snap.segmentName || `#${snap.segmentId}`}`,
      segmentId: snap.segmentId ?? null,
      listIds: [],
    };
  }
  const lists = snap.source === "LIST" && Array.isArray(snap.lists) ? snap.lists.filter((l) => l && l.id) : [];
  if (lists.length > 0) {
    const sorted = [...lists].sort((a, b) => a.id - b.id);
    const names = [...lists].map((l) => l.name || `#${l.id}`).sort((a, b) => a.localeCompare(b));
    return {
      key: `LIST:${sorted.map((l) => l.id).join(",")}`,
      kind: "LIST",
      label: names.length === 1 ? `List: ${names[0]}` : `Lists: ${names.join(" + ")}`,
      segmentId: null,
      listIds: sorted.map((l) => l.id),
    };
  }
  return { key: "MANUAL", kind: "MANUAL", label: "Picked contacts", segmentId: null, listIds: [] };
}

// The per-campaign rows above, added up by audience. No extra queries.
function audiencePerformanceOf(campaigns, rows, lastSent) {
  const groups = new Map();
  campaigns.forEach((c, i) => {
    const r = rows[i];
    const a = audienceOf(c.audienceSnapshot);
    const g =
      groups.get(a.key) ||
      { ...a, campaigns: 0, recipients: 0, sent: 0, replied: 0, optOuts: 0, failedSkipped: 0, lastSentAt: null };
    g.campaigns += 1;
    g.recipients += r.recipients;
    g.sent += r.sent;
    g.replied += r.replied;
    g.optOuts += r.optOuts;
    g.failedSkipped += r.failed + r.skipped;
    const last = lastSent.get(c.id);
    if (last && (!g.lastSentAt || last > g.lastSentAt)) g.lastSentAt = last;
    groups.set(a.key, g);
  });
  return [...groups.values()]
    .map((g) => ({ ...g, repliedPct: pct(g.replied, g.sent), optOutPct: pct(g.optOuts, g.sent) }))
    .sort((a, b) => b.sent - a.sent || b.campaigns - a.campaigns || a.label.localeCompare(b.label));
}

function funnelOf(rows) {
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const sent = sum("sent");
  const delivered = sum("delivered");
  const read = sum("read");
  const replied = sum("replied");
  const optOuts = sum("optOuts");
  const recipients = sum("recipients");
  const failed = sum("failed");
  const skipped = sum("skipped");
  return {
    campaigns: rows.length,
    recipients,
    sent,
    delivered,
    read,
    replied,
    failed,
    skipped,
    // Still waiting for their turn (running, paused or scheduled campaigns).
    pending: Math.max(0, recipients - sent - failed - skipped),
    optOutsFromCampaigns: optOuts,
    rates: {
      deliveredPct: pct(delivered, sent),
      readPct: pct(read, sent),
      repliedPct: pct(replied, sent),
      optOutPct: pct(optOuts, sent),
    },
  };
}

// ─── 3. Flows ───────────────────────────────────────────────────────────────
async function flowSection(period) {
  const { from, to, numberId } = period;
  const stalledBefore = new Date(Date.now() - STALLED_FLOW_MS);
  const [rows, taps] = await Promise.all([
    prisma.$queryRaw`
      SELECT fr."flowId" AS id, f.name, f."isActive",
        COUNT(*)::int AS started,
        COUNT(*) FILTER (WHERE fr.status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE fr.status = 'HANDED_OFF')::int AS "handedOff",
        COUNT(*) FILTER (WHERE fr.status IN ('EXPIRED', 'STOPPED')
                            OR (fr.status = 'ACTIVE' AND fr."updatedAt" < ${stalledBefore}))::int AS dropped,
        COUNT(*) FILTER (WHERE fr.status = 'ACTIVE' AND fr."updatedAt" >= ${stalledBefore})::int AS active,
        COUNT(*) FILTER (WHERE fr.status = 'FAILED')::int AS failed
      FROM "FlowRun" fr
      JOIN "Flow" f ON f.id = fr."flowId"
      JOIN "Conversation" c ON c.id = fr."conversationId"
      WHERE fr."startedAt" >= ${from} AND fr."startedAt" < ${to}
        AND ${lineIs(numberId, 'c."whatsappNumberId"')}
      GROUP BY fr."flowId", f.name, f."isActive"
      ORDER BY started DESC, f.name`,
    // A run's taps are data.path[] entries with a `choice` (the button or list
    // row title — utils/flowEngine.js), the campaign button that started it
    // included. Counted once per run, so "34" means 34 patients picked it.
    prisma.$queryRaw`
      WITH taps AS (
        SELECT fr."flowId", p->>'choice' AS choice, COUNT(DISTINCT fr.id)::int AS runs
        FROM "FlowRun" fr
        JOIN "Conversation" c ON c.id = fr."conversationId"
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(fr.data->'path') = 'array' THEN fr.data->'path' ELSE '[]'::jsonb END
        ) p
        WHERE fr."startedAt" >= ${from} AND fr."startedAt" < ${to}
          AND ${lineIs(numberId, 'c."whatsappNumberId"')}
          AND jsonb_typeof(p) = 'object'
          AND COALESCE(p->>'choice', '') <> ''
        GROUP BY fr."flowId", p->>'choice'
      )
      SELECT "flowId", choice, runs
      FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY "flowId" ORDER BY runs DESC, choice) AS rn FROM taps) t
      WHERE rn <= 5
      ORDER BY "flowId", runs DESC`,
  ]);

  const tapMap = new Map();
  for (const t of taps) {
    if (!tapMap.has(t.flowId)) tapMap.set(t.flowId, []);
    tapMap.get(t.flowId).push({ choice: t.choice, runs: toNum(t.runs) });
  }
  return rows.map((r) => {
    const started = toNum(r.started);
    const completed = toNum(r.completed);
    const handedOff = toNum(r.handedOff);
    const dropped = toNum(r.dropped);
    return {
      id: r.id,
      name: r.name,
      isActive: r.isActive,
      started,
      completed,
      handedOff,
      dropped,
      active: toNum(r.active),
      failed: toNum(r.failed),
      rates: {
        completedPct: pct(completed, started),
        handedOffPct: pct(handedOff, started),
        droppedPct: pct(dropped, started),
      },
      topChoices: tapMap.get(r.id) || [],
    };
  });
}

// ─── 4. Audience ────────────────────────────────────────────────────────────
async function audienceSection(period) {
  const { from, to, numberId } = period;
  const { frequencyCapDays } = getSetting("campaignSafety");
  const capSince = frequencyCapDays > 0 ? new Date(Date.now() - frequencyCapDays * DAY) : null;
  // Opted out = the global switch, or (line filter) a STOP on that line, or
  // (all lines) a STOP on any line.
  const lineOptOut = numberId ? { optOuts: { some: { whatsappNumberId: numberId } } } : { optOuts: { some: {} } };

  const [total, created, reachable, optedOutTotal, optedOutGlobal, optedOutNewRow, cappedRow] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.customer.count({
      where: { optedOut: false, ...(numberId ? { optOuts: { none: { whatsappNumberId: numberId } } } : {}) },
    }),
    prisma.customer.count({ where: { OR: [{ optedOut: true }, lineOptOut] } }),
    prisma.customer.count({ where: { optedOut: true } }),
    // New in the period: a line opt-out recorded in it, or a global "do not
    // contact" switched on in it (from the audit log) that still stands.
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT id)::int AS n FROM (
        SELECT o."customerId" AS id
        FROM "CustomerOptOut" o
        WHERE o."optedOutAt" >= ${from} AND o."optedOutAt" < ${to}
          AND ${lineIs(numberId, 'o."whatsappNumberId"')}
        UNION
        SELECT a."targetId" AS id
        FROM "AuditLog" a
        JOIN "Customer" cu ON cu.id = a."targetId" AND cu."optedOut" = true
        WHERE a.action = 'CUSTOMER_OPTED_OUT'
          AND a."targetType" = 'Customer'
          AND a.details->>'scope' = 'all'
          AND a."createdAt" >= ${from} AND a."createdAt" < ${to}
      ) x`,
    // Settings → Campaign safety: people a campaign would skip right now
    // because they had one within the cap (per line, like the send loop).
    capSince
      ? prisma.$queryRaw`
          SELECT COUNT(DISTINCT r."customerId")::int AS n
          FROM "CampaignRecipient" r
          JOIN "Campaign" c ON c.id = r."campaignId"
          WHERE r.status = 'SENT'
            AND r."sentAt" >= ${capSince}
            AND ${lineIs(numberId, 'c."whatsappNumberId"')}`
      : Promise.resolve(null),
  ]);

  return {
    totalContacts: total,
    newContacts: created,
    reachable,
    optedOutTotal,
    optedOutGlobal,
    optedOutNew: toNum(optedOutNewRow[0]?.n),
    frequencyCapDays,
    frequencyCappedNow: cappedRow ? toNum(cappedRow[0]?.n) : null,
  };
}

// ─── 5. Line health ─────────────────────────────────────────────────────────
async function lineHealthSection(period, templateSince) {
  const lines = await prisma.whatsAppNumber.findMany({
    where: { isActive: true, ...(period.numberId ? { id: period.numberId } : {}) },
    orderBy: [{ isDefault: "desc" }, { label: "asc" }],
  });
  if (lines.length === 0) return [];
  const [used, tiers, templates] = await Promise.all([
    usedLast24hByNumber(lines.map((l) => l.id)),
    Promise.all(lines.map(tierFor)),
    prisma.template.groupBy({
      by: ["wabaId", "approvalStatus"],
      where: { ...templateAttentionWhere(templateSince), wabaId: { in: [...new Set(lines.map((l) => l.wabaId))] } },
      _count: { _all: true },
    }),
  ]);

  return lines.map((l, i) => {
    const tier = tiers[i];
    const limit = tier && TIER_LIMITS[tier] !== undefined ? TIER_LIMITS[tier] : null;
    const usedNow = used.get(l.id) || 0;
    const tpl = (status) =>
      templates.find((t) => t.wabaId === l.wabaId && t.approvalStatus === status)?._count._all || 0;
    return {
      id: l.id,
      label: l.label,
      displayPhoneNumber: l.displayPhoneNumber,
      // As of the last quality check (jobs/numberQualityWatch.js, every 30 min).
      qualityRating: l.qualityRating,
      metaStatus: l.metaStatus,
      qualityCheckedAt: l.qualityCheckedAt,
      // null when Meta couldn't be asked; unlimited lines have no limit.
      messagingTier: tier,
      messagingLimit: limit === Infinity ? null : limit,
      unlimited: limit === Infinity,
      // Different people sent a template in the last 24 hours (our records).
      usedLast24h: usedNow,
      usedPct: limit && limit !== Infinity ? pct(usedNow, limit) : null,
      templates: { pending: tpl("SUBMITTED"), rejected: tpl("REJECTED"), paused: tpl("PAUSED") },
    };
  });
}

// ─── 6. Needs attention ─────────────────────────────────────────────────────
async function attentionSection(period, templateSince) {
  const { numberId } = period;
  const line = numberId ? { whatsappNumberId: numberId } : {};
  const PERSON = { select: { name: true, username: true } };
  const base = { deletedAt: null, ...line };
  const lineSelect = { whatsappNumberId: true, whatsappNumber: { select: { label: true } } };

  let wabaFilter = {};
  if (numberId) {
    const n = await prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { wabaId: true } });
    wabaFilter = { wabaId: n ? n.wabaId : "__none__" };
  }

  const [pendingCount, pending, rejected, paused, templates] = await Promise.all([
    prisma.campaign.count({ where: { ...base, status: "PENDING_APPROVAL" } }),
    prisma.campaign.findMany({
      where: { ...base, status: "PENDING_APPROVAL" },
      orderBy: { submittedAt: "asc" },
      take: 20,
      select: { id: true, name: true, submittedAt: true, totalRecipients: true, submittedBy: PERSON, ...lineSelect },
    }),
    // Rejection is tracked on the row: back to DRAFT with the reviewer's reason.
    prisma.campaign.findMany({
      where: { ...base, status: "DRAFT", rejectionReason: { not: null }, reviewedAt: { gte: templateSince } },
      orderBy: { reviewedAt: "desc" },
      take: 20,
      select: { id: true, name: true, reviewedAt: true, rejectionReason: true, reviewedBy: PERSON, ...lineSelect },
    }),
    prisma.campaign.findMany({
      where: { ...base, status: "PAUSED" },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true, name: true, pauseReason: true, pauseDetail: true, resumeAt: true, updatedAt: true,
        sentCount: true, totalRecipients: true, ...lineSelect,
      },
    }),
    prisma.template.findMany({
      where: { ...templateAttentionWhere(templateSince), ...wabaFilter },
      orderBy: [{ approvalStatus: "asc" }, { updatedAt: "desc" }],
      take: 30,
      select: { id: true, name: true, approvalStatus: true, rejectionReason: true, statusChangedAt: true, updatedAt: true, wabaId: true },
    }),
  ]);

  const lineOf = (c) => ({ whatsappNumberId: c.whatsappNumberId, line: c.whatsappNumber?.label || null });
  return {
    pendingApproval: {
      count: pendingCount,
      campaigns: pending.map((c) => ({
        id: c.id, name: c.name, ...lineOf(c), submittedAt: c.submittedAt, submittedBy: who(c.submittedBy), recipients: c.totalRecipients,
      })),
    },
    rejectedRecently: rejected.map((c) => ({
      id: c.id, name: c.name, ...lineOf(c), reviewedAt: c.reviewedAt, reviewedBy: who(c.reviewedBy), reason: c.rejectionReason,
    })),
    paused: paused.map((c) => ({
      id: c.id, name: c.name, ...lineOf(c), reason: c.pauseReason, detail: c.pauseDetail, resumeAt: c.resumeAt,
      pausedAt: c.updatedAt, sent: c.sentCount, recipients: c.totalRecipients,
    })),
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.approvalStatus,
      reason: t.approvalStatus === "REJECTED" ? t.rejectionReason : null,
      changedAt: t.statusChangedAt || t.updatedAt,
    })),
    recentDays: RECENT_REJECTION_DAYS,
  };
}

// ─── GET /api/stats/marketing ───────────────────────────────────────────────
const getMarketingStats = async (req, res, next) => {
  try {
    const period = readPeriod(req);
    const templateSince = new Date(Date.now() - RECENT_REJECTION_DAYS * DAY);

    const [campaignData, flows, audience, lineHealth, attention] = await Promise.all([
      campaignSection(period),
      flowSection(period),
      audienceSection(period),
      lineHealthSection(period, templateSince),
      attentionSection(period, templateSince),
    ]);

    res.status(200).json({
      success: true,
      data: {
        period: {
          from: period.from,
          to: period.to,
          fromDay: req.query.from,
          toDay: req.query.to,
          timezone: getQuietHoursConfig().timezone,
        },
        numberId: period.numberId,
        generatedAt: new Date(),
        definitions: {
          optOutWindowDays: OPT_OUT_WINDOW_DAYS,
          stalledFlowMinutes: STALLED_FLOW_MS / 60000,
        },
        campaignFunnel: { ...campaignData.funnel, failedReasons: campaignData.failedReasons },
        campaigns: campaignData.campaigns,
        flows,
        // performance: the period's campaigns grouped by where their audience
        // came from (see audiencePerformanceOf).
        audience: { ...audience, performance: campaignData.audiencePerformance },
        lineHealth,
        attention,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getMarketingStats };
