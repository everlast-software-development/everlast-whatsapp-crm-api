// Chat ownership check: who may reassign, take over, set the follow-up of, and
// close a chat (utils/conversationAssignment.js), and the "Seen by" record
// (utils/chatPresence.js). Drives the REAL assign / status / outcome handlers
// and the supervision seen-by handler.
//
// Safe to run against a database with real patients: it creates only its own
// tagged rows — a throwaway WhatsApp number, phones starting TAG, users named
// own_* — and deletes exactly those in a finally block.
//
//   npm run check:ownership

process.env.WHATSAPP_TOKEN_OWNERSHIPCHECK = "fake-token";
require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });

const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const convCtl = require("../modules/conversations/conversation.controller");
const outcomeCtl = require("../modules/conversations/outcome.controller");
const sup = require("../modules/supervision/supervision.controller");
const { recordView, VISIT_GAP_MS } = require("../utils/chatPresence");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m";
const TAG = "999561";
const PNID = "__ownership_check_pnid__";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}
const made = { numbers: [], users: [], customers: [] };
let ctx;

function call(handler, req) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { resolve({ code: this.code, body }); } };
    Promise.resolve(handler(req, res, (err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
  });
}
const req = (user, extra = {}) => ({ params: {}, query: {}, body: {}, user, numberId: ctx.number.id, number: ctx.number, ...extra });
const owner = async (id) => (await prisma.conversation.findUnique({ where: { id }, select: { assignedAgentId: true } })).assignedAgentId;
const setOwner = (id, userId) => prisma.conversation.update({ where: { id }, data: { assignedAgentId: userId, status: "OPEN", outcome: null, followUpAt: null } });
const setStatus = (userId, status) => prisma.user.update({ where: { id: userId }, data: { status } });
const code = (r) => r.error?.errorCode || r.error?.statusCode || r.code;

const assign = (user, convId, agentId, body = {}) =>
  call(convCtl.assignConversation, req(user, { params: { id: String(convId) }, body: { agentId, ...body } }));
const followUp = (user, convId) =>
  call(outcomeCtl.setOutcome, req(user, { params: { id: String(convId) }, body: { outcome: "FOLLOW_UP", followUpAt: new Date(Date.now() + 3600e3).toISOString() } }));
const closeChat = (user, convId) =>
  call(convCtl.changeConversationStatus, req(user, { params: { id: String(convId) }, body: { status: "RESOLVED" } }));

