const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");

// Ready-made answers agents insert with "/" in the composer. One shared list;
// the frontend fills {name} when inserting, so the body is stored as typed.

const SHORTCUT_MAX = 30;
const TITLE_MAX = 80;
const BODY_MAX = 4096; // WhatsApp's limit for a text message
const SHORTCUT_RE = /^[a-z0-9_-]+$/;
const SHORTCUT_TAKEN = "That shortcut is already used";

// Returns { data } with trimmed fields, or { error }. With partial, only the
// fields present are checked and returned (for PATCH). Never rewrites a
// shortcut: "Opening Hours" is refused, not turned into "opening-hours".
function validateSavedReply(input, { partial = false } = {}) {
  const data = {};
  const rules = [
    ["shortcut", "Shortcut", SHORTCUT_MAX],
    ["title", "Title", TITLE_MAX],
    ["body", "Text", BODY_MAX],
  ];
  for (const [key, label, max] of rules) {
    const raw = input?.[key];
    if (raw === undefined && partial) continue;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) return { error: `${label} is required` };
    if (value.length > max) return { error: `${label} must be ${max} characters or fewer` };
    if (key === "shortcut" && !SHORTCUT_RE.test(value)) {
      return { error: "Shortcut must be lowercase letters, numbers, - or _ (no spaces)" };
    }
    data[key] = value;
  }
  return { data };
}

const select = { id: true, shortcut: true, title: true, body: true, createdAt: true, updatedAt: true };

const parseId = (raw) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const getSavedReplies = async (req, res, next) => {
  try {
    const replies = await prisma.savedReply.findMany({ select, orderBy: { shortcut: "asc" } });
    res.status(200).json({ success: true, data: replies });
  } catch (err) {
    next(err);
  }
};

const createSavedReply = async (req, res, next) => {
  try {
    const { data, error } = validateSavedReply(req.body);
    if (error) return next(new AppError(error, 400));
    const reply = await prisma.savedReply.create({ data: { ...data, createdById: req.user.id }, select });
    logAudit({ action: "saved_reply.created", actor: req.user, targetType: "SavedReply", targetId: reply.id, details: { shortcut: reply.shortcut } });
    res.status(201).json({ success: true, data: reply });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError(SHORTCUT_TAKEN, 409));
    next(err);
  }
};

const updateSavedReply = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Saved reply not found", 404));
    const { data, error } = validateSavedReply(req.body, { partial: true });
    if (error) return next(new AppError(error, 400));
    if (!Object.keys(data).length) return next(new AppError("Nothing to update", 400));
    const reply = await prisma.savedReply.update({ where: { id }, data, select });
    logAudit({ action: "saved_reply.updated", actor: req.user, targetType: "SavedReply", targetId: id, details: { fields: Object.keys(data), shortcut: reply.shortcut } });
    res.status(200).json({ success: true, data: reply });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError(SHORTCUT_TAKEN, 409));
    if (err.code === "P2025") return next(new AppError("Saved reply not found", 404));
    next(err);
  }
};

const deleteSavedReply = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Saved reply not found", 404));
    const reply = await prisma.savedReply.delete({ where: { id }, select: { shortcut: true } });
    logAudit({ action: "saved_reply.deleted", actor: req.user, targetType: "SavedReply", targetId: id, details: { shortcut: reply.shortcut } });
    res.status(200).json({ success: true });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Saved reply not found", 404));
    next(err);
  }
};

module.exports = {
  validateSavedReply,
  getSavedReplies,
  createSavedReply,
  updateSavedReply,
  deleteSavedReply,
};
