const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const workersAi = require("../../utils/workersAi");
const {
  SECTIONS,
  normaliseSections,
  hasContent,
  reindexArticle,
  startReindexAll,
  reindexStatus,
} = require("../../utils/knowledge");
const aiAssistant = require("../../utils/aiAssistant");

const STATUSES = ["DRAFT", "APPROVED", "ARCHIVED"];

// What the list and the editor show. `searchable`: the assistant can find it
// right now (approved AND embedded).
const view = (a) => ({
  id: a.id,
  title: a.title,
  category: a.category,
  sections: normaliseSections(a.sections),
  status: a.status,
  approvedById: a.approvedById,
  approvedAt: a.approvedAt,
  createdById: a.createdById,
  updatedById: a.updatedById,
  embeddedAt: a.embeddedAt,
  searchable: a.status === "APPROVED" && Boolean(a.embeddedAt),
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const parseId = (req) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError("Article not found", 404);
  return id;
};

async function findOr404(id) {
  const article = await prisma.knowledgeArticle.findUnique({ where: { id } });
  if (!article) throw new AppError("Article not found", 404);
  return article;
}

function readFields(body, { partial = false } = {}) {
  const data = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? "").trim();
    if (!title) throw new AppError("The title is required", 400);
    if (title.length > 200) throw new AppError("The title must be at most 200 characters", 400);
    data.title = title;
  }
  if (!partial || body.category !== undefined) {
    const category = String(body.category ?? "").trim();
    if (category.length > 80) throw new AppError("The category must be at most 80 characters", 400);
    data.category = category || null;
  }
  if (!partial || body.sections !== undefined) {
    const sections = normaliseSections(body.sections);
    for (const { key, label } of SECTIONS) {
      if (sections[key].length > 20000) throw new AppError(`"${label}" must be at most 20,000 characters`, 400);
    }
    data.sections = sections;
  }
  return data;
}

// The indexing result as the UI words it.
const indexingView = (r) => ({ indexed: Boolean(r?.indexed), reason: r?.reason ?? null, error: r?.error ?? null });

