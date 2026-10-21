// Demo data for the in-app documentation and its screenshots
// (`npm run seed:demo`, remove with `npm run seed:demo -- --remove`).
//
// Everything lives on its own WhatsApp line, "Demo Clinic (docs)", whose
// phone-number and business-account ids are made up — so Meta rejects any
// send from it and nothing here can ever reach a real phone. Patients use
// +999 numbers (an unassigned country code). Every row is tagged and removed
// by exactly those tags:
//   · the line           phoneNumberId DEMO_PNID
//   · patients           phone starting DEMO_PHONE_PREFIX
//   · staff              username starting "docs_"
//   · templates          wabaId DEMO_WABA
//   · lists / segments   name starting "[Demo]"
// Chats, messages, flow runs and campaigns go with the line. No booking data
// is created (booking moved to a later phase), but removal still clears any
// booking rows an older copy of the demo left on the line. Knowledge articles
// are the same (the AI assistant moved to a later phase too): none are
// created, and removal clears "[Demo]" ones an older copy made.
//
// Re-running replaces the demo data with a fresh copy (timestamps are relative
// to now, so "waiting 12m" and "follow up tomorrow" stay meaningful).
require("../config/env");

if (process.env.NODE_ENV === "production") {
  console.error("seed:demo: refusing to run with NODE_ENV=production.");
  process.exit(1);
}

const prisma = require("../config/prisma");
const bcryptjs = require("bcryptjs");

// Only docs_* accounts can see or switch to the demo line, and they see
// nothing else — enforced in middleware/whatsappNumber.js mayUseNumber.
const { DEMO_PHONE_NUMBER_ID: DEMO_PNID } = require("./whatsappNumbers");
const DEMO_WABA = "docs-demo-waba";
const DEMO_PHONE_PREFIX = "99900000";
const DEMO_TAG = "[Demo]";
const PASSWORD = "DocsDemo@1234";

const STAFF = [
  { key: "admin", username: "docs_admin", name: "Layla Haddad", role: "ADMIN", status: "ONLINE" },
  { key: "supervisor", username: "docs_supervisor", name: "Omar Farouk", role: "SUPERVISOR", status: "ONLINE" },
  { key: "agent", username: "docs_agent", name: "Nadia Karim", role: "AGENT", status: "ONLINE" },
  { key: "agent2", username: "docs_agent2", name: "Yousef Ali", role: "AGENT", status: "ON_BREAK" },
  { key: "marketing", username: "docs_marketing", name: "Rania Saleh", role: "MARKETING", status: "ONLINE" },
];

const now = Date.now();
const minsAgo = (n) => new Date(now - n * 60_000);
const hoursAgo = (n) => minsAgo(n * 60);
const daysAgo = (n) => hoursAgo(n * 24);
const inHours = (n) => new Date(now + n * 3_600_000);
const atDayTime = (dayOffset, h, m = 0) => {
  const d = new Date(now + dayOffset * 86_400_000);
  d.setHours(h, m, 0, 0);
  return d;
};
const dateOnly = (iso) => new Date(`${iso}T00:00:00.000Z`);

// ── remove ──────────────────────────────────────────────────────────────────

