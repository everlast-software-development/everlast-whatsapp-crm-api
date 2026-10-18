// Opt-outs remembered by phone number (OptOutSuppression), so deleting a
// contact never erases their "don't message me". Written when an opted-out
// contact is deleted; applied when a contact with that phone is created again
// (by hand, CSV import, list import, or a new inbound WhatsApp message); and
// trimmed when the opt-out is lifted, so it never outlives the consent it
// stands for.

const prisma = require("../config/prisma");

// Before deleting contacts: snapshot each one's opt-outs under their phone.
// The contact's current state is authoritative — lifts keep the suppression in
// step — so an existing row is overwritten, and dropped when nothing is left.
async function rememberOptOuts(customerIds) {
  if (!customerIds.length) return;
  const customers = await prisma.customer.findMany({
    where: { id: { in: customerIds } },
    select: {
      phone: true,
      optedOut: true,
      optOuts: { select: { whatsappNumberId: true, source: true, optedOutAt: true } },
    },
  });
  const ops = [];
  for (const c of customers) {
    if (!c.optedOut && c.optOuts.length === 0) {
      ops.push(prisma.optOutSuppression.deleteMany({ where: { phone: c.phone } }));
      continue;
    }
    const lines = c.optOuts.map((o) => ({ whatsappNumberId: o.whatsappNumberId, source: o.source, optedOutAt: o.optedOutAt.toISOString() }));
    ops.push(prisma.optOutSuppression.upsert({
      where: { phone: c.phone },
      update: { global: c.optedOut, lines },
      create: { phone: c.phone, global: c.optedOut, lines },
    }));
  }
  if (ops.length) await prisma.$transaction(ops);
}

// After creating contacts: give back the opt-outs remembered for their phones.
// Lines whose WhatsApp number no longer exists are skipped. Returns how many
// contacts were affected.
async function applySuppressions(phones) {
  const unique = [...new Set(phones.filter(Boolean))];
  if (!unique.length) return 0;
  const rows = await prisma.optOutSuppression.findMany({ where: { phone: { in: unique } } });
  if (!rows.length) return 0;
  const customers = await prisma.customer.findMany({ where: { phone: { in: rows.map((r) => r.phone) } }, select: { id: true, phone: true } });
  const idByPhone = new Map(customers.map((c) => [c.phone, c.id]));
  const liveNumbers = new Set((await prisma.whatsAppNumber.findMany({ select: { id: true } })).map((n) => n.id));

  let affected = 0;
  for (const row of rows) {
    const customerId = idByPhone.get(row.phone);
    if (!customerId) continue;
    const lines = (Array.isArray(row.lines) ? row.lines : []).filter((l) => liveNumbers.has(Number(l.whatsappNumberId)));
    const ops = lines.map((l) => prisma.customerOptOut.upsert({
      where: { customerId_whatsappNumberId: { customerId, whatsappNumberId: Number(l.whatsappNumberId) } },
      update: {},
      create: {
        customerId,
        whatsappNumberId: Number(l.whatsappNumberId),
        source: l.source || "MANUAL",
        optedOutAt: l.optedOutAt ? new Date(l.optedOutAt) : new Date(),
      },
    }));
    if (row.global) ops.push(prisma.customer.update({ where: { id: customerId }, data: { optedOut: true } }));
    if (ops.length) {
      await prisma.$transaction(ops);
      affected++;
    }
  }
  return affected;
}

// An opt-out was lifted: drop the matching part of the remembered one.
//   { global: true }              — the all-lines switch was turned off
//   { whatsappNumberId, sources } — one line (only those sources, if given;
//                                   a patient's START lifts only their own)
// The row is deleted once nothing is left in it.
async function liftSuppression(phone, { global = false, whatsappNumberId = null, sources = null } = {}) {
  if (!phone) return;
  const row = await prisma.optOutSuppression.findUnique({ where: { phone } });
  if (!row) return;
  const nextGlobal = global ? false : row.global;
  const nextLines = (Array.isArray(row.lines) ? row.lines : []).filter((l) =>
    whatsappNumberId === null ||
    Number(l.whatsappNumberId) !== Number(whatsappNumberId) ||
    (sources && !sources.includes(l.source)),
  );
  if (!nextGlobal && nextLines.length === 0) {
    await prisma.optOutSuppression.deleteMany({ where: { phone } });
  } else {
    await prisma.optOutSuppression.update({ where: { phone }, data: { global: nextGlobal, lines: nextLines } });
  }
}

module.exports = { rememberOptOuts, applySuppressions, liftSuppression };
