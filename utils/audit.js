const prisma = require("../config/prisma");

const logAudit = ({ action, actor, targetType, targetId, details }) => {
  prisma.auditLog.create({
    data: {
      action,
      actorId: actor?.id || null,
      actorUsername: actor?.username || null,
      targetType,
      targetId,
      details: details || null,
    },
  }).catch((err) => console.error("Audit log failed:", err.message));
};

// Audit details never hold a full phone number (or a message body): the last
// four digits are enough to tell entries apart.
const maskPhone = (phone) => (phone ? `…${String(phone).slice(-4)}` : null);

module.exports = logAudit;
module.exports.maskPhone = maskPhone;
