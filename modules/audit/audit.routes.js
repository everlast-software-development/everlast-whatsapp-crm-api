const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getAuditLogs } = require("./audit.controller");
const { getErrors, getErrorSummary, resolveError, reopenError, resolveAll } = require("./errors.controller");

const router = express.Router();

router.use(protect, requirePermission("audit:read"));

router.get("/", getAuditLogs);

// The error log (utils/errorLog.js): admin-only, like the rest of the audit log.
router.get("/errors", getErrors);
router.get("/errors/summary", getErrorSummary);
router.post("/errors/resolve-all", resolveAll);
router.post("/errors/:id/resolve", resolveError);
router.post("/errors/:id/reopen", reopenError);

module.exports = router;
