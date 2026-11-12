// Who may own a conversation, and the "replying claims it" rule — kept in one
// place so the assign endpoint, the send paths and the assignable-users list
// can never disagree about it.

const prisma = require("../config/prisma");
const { roleHasPermission } = require("../config/permissions");
const { emitToNumber } = require("./socket");
const logAudit = require("./audit");

// The fields every assignment response and socket event carries about the owner.
const ASSIGNEE_SELECT = { id: true, name: true, username: true };

// Admins oversee the inbox: they can read and reply in any chat, but chats are
// never theirs — not by hand, not by replying, not by a flow or a hand-over.
// A role-name rule on purpose: ADMIN is "*" in config/permissions.js, so no
// permission can be taken away from it.
const NEVER_OWNS_CHATS = ["ADMIN"];
const canOwnChats = (role) => !NEVER_OWNS_CHATS.includes(role) && roleHasPermission(role, "conversation:write");

// An owner must be able to actually work the conversation: an active account
// whose role can reply — and not an admin. A marketing user (read-only inbox)
// is not assignable either.
function isAssignable(user) {
  return Boolean(user && user.isActive && canOwnChats(user.role));
}

// Assign an UNASSIGNED conversation to the user replying in it. The WHERE clause
// includes `assignedAgentId: null`, so it is one atomic statement: if two agents
// reply at the same moment, exactly one update matches and the first reply wins —
// the second never overwrites the first. Returns true if this call claimed it.
async function claimIfUnassigned({ conversationId, numberId, user }) {
  if (!canOwnChats(user.role)) return false;

  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAgentId: null },
    data: { assignedAgentId: user.id },
  });
  if (count === 0) return false;
  // A person has it now: the store's AI stops (utils/aiAssistant.js).
  require("./aiAssistant").stop(conversationId, "a person took the chat");

  emitToNumber(numberId, "conversation.assigned", {
    conversationId,
    agentId: user.id,
    agentUsername: user.username,
  });
  emitToNumber(numberId, "conversation.updated", { conversationId });

  logAudit({
    action: "conversation.claimed",
    actor: user,
    targetType: "conversation",
    targetId: conversationId,
    details: { agentId: user.id, agentUsername: user.username, reason: "replied while unassigned" },
  });
  return true;
}

// ── Who may change a chat ───────────────────────────────────────────────────
// Everyone who works the inbox can read every chat on their line, but a chat's
// owner decides what happens to it: its assignment, its follow-up and its
// status. Team leads (team:supervise — supervisors and admins) may change any
// chat; an unassigned chat is anyone's. The one way into a colleague's chat is
// taking it over yourself while they're away (on a break or offline) — never
// while they're online, and only once confirmed, so it can't happen by a
// mis-click. Replying in a colleague's chat has its own confirm (replyGuards).

const AppError = require("./AppError");

const leadsTeam = (user) => roleHasPermission(user?.role, "team:supervise");
const ownerName = (owner) => (owner ? owner.name || owner.username : "a colleague");

/**
 * Throws unless `user` may change this chat's follow-up or status.
 * @param conversation needs assignedAgentId; assignedAgent ({ name, username }) for the message
 */
function assertMayChangeChat(conversation, user) {
  const ownerId = conversation.assignedAgentId ?? null;
  if (ownerId === null || ownerId === user.id || leadsTeam(user)) return;
  throw new AppError(
    `This chat belongs to ${ownerName(conversation.assignedAgent)}. Only they or a supervisor can change it — take the chat over first if they're away.`,
    403,
    "NOT_YOUR_CHAT",
    { owner: conversation.assignedAgent ?? null },
  );
}

/**
 * Throws unless `user` may move this chat to `targetId` (null = unassign).
 * Returns "takeover" when it's an allowed take-over of an away colleague's chat.
 * @param conversation needs assignedAgentId and assignedAgent { id, name, username, status }
 */
function assertMayAssign(conversation, user, targetId, { confirmTakeover = false } = {}) {
  const ownerId = conversation.assignedAgentId ?? null;
  if (ownerId === null || ownerId === user.id || leadsTeam(user)) return null;

  const owner = conversation.assignedAgent;
  const who = ownerName(owner);
  if (targetId !== user.id) {
    throw new AppError(
      `This chat belongs to ${who}. Only they or a supervisor can hand it to someone else.`,
      403,
      "NOT_YOUR_CHAT",
      { owner: owner ?? null },
    );
  }
  if (owner?.status === "ONLINE") {
    throw new AppError(
      `${who} is online — ask them to hand the chat over, or ask a supervisor.`,
      403,
      "OWNER_ONLINE",
      { owner },
    );
  }
  if (!confirmTakeover) {
    throw new AppError(
      `${who} is ${owner?.status === "ON_BREAK" ? "on a break" : "offline"}. Take this chat over?`,
      409,
      "TAKEOVER_CONFIRM",
      { owner: owner ?? null },
    );
  }
  return "takeover";
}

// ── Sending into a chat nobody owns ─────────────────────────────────────────
// The chat is taken BEFORE the message goes to WhatsApp. Claiming after the
// send let two agents pressing Send at the same moment both reach the patient
// (each saw "unassigned", each sent, only then did one win the claim). Now the
// claim is the gate: the first sender takes the chat and sends; the second is
// told who has it (ASSIGNED_TO_OTHER — the browser asks "reply anyway?") and
// nothing is sent unless they confirm.
// Returns true when this call took the chat (release it again if the send fails).
async function claimBeforeSend(conversation, user, confirmedOtherOwner) {
  if (conversation.assignedAgentId || !canOwnChats(user.role)) return false;
  const claimed = await claimIfUnassigned({ conversationId: conversation.id, numberId: conversation.whatsappNumberId, user });
  if (claimed) return true;
  // Someone took it between reading the chat and now.
  const fresh = await prisma.conversation.findUnique({
    where: { id: conversation.id },
    select: { assignedAgentId: true, assignedAgent: { select: ASSIGNEE_SELECT } },
  });
  const { assertMayReply } = require("./replyGuards");
  assertMayReply(fresh, user, confirmedOtherOwner);
  return false;
}

// The send failed: a message that never reached the patient doesn't keep the chat.
async function releaseClaim(conversation, user) {
  const { count } = await prisma.conversation.updateMany({
    where: { id: conversation.id, assignedAgentId: user.id },
    data: { assignedAgentId: null },
  });
  if (!count) return;
  emitToNumber(conversation.whatsappNumberId, "conversation.assigned", { conversationId: conversation.id, agentId: null, agentUsername: null });
  emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId: conversation.id });
}

module.exports = {
  claimBeforeSend, releaseClaim,
  ASSIGNEE_SELECT, isAssignable, canOwnChats, claimIfUnassigned,
  leadsTeam, assertMayChangeChat, assertMayAssign,
};
