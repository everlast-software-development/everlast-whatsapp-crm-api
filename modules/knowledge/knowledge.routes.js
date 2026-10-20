const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const {
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  approveArticle,
  unapproveArticle,
  archiveArticle,
  deleteArticle,
  reindexAll,
  getReindexStatus,
  askAssistant,
} = require("./knowledge.controller");

const router = express.Router();

// The AI assistant's knowledge base. Not scoped to a WhatsApp line: one
// clinic, one set of approved answers. Everyone reads it; knowledge:write
// (ADMIN) writes and approves.
router.use(protect);

router.get("/", requirePermission("knowledge:read"), listArticles);
router.post("/", requirePermission("knowledge:write"), createArticle);
// Test the assistant: admins only (it runs the real model and costs money).
router.post("/ask", requirePermission("knowledge:write"), askAssistant);
router.post("/reindex-all", requirePermission("knowledge:write"), reindexAll);
router.get("/reindex-status", requirePermission("knowledge:read"), getReindexStatus);
router.get("/:id", requirePermission("knowledge:read"), getArticle);
router.put("/:id", requirePermission("knowledge:write"), updateArticle);
router.post("/:id/approve", requirePermission("knowledge:write"), approveArticle);
router.post("/:id/unapprove", requirePermission("knowledge:write"), unapproveArticle);
router.post("/:id/archive", requirePermission("knowledge:write"), archiveArticle);
router.delete("/:id", requirePermission("knowledge:write"), deleteArticle);

module.exports = router;
