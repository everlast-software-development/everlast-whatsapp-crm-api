const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const {
  getOverview,
  getMessageStats,
  getConversationStats,
  getAgentStats,
  getCustomerStats,
} = require("./stats.controller");
const { getMarketingStats } = require("./marketing.controller");

const router = express.Router();

// allowAll: this router accepts `X-WhatsApp-Number-Id: all` so an owner can
// see figures across every line, not just the selected one.
router.use(protect, requirePermission("stats:read"), resolveNumber({ allowAll: true }));

router.get("/overview", getOverview);
router.get("/messages", getMessageStats);
router.get("/conversations", getConversationStats);
// How each staff member is doing: supervisors and admins, never marketing.
router.get("/agents", requirePermission("stats:team"), getAgentStats);
router.get("/customers", getCustomerStats);
// The Marketing dashboard. Takes ?from=&to=&numberId= like the supervisor
// reports; the switcher header is ignored (numberId absent = all lines).
router.get("/marketing", requirePermission("stats:marketing"), getMarketingStats);

module.exports = router;