// ─── GET /api/knowledge ─────────────────────────────────────────────────────
// ?status=DRAFT|APPROVED|ARCHIVED &category= &search= (title or any section)
const listArticles = async (req, res, next) => {
  try {
    const where = {};
    const status = String(req.query.status || "").toUpperCase();
    if (STATUSES.includes(status)) where.status = status;
    const category = String(req.query.category || "").trim();
    if (category) where.category = category;
    const search = String(req.query.search || "").trim().slice(0, 100);

    const [rows, categoryRows] = await Promise.all([
      prisma.knowledgeArticle.findMany({ where, orderBy: [{ updatedAt: "desc" }] }),
      prisma.knowledgeArticle.findMany({ where: { category: { not: null } }, select: { category: true }, distinct: ["category"], orderBy: { category: "asc" } }),
    ]);
    // Sections are JSON, so the text search runs here — the knowledge base is
    // tens of articles, not thousands.
    const needle = search.toLowerCase();
    const matches = needle
      ? rows.filter((a) => `${a.title}\n${a.category || ""}\n${Object.values(normaliseSections(a.sections)).join("\n")}`.toLowerCase().includes(needle))
      : rows;

    res.status(200).json({
      success: true,
      data: matches.map(view),
      categories: categoryRows.map((r) => r.category),
      aiConfigured: workersAi.isConfigured(),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/knowledge/:id ─────────────────────────────────────────────────
const getArticle = async (req, res, next) => {
  try {
    const article = await findOr404(parseId(req));
    res.status(200).json({ success: true, data: view(article), aiConfigured: workersAi.isConfigured() });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/knowledge ────────────────────────────────────────────────────
// Always a draft: nothing reaches patients until someone approves it.
const createArticle = async (req, res, next) => {
  try {
    const data = readFields(req.body || {});
    const created = await prisma.knowledgeArticle.create({
      data: { ...data, status: "DRAFT", createdById: req.user.id, updatedById: req.user.id },
    });
    logAudit({ action: "knowledge.created", actor: req.user, targetType: "KnowledgeArticle", targetId: created.id, details: { title: created.title } });
    res.status(201).json({ success: true, data: view(created) });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/knowledge/:id ─────────────────────────────────────────────────
// An edit to an approved article keeps it approved (the editor is an admin,
// the same people who approve) and re-indexes it at once.
const updateArticle = async (req, res, next) => {
  try {
    const id = parseId(req);
    const existing = await findOr404(id);
    const data = readFields(req.body || {}, { partial: true });
    if (existing.status === "APPROVED" && data.sections && !hasContent(data.sections)) {
      return next(new AppError("An approved article needs at least one section filled in — move it to draft first to empty it", 400));
    }
    const updated = await prisma.knowledgeArticle.update({ where: { id }, data: { ...data, updatedById: req.user.id } });
    const indexing = updated.status === "APPROVED" ? await reindexArticle(id) : null;
    logAudit({
      action: "knowledge.updated",
      actor: req.user,
      targetType: "KnowledgeArticle",
      targetId: id,
      details: { title: updated.title, changes: Object.keys(data), status: updated.status },
    });
    const fresh = await findOr404(id);
    res.status(200).json({ success: true, data: view(fresh), indexing: indexing && indexingView(indexing) });
  } catch (err) {
    next(err);
  }
};

// Shared by approve / unapprove / archive.
async function changeStatus(req, status, extra = {}) {
  const id = parseId(req);
  const existing = await findOr404(id);
  if (status === "APPROVED" && !hasContent(existing.sections)) {
    throw new AppError("Fill in at least one section before approving", 400);
  }
  await prisma.knowledgeArticle.update({ where: { id }, data: { status, updatedById: req.user.id, ...extra } });
  const indexing = await reindexArticle(id);
  const fresh = await findOr404(id);
  return { existing, fresh, indexing };
}

// ─── POST /api/knowledge/:id/approve ────────────────────────────────────────
const approveArticle = async (req, res, next) => {
  try {
    const { existing, fresh, indexing } = await changeStatus(req, "APPROVED", { approvedById: req.user.id, approvedAt: new Date() });
    logAudit({
      action: "knowledge.approved",
      actor: req.user,
      targetType: "KnowledgeArticle",
      targetId: fresh.id,
      details: { title: fresh.title, previousStatus: existing.status, indexed: indexing.indexed },
    });
    res.status(200).json({ success: true, data: view(fresh), indexing: indexingView(indexing) });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/knowledge/:id/unapprove ──────────────────────────────────────
// Back to draft: the assistant stops using it immediately.
const unapproveArticle = async (req, res, next) => {
  try {
    const { existing, fresh } = await changeStatus(req, "DRAFT", { approvedById: null, approvedAt: null });
    logAudit({
      action: "knowledge.unapproved",
      actor: req.user,
      targetType: "KnowledgeArticle",
      targetId: fresh.id,
      details: { title: fresh.title, previousStatus: existing.status },
    });
    res.status(200).json({ success: true, data: view(fresh) });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/knowledge/:id/archive ────────────────────────────────────────
const archiveArticle = async (req, res, next) => {
  try {
    const { existing, fresh } = await changeStatus(req, "ARCHIVED", { approvedById: null, approvedAt: null });
    logAudit({
      action: "knowledge.archived",
      actor: req.user,
      targetType: "KnowledgeArticle",
      targetId: fresh.id,
      details: { title: fresh.title, previousStatus: existing.status },
    });
    res.status(200).json({ success: true, data: view(fresh) });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/knowledge/:id ──────────────────────────────────────────────
// Its chunks go with it (ON DELETE CASCADE).
const deleteArticle = async (req, res, next) => {
  try {
    const id = parseId(req);
    const existing = await findOr404(id);
    await prisma.knowledgeArticle.delete({ where: { id } });
    logAudit({
      action: "knowledge.deleted",
      actor: req.user,
      targetType: "KnowledgeArticle",
      targetId: id,
      details: { title: existing.title, status: existing.status },
    });
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/knowledge/reindex-all ────────────────────────────────────────
// After Workers AI is first configured (or the embedding model changes).
// Default: waits and answers with the counts. ?background=1: starts it (or
// joins the one already running) and answers at once with the progress —
// poll GET /api/knowledge/reindex-status.
const reindexAll = async (req, res, next) => {
  try {
    if (!workersAi.isConfigured()) {
      return next(new AppError("Cloudflare Workers AI isn't configured — add the account ID and API token in Settings → AI assistant → AI model & Cloudflare", 400, "AI_NOT_CONFIGURED"));
    }
    const wasRunning = reindexStatus().running;
    const run = startReindexAll({ trigger: "manual" });
    const audit = (results) => {
      if (!wasRunning) logAudit({ action: "knowledge.reindexed", actor: req.user, targetType: "KnowledgeArticle", targetId: 0, details: results });
    };
    if (req.query.background === "1") {
      run.then(audit).catch((err) => console.error("[knowledge] re-index failed:", err.message));
      return res.status(202).json({ success: true, data: reindexStatus(), alreadyRunning: wasRunning });
    }
    const results = await run;
    audit(results);
    res.status(200).json({ success: true, data: results, alreadyRunning: wasRunning });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/knowledge/reindex-status ──────────────────────────────────────
const getReindexStatus = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: reindexStatus() });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/knowledge/ask ────────────────────────────────────────────────
// "Test the assistant": the full pipeline on a typed question. Sends nothing,
// saves nothing. A small per-user limit, since each one costs a model call.
const ASK_LIMIT = 15;
const ASK_WINDOW_MS = 60 * 1000;
const askLog = new Map();
const askAssistant = async (req, res, next) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) return next(new AppError("Type a question", 400));
    if (question.length > 2000) return next(new AppError("The question must be at most 2,000 characters", 400));
    if (!workersAi.isConfigured()) {
      return next(new AppError("Cloudflare Workers AI isn't configured yet — add the account ID and API token in Settings → AI assistant → AI model & Cloudflare", 400, "AI_NOT_CONFIGURED"));
    }
    const now = Date.now();
    const recent = (askLog.get(req.user.id) || []).filter((t) => now - t < ASK_WINDOW_MS);
    if (recent.length >= ASK_LIMIT) return next(new AppError("Too many test questions — wait a minute and try again", 429));
    askLog.set(req.user.id, [...recent, now]);

    const r = await aiAssistant.ask({ question });
    res.status(200).json({
      success: true,
      data: {
        reply: r.reply,
        outcome: r.outcome,
        reason: r.reason,
        summary: r.summary,
        draft: r.draft,
        error: r.error,
        toolCalls: r.toolCalls,
        sources: r.sources.map(({ title, section, score }) => ({ title, section, score })),
        usage: r.usage,
        model: r.model,
        latencyMs: r.latencyMs,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  approveArticle,
  unapproveArticle,
  archiveArticle,
  deleteArticle,
  reindexAll,
  getReindexStatus,
  askAssistant,
};
