const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { emitToNumber } = require("../../utils/socket");
const { roleHasPermission } = require("../../config/permissions");

// The chat's outcome, set by the agent handling it, plus staff-only notes.
// The only outcome left is "Follow up" (a date: the chat goes to the
// Follow-ups tab and jobs/followUpReminders.js reminds whoever owns it); the
// other choice is clearing it. A patient writing again clears it on its own
// (see the webhook).
//
// NOT_INTERESTED, NO_ANSWER and BOOKED are still in the database enum because
// older chats may carry them, but they can no longer be chosen. A chat holding
// one can be set to Follow up or cleared like any other.
const OUTCOMES = ["FOLLOW_UP"];
const RETIRED_OUTCOMES = ["NOT_INTERESTED", "NO_ANSWER", "BOOKED"];
const PERSON = { select: { id: true, name: true, username: true } };

const validDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function loadConversation(req) {
  const id = parseInt(req.params.id);
  const conversation = await prisma.conversation.findFirst({ where: { id, whatsappNumberId: req.numberId } });
  if (!conversation) throw new AppError("Conversation not found", 404);
  return conversation;
}

const outcomeView = (c) => ({
  id: c.id,
  outcome: c.outcome,
  outcomeAt: c.outcomeAt,
  outcomeBy: c.outcomeBy || null,
  followUpAt: c.followUpAt,
});

// ─── PUT /api/conversations/:id/outcome ─────────────────────────────────────
// { outcome: "FOLLOW_UP", followUpAt }   { outcome: null } clears it.
const setOutcome = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const outcome = req.body.outcome ?? null;
    if (RETIRED_OUTCOMES.includes(outcome)) {
      return next(new AppError("That outcome is no longer used. Set a follow-up date, or clear the outcome", 400));
    }
    if (outcome !== null && !OUTCOMES.includes(outcome)) {
      return next(new AppError(`Outcome must be one of ${OUTCOMES.join(", ")}`, 400));
    }

    const now = new Date();
    // followUpNotifiedAt reset: a new follow-up date gets its own reminder.
    const data = { outcome, outcomeAt: outcome ? now : null, outcomeById: outcome ? req.user.id : null, followUpAt: null, followUpNotifiedAt: null };

    if (outcome === "FOLLOW_UP") {
      const followUpAt = validDate(req.body.followUpAt);
      if (!followUpAt) return next(new AppError("Choose when to follow up", 400));
      data.followUpAt = followUpAt;
    }

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data,
      include: { outcomeBy: PERSON },
    });

    logAudit({
      action: "conversation.outcome_set",
      actor: req.user,
      targetType: "conversation",
      targetId: conversation.id,
      details: {
        outcome,
        previousOutcome: conversation.outcome,
        followUpAt: data.followUpAt,
      },
    });
    emitToNumber(conversation.whatsappNumberId, "conversation.outcome", { conversationId: conversation.id, outcome });
    emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId: conversation.id });
    res.status(200).json({ success: true, data: outcomeView(updated) });
  } catch (err) {
    next(err);
  }
};

// ─── Notes: GET / POST /api/conversations/:id/notes, DELETE …/notes/:noteId ──
const listNotes = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const notes = await prisma.conversationNote.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      include: { author: PERSON },
    });
    res.status(200).json({ success: true, data: notes });
  } catch (err) {
    next(err);
  }
};

const addNote = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const body = String(req.body.body || "").trim();
    if (!body) return next(new AppError("The note is empty", 400));
    if (body.length > 2000) return next(new AppError("Notes are limited to 2000 characters", 400));
    const note = await prisma.conversationNote.create({
      data: { conversationId: conversation.id, authorId: req.user.id, body },
      include: { author: PERSON },
    });
    emitToNumber(conversation.whatsappNumberId, "conversation.note", { conversationId: conversation.id, noteId: note.id });
    res.status(201).json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Your own notes; a supervisor can remove anyone's.
const deleteNote = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const note = await prisma.conversationNote.findFirst({ where: { id: parseInt(req.params.noteId), conversationId: conversation.id } });
    if (!note) return next(new AppError("Note not found", 404));
    if (note.authorId !== req.user.id && !roleHasPermission(req.user.role, "team:supervise")) {
      return next(new AppError("You can only delete your own notes", 403));
    }
    await prisma.conversationNote.delete({ where: { id: note.id } });
    emitToNumber(conversation.whatsappNumberId, "conversation.note", { conversationId: conversation.id, noteId: note.id });
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports = { setOutcome, listNotes, addNote, deleteNote, OUTCOMES };
