const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { applySuppressions } = require("../../utils/optOutSuppression");
const {
  normalizeImportPhone,
  parseGender,
  parseFlexibleDate,
  splitList,
  parseUpload,
} = require("../customers/import.utils");

// Build a plan for adding CSV rows to a list. Unlike the Contacts importer, a
// row that matches an existing contact (by phone or chart number) is NOT
// rejected as a duplicate — it's linked, so the same person never gets
// duplicated in Contacts even though they can belong to many lists.
async function buildListImportPlan(rows, dateFormat = "auto", defaultCountry = "") {
  const invalid = [];
  const candidates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +2: row 1 is the header
    const { phone, error: phoneError } = normalizeImportPhone(row.phone, defaultCountry);
    if (phoneError) { invalid.push({ row: rowNum, phone: row.phone?.trim() || undefined, reason: phoneError }); continue; }
    const gender = parseGender(row.gender);
    if (gender === undefined) { invalid.push({ row: rowNum, phone, reason: "Invalid gender (use Male or Female)" }); continue; }
    const dateOfBirth = parseFlexibleDate(row.date_of_birth || row.dateofbirth || row.dob, dateFormat);
    if (dateOfBirth === undefined) { invalid.push({ row: rowNum, phone, reason: "Unrecognized date of birth" }); continue; }
    const joinDate = parseFlexibleDate(row.join_date || row.joindate, dateFormat);
    if (joinDate === undefined) { invalid.push({ row: rowNum, phone, reason: "Unrecognized join date" }); continue; }
    const email = row.email?.trim() || null;
    const chartNumber = (row.chart_number || row.chartnumber)?.trim() || null;
    candidates.push({
      rowNum, phone, chartNumber,
      data: {
        name: row.name?.trim() || null,
        phone, email, chartNumber,
        nationality: row.nationality?.trim() || null,
        gender, dateOfBirth, joinDate,
        departments: splitList(row.departments),
        tags: splitList(row.tags),
        notes: row.notes?.trim() || null,
      },
    });
  }

  // Match every candidate against existing contacts (not just a deduped
  // subset) so a repeated row that matches the DB is still correctly labeled
  // "already in Contacts" rather than lumped in with in-file repeats.
  const phones = [...new Set(candidates.map((c) => c.phone))];
  const charts = [...new Set(candidates.map((c) => c.chartNumber).filter(Boolean))];
  const existing = (phones.length || charts.length)
    ? await prisma.customer.findMany({
        where: { OR: [...(phones.length ? [{ phone: { in: phones } }] : []), ...(charts.length ? [{ chartNumber: { in: charts } }] : [])] },
        select: { id: true, phone: true, chartNumber: true },
      })
    : [];
  const existingByPhone = new Map(existing.map((e) => [e.phone, e.id]));
  const existingByChart = new Map(existing.filter((e) => e.chartNumber).map((e) => [e.chartNumber, e.id]));

  // Rows that won't create a new contact — either they already exist in
  // Contacts, or they repeat an earlier (not-yet-existing) row in this same
  // file. Every non-invalid row ends up in exactly one of toCreate/existingRows,
  // so total === toCreate.length + existingRows.length + invalid.length always.
  const seenPhones = new Set();
  const seenCharts = new Set();
  const toCreate = [];
  const existingRows = [];
  for (const c of candidates) {
    const existId = existingByPhone.get(c.phone) ?? (c.chartNumber ? existingByChart.get(c.chartNumber) : undefined);
    if (existId) {
      existingRows.push({ row: c.rowNum, phone: c.phone, reason: "Already in Contacts — will be linked", customerId: existId });
      continue;
    }
    if (seenPhones.has(c.phone) || (c.chartNumber && seenCharts.has(c.chartNumber))) {
      existingRows.push({ row: c.rowNum, phone: c.phone, reason: "Duplicate row in file", customerId: null });
      continue;
    }
    seenPhones.add(c.phone);
    if (c.chartNumber) seenCharts.add(c.chartNumber);
    toCreate.push(c.data);
  }

  return { total: rows.length, invalid, existingRows, toCreate };
}