async function remove() {
  const number = await prisma.whatsAppNumber.findUnique({ where: { phoneNumberId: DEMO_PNID } });
  const users = await prisma.user.findMany({ where: { username: { startsWith: "docs_" } }, select: { id: true, username: true } });
  const userIds = users.map((u) => u.id);
  const customers = await prisma.customer.findMany({ where: { phone: { startsWith: DEMO_PHONE_PREFIX } }, select: { id: true } });
  const customerIds = customers.map((c) => c.id);

  if (number) {
    const convWhere = { conversation: { whatsappNumberId: number.id } };
    await prisma.campaign.deleteMany({ where: { whatsappNumberId: number.id } }); // recipients cascade
    await prisma.message.updateMany({ where: convWhere, data: { quotedMessageId: null } });
    await prisma.message.deleteMany({ where: convWhere });
    // Only older demo copies have these; booking isn't seeded any more.
    await prisma.booking.deleteMany({ where: { whatsappNumberId: number.id } });
    await prisma.bookingRequest.deleteMany({ where: { whatsappNumberId: number.id } });
    await prisma.flowRun.deleteMany({ where: convWhere });
    await prisma.conversation.deleteMany({ where: { whatsappNumberId: number.id } }); // notes cascade
  }
  if (customerIds.length) {
    // A demo patient can only have chats on the demo line, unless someone used
    // the demo data on a real one — leave such a patient in place rather than
    // touch a real line's history.
    const elsewhere = await prisma.conversation.findMany({ where: { customerId: { in: customerIds } }, select: { customerId: true } });
    const keep = new Set(elsewhere.map((c) => c.customerId));
    await prisma.customer.deleteMany({ where: { id: { in: customerIds.filter((id) => !keep.has(id)) } } });
    if (keep.size) console.warn(`seed:demo: kept ${keep.size} demo patient(s) that have chats on another line`);
  }
  await prisma.template.deleteMany({ where: { wabaId: DEMO_WABA, campaigns: { none: {} } } });
  await prisma.contactList.deleteMany({ where: { name: { startsWith: DEMO_TAG } } });
  await prisma.segment.deleteMany({ where: { name: { startsWith: DEMO_TAG }, campaigns: { none: {} } } });
  await prisma.knowledgeArticle.deleteMany({ where: { title: { startsWith: DEMO_TAG } } });
  if (number) await prisma.whatsAppNumber.delete({ where: { id: number.id } });

  for (const u of users) {
    await prisma.conversation.updateMany({ where: { assignedAgentId: u.id }, data: { assignedAgentId: null } });
    try {
      await prisma.user.delete({ where: { id: u.id } });
    } catch {
      // Used on a real line (a message, a campaign) — keep the history, lock the account.
      await prisma.user.update({ where: { id: u.id }, data: { isActive: false, tokenVersion: { increment: 1 } } });
      console.warn(`seed:demo: ${u.username} has history outside the demo line — deactivated instead of deleted`);
    }
  }
  if (userIds.length) await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
}

// ── create ──────────────────────────────────────────────────────────────────

