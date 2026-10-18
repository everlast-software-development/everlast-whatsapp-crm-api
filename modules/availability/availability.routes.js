const express = require("express");
const protect = require("../../middleware/auth");
const { requireAnyPermission } = require("../../middleware/permissions");
const { getDays, getDay, checkSlot, parseText } = require("./availability.controller");

const router = express.Router();

// The clinic's free times aren't tied to a WhatsApp line. Open to whoever works
// booking requests (conversation:read) or can read flows, whose simulator
// shows free times (campaign:read — flows have no permissions of their own).
router.use(protect, requireAnyPermission("conversation:read", "campaign:read"));

router.get("/days", getDays);
router.get("/day", getDay);
router.get("/check", checkSlot);
router.get("/parse", parseText);

module.exports = router;