// Two lists with the same name are indistinguishable in the campaign wizard and
// on the Marketing dashboard's audience table. Case and surrounding spaces
// don't count. Lists that were already duplicated before this check stay.
async function nameTaken(name, exceptId = null) {
  const clash = await prisma.contactList.findFirst({
    where: { name: { equals: name.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return !!clash;
}
const NAME_TAKEN = "A list with this name already exists";

const getAllLists = async (req, res, next) => {
  try {
    const lists = await prisma.contactList.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { members: true } } },
    });
    res.status(200).json({
      success: true,
      data: lists.map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        memberCount: l._count.members,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
};

const createList = async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return next(new AppError("List name is required", 400));
    if (await nameTaken(name)) return next(new AppError(NAME_TAKEN, 409));
    const list = await prisma.contactList.create({
      data: { name: name.trim(), description: description?.trim() || null, createdById: req.user.id },
    });
    logAudit({ action: "list.created", actor: req.user, targetType: "ContactList", targetId: list.id, details: { name: list.name } });
    res.status(201).json({ success: true, data: { ...list, memberCount: 0 } });
  } catch (err) {
    next(err);
  }
};

const getListById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;

    const list = await prisma.contactList.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    if (!list) return next(new AppError("List not found", 404));

    const where = { listId: id };
    if (req.query.search) {
      where.customer = {
        OR: [
          { name: { contains: req.query.search, mode: "insensitive" } },
          { phone: { contains: req.query.search, mode: "insensitive" } },
          { email: { contains: req.query.search, mode: "insensitive" } },
          { chartNumber: { contains: req.query.search, mode: "insensitive" } },
        ],
      };
    }

    const [members, total] = await Promise.all([
      prisma.listMember.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ addedAt: "desc" }, { id: "desc" }],
        include: { customer: true },
      }),
      prisma.listMember.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        id: list.id,
        name: list.name,
        description: list.description,
        memberCount: list._count.members,
        createdAt: list.createdAt,
        updatedAt: list.updatedAt,
        members: members.map((m) => ({ ...m.customer, addedAt: m.addedAt })),
      },
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

const updateList = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description } = req.body;
    const data = {};
    if (name !== undefined) {
      if (!name?.trim()) return next(new AppError("List name is required", 400));
      // Only a real rename is checked, so an old duplicate can still have its
      // description edited (the edit form sends the name back unchanged).
      const current = await prisma.contactList.findUnique({ where: { id }, select: { name: true } });
      if (!current) return next(new AppError("List not found", 404));
      const renamed = current.name.trim().toLowerCase() !== name.trim().toLowerCase();
      if (renamed && (await nameTaken(name, id))) return next(new AppError(NAME_TAKEN, 409));
      data.name = name.trim();
    }
    if (description !== undefined) data.description = description?.trim() || null;

    const list = await prisma.contactList.update({ where: { id }, data });
    logAudit({ action: "list.updated", actor: req.user, targetType: "ContactList", targetId: id, details: { fields: Object.keys(data), name: list.name } });
    res.status(200).json({ success: true, data: list });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("List not found", 404));
    next(err);
  }
};

const deleteList = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const list = await prisma.contactList.delete({ where: { id } }); // ListMember rows cascade
    logAudit({ action: "list.deleted", actor: req.user, targetType: "ContactList", targetId: id, details: { name: list.name } });
    res.status(200).json({ success: true, message: "List deleted" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("List not found", 404));
    next(err);
  }
};

// Link existing contacts into a list (the "select from Contacts" flow).
const addMembers = async (req, res, next) => {
  try {
    const listId = parseInt(req.params.id);
    const { customerIds } = req.body;
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return next(new AppError("Provide a non-empty array of customer ids", 400));
    }
    const list = await prisma.contactList.findUnique({ where: { id: listId } });
    if (!list) return next(new AppError("List not found", 404));

    const parsed = [...new Set(customerIds.map((n) => parseInt(n)).filter((n) => Number.isInteger(n)))];
    if (parsed.length === 0) return next(new AppError("No valid customer ids provided", 400));
    if (parsed.length > 5000) return next(new AppError("Cannot add more than 5000 contacts per request", 400));

    const result = await prisma.listMember.createMany({
      data: parsed.map((customerId) => ({ listId, customerId })),
      skipDuplicates: true,
    });
    logAudit({
      action: "list.members_added", actor: req.user, targetType: "ContactList", targetId: listId,
      details: { name: list.name, added: result.count, alreadyInList: parsed.length - result.count },
    });
    res.status(200).json({
      success: true,
      message: `Added ${result.count} contact(s) to the list`,
      data: { added: result.count, alreadyInList: parsed.length - result.count },
    });
  } catch (err) {
    if (err.code === "P2003") return next(new AppError("One or more customer ids don't exist", 400));
    next(err);
  }
};

