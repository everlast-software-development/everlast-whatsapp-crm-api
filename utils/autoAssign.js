// Giving each new chat to one agent, automatically, so the team doesn't race
// to answer (Settings → Assigning chats, on by default).
//
// When a patient is waiting and the chat has no owner, it goes straight to an
// ONLINE agent: the one with the fewest open chats, taking turns on a tie
// (whoever was given a chat longest ago). Only agents (role AGENT): supervisors
// and admins oversee, and can still take or move any chat by hand.
//
// When it happens:
//   - a patient writes in a chat nobody owns (webhook) — unless a flow is
//     talking to them; then
//   - a flow hands the patient to the team without naming an agent;
//   - the backlog: chats that came in while nobody was online (overnight) are
//     shared out once agents are — one chat per online agent per round, every
//     minute and whenever someone comes online, so the first person in
//     doesn't get the whole night's queue.
//
// Nobody online → the chat waits in Unassigned, where replying still claims it.
// Picks run one at a time (a single backend instance, like the rest of the
// app's in-memory state), so two chats arriving together can't both go to the
// same "least busy" agent; the assignment itself is atomic (only if the chat
// is still unowned), so it never overwrites a person's choice.

const prisma = require("../config/prisma");
const logAudit = require("./audit");
const { getSetting } = require("./appSettings");
const { emitToNumber, emitToUser } = require("./socket");
const numbers = require("./whatsappNumbers");
const { roleHasPermission } = require("../config/permissions");

const AUTO_ROLES = ["AGENT"];
// A chat someone gave back (unassigned, or handed back to the queue) doesn't
// go straight back to them.
const RELEASE_MEMORY_MS = 30 * 60 * 1000;
// Only chats a person can still answer freely: the patient wrote in the last 24h.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKLOG_ROUND_MS = 60 * 1000;

const lastGiven = new Map(); // userId → when they were last given a chat
const released = new Map(); // conversationId → { userId, until }

let chain = Promise.resolve();
const oneAtATime = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

const enabled = () => getSetting("autoAssign")?.enabled !== false;

function rememberReleased(conversationIds, userId) {
  if (!userId) return;
  const until = Date.now() + RELEASE_MEMORY_MS;
  for (const id of conversationIds) released.set(id, { userId, until });
}

function releasedBy(conversationId) {
  const r = released.get(conversationId);
  if (!r) return null;
  if (r.until < Date.now()) {
    released.delete(conversationId);
    return null;
  }
  return r.userId;
}

// Online agents who may answer on this line, least busy first.
async function rankAgents(numberId, excludeIds = []) {
  const number = await numbers.getById(numberId).catch(() => null);
  const people = await prisma.user.findMany({
    where: { isActive: true, role: { in: AUTO_ROLES }, status: "ONLINE", ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}) },
    select: { id: true, name: true, username: true, role: true, isActive: true },
  });
  // Same rule as the number middleware: an agent may answer any line, except
  // the docs demo line is for demo accounts only.
  const allowed = people.filter(
    (u) => roleHasPermission(u.role, "conversation:write") && (!number || numbers.isDemoNumber(number) === numbers.isDemoUser(u)),
  );
  if (!allowed.length) return [];
  const open = await prisma.conversation.groupBy({
    by: ["assignedAgentId"],
    where: { assignedAgentId: { in: allowed.map((u) => u.id) }, status: { not: "RESOLVED" } },
    _count: { _all: true },
  });
  const load = new Map(open.map((g) => [g.assignedAgentId, g._count._all]));
  return allowed
    .map((u) => ({ ...u, openChats: load.get(u.id) || 0 }))
    .sort((a, b) => a.openChats - b.openChats || (lastGiven.get(a.id) || 0) - (lastGiven.get(b.id) || 0) || a.id - b.id);
}