async function create() {
  const passwordHash = await bcryptjs.hash(PASSWORD, 12);
  const staff = {};
  for (const s of STAFF) {
    staff[s.key] = await prisma.user.create({
      data: { username: s.username, name: s.name, role: s.role, passwordHash, status: s.status, lastActiveAt: new Date() },
    });
  }

  const number = await prisma.whatsAppNumber.create({
    data: {
      label: "Demo Clinic (docs)",
      phoneNumberId: DEMO_PNID,
      wabaId: DEMO_WABA,
      displayPhoneNumber: "+999 000 0000",
      tokenEnvKey: "WHATSAPP_ACCESS_TOKEN",
      qualityRating: "GREEN",
      metaStatus: "CONNECTED",
      qualityCheckedAt: new Date(),
    },
  });

  // ── templates ──
  const tpl = {};
  const T = async (key, data) => (tpl[key] = await prisma.template.create({ data: { wabaId: DEMO_WABA, language: "en_US", statusChangedAt: daysAgo(10), ...data } }));
  await T("glow", {
    name: "Summer Glow offer", metaTemplateName: "demo_summer_glow", category: "CAMPAIGN", metaCategory: "MARKETING", approvalStatus: "APPROVED",
    headerType: "TEXT", header: "Summer Glow ✨ 20% off HydraFacial",
    body: "Hi {{first_name}}, beat the summer heat with our HydraFacial — 20% off until the end of the month.\n\nTap below to pick a time that suits you.",
    footer: "Reply STOP to opt out",
    buttons: [{ type: "QUICK_REPLY", text: "Book now" }, { type: "QUICK_REPLY", text: "Tell me more" }],
  });
  await T("welcome", {
    name: "Welcome back", metaTemplateName: "demo_welcome_back", category: "RE_ENGAGEMENT", metaCategory: "MARKETING", approvalStatus: "APPROVED",
    body: "Hi {{customer_name}}, it's {{agent_name}} from Everlast Wellness. We'd love to help you with your next visit — just reply to this message.",
  });
  await T("reminder", {
    name: "Appointment reminder", metaTemplateName: "demo_appointment_reminder", category: "GENERAL", metaCategory: "UTILITY", approvalStatus: "APPROVED",
    body: "Hi {{first_name}}, this is a reminder of your appointment at Everlast Wellness. Reply here if you need to change it.",
  });
  await T("ramadan", {
    name: "Ramadan opening hours", metaTemplateName: "demo_ramadan_hours", category: "CAMPAIGN", metaCategory: "MARKETING", approvalStatus: "APPROVED",
    body: "Ramadan Kareem, {{first_name}} 🌙 During Ramadan the clinic is open 10:00–17:00 and 21:00–01:00. Reply to book.",
    footer: "Reply STOP to opt out",
  });
  await T("laser", {
    name: "Laser hair removal – autumn", metaTemplateName: "demo_laser_autumn", category: "CAMPAIGN", approvalStatus: "SUBMITTED",
    body: "Hi {{first_name}}, autumn is the best time to start laser hair removal. Packages from AED 499.",
  });
  await T("botox", {
    name: "Botox open day", category: "CAMPAIGN", approvalStatus: "DRAFT",
    body: "Join our Botox open day this Saturday — free consultations with Dr. Sara.",
  });
  await T("rejected", {
    name: "Flash sale 70% off", metaTemplateName: "demo_flash_sale", category: "CAMPAIGN", approvalStatus: "REJECTED",
    rejectionReason: "INVALID_FORMAT — the body can't start or end with a placeholder.",
    body: "{{first_name}} 70% OFF EVERYTHING TODAY ONLY!!!",
  });

  // ── patients ──
  const P = [
    { n: "01", name: "Fatima Al Mansoori", gender: "FEMALE", nat: "Emirati", dob: "1991-04-12", join: "2023-02-01", dept: ["Dermatology", "Aesthetics"], tags: ["VIP"], chart: "DEMO-1001" },
    { n: "02", name: "James Wilson", gender: "MALE", nat: "British", dob: "1985-09-30", join: "2024-06-15", dept: ["Physiotherapy"], tags: [], chart: "DEMO-1002" },
    { n: "03", name: "Aisha Rahman", gender: "FEMALE", nat: "Indian", dob: "1995-01-22", join: "2024-11-03", dept: ["Aesthetics"], tags: ["Summer Glow lead"], chart: "DEMO-1003" },
    { n: "04", name: "Mohammed Al Hashimi", gender: "MALE", nat: "Emirati", dob: "1979-07-08", join: "2022-08-19", dept: ["Dental"], tags: ["VIP"], chart: "DEMO-1004" },
    { n: "05", name: "Sophie Martin", gender: "FEMALE", nat: "French", dob: "1988-03-17", join: "2025-01-10", dept: ["Dermatology"], tags: [], chart: "DEMO-1005" },
    { n: "06", name: "Hassan Youssef", gender: "MALE", nat: "Egyptian", dob: "1993-12-02", join: "2025-03-21", dept: ["Laser"], tags: ["Laser lead"], chart: "DEMO-1006" },
    { n: "07", name: "Priya Sharma", gender: "FEMALE", nat: "Indian", dob: "1990-06-25", join: "2024-02-14", dept: ["Aesthetics"], tags: [], chart: "DEMO-1007" },
    { n: "08", name: "Khalid Al Suwaidi", gender: "MALE", nat: "Emirati", dob: "1987-10-11", join: "2023-09-05", dept: ["Physiotherapy", "Wellness"], tags: [], chart: "DEMO-1008" },
    { n: "09", name: "Elena Petrova", gender: "FEMALE", nat: "Russian", dob: "1996-08-03", join: "2025-05-28", dept: ["Aesthetics"], tags: ["Summer Glow lead"], chart: "DEMO-1009" },
    { n: "10", name: "نورة الكعبي", gender: "FEMALE", nat: "Emirati", dob: "1992-02-14", join: "2023-12-12", dept: ["Dermatology"], tags: ["VIP"], chart: "DEMO-1010" },
    { n: "11", name: "Daniel Okafor", gender: "MALE", nat: "Nigerian", dob: "1984-05-19", join: "2024-07-07", dept: ["Dental"], tags: [], chart: "DEMO-1011" },
    { n: "12", name: "Mariam Haddad", gender: "FEMALE", nat: "Lebanese", dob: "1999-11-29", join: "2025-08-02", dept: ["Laser"], tags: ["Laser lead"], chart: "DEMO-1012" },
    { n: "13", name: "Ahmed Siddiqui", gender: "MALE", nat: "Pakistani", dob: "1982-01-05", join: "2022-04-18", dept: ["Wellness"], tags: [], chart: "DEMO-1013" },
    { n: "14", name: "Chloé Dubois", gender: "FEMALE", nat: "French", dob: "1994-09-09", join: "2025-09-15", dept: ["Aesthetics", "Laser"], tags: ["Laser lead"], chart: "DEMO-1014" },
    { n: "15", name: "Omar Bin Rashid", gender: "MALE", nat: "Emirati", dob: "1975-12-24", join: "2021-11-30", dept: ["Dental"], tags: ["VIP"], chart: "DEMO-1015" },
    { n: "16", name: "Grace Lee", gender: "FEMALE", nat: "Korean", dob: "1997-07-14", join: "2025-10-01", dept: [], tags: [], chart: "DEMO-1016" },
  ];
  const c = {};
  for (const p of P) {
    c[p.n] = await prisma.customer.create({
      data: {
        phone: `${DEMO_PHONE_PREFIX}${p.n.padStart(4, "0")}`, name: p.name, gender: p.gender, nationality: p.nat,
        dateOfBirth: dateOnly(p.dob), joinDate: dateOnly(p.join), departments: p.dept, tags: p.tags, chartNumber: p.chart,
        email: /[a-z]/i.test(p.name) && !p.name.includes("ة") ? `${p.name.split(" ")[0].toLowerCase()}@example.com` : null,
        createdAt: dateOnly(p.join),
      },
    });
  }

  // ── campaigns ──
  const campaign = async (data) => prisma.campaign.create({ data: { whatsappNumberId: number.id, createdById: staff.marketing.id, ...data } });
  const glow = await campaign({
    name: "Summer Glow – HydraFacial", templateId: tpl.glow.id, category: "PROMOTION", status: "COMPLETED",
    submittedById: staff.marketing.id, submittedAt: daysAgo(3.2), reviewedById: staff.admin.id, reviewedAt: daysAgo(3),
    startedAt: daysAgo(3), completedAt: daysAgo(2.99), totalRecipients: 8, sentCount: 6, failedCount: 1, skippedCount: 1,
  });
  await campaign({
    name: "Ramadan opening hours", templateId: tpl.ramadan.id, category: "ANNOUNCEMENT", status: "PENDING_APPROVAL",
    submittedById: staff.marketing.id, submittedAt: hoursAgo(2), scheduledAt: atDayTime(2, 10), totalRecipients: 16,
  });
  await campaign({
    name: "Laser hair removal – autumn", templateId: tpl.glow.id, category: "SEASONAL", status: "DRAFT", totalRecipients: 4,
  });
  await campaign({
    name: "New year check-up", templateId: tpl.welcome.id, category: "FOLLOW_UP", status: "SCHEDULED", createdById: staff.admin.id,
    reviewedById: staff.admin.id, reviewedAt: daysAgo(1), scheduledAt: new Date("2027-01-05T06:00:00.000Z"), totalRecipients: 12,
  });
  await campaign({
    name: "Eid greetings", templateId: tpl.welcome.id, category: "SEASONAL", status: "COMPLETED",
    submittedById: staff.marketing.id, submittedAt: daysAgo(40), reviewedById: staff.admin.id, reviewedAt: daysAgo(40),
    startedAt: daysAgo(40), completedAt: daysAgo(40), totalRecipients: 14, sentCount: 14,
  });
  await campaign({
    name: "Black Friday teaser", templateId: tpl.glow.id, category: "PROMOTION", status: "DRAFT",
    submittedById: staff.marketing.id, submittedAt: daysAgo(1.5), reviewedById: staff.admin.id, reviewedAt: daysAgo(1.4),
    rejectionReason: "Wrong audience — exclude patients who visited this month.", totalRecipients: 9,
  });

  // ── conversations ──
  // msgs: [who, text, minutesAgo, extra?]  who: "p" patient, "a"/"a2"/"s" staff, "bot", "tpl" campaign template
  const recipientFor = {};
  async function chat(key, { assigned, status = "OPEN", outcome, outcomeBy, followUpAt, unread = 0, msgs, campaignSent }) {
    const customer = c[key];
    const conv = await prisma.conversation.create({
      data: {
        customerId: customer.id, whatsappNumberId: number.id, assignedAgentId: assigned ? staff[assigned].id : null, status, unreadCount: unread,
        outcome: outcome || null, outcomeAt: outcome ? minsAgo(msgs[msgs.length - 1][2]) : null, outcomeById: outcomeBy ? staff[outcomeBy].id : null,
        followUpAt: followUpAt || null, createdAt: minsAgo(msgs[0][2] + 1),
      },
    });
    let lastCustomerAt = null;
    let lastAgentAt = null;
    for (const [who, text, ago, extra = {}] of msgs) {
      const at = minsAgo(ago);
      const staffKey = ["a", "a2", "s", "adm"].includes(who) ? { a: "agent", a2: "agent2", s: "supervisor", adm: "admin" }[who] : null;
      const senderType = who === "p" ? "CUSTOMER" : who === "bot" ? "BOT" : "AGENT";
      const m = await prisma.message.create({
        data: {
          conversationId: conv.id, senderType, senderId: staffKey ? staff[staffKey].id : who === "tpl" ? staff.admin.id : null,
          content: text, messageType: who === "tpl" ? "TEMPLATE" : extra.type || "TEXT", mediaUrl: extra.mediaUrl || null,
          status: senderType === "CUSTOMER" ? null : extra.status || "READ", createdAt: at, updatedAt: at,
          campaignRecipientId: who === "p" && recipientFor[key] && ago < campaignSent ? recipientFor[key].id : null,
        },
      });
      if (who === "tpl" && campaignSent) {
        recipientFor[key] = await prisma.campaignRecipient.create({
          data: { campaignId: glow.id, customerId: customer.id, status: "SENT", messageId: m.id, attempts: 1, sentAt: at, claimedAt: at },
        });
      }
      if (who === "p") {
        lastCustomerAt = at;
        if (recipientFor[key] && !recipientFor[key].repliedAt) {
          recipientFor[key] = await prisma.campaignRecipient.update({ where: { id: recipientFor[key].id }, data: { repliedAt: at } });
        }
      } else if (who !== "tpl") lastAgentAt = at;
    }
    const last = msgs[msgs.length - 1];
    const lastWho = last[0];
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessage: last[1], lastMessageAt: minsAgo(last[2]), lastSenderType: lastWho === "p" ? "CUSTOMER" : lastWho === "bot" ? "BOT" : "AGENT",
        lastCustomerMessageAt: lastCustomerAt, lastAgentReplyAt: lastAgentAt,
        awaitingReplySince: lastWho === "p" && status !== "RESOLVED" ? minsAgo(last[2]) : null,
      },
    });
    return conv;
  }

  const glowText = "Summer Glow ✨ 20% off HydraFacial — Hi there, beat the summer heat with our HydraFacial — 20% off until the end of the month.";
  const conv = {};
  conv.fatima = await chat("01", {
    assigned: "agent", unread: 2,
    msgs: [
      ["p", "Hello, I had a HydraFacial last month and loved it 😊", 95],
      ["a", "Hi Fatima! Lovely to hear from you. Would you like to book your next session?", 90],
      ["p", "Yes please. Do you have anything on Thursday evening?", 14],
      ["p", "After 6pm ideally", 12],
    ],
  });
  conv.james = await chat("02", {
    unread: 1,
    msgs: [["p", "Hi, I hurt my lower back at the gym. Can I see a physio this week?", 41]],
  });
  conv.aisha = await chat("03", {
    assigned: "agent", campaignSent: 4300,
    msgs: [
      ["tpl", glowText, 4300],
      ["p", "Tell me more", 4290],
      ["bot", "Our HydraFacial cleanses, exfoliates and hydrates in about 45 minutes, with no downtime. Would you like to book?", 4289],
      ["p", "Yes I'd like to book one, maybe Saturday morning?", 300],
      ["a", "Of course! Let me check Saturday morning for you 🙂", 290],
    ],
  });
  conv.mohammed = await chat("04", {
    assigned: "agent2", status: "RESOLVED",
    msgs: [
      ["p", "I need a dental cleaning, is next week possible?", 1500],
      ["a2", "Yes — we have Tuesday at 11:00 with Dr. Sara. Shall I book it?", 1490],
      ["p", "Perfect, book it please", 1480],
      ["a2", "Done ✅ See you Tuesday at 11:00. You'll get a reminder the day before.", 1470],
    ],
  });
  conv.sophie = await chat("05", {
    assigned: "agent", outcome: "FOLLOW_UP", outcomeBy: "agent", followUpAt: inHours(3), campaignSent: 4300,
    msgs: [
      ["tpl", glowText, 4300],
      ["p", "How much is it after the discount?", 2000],
      ["a", "It's AED 560 after the 20% discount. Would you like me to hold a slot?", 1990],
      ["p", "Let me check my calendar and come back to you", 1985],
    ],
  });
  conv.hassan = await chat("06", {
    assigned: "agent2", status: "PENDING",
    msgs: [
      ["p", "Is laser hair removal painful?", 4400],
      ["a2", "Most patients describe it as a light snap — we use cooling to keep it comfortable.", 4390],
    ],
  });
  conv.priya = await chat("07", {
    assigned: "agent", status: "RESOLVED", campaignSent: 4300,
    msgs: [
      ["tpl", glowText, 4300],
      ["p", "Not for me right now, thanks", 4200],
      ["a", "No problem at all, Priya. We're here whenever you need us.", 4190],
    ],
  });
  conv.khalid = await chat("08", {
    msgs: [
      ["p", "What should I do after my dry needling session?", 180],
      ["bot", "After dry needling, drink plenty of water, keep moving gently and avoid intense exercise for 24 hours. Mild soreness for a day or two is normal. Anything else?", 179],
      ["p", "Thanks! That's helpful", 170],
    ],
  });
  conv.elena = await chat("09", {
    unread: 1, campaignSent: 4300,
    msgs: [
      ["tpl", glowText, 4300],
      ["p", "Book now", 55],
      ["bot", "Great! Which day suits you best?", 54],
      ["p", "This Friday", 53],
      ["bot", "Thank you — a member of our team will confirm your appointment shortly.", 52],
    ],
  });
  conv.noura = await chat("10", {
    assigned: "agent", unread: 1, campaignSent: 4300,
    msgs: [
      ["tpl", glowText, 4300],
      ["p", "مرحبا، هل العرض متاح يوم السبت؟", 25],
    ],
  });
  conv.daniel = await chat("11", {
    msgs: [
      ["p", "STOP", 6000],
    ],
    status: "RESOLVED",
  });
  conv.mariam = await chat("12", {
    assigned: "agent2", campaignSent: 4300,
    msgs: [
      ["tpl", glowText, 4300],
      ["p", "Hi, call me please", 3000],
      ["a2", "Hi Mariam, I tried calling twice — when is a good time?", 2900],
    ],
  });
  conv.ahmed = await chat("13", {
    assigned: "agent", status: "PENDING", outcome: "FOLLOW_UP", outcomeBy: "agent", followUpAt: hoursAgo(5),
    msgs: [
      ["p", "Can you send me my last invoice?", 2900],
      ["a", "Sure — I've asked accounts, I'll send it over as soon as I have it.", 2880],
    ],
  });
  await prisma.customerOptOut.create({ data: { customerId: c["11"].id, whatsappNumberId: number.id, source: "KEYWORD", optedOutAt: minsAgo(6000) } });

  // One failed send on the campaign, for the recipients table.
  await prisma.campaignRecipient.create({
    data: { campaignId: glow.id, customerId: c["14"].id, status: "FAILED", attempts: 3, error: "131026 — Message undeliverable (not on WhatsApp)" },
  });
  await prisma.campaignRecipient.create({
    data: { campaignId: glow.id, customerId: c["16"].id, status: "SKIPPED", error: "Got \"Eid greetings\" recently — limit is one campaign every 7 day(s)" },
  });

  // ── notes ──
  await prisma.conversationNote.create({ data: { conversationId: conv.fatima.id, authorId: staff.agent.id, body: "Prefers evening slots, sensitive skin — use the gentle serum.", createdAt: minsAgo(89) } });
  await prisma.conversationNote.create({ data: { conversationId: conv.sophie.id, authorId: staff.supervisor.id, body: "Price-sensitive — offer the 3-session package if she hesitates.", createdAt: minsAgo(1980) } });

  // ── lists & segments ──
  const vip = await prisma.contactList.create({ data: { name: `${DEMO_TAG} VIP patients`, description: "Long-standing patients who get early access to offers", createdById: staff.marketing.id } });
  const laser = await prisma.contactList.create({ data: { name: `${DEMO_TAG} Laser leads – autumn`, description: "Asked about laser hair removal this year", createdById: staff.marketing.id } });
  for (const k of ["01", "04", "10", "15"]) await prisma.listMember.create({ data: { listId: vip.id, customerId: c[k].id } });
  for (const k of ["06", "12", "14"]) await prisma.listMember.create({ data: { listId: laser.id, customerId: c[k].id } });
  await prisma.segment.create({
    data: {
      name: `${DEMO_TAG} Aesthetics patients`, description: "Everyone in the Aesthetics department on the demo line",
      definition: { match: "ALL", rules: [{ field: "department", op: "has_any", value: ["Aesthetics"] }, { field: "phone", op: "starts_with", value: "+999" }] },
      createdById: staff.marketing.id,
    },
  });
  await prisma.segment.create({
    data: {
      name: `${DEMO_TAG} Women 25–40`, description: "For the Summer Glow follow-up",
      definition: { match: "ALL", rules: [{ field: "gender", op: "eq", value: "FEMALE" }, { field: "age", op: "between", value: [25, 40] }, { field: "phone", op: "starts_with", value: "+999" }] },
      createdById: staff.marketing.id,
    },
  });

  return { staff, number };
}

// ── run ─────────────────────────────────────────────────────────────────────

(async () => {
  const removing = process.argv.includes("--remove");
  await remove();
  if (removing) {
    console.log("seed:demo: demo data removed.");
  } else {
    const { number } = await create();
    console.log(`seed:demo: demo data created on "${number.label}" (id ${number.id}).`);
    console.log(`Staff accounts (password ${PASSWORD}): ${STAFF.map((s) => `${s.username} (${s.role})`).join(", ")}`);
    console.log(`Remove it with: npm run seed:demo -- --remove`);
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("seed:demo failed:", err.message);
  await prisma.$disconnect();
  process.exit(1);
});