async function main() {
  try {
    const mk = async (username, role, status = "ONLINE") => {
      const u = await prisma.user.create({ data: { username, name: username, passwordHash: "x", role, status } });
      made.users.push(u.id);
      return u;
    };
    const sara = await mk("own_sara", "AGENT");
    const omar = await mk("own_omar", "AGENT");
    const lead = await mk("own_super", "SUPERVISOR");
    const admin = await mk("own_admin", "ADMIN");
    const number = await prisma.whatsAppNumber.create({ data: { label: "Ownership check", phoneNumberId: PNID, wabaId: "waba_own", tokenEnvKey: "WHATSAPP_TOKEN_OWNERSHIPCHECK" } });
    made.numbers.push(number.id);
    numbers.invalidate();
    ctx = { number };
    const customer = await prisma.customer.create({ data: { phone: `${TAG}00001`, name: "Ownership Patient" } });
    made.customers.push(customer.id);
    const conv = await prisma.conversation.create({ data: { customerId: customer.id, whatsappNumberId: number.id, status: "OPEN", assignedAgentId: sara.id } });
    const id = conv.id;

    console.log(`\n${B}a colleague's chat (Sara owns it, Omar is another agent)${RESET}`);
    await setOwner(id, sara.id);
    let r = await assign(omar, id, null);
    check("Omar can't unassign Sara's chat", code(r) === "NOT_YOUR_CHAT" && (await owner(id)) === sara.id, String(code(r)));
    r = await assign(omar, id, lead.id);
    check("Omar can't hand Sara's chat to someone else", code(r) === "NOT_YOUR_CHAT" && (await owner(id)) === sara.id, String(code(r)));
    await setStatus(sara.id, "ONLINE");
    r = await assign(omar, id, omar.id);
    check("Omar can't take it while Sara is online", code(r) === "OWNER_ONLINE" && (await owner(id)) === sara.id, String(code(r)));
    await setStatus(sara.id, "ON_BREAK");
    r = await assign(omar, id, omar.id);
    check("Sara on a break: Omar is asked to confirm first", code(r) === "TAKEOVER_CONFIRM" && (await owner(id)) === sara.id, String(code(r)));
    r = await assign(omar, id, omar.id, { confirmTakeover: true });
    check("…and with the confirmation, Omar takes it over", r.code === 200 && (await owner(id)) === omar.id, String(code(r)));
    // The audit log is written in the background; over a slow link to the
    // database that can take well over half a second, so look for up to 5s.
    let audit = null;
    for (let i = 0; i < 20 && !audit?.details?.takeover; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      audit = await prisma.auditLog.findFirst({ where: { targetType: "conversation", targetId: id, action: "conversation.assigned" }, orderBy: { id: "desc" } });
    }
    check("the take-over is recorded (from Sara, on a break)", audit?.details?.takeover === true && audit?.details?.previousAgentUsername === "own_sara" && audit?.details?.previousAgentStatus === "ON_BREAK", JSON.stringify(audit?.details));
    await setOwner(id, sara.id);
    await setStatus(sara.id, "OFFLINE");
    r = await assign(omar, id, omar.id, { confirmTakeover: true });
    check("Sara offline: Omar can take it over too", r.code === 200 && (await owner(id)) === omar.id, String(code(r)));

    r = await followUp(omar, id);
    check("…and once it's his, Omar sets the follow-up", r.code === 200, String(code(r)));
    await setOwner(id, sara.id);
    r = await followUp(omar, id);
    check("Omar can't set a follow-up on Sara's chat", code(r) === "NOT_YOUR_CHAT", String(code(r)));
    r = await closeChat(omar, id);
    const st = (await prisma.conversation.findUnique({ where: { id } })).status;
    check("Omar can't close Sara's chat", code(r) === "NOT_YOUR_CHAT" && st === "OPEN", `${code(r)} / ${st}`);

    console.log(`\n${B}the owner, an unassigned chat, and team leads${RESET}`);
    await setOwner(id, sara.id);
    r = await followUp(sara, id);
    check("Sara sets her own chat's follow-up", r.code === 200, String(code(r)));
    r = await assign(sara, id, omar.id);
    check("Sara hands her chat to Omar", r.code === 200 && (await owner(id)) === omar.id, String(code(r)));
    await setOwner(id, sara.id);
    r = await assign(sara, id, null);
    check("Sara releases her chat to the queue", r.code === 200 && (await owner(id)) === null, String(code(r)));
    r = await followUp(omar, id);
    check("an unassigned chat: anyone sets the follow-up (ownership unchanged)", r.code === 200 && (await owner(id)) === null, String(code(r)));
    r = await assign(omar, id, omar.id);
    check("an unassigned chat: Omar assigns it to himself", r.code === 200 && (await owner(id)) === omar.id, String(code(r)));
    await setOwner(id, null);
    r = await assign(omar, id, sara.id);
    check("an unassigned chat: Omar assigns it to Sara", r.code === 200 && (await owner(id)) === sara.id, String(code(r)));

    await setOwner(id, sara.id);
    await setStatus(sara.id, "ONLINE");
    r = await assign(lead, id, omar.id);
    check("a supervisor reassigns Sara's chat while she's online", r.code === 200 && (await owner(id)) === omar.id, String(code(r)));
    await setOwner(id, sara.id);
    r = await followUp(lead, id);
    check("a supervisor sets a follow-up on Sara's chat", r.code === 200, String(code(r)));
    r = await closeChat(lead, id);
    check("a supervisor closes Sara's chat", r.code === 200, String(code(r)));
    await setOwner(id, sara.id);
    r = await assign(admin, id, omar.id);
    check("an admin reassigns any chat", r.code === 200 && (await owner(id)) === omar.id, String(code(r)));
    r = await assign(admin, id, admin.id);
    check("…but still can't own one", code(r) === "NOT_ASSIGNABLE", String(code(r)));
    await setOwner(id, sara.id);
    r = await assign(sara, id, admin.id);
    check("nobody can hand a chat to an admin", code(r) === "NOT_ASSIGNABLE" && (await owner(id)) === sara.id, String(code(r)));

    console.log(`\n${B}"Seen by"${RESET}`);
    await setOwner(id, sara.id);
    await recordView({ conversationId: id, ownerId: sara.id, userId: sara.id });
    check("the owner opening her chat isn't recorded", (await prisma.chatView.count({ where: { conversationId: id } })) === 0);
    await recordView({ conversationId: id, ownerId: null, userId: omar.id });
    check("opening an unassigned chat isn't recorded", (await prisma.chatView.count({ where: { conversationId: id } })) === 0);
    await recordView({ conversationId: id, ownerId: sara.id, userId: omar.id });
    await recordView({ conversationId: id, ownerId: sara.id, userId: omar.id });
    let v = await prisma.chatView.findUnique({ where: { conversationId_userId: { conversationId: id, userId: omar.id } } });
    check("Omar opening Sara's chat is recorded once (a reload isn't a new visit)", v && v.visits === 1, `visits ${v?.visits}`);
    await prisma.chatView.update({ where: { id: v.id }, data: { lastSeenAt: new Date(Date.now() - VISIT_GAP_MS - 1000) } });
    await recordView({ conversationId: id, ownerId: sara.id, userId: omar.id });
    v = await prisma.chatView.findUnique({ where: { id: v.id } });
    check("coming back later counts as a second visit", v.visits === 2, `visits ${v.visits}`);
    await Promise.all([
      recordView({ conversationId: id, ownerId: sara.id, userId: lead.id }),
      recordView({ conversationId: id, ownerId: sara.id, userId: lead.id }),
    ]);
    check("two tabs opening at once make one row", (await prisma.chatView.count({ where: { conversationId: id, userId: lead.id } })) === 1);
    r = await call(sup.getSeenBy, req(lead, { params: { id: String(id) } }));
    const names = (r.body?.data || []).map((x) => x.user.username);
    check("the supervisor's Seen by list shows both", r.code === 200 && names.includes("own_omar") && names.includes("own_super"), names.join(", "));
  } catch (err) {
    check("check ran without crashing", false, err.stack || err.message);
  } finally {
    const convs = await prisma.conversation.findMany({ where: { customerId: { in: made.customers } }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetType: "conversation", targetId: { in: convIds } }, { actorId: { in: made.users } }] } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } }); // ChatView rows cascade
    await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    await prisma.whatsAppNumber.deleteMany({ where: { id: { in: made.numbers } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    numbers.invalidate();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`${R}Check crashed:${RESET}`, err);
  await prisma.$disconnect();
  process.exit(1);
});
