const express = require("express");
const verifyWebhookSignature = require("../../middleware/webhookSignature");
const { rateLimit } = require("express-rate-limit");
const { verifyWebhook, receiveWhatsAppMessage } = require("./webhook.controller");
const { receiveStoreMessage } = require("../store/store.controller");

const router = express.Router();

router.get("/whatsapp/messages", verifyWebhook);
// Do NOT log raw headers/body here — the payload contains customer PII (message
// content, phone numbers). Signature verification runs before the handler.
router.post("/whatsapp/messages", verifyWebhookSignature, receiveWhatsAppMessage);

// Messages the online store sends first (utils/storeEvents.js): signed with the shared
// secret, checked in the handler. A generous limit, so a stuck retry loop on
// the store's side can't flood the CRM.
const storeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false, message: { success: false, error: "Too many requests — at most 300 a minute" } });
router.post("/store", storeLimiter, receiveStoreMessage);

module.exports = router;
