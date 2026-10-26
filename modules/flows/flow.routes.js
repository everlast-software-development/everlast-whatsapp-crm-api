const express = require("express");
const requirePermission = require("../../middleware/permissions");
const { listFlows, getFlow, createFlow, duplicateFlow, updateFlow, deleteFlow, listFlowRuns } = require("./flow.controller");

// Mounted at /api/campaigns/flows by campaign.routes.js, which has already run
// protect + resolveNumber. Flows are part of the campaign manager, so they use
// its permissions: reading needs campaign:read, building needs campaign:write.
const router = express.Router();

router.get("/", requirePermission("campaign:read"), listFlows);
router.post("/", requirePermission("campaign:write"), createFlow);
router.get("/:id", requirePermission("campaign:read"), getFlow);
router.put("/:id", requirePermission("campaign:write"), updateFlow);
// Copy under a free "X (copy)" name — duplicating never fails on a name clash.
router.post("/:id/duplicate", requirePermission("campaign:write"), duplicateFlow);
router.delete("/:id", requirePermission("campaign:write"), deleteFlow);
router.get("/:id/runs", requirePermission("campaign:read"), listFlowRuns);

module.exports = router;
