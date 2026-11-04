const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const {
  getSavedReplies,
  createSavedReply,
  updateSavedReply,
  deleteSavedReply,
} = require("./savedReply.controller");

const router = express.Router();

router.use(protect);

router.get("/", requirePermission("saved_reply:read"), getSavedReplies);
router.post("/", requirePermission("saved_reply:write"), createSavedReply);
router.patch("/:id", requirePermission("saved_reply:write"), updateSavedReply);
router.delete("/:id", requirePermission("saved_reply:write"), deleteSavedReply);

module.exports = router;
