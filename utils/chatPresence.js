// Who is looking at a chat.
//
// Live: while someone has a chat open, their browser holds a place in the
// chat's socket room (utils/socket.js, "conversation.view"); everyone in the
// room is told who else is there, so two people don't answer the same patient
// at once. Nothing here is stored.
//
// Kept: when someone opens a chat that belongs to a colleague, it's recorded in
// ChatView — one row per person per chat — for the supervisor's "Seen by" list.
// Opening your own chat, or an unassigned one, isn't recorded.

const prisma = require("../config/prisma");

// Opens closer together than this are the same visit (a reload, switching
// tabs and back), so `visits` counts real visits.
const VISIT_GAP_MS = 30 * 60 * 1000;

const chatRoom = (conversationId) => `chat:${conversationId}`;

async function recordView({ conversationId, ownerId, userId }) {
  if (!ownerId || ownerId === userId) return;
  const now = new Date();
  const existing = await prisma.chatView.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true, lastSeenAt: true },
  });
  if (!existing) {
    try {
      await prisma.chatView.create({ data: { conversationId, userId, firstSeenAt: now, lastSeenAt: now } });
      return;
    } catch (err) {
      if (err.code !== "P2002") throw err; // a second tab won the race: update it below
    }
  }
  const newVisit = !existing || now - existing.lastSeenAt >= VISIT_GAP_MS;
  await prisma.chatView.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastSeenAt: now, ...(newVisit && existing ? { visits: { increment: 1 } } : {}) },
  });
}

module.exports = { chatRoom, recordView, VISIT_GAP_MS };
