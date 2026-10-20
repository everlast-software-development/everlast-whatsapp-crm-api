const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getOverview, getConversations, getConversationTimeline, getActivity } = require("./supervision.controller");

const router = express.Router();

// Supervisors (team:supervise) and admins. Across all numbers — not scoped by
// the number switcher; ?numberId= narrows when wanted.
router.use(protect, requirePermission("team:supervise"));

router.get("/overview", getOverview);
router.get("/conversations", getConversations);
router.get("/conversations/:id", getConversationTimeline);
router.get("/activity", getActivity);
// Move one person's open chats to a colleague / the queue.
router.post("/hand-over", async (req, res, next) => {
  try {
    const AppError = require("../../utils/AppError");
    const { handOver } = require("../../utils/handOver");
    const fromUserId = parseInt(req.body?.fromUserId);
    if (!Number.isInteger(fromUserId)) return next(new AppError("Choose whose chats to hand over", 400));
    // Your own chats go through "End of shift" (/api/users/me/hand-over). And a
    // supervisor manages the team, not the admins above them.
    if (fromUserId === req.user.id) return next(new AppError("Use End of shift to hand over your own chats", 400));
    const { isAdminRole } = require("../../config/permissions");
    if (!isAdminRole(req.user.role)) {
      const prisma = require("../../config/prisma");
      const from = await prisma.user.findUnique({ where: { id: fromUserId }, select: { role: true } });
      if (from && isAdminRole(from.role)) return next(new AppError("Only an admin can hand over an admin's chats", 403, "FORBIDDEN"));
    }
    const result = await handOver(fromUserId, req.body?.toUserId ?? null, req.user, { reason: "supervisor reassigned" });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});
// The PDF report: figures for a period, and the transcripts the supervisor ticks.
const { getReport, getTranscripts } = require("./report.controller");
router.get("/report", getReport);
router.get("/report/transcripts", getTranscripts);
// The separate, detailed reports.
const { getTeamReport, getCampaignsReport, getChatsReport } = require("./reports.controller");
router.get("/reports/team", getTeamReport);
router.get("/reports/campaigns", getCampaignsReport);
router.get("/reports/chats", getChatsReport);

module.exports = router;
