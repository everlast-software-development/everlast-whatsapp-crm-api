const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const c = require("./store.controller");

// Templates → Website: the online store's connection, a template per message
// kind × language, and everything the store sent. Admins only (settings:write).
// The store itself posts to /api/webhooks/store (webhook.routes.js), signed.
const router = express.Router();
router.use(protect, requirePermission("settings:write"));

router.get("/settings", c.getStoreSettings);
router.put("/settings", c.updateStoreSettings);
router.post("/settings/rotate", c.rotateStoreSecret);

router.get("/overview", c.getStoreOverview);
router.get("/messages", c.listStoreMessages);

router.post("/templates", c.createWebsiteTemplate);
router.put("/templates/:id", c.updateWebsiteTemplate);
router.put("/templates/:id/active", c.setWebsiteTemplateActive);
router.post("/templates/:id/submit", c.submitWebsiteTemplate);
router.post("/templates/:id/test-send", c.testSendWebsiteTemplate);
router.delete("/templates/:id", c.deleteWebsiteTemplate);

module.exports = router;
