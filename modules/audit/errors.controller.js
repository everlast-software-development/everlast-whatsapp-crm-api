const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");

const SOURCES = ["webhook", "delivery", "send", "flow", "campaign", "api", "job", "templates", "number", "system"];

// Open = not resolved yet. Grouped entries are one row each, newest activity first.
const errorWhere = (q) => {
  const where = {};
  if (SOURCES.includes(q.source)) where.source = q.source;
  if (q.status === "open" || !q.status) where.resolvedAt = null;
  else if (q.status === "resolved") where.resolvedAt = { not: null };
  const search = String(q.q || "").trim();
  if (search) {
    where.OR = [
      { message: { contains: search, mode: "insensitive" } },
      { code: { contains: search, mode: "insensitive" } },
    ];
  }
  return where;
};

const getErrors = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const where = errorWhere(req.query);

    const [rows, total, bySource] = await Promise.all([
      prisma.errorLog.findMany({ where, orderBy: { lastSeenAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      prisma.errorLog.count({ where }),
      // Open problems per source, for the filter chips.
      prisma.errorLog.groupBy({ by: ["source"], where: { resolvedAt: null }, _count: { _all: true } }),
    ]);

    res.status(200).json({
      success: true,
      data: rows,
      openBySource: Object.fromEntries(bySource.map((g) => [g.source, g._count._all])),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// For the sidebar badge: open problems seen in the last 24 hours.
const getErrorSummary = async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await prisma.errorLog.count({ where: { resolvedAt: null, lastSeenAt: { gte: since } } });
    res.status(200).json({ success: true, data: { recent } });
  } catch (err) {
    next(err);
  }
};

// Resolve (or reopen) one entry. Resolving means "seen / handled": the next
// occurrence of the same problem starts a fresh entry.
const setResolved = (resolved) => async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return next(new AppError("Invalid id", 400));
    const { count } = await prisma.errorLog.updateMany({
      where: { id },
      data: resolved ? { resolvedAt: new Date(), resolvedById: req.user.id } : { resolvedAt: null, resolvedById: null },
    });
    if (!count) return next(new AppError("Not found", 404));
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// Resolve everything open that matches the current filter (source / search).
const resolveAll = async (req, res, next) => {
  try {
    const where = { ...errorWhere({ ...req.body, status: "open" }) };
    const { count } = await prisma.errorLog.updateMany({
      where,
      data: { resolvedAt: new Date(), resolvedById: req.user.id },
    });
    logAudit({ action: "errors.resolved_all", actor: req.user, targetType: "ErrorLog", targetId: 0, details: { count, source: req.body?.source || null } });
    res.status(200).json({ success: true, data: { count } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getErrors, getErrorSummary, resolveError: setResolved(true), reopenError: setResolved(false), resolveAll };
