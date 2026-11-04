const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  syncApprovalStatus,
  importFromMeta,
  mapVariables,
  setTemplateMedia,
  sendTemplate,
} = require("./template.controller");
const {
  listUtilityTemplates,
  createUtilityTemplate,
  updateUtilityTemplate,
  submitUtilityTemplate,
  deleteUtilityTemplate,
} = require("./utilityTemplate.controller");

const router = express.Router();

// This file used to attach `protect` per route, making it the one router that
// did not follow the router.use pattern. Collapsed so number resolution is
// applied uniformly and cannot be forgotten on a route added later.
router.use(protect, resolveNumber());

router.get("/", requirePermission("template:read"), getTemplates);
// Patient messages page: patient-care (UTILITY) templates only, for
// supervisors. Before the /:id routes.
router.get("/utility", requirePermission("template:write_utility"), listUtilityTemplates);
router.post("/utility", requirePermission("template:write_utility"), createUtilityTemplate);
router.put("/utility/:id", requirePermission("template:write_utility"), updateUtilityTemplate);
router.post("/utility/:id/submit", requirePermission("template:write_utility"), submitUtilityTemplate);
router.delete("/utility/:id", requirePermission("template:write_utility"), deleteUtilityTemplate);
router.post("/sync", requirePermission("template:write"), syncApprovalStatus);
// Pull templates made in WhatsApp Manager into the active line's WABA.
router.post("/import", requirePermission("template:write"), importFromMeta);
router.post("/", requirePermission("template:write"), createTemplate);
router.put("/:id", requirePermission("template:write"), updateTemplate);
router.delete("/:id", requirePermission("template:write"), deleteTemplate);
router.post("/:id/submit", requirePermission("template:write"), submitForApproval);
// Imported templates: what each {{n}} means, and a media file of our own.
router.post("/:id/map-variables", requirePermission("template:write"), mapVariables);
router.put("/:id/media", requirePermission("template:write"), setTemplateMedia);

// Send a template in a conversation — :id is conversationId
router.post("/conversations/:id/send-template", requirePermission("message:send"), sendTemplate);

module.exports = router;