// Every customer id in a list, unpaginated — used to seed campaign recipients
// from an entire list in one shot instead of paging through members.
const getListMemberIds = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const list = await prisma.contactList.findUnique({ where: { id } });
    if (!list) return next(new AppError("List not found", 404));

    const members = await prisma.listMember.findMany({
      where: { listId: id },
      select: { customerId: true },
    });
    res.status(200).json({
      success: true,
      data: { listId: id, name: list.name, customerIds: members.map((m) => m.customerId) },
    });
  } catch (err) {
    next(err);
  }
};

const removeMember = async (req, res, next) => {
  try {
    const listId = parseInt(req.params.id);
    const customerId = parseInt(req.params.customerId);
    await prisma.listMember.delete({ where: { listId_customerId: { listId, customerId } } });
    logAudit({ action: "list.member_removed", actor: req.user, targetType: "ContactList", targetId: listId, details: { customerId } });
    res.status(200).json({ success: true, message: "Removed from list" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("That contact isn't in this list", 404));
    next(err);
  }
};

// Dry-run: validate & categorize the upload without writing anything.
const validateListImport = async (req, res, next) => {
  try {
    const listId = parseInt(req.params.id);
    const list = await prisma.contactList.findUnique({ where: { id: listId } });
    if (!list) return next(new AppError("List not found", 404));

    const rows = parseUpload(req);
    const plan = await buildListImportPlan(rows, req.body?.dateFormat, req.body?.defaultCountry);
    res.status(200).json({
      success: true,
      data: {
        total: plan.total,
        valid: plan.toCreate.length,
        duplicates: plan.existingRows.map(({ row, phone, reason }) => ({ row, phone, reason })),
        invalid: plan.invalid,
      },
    });
  } catch (err) {
    next(err);
  }
};

// Real import: create any missing contacts, then link every matched row
// (new + already-existing) into the list.
const importListMembers = async (req, res, next) => {
  try {
    const listId = parseInt(req.params.id);
    const list = await prisma.contactList.findUnique({ where: { id: listId } });
    if (!list) return next(new AppError("List not found", 404));

    const rows = parseUpload(req);
    const plan = await buildListImportPlan(rows, req.body?.dateFormat, req.body?.defaultCountry);

    let createdIds = [];
    if (plan.toCreate.length > 0) {
      await prisma.customer.createMany({ data: plan.toCreate, skipDuplicates: true });
      // Contacts deleted while opted out come back opted out.
      await applySuppressions(plan.toCreate.map((d) => d.phone));
      const created = await prisma.customer.findMany({
        where: { phone: { in: plan.toCreate.map((d) => d.phone) } },
        select: { id: true },
      });
      createdIds = created.map((c) => c.id);
    }
    // Rows that repeated an earlier not-yet-existing row (customerId: null)
    // are the same person as that first row — they're covered once it's
    // created, so only rows already matched to a real contact are linked here.
    const existingIds = plan.existingRows.filter((e) => e.customerId).map((e) => e.customerId);
    const duplicatesInFile = plan.existingRows.filter((e) => !e.customerId).length;
    const allIds = [...new Set([...existingIds, ...createdIds])];

    let linked = 0;
    if (allIds.length > 0) {
      const result = await prisma.listMember.createMany({
        data: allIds.map((customerId) => ({ listId, customerId })),
        skipDuplicates: true,
      });
      linked = result.count;
    }
    logAudit({
      action: "list.imported", actor: req.user, targetType: "ContactList", targetId: listId,
      details: { name: list.name, total: plan.total, created: createdIds.length, linked, invalid: plan.invalid.length },
    });

    res.status(200).json({
      success: true,
      data: {
        total: plan.total,
        created: createdIds.length,
        matchedExisting: existingIds.length,
        linked,
        alreadyInList: allIds.length - linked,
        duplicatesInFile,
        errors: plan.invalid,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAllLists,
  createList,
  getListById,
  updateList,
  deleteList,
  addMembers,
  getListMemberIds,
  removeMember,
  validateListImport,
  importListMembers,
};