/**
 * Give an unowned chat to the next agent. Returns the agent, or null when it
 * stays unassigned (turned off, already owned, a flow is running, nobody online).
 * @param opts.reason    why, for the audit log and the agent's alert
 * @param opts.duringFlow  true from the flow's own hand-off (its run is still active)
 * @param opts.notify    false when the caller alerts the agent itself
 */
function autoAssign(conversationId, { reason = "new chat", duringFlow = false, notify = true, note = null } = {}) {
  return oneAtATime(async () => {
    if (!enabled()) return null;
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, whatsappNumberId: true, assignedAgentId: true, status: true, aiActiveAt: true, customer: { select: { name: true, phone: true } } },
    });
    if (!conv || conv.assignedAgentId || conv.status === "RESOLVED") return null;
    // The store's AI is answering it (utils/aiAssistant.js): it hands over when a person is needed.
    if (conv.aiActiveAt) return null;
    if (!duringFlow && (await prisma.flowRun.count({ where: { conversationId, status: "ACTIVE" } }))) return null;

    const not = releasedBy(conversationId);
    const [agent] = await rankAgents(conv.whatsappNumberId, not ? [not] : []);
    if (!agent) return null;

    const { count } = await prisma.conversation.updateMany({
      where: { id: conversationId, assignedAgentId: null },
      data: { assignedAgentId: agent.id },
    });
    if (!count) return null;
    lastGiven.set(agent.id, Date.now());
    released.delete(conversationId);

    emitToNumber(conv.whatsappNumberId, "conversation.assigned", { conversationId, agentId: agent.id, agentUsername: agent.username });
    emitToNumber(conv.whatsappNumberId, "conversation.updated", { conversationId });
    if (notify) {
      emitToUser(agent.id, "chat.assigned_to_you", {
        conversationId,
        whatsappNumberId: conv.whatsappNumberId,
        customerName: conv.customer?.name || null,
        customerPhone: conv.customer?.phone || "",
        reason,
        // Why it came to them, e.g. the AI's hand-over summary.
        note,
        at: new Date().toISOString(),
      });
    }
    logAudit({
      action: "conversation.auto_assigned",
      actor: null,
      targetType: "conversation",
      targetId: conversationId,
      details: { agentId: agent.id, agentUsername: agent.username, openChats: agent.openChats, reason },
    });
    return agent;
  }).catch((err) => {
    // Never allowed to break message intake or a flow: the chat just stays unassigned.
    console.error("[AutoAssign] failed:", err.message);
    return null;
  });
}

// One round of the backlog: patients waiting in Unassigned (still inside the
// 24-hour window, no flow talking to them), oldest wait first — at most one
// chat per online agent.
let sharing = false;
async function shareBacklog() {
  if (sharing || !enabled()) return 0;
  sharing = true;
  try {
    const online = await prisma.user.count({ where: { isActive: true, role: { in: AUTO_ROLES }, status: "ONLINE" } });
    if (!online) return 0;
    const waiting = await prisma.conversation.findMany({
      where: {
        assignedAgentId: null,
        status: { not: "RESOLVED" },
        awaitingReplySince: { not: null },
        lastCustomerMessageAt: { gte: new Date(Date.now() - WINDOW_MS) },
        flowRuns: { none: { status: "ACTIVE" } },
        aiActiveAt: null,
      },
      orderBy: { awaitingReplySince: "asc" },
      take: online,
      select: { id: true },
    });
    let given = 0;
    for (const c of waiting) if (await autoAssign(c.id, { reason: "waiting in Unassigned" })) given++;
    return given;
  } catch (err) {
    console.error("[AutoAssign] backlog failed:", err.message);
    return 0;
  } finally {
    sharing = false;
  }
}

function startBacklogSharing() {
  setTimeout(shareBacklog, 30 * 1000);
  setInterval(shareBacklog, BACKLOG_ROUND_MS).unref?.();
}

module.exports = { autoAssign, shareBacklog, startBacklogSharing, rememberReleased, rankAgents };
