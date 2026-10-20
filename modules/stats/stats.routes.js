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

const router = express.Router();

// allowAll: this router accepts `X-WhatsApp-Number-Id: all` so an owner can
// see figures across every line, not just the selected one.
router.use(protect, requirePermission("stats:read"), resolveNumber({ allowAll: true }));

router.get("/overview", getOverview);
router.get("/messages", getMessageStats);
router.get("/conversations", getConversationStats);
router.get("/agents", getAgentStats);
router.get("/customers", getCustomerStats);

module.exports = router;
