const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { validateGraph, variablesOf } = require("../../utils/flowGraph");
const { expireStaleRuns } = require("../../utils/flowEngine");
const { roleHasPermission } = require("../../config/permissions");
const { nameEquals, isRename, freeName, copied } = require("../../utils/uniqueName");

const RUN_STATUSES = ["ACTIVE", "COMPLETED", "HANDED_OFF", "STOPPED", "EXPIRED", "FAILED"];

const parseId = (raw) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// 400 that carries the per-step problems in `details.errors` (where the
// frontend's ApiError looks), so the builder can mark each step.
const invalidGraph = (res, errors) =>
  res.status(400).json({
    success: false,
    code: "INVALID_FLOW",
    message: errors[0]?.message || "The flow has problems",
    details: { errors },
  });

// A flow attached to a campaign that has been submitted is part of what the
// admin reviewed (or is already answering patients), so it's frozen for
// builders. Admins (campaign:send — they approve anyway) may still change it,
// and that is audited. Returns the first such campaign, or null.
const LOCKING_STATUSES = ["PENDING_APPROVAL", "SCHEDULED", "RUNNING", "PAUSED"];
const STATUS_WORDS = { PENDING_APPROVAL: "awaiting approval", SCHEDULED: "scheduled", RUNNING: "running", PAUSED: "paused" };

const lockingCampaign = (flowId) =>
  prisma.campaign.findFirst({
    where: { flowId, status: { in: LOCKING_STATUSES }, deletedAt: null },
    select: { id: true, name: true, status: true },
    orderBy: { createdAt: "desc" },
  });

const flowInUse = (campaign) =>
  new AppError(
    `This flow is used by campaign "${campaign.name}" (${STATUS_WORDS[campaign.status]}) — duplicate it to make changes.`,
    409,
    "FLOW_IN_USE",
  );

// Two flows with the same name are indistinguishable in the campaign wizard's
// flow picker. Unique among all flows (a deleted flow is really deleted; a
// turned-off one still shows in the list); case and surrounding spaces don't
// count. Flows that were already duplicated before this check stay.
const NAME_MAX = 120;
async function flowNameTaken(name, exceptId = null) {
  const clash = await prisma.flow.findFirst({ where: nameEquals(name, exceptId), select: { id: true } });
  return !!clash;
}
const FLOW_NAME_TAKEN = () => new AppError("A flow with this name already exists", 409, "FLOW_NAME_TAKEN");

// Run counts per status for a set of flows: { [flowId]: { total, ACTIVE, ... } }.
async function runStats(flowIds) {
  if (!flowIds.length) return {};
  const rows = await prisma.flowRun.groupBy({
    by: ["flowId", "status"],
    where: { flowId: { in: flowIds } },
    _count: { _all: true },
  });
  const out = {};
  for (const r of rows) {
    const s = (out[r.flowId] ||= { total: 0 });
    s[r.status] = r._count._all;
    s.total += r._count._all;
  }
  return out;
}

// ─── GET /api/campaigns/flows ────────────────────────────────────────────────
const listFlows = async (req, res, next) => {
  try {
    const flows = await prisma.flow.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, description: true, isActive: true, createdAt: true, updatedAt: true,
        createdBy: { select: { id: true, name: true, username: true } },
        _count: { select: { campaigns: true } },
      },
    });
    const stats = await runStats(flows.map((f) => f.id));
    res.json({
      success: true,
      data: flows.map(({ _count, ...f }) => ({ ...f, campaignCount: _count.campaigns, runs: stats[f.id] || { total: 0 } })),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/campaigns/flows/:id ────────────────────────────────────────────
const getFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const flow = await prisma.flow.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, username: true } },
        campaigns: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!flow) return next(new AppError("Flow not found", 404));
    const stats = await runStats([id]);
    res.json({ success: true, data: { ...flow, variables: variablesOf(flow.graph), runs: stats[id] || { total: 0 } } });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/campaigns/flows ───────────────────────────────────────────────
const createFlow = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, NAME_MAX).trim();
    if (!name) return next(new AppError("Give the flow a name", 400));
    const { graph, errors } = validateGraph(req.body.graph);
    if (errors.length) return invalidGraph(res, errors);
    if (await flowNameTaken(name)) return next(FLOW_NAME_TAKEN());

    const flow = await prisma.flow.create({
      data: {
        name,
        description: String(req.body.description || "").trim().slice(0, 500) || null,
        isActive: req.body.isActive !== false,
        graph,
        createdById: req.user.id,
      },
    });
    logAudit({ action: "flow.created", actor: req.user, targetType: "flow", targetId: flow.id, details: { name: flow.name } });
    res.status(201).json({ success: true, data: { ...flow, variables: variablesOf(graph) } });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/campaigns/flows/:id ────────────────────────────────────────────
// Editing a flow affects runs already in progress: a parked run resumes into
// the NEW graph. A step that was deleted ends that run (recorded as FAILED with
// the reason), which is the honest outcome — the step it was waiting on is gone.
const updateFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const existing = await prisma.flow.findUnique({ where: { id }, select: { id: true, name: true, updatedAt: true } });
    if (!existing) return next(new AppError("Flow not found", 404));
    const locked = await lockingCampaign(id);
    const isAdmin = roleHasPermission(req.user.role, "campaign:send");
    if (locked && !isAdmin) return next(flowInUse(locked));

    // A builder tab opened before someone else saved must not silently put
    // its older copy back: the editor sends the version it loaded, and a save
    // based on an outdated version is refused.
    if (req.body.graph !== undefined && req.body.baseUpdatedAt) {
      const base = new Date(req.body.baseUpdatedAt);
      if (!Number.isNaN(base.getTime()) && existing.updatedAt.getTime() > base.getTime()) {
        return next(new AppError(
          "This flow was changed somewhere else after you opened it. Reload the page to get the latest version before saving.",
          409,
          "FLOW_CHANGED",
        ));
      }
    }

    const data = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, NAME_MAX).trim();
      if (!name) return next(new AppError("Give the flow a name", 400));
      // Only a real rename is checked (the editor sends the name back on every
      // save), and the flow itself never counts as the clash.
      if (isRename(existing.name, name) && (await flowNameTaken(name, id))) return next(FLOW_NAME_TAKEN());
      data.name = name;
    }
    if (req.body.description !== undefined) data.description = String(req.body.description || "").trim().slice(0, 500) || null;
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (req.body.graph !== undefined) {
      const { graph, errors } = validateGraph(req.body.graph);
      if (errors.length) return invalidGraph(res, errors);
      data.graph = graph;
    }

    const flow = await prisma.flow.update({ where: { id }, data });
    logAudit({
      action: "flow.updated", actor: req.user, targetType: "flow", targetId: id,
      details: {
        fields: Object.keys(data),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        // An admin changing a flow a submitted/running campaign uses.
        ...(locked ? { lockedByCampaign: { id: locked.id, name: locked.name, status: locked.status } } : {}),
      },
    });
    res.json({ success: true, data: { ...flow, variables: variablesOf(flow.graph) } });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/campaigns/flows/:id/duplicate ─────────────────────────────────
// A copy to change freely (e.g. when the original is locked by a submitted
// campaign). Picks the first free "X (copy)", "X (copy 2)"… so duplicating
// never fails on the name. The copy starts on, with no runs and no campaigns.
const duplicateFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const source = await prisma.flow.findUnique({ where: { id }, select: { id: true, name: true, description: true, graph: true } });
    if (!source) return next(new AppError("Flow not found", 404));

    // Room for the longest suffix within the name limit.
    const base = source.name.trim().slice(0, NAME_MAX - 12).trim() || "Flow";
    const name = await freeName((n) => flowNameTaken(n), base, copied);
    const flow = await prisma.flow.create({
      data: { name, description: source.description, isActive: true, graph: source.graph, createdById: req.user.id },
    });
    logAudit({
      action: "flow.created", actor: req.user, targetType: "flow", targetId: flow.id,
      details: { name: flow.name, duplicatedFrom: { id: source.id, name: source.name } },
    });
    res.status(201).json({ success: true, data: { ...flow, variables: variablesOf(flow.graph) } });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/campaigns/flows/:id ─────────────────────────────────────────
// Deleting would delete every response the flow collected (FlowRun cascades),
// so a flow that has been used can only be turned off.
const deleteFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const flow = await prisma.flow.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { runs: true } } } });
    if (!flow) return next(new AppError("Flow not found", 404));
    const locked = await lockingCampaign(id);
    if (locked && !roleHasPermission(req.user.role, "campaign:send")) return next(flowInUse(locked));
    if (flow._count.runs > 0) {
      return next(new AppError(
        `This flow has ${flow._count.runs} response(s). Turn it off instead, so its collected data is kept.`, 409,
      ));
    }
    await prisma.flow.delete({ where: { id } });
    logAudit({
      action: "flow.deleted", actor: req.user, targetType: "flow", targetId: id,
      details: { name: flow.name, ...(locked ? { lockedByCampaign: { id: locked.id, name: locked.name, status: locked.status } } : {}) },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/campaigns/flows/:id/runs?status=&page=&limit= ──────────────────
// The flow's responses: who went through it, where they ended, what they gave.
// When each flow last had its abandoned runs marked EXPIRED (see listFlowRuns).
const lastExpiredAt = new Map();

const listFlowRuns = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const flow = await prisma.flow.findUnique({ where: { id }, select: { id: true, graph: true } });
    if (!flow) return next(new AppError("Flow not found", 404));

    // At most once a minute per flow: the update is a full round trip to the
    // database, and paging or filtering the list shouldn't pay for it again.
    if ((lastExpiredAt.get(id) || 0) < Date.now() - 60 * 1000) {
      lastExpiredAt.set(id, Date.now());
      await expireStaleRuns({ flowId: id });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
    const where = { flowId: id };
    if (req.query.status) {
      if (!RUN_STATUSES.includes(req.query.status)) return next(new AppError("Unknown status", 400));
      where.status = req.query.status;
    }
    // Number scoping: a run lives in a conversation on one line; only show the
    // runs of the line being viewed, like every other inbox-derived list.
    if (req.numberId) where.conversation = { whatsappNumberId: req.numberId };

    const [runs, total] = await Promise.all([
      prisma.flowRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.flowRun.count({ where }),
    ]);
    res.json({
      success: true,
      data: runs,
      variables: variablesOf(flow.graph),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { listFlows, getFlow, createFlow, duplicateFlow, updateFlow, deleteFlow, listFlowRuns };
