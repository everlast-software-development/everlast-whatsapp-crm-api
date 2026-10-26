const axios = require("axios");
const { Prisma } = require("@prisma/client");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { sendWhatsAppMessage } = require("../../utils/whatsappClient");
const numbers = require("../../utils/whatsappNumbers");
const { emitToNumber } = require("../../utils/socket");
const logAudit = require("../../utils/audit");
const { claimIfUnassigned } = require("../../utils/conversationAssignment");
const { roleHasPermission } = require("../../config/permissions");
const { handOffOnAgentReply } = require("../../utils/flowEngine");
const { readClientMessageId, findDuplicateSend, isClientIdRace, assertMayReply } = require("../../utils/replyGuards");
const { buildTemplateSend } = require("../../utils/templateSend");
const { windowState, windowClosedError } = require("../../utils/messagingWindow");
const { describeMetaTemplateError } = require("../../utils/metaErrors");
const { syncSubmittedTemplates, applyTemplateStatus, applyTemplateCategory } = require("../../utils/templateStatus");
const { toMetaPositionalBody, buildTemplateParams } = require("../../utils/templateVars");
const {
  PLACEHOLDER_RE,
  headerCharError,
  validateHeader,
  validateButtons,
  validateCards,
} = require("../../utils/templateValidation");
const { templateNeedsSetup, assertTemplateReady, isMetaSampleUrl } = require("../../utils/templateSend");
const { mapMetaTemplate, chooseLanguageVersions, applyVariableMapping } = require("../../utils/templateImport");
const { nameEquals, isRename, freeName, numbered } = require("../../utils/uniqueName");

const VALID_CATEGORIES = ["GENERAL", "RE_ENGAGEMENT", "CAMPAIGN"];
const VALID_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PAUSED", "DISABLED"];
// Meta's own per-message billing category, mapped from this CRM's category —
// kept in sync with the frontend's cost estimator (campaigns/new/page.tsx).
const META_TEMPLATE_CATEGORY = { GENERAL: "UTILITY", RE_ENGAGEMENT: "MARKETING", CAMPAIGN: "MARKETING" };
const BODY_MAX_LENGTH = 800; // kept in sync with the frontend's LIMITS.body
const getApiVersion = () => process.env.WHATSAPP_API_VERSION || "v19.0";

const toMetaName = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Meta only accepts these mimetypes for template headers. Anything else (very
// commonly WebP/HEIC/GIF images) is rejected with a cryptic "File Type Not
// Supported" error at submission time.
const META_HEADER_IMAGE_MIME = ["image/jpeg", "image/png"];

// If a Cloudinary delivery URL points at an unsupported image format, rewrite it
// to force on-the-fly conversion to PNG (f_png). Returns null for non-Cloudinary
// URLs (nothing we can transform).
function cloudinaryAsPng(url) {
  if (!/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url)) return null;
  return url.replace("/image/upload/", "/image/upload/f_png/");
}

// Uploads a remote media file to Meta's resumable upload API and returns the
// media "handle" needed to submit a template with an IMAGE/VIDEO/DOCUMENT
// header for approval. Requires WHATSAPP_APP_ID (separate from the WABA id).
async function uploadHeaderMediaHandle(mediaUrl, { appId, accessToken }) {
  if (!appId) {
    throw new AppError("WHATSAPP_APP_ID is not configured — required to submit templates with an image/video/document header", 500);
  }

  let file = await axios.get(mediaUrl, { responseType: "arraybuffer" });
  let contentType = file.headers["content-type"] || "application/octet-stream";

  // Auto-fix unsupported image headers (e.g. WebP) so Meta doesn't reject them.
  if (contentType.startsWith("image/") && !META_HEADER_IMAGE_MIME.includes(contentType)) {
    const pngUrl = cloudinaryAsPng(mediaUrl);
    if (pngUrl) {
      file = await axios.get(pngUrl, { responseType: "arraybuffer" });
      contentType = file.headers["content-type"] || "image/png";
    } else {
      throw new AppError(
        `Template header images must be JPEG or PNG — this file is ${contentType}. Please re-upload it as a JPEG or PNG.`,
        400,
      );
    }
  }

  const fileBuffer = Buffer.from(file.data);

  const session = await axios.post(
    `https://graph.facebook.com/${getApiVersion()}/${appId}/uploads`,
    null,
    { params: { file_length: fileBuffer.length, file_type: contentType, access_token: accessToken } },
  );
  const uploadSessionId = session.data?.id;
  if (!uploadSessionId) throw new AppError("Meta did not return an upload session id", 502);

  const uploaded = await axios.post(
    `https://graph.facebook.com/${getApiVersion()}/${uploadSessionId}`,
    fileBuffer,
    { headers: { Authorization: `OAuth ${accessToken}`, file_offset: "0", "Content-Type": contentType } },
  );
  const handle = uploaded.data?.h;
  if (!handle) throw new AppError("Meta did not return a media handle", 502);
  return handle;
}

const getTemplates = async (req, res, next) => {
  try {
    // Templates belong to a WABA, so two numbers on the same WABA see one shared
    // library and two numbers on different WABAs see none of each other's. That
    // fall-out is the whole reason wabaId is the key rather than the number id.
    const where = { isActive: true, wabaId: req.number.wabaId };
    if (req.query.category) {
      if (!VALID_CATEGORIES.includes(req.query.category)) {
        return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
      }
      where.category = req.query.category;
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return next(new AppError(`Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`, 400));
      }
      where.approvalStatus = req.query.status;
    }

    const templates = await prisma.template.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    // needsSetup: what an imported template still lacks before it can be sent
    // ("variables", "media") — computed, never stored, so it can't go stale.
    res.status(200).json({
      success: true,
      data: templates.map((t) => ({ ...t, needsSetup: templateNeedsSetup(t) })),
    });
  } catch (err) {
    next(err);
  }
};

// Two templates with the same name are indistinguishable in the campaign
// wizard's template picker. Unique per business account (the picker only ever
// lists one WABA's templates) among active ones; case and surrounding spaces
// don't count. Templates that were already duplicated before this check stay.
async function templateNameTaken(wabaId, name, exceptId = null) {
  const clash = await prisma.template.findFirst({
    where: { ...nameEquals(name, exceptId), wabaId, isActive: true },
    select: { id: true },
  });
  return !!clash;
}
const TEMPLATE_NAME_TAKEN = () => new AppError("A template with this name already exists", 409, "TEMPLATE_NAME_TAKEN");

const createTemplate = async (req, res, next) => {
  try {
    const { category, language, headerType, header, headerMediaUrl, body, footer, buttons } = req.body;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name) return next(new AppError("name is required", 400));
    if (await templateNameTaken(req.number.wabaId, name)) return next(TEMPLATE_NAME_TAKEN());
    const cards = validateCards(req.body.cards);
    if (cards && (category || "GENERAL") === "GENERAL") {
      return next(new AppError("A carousel is a marketing template — choose Campaign or Re-engagement as the category", 400));
    }
    if (!body) return next(new AppError("body is required", 400));
    if (body.length > BODY_MAX_LENGTH) return next(new AppError(`Body must be ${BODY_MAX_LENGTH} characters or fewer`, 400));
    if (category && !VALID_CATEGORIES.includes(category)) {
      return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
    }

    // A carousel's only free text is the body above the cards: no header,
    // footer or message-level buttons (Meta's rule for carousel templates).
    const headerFields = cards ? validateHeader("NONE") : validateHeader(headerType, header, headerMediaUrl);
    const validatedButtons = cards ? null : validateButtons(buttons);

    const template = await prisma.template.create({
      data: {
        name,
        // Fixed at creation and never editable: a template is submitted to, and
        // approved by, one specific WhatsApp Business Account.
        wabaId: req.number.wabaId,
        category: category || "GENERAL",
        language: language || "en_US",
        ...headerFields,
        body,
        footer: cards ? null : footer || null,
        buttons: validatedButtons,
        cards,
      },
    });

    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
};

const updateTemplate = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    // 404 rather than 403 for another WABA's template — its existence is not
    // something a caller on a different account needs confirmed.
    const existing = await prisma.template.findFirst({
      where: { id, wabaId: req.number.wabaId },
    });
    if (!existing || !existing.isActive) return next(new AppError("Template not found", 404));

    if (existing.approvalStatus === "SUBMITTED" || existing.approvalStatus === "APPROVED") {
      return next(new AppError("Cannot edit a SUBMITTED or APPROVED template", 400));
    }

    const { category, language, headerType, header, headerMediaUrl, body, footer, buttons } = req.body;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    // Only a real rename is checked (the form sends the name back on every
    // save), and the template itself never counts as the clash.
    if (name && isRename(existing.name, name) && (await templateNameTaken(existing.wabaId, name, id))) {
      return next(TEMPLATE_NAME_TAKEN());
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
    }
    if (body !== undefined && body.length > BODY_MAX_LENGTH) {
      return next(new AppError(`Body must be ${BODY_MAX_LENGTH} characters or fewer`, 400));
    }

    // cards: undefined = unchanged, null/[] = back to a standard template.
    const cards = req.body.cards !== undefined
      ? (Array.isArray(req.body.cards) && req.body.cards.length === 0 ? null : validateCards(req.body.cards))
      : existing.cards;
    if (cards && (category || existing.category) === "GENERAL") {
      return next(new AppError("A carousel is a marketing template — choose Campaign or Re-engagement as the category", 400));
    }
    const headerFields = cards
      ? validateHeader("NONE")
      : headerType !== undefined ? validateHeader(headerType, header, headerMediaUrl) : null;
    const validatedButtons = cards ? null : buttons !== undefined ? validateButtons(buttons) : existing.buttons;

    const template = await prisma.template.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(category && { category }),
        ...(language && { language }),
        ...(headerFields || {}),
        ...(body && { body }),
        footer: cards ? null : footer !== undefined ? footer : existing.footer,
        buttons: validatedButtons,
        cards: cards ?? Prisma.DbNull,
        approvalStatus: "DRAFT",
        rejectionReason: null,
      },
    });

    res.status(200).json({ success: true, data: template });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Template not found", 404));
    next(err);
  }
};

const deleteTemplate = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    // 404 rather than 403 for another WABA's template — its existence is not
    // something a caller on a different account needs confirmed.
    const existing = await prisma.template.findFirst({
      where: { id, wabaId: req.number.wabaId },
    });
    if (!existing || !existing.isActive) return next(new AppError("Template not found", 404));

    // Deleting at Meta stops every send of this template, so refuse while a
    // campaign still needs it rather than failing that campaign mid-send —
    // including drafts and ones waiting for approval, which would otherwise
    // be approved and then fail on their first send.
    const users = await prisma.campaign.findMany({
      where: {
        templateId: id,
        deletedAt: null,
        status: { in: ["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "RUNNING", "PAUSED"] },
      },
      select: { name: true, status: true },
      take: 5,
    });
    if (users.length > 0) {
      const names = users.map((c) => `"${c.name}" (${c.status.toLowerCase().replace("_", " ")})`).join(", ");
      return next(new AppError(
        `Campaigns still use this template: ${names}${users.length === 5 ? " and maybe more" : ""}. Finish, cancel or delete them first.`,
        409,
        "TEMPLATE_IN_USE",
      ));
    }

    // A template that was ever submitted also exists in WhatsApp Manager.
    // Hiding it here alone left it there; delete it at Meta first, so the two
    // never disagree. Meta keeps the name reserved for 30 days afterwards.
    if (existing.metaTemplateName) {
      try {
        const credentials = await numbers.getCredentials(req.numberId);
        await axios.delete(`https://graph.facebook.com/${getApiVersion()}/${existing.wabaId}/message_templates`, {
          params: {
            name: existing.metaTemplateName,
            ...(existing.metaTemplateId ? { hsm_id: existing.metaTemplateId } : {}),
          },
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
          timeout: 20000,
        });
      } catch (metaErr) {
        const metaError = metaErr.response?.data?.error;
        // Already gone at Meta (deleted in WhatsApp Manager): just hide it here.
        const alreadyGone = /does not exist|not found|nonexisting/i.test(metaError?.error_user_msg || metaError?.message || "");
        if (!alreadyGone) {
          console.error("Meta template delete failed:", JSON.stringify(metaErr.response?.data || metaErr.message));
          return next(new AppError(
            `WhatsApp didn't delete the template: ${metaError?.error_user_msg || metaError?.message || metaErr.message}`,
            metaErr.response ? 422 : 502,
            "META_DELETE_FAILED",
          ));
        }
      }
    }

    await prisma.template.update({ where: { id }, data: { isActive: false } });

    res.status(200).json({ success: true, message: "Template deleted" });
  } catch (err) {
    next(err);
  }
};

const submitForApproval = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const template = await prisma.template.findUnique({ where: { id } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));

    if (template.approvalStatus !== "DRAFT" && template.approvalStatus !== "REJECTED") {
      return next(new AppError("Only DRAFT or REJECTED templates can be submitted", 400));
    }

    // The template's own WABA, not the environment's. The ownership check above
    // already guarantees it equals req.number.wabaId.
    const wabaId = template.wabaId;
    const credentials = await numbers.getCredentials(req.numberId);

    const metaName = template.metaTemplateName || toMetaName(template.name);

    // Build Meta components
    const components = [];
    if (template.headerType === "TEXT" && template.header) {
      // Drafts saved before this rule existed skip validateHeader; catch them
      // here with a clear message instead of Meta's error.
      const charErr = headerCharError(template.header);
      if (charErr) return next(new AppError(charErr, 400, "TEMPLATE_INVALID", { field: "header" }));
      // Same named → positional conversion as the body. Header variables are
      // numbered on their own, so the header's one variable is always {{1}}.
      const headerComponent = { type: "HEADER", format: "TEXT", text: toMetaPositionalBody(template.header) };
      const headerSample = buildTemplateParams(template.header, { name: "Sarah Ahmed" }, { name: "Alex" });
      if (headerSample.length > 0) headerComponent.example = { header_text: headerSample };
      components.push(headerComponent);
    } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(template.headerType) && template.headerMediaUrl) {
      let handle;
      try {
        handle = await uploadHeaderMediaHandle(template.headerMediaUrl, {
          appId: credentials.appId,
          accessToken: credentials.accessToken,
        });
      } catch (uploadErr) {
        if (uploadErr instanceof AppError) return next(uploadErr);
        console.error("Header media upload failed:", uploadErr.response?.data || uploadErr.message);
        return next(new AppError("Failed to upload header media to Meta", 502));
      }
      components.push({ type: "HEADER", format: template.headerType, example: { header_handle: [handle] } });
    }

    // Convert named placeholders to Meta positional {{1}},{{2}} (by order of
    // appearance) and attach example values so Meta can validate on submit.
    const metaBody = toMetaPositionalBody(template.body);
    const bodyComponent = { type: "BODY", text: metaBody };
    const sampleParams = buildTemplateParams(template.body, { name: "Sarah Ahmed" }, { name: "Alex" });
    if (sampleParams.length > 0) {
      bodyComponent.example = { body_text: [sampleParams] };
    }
    components.push(bodyComponent);

    if (template.footer) {
      components.push({ type: "FOOTER", text: template.footer });
    }

    // Carousel: every card's media goes up to Meta as a sample (one handle per
    // card), then the cards ride along as a single CAROUSEL component.
    if (Array.isArray(template.cards) && template.cards.length) {
      const cards = [];
      for (const [i, card] of template.cards.entries()) {
        let handle;
        try {
          handle = await uploadHeaderMediaHandle(card.mediaUrl, { appId: credentials.appId, accessToken: credentials.accessToken });
        } catch (uploadErr) {
          if (uploadErr instanceof AppError) return next(new AppError(`Card ${i + 1}: ${uploadErr.message}`, uploadErr.statusCode || 400));
          console.error(`Carousel card ${i + 1} media upload failed:`, uploadErr.response?.data || uploadErr.message);
          return next(new AppError(`Failed to upload card ${i + 1}'s media to Meta`, 502));
        }
        cards.push({
          components: [
            { type: "HEADER", format: card.mediaType, example: { header_handle: [handle] } },
            { type: "BODY", text: card.body },
            {
              type: "BUTTONS",
              buttons: card.buttons.map((b) =>
                b.type === "URL" ? { type: "URL", text: b.title, url: b.url } : { type: "QUICK_REPLY", text: b.title },
              ),
            },
          ],
        });
      }
      components.push({ type: "CAROUSEL", cards });
    }

    if (template.buttons && Array.isArray(template.buttons) && template.buttons.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: template.buttons.map((b) => {
          if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.title, phone_number: b.phoneNumber };
          if (b.type === "URL") {
            const btn = { type: "URL", text: b.title, url: b.url };
            if (PLACEHOLDER_RE.test(b.url)) {
              btn.example = [b.url.replace(PLACEHOLDER_RE, "sample")];
            }
            return btn;
          }
          return { type: "QUICK_REPLY", text: b.title };
        }),
      });
    }

    let metaRes;
    try {
      metaRes = await axios.post(
        `https://graph.facebook.com/${getApiVersion()}/${wabaId}/message_templates`,
        {
          name: metaName,
          language: template.language,
          category: META_TEMPLATE_CATEGORY[template.category] || "MARKETING",
          components,
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } },
      );
    } catch (metaErr) {
      const detail = metaErr.response?.data || metaErr.message;
      console.error("Meta template submission failed:", JSON.stringify(detail));
      // No response at all = Meta was unreachable; that is worth retrying.
      if (!metaErr.response) {
        return next(new AppError("Couldn't reach Meta — check the connection and try again", 502, "META_UNREACHABLE"));
      }
      // Meta answered and said no: pass on its explanation and the field.
      const { message, field, metaCode, metaSubcode } = describeMetaTemplateError(metaErr.response.data);
      return next(new AppError(message, 422, "META_REJECTED", { field, metaCode, metaSubcode }));
    }

    const updated = await prisma.template.update({
      where: { id },
      data: {
        approvalStatus: "SUBMITTED",
        metaTemplateName: metaName,
        metaTemplateId: String(metaRes.data?.id || ""),
        rejectionReason: null,
      },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// Deliberately NOT scoped to the active number. This is global maintenance:
// scoping it to whatever is selected in the dropdown would silently stop
// approval sync for every other WABA, and the symptom — "templates stay
// SUBMITTED forever on the number I'm not looking at" — is near-undiagnosable.
const syncApprovalStatus = async (req, res, next) => {
  try {
    const { approved, rejected, checked } = await syncSubmittedTemplates();
    if (checked === 0) {
      return res.status(200).json({ success: true, message: "No submitted templates to sync", updated: 0 });
    }
    res.status(200).json({ success: true, updated: approved + rejected, approved, rejected });
  } catch (err) {
    next(err);
  }
};

// ── Import from Meta ─────────────────────────────────────────────────────────
//
// Templates made in WhatsApp Manager (or by another tool) never reached the
// CRM. This reads the active line's WABA template list and brings in what the
// CRM can show and send faithfully; the mapping and every skip reason live in
// utils/templateImport.js.

const IMPORT_MAX_TEMPLATES = 1000;
const META_TEMPLATE_FIELDS = "id,name,language,status,category,components,parameter_format,rejected_reason";

// Every page of the WABA's template list. paging.next is followed only while
// it points back at Graph: the token goes with each request.
async function fetchMetaTemplates(wabaId, accessToken) {
  const templates = [];
  let url = `https://graph.facebook.com/${getApiVersion()}/${wabaId}/message_templates`;
  let params = { fields: META_TEMPLATE_FIELDS, limit: 100 };
  let truncated = false;
  while (url) {
    const page = await axios.get(url, { params, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 });
    templates.push(...(Array.isArray(page.data?.data) ? page.data.data : []));
    const nextUrl = page.data?.paging?.next || null;
    if (templates.length >= IMPORT_MAX_TEMPLATES) {
      truncated = templates.length > IMPORT_MAX_TEMPLATES || !!nextUrl;
      break;
    }
    url = nextUrl && /^https:\/\/graph\.facebook\.com\//.test(nextUrl) ? nextUrl : null;
    params = undefined; // the next link already carries the query
  }
  return { templates: templates.slice(0, IMPORT_MAX_TEMPLATES), truncated };
}

const importFromMeta = async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun === true;
    // Scoped to the active line's WABA, like every other template route.
    const wabaId = req.number.wabaId;
    const credentials = await numbers.getCredentials(req.numberId);

    let fetched;
    try {
      fetched = await fetchMetaTemplates(wabaId, credentials.accessToken);
    } catch (metaErr) {
      console.error("Meta template list failed:", JSON.stringify(metaErr.response?.data || metaErr.message));
      if (!metaErr.response) {
        return next(new AppError("Couldn't reach Meta — check the connection and try again", 502, "META_UNREACHABLE"));
      }
      const metaError = metaErr.response.data?.error;
      return next(new AppError(
        `WhatsApp didn't share this account's templates: ${metaError?.error_user_msg || metaError?.message || "unknown error"}`,
        422,
        "META_REJECTED",
      ));
    }

    const metaTemplates = fetched.templates.filter((t) => t && t.name);
    // Inactive (deleted here) rows too: [wabaId, metaTemplateName] is unique
    // across them, so a name deleted here and recreated at Meta reuses its row.
    const rows = await prisma.template.findMany({
      where: { wabaId, metaTemplateName: { in: [...new Set(metaTemplates.map((t) => t.name))] } },
    });
    const rowByName = new Map(rows.map((r) => [r.metaTemplateName, r]));
    const activeLanguage = new Map(rows.filter((r) => r.isActive).map((r) => [r.metaTemplateName, r.language]));
    const { chosen, otherLanguages } = chooseLanguageVersions(metaTemplates, activeLanguage);

    const imported = [];
    const skipped = [];
    let updated = 0;
    // Display names handed out in this import (lower-cased). An imported
    // template never fails on a name clash: it gets the first free
    // "Name", "Name (2)", "Name (3)"… among this WABA's active templates and
    // the others of this batch — also in a dry run, so the preview shows the
    // name it will really get.
    const namesTaken = new Set();

    for (const meta of chosen) {
      const row = rowByName.get(meta.name);

      // Already here: never a duplicate — just refresh what Meta decides.
      if (row && row.isActive) {
        if (row.approvalStatus === "DRAFT") {
          // A local edit not yet resubmitted: Meta's status is about the old
          // wording, and would wrongly mark the new one approved.
          skipped.push({ name: meta.name, language: meta.language, reason: "already in the CRM as a draft being edited — left as it is" });
          continue;
        }
        updated++;
        if (dryRun) continue;
        if (!row.metaTemplateId && meta.id != null) {
          await prisma.template.update({ where: { id: row.id }, data: { metaTemplateId: String(meta.id) } });
        }
        // The same functions the webhook and sync use: one notification, and
        // running campaigns paused if Meta paused/disabled the template.
        const reason = meta.rejected_reason && meta.rejected_reason !== "NONE" ? meta.rejected_reason : null;
        await applyTemplateStatus(row, meta.status, reason, "import");
        await applyTemplateCategory(row, meta.category, "import");
        continue;
      }

      const mapped = mapMetaTemplate(meta);
      if (mapped.reason) {
        skipped.push({ name: meta.name, language: meta.language, reason: mapped.reason });
        continue;
      }

      const name = await freeName(
        (n) => templateNameTaken(wabaId, n, row?.id),
        mapped.data.name,
        numbered,
        namesTaken,
      );

      let id = null;
      if (!dryRun) {
        const data = {
          ...mapped.data,
          name,
          wabaId,
          buttons: mapped.data.buttons ?? Prisma.DbNull,
          cards: mapped.data.cards ?? Prisma.DbNull,
          isActive: true,
          // Not a decision Meta made "since your last visit" — no news banner.
          statusChangedAt: null,
        };
        try {
          const saved = row
            ? await prisma.template.update({ where: { id: row.id }, data })
            : await prisma.template.create({ data });
          id = saved.id;
        } catch (err) {
          // Someone else's import got there first.
          if (err.code === "P2002") {
            skipped.push({ name: meta.name, language: meta.language, reason: "was imported by someone else at the same moment" });
            continue;
          }
          throw err;
        }
      }
      imported.push({
        id,
        name,
        metaTemplateName: meta.name,
        language: mapped.data.language,
        status: mapped.data.approvalStatus,
        needsSetup: mapped.needsSetup,
      });
    }

    for (const v of otherLanguages) {
      skipped.push({
        name: v.name,
        language: v.language,
        reason: "another language version of a template imported in a different language — the CRM keeps one language per template name",
      });
    }

    if (!dryRun) {
      logAudit({
        action: "template.imported",
        actor: req.user,
        targetType: "WhatsAppNumber",
        targetId: req.numberId,
        details: {
          wabaId,
          found: metaTemplates.length,
          imported: imported.length,
          updated,
          skipped: skipped.length,
          needsSetup: imported.filter((t) => t.needsSetup.length).length,
          truncated: fetched.truncated,
        },
      });
    }

    res.status(200).json({ success: true, dryRun, imported, updated, skipped, truncated: fetched.truncated });
  } catch (err) {
    next(err);
  }
};

// A running campaign re-reads its template for every recipient; changing what
// it sends halfway through would split one campaign into two messages.
async function assertNotSending(templateId) {
  const running = await prisma.campaign.findFirst({
    where: { templateId, status: "RUNNING", deletedAt: null },
    select: { name: true },
  });
  if (running) {
    throw new AppError(`The campaign "${running.name}" is sending this template right now. Wait for it to finish or pause it first.`, 409, "TEMPLATE_IN_USE");
  }
}

// POST /:id/map-variables — { mapping: { "1": "first_name" }, headerMapping?: { "1": "agent_name" } }
// Says what an imported template's {{1}}, {{2}} mean, in the CRM's copy only:
// Meta's approved template is unchanged and nothing is resubmitted.
const mapVariables = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const template = await prisma.template.findFirst({ where: { id, wabaId: req.number.wabaId } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));
    const { mapping, headerMapping } = req.body || {};
    if (!mapping && !headerMapping) return next(new AppError("mapping is required", 400));
    await assertNotSending(id);

    const { body, header } = applyVariableMapping(template, mapping, headerMapping);
    const updated = await prisma.template.update({ where: { id }, data: { body, header } });

    logAudit({
      action: "template.variables_mapped",
      actor: req.user,
      targetType: "Template",
      targetId: id,
      details: { name: template.name, mapping: mapping || null, headerMapping: headerMapping || null },
    });
    res.status(200).json({ success: true, data: { ...updated, needsSetup: templateNeedsSetup(updated) } });
  } catch (err) {
    next(err);
  }
};

// PUT /:id/media — { headerMediaUrl?, cards?: [{ mediaUrl }] }
// Gives an imported template a file of its own in place of Meta's expiring
// sample. A template's header media is sent with every message anyway, so
// this changes the CRM's copy only — no resubmission.
const setTemplateMedia = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const template = await prisma.template.findFirst({ where: { id, wabaId: req.number.wabaId } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));

    const usableUrl = (value, what) => {
      const url = String(value ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new AppError(`${what} must be a link starting with https://`, 400);
      if (isMetaSampleUrl(url)) {
        throw new AppError(`${what} is Meta's sample link, which expires — choose a file from the Media Library or upload one`, 400);
      }
      return url;
    };

    const data = {};
    if (req.body?.headerMediaUrl !== undefined) {
      if (!["IMAGE", "VIDEO", "DOCUMENT"].includes(template.headerType)) {
        return next(new AppError("This template has no image, video or document header", 400));
      }
      data.headerMediaUrl = usableUrl(req.body.headerMediaUrl, "The header file");
    }
    if (req.body?.cards !== undefined) {
      const cards = Array.isArray(template.cards) ? template.cards : [];
      if (!cards.length) return next(new AppError("This template has no carousel cards", 400));
      if (!Array.isArray(req.body.cards) || req.body.cards.length !== cards.length) {
        return next(new AppError(`Send one entry per card (${cards.length})`, 400));
      }
      // An empty entry keeps that card's current file.
      data.cards = cards.map((c, i) => {
        const url = req.body.cards[i]?.mediaUrl;
        return url ? { ...c, mediaUrl: usableUrl(url, `Card ${i + 1}'s file`) } : c;
      });
    }
    if (Object.keys(data).length === 0) return next(new AppError("Nothing to change — send headerMediaUrl or cards", 400));
    await assertNotSending(id);

    const updated = await prisma.template.update({ where: { id }, data });
    logAudit({
      action: "template.media_set",
      actor: req.user,
      targetType: "Template",
      targetId: id,
      details: { name: template.name, header: data.headerMediaUrl !== undefined, cards: data.cards !== undefined },
    });
    res.status(200).json({ success: true, data: { ...updated, needsSetup: templateNeedsSetup(updated) } });
  } catch (err) {
    next(err);
  }
};

const sendTemplate = async (req, res, next) => {
  let clientMessageId = null;
  try {
    clientMessageId = readClientMessageId(req.body.clientMessageId);
    const conversationId = parseInt(req.params.id);
    const { templateId } = req.body;
    if (!templateId) return next(new AppError("templateId is required", 400));

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: true,
        assignedAgent: { select: { id: true, name: true, username: true } },
      },
    });
    if (!conversation || conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }

    const template = await prisma.template.findFirst({
      where: { id: parseInt(templateId), wabaId: req.number.wabaId },
    });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));
    // An imported template whose variables or media aren't set up yet.
    // buildTemplateSend refuses it too; checked first for a clean answer.
    assertTemplateReady(template);

    // Credentials come from the conversation's number, which the check above has
    // already confirmed is the active one. A reply always goes out on the line
    // the customer originally wrote to.
    const credentials = await numbers.getCredentials(conversation.whatsappNumberId);

    // RE_ENGAGEMENT and CAMPAIGN require APPROVED status
    if (template.category !== "GENERAL" && template.approvalStatus !== "APPROVED") {
      return next(new AppError(`${template.category} templates must be APPROVED before sending`, 400));
    }

    // Consent. A marketing template to a patient who opted out (on this line
    // or everywhere) needs an explicit confirmation, and is audited. Utility
    // templates (appointment details…) aren't marketing and go through.
    const isMarketing = template.metaCategory ? template.metaCategory === "MARKETING" : template.category !== "GENERAL";
    // Agents send general and utility templates only — never marketing.
    if (isMarketing && !roleHasPermission(req.user.role, "template:send_marketing")) {
      return next(new AppError("Marketing templates can only be sent by a supervisor or an admin", 403, "MARKETING_NOT_ALLOWED"));
    }
    if (isMarketing) {
      const lineOptOut = await prisma.customerOptOut.findUnique({
        where: { customerId_whatsappNumberId: { customerId: conversation.customerId, whatsappNumberId: conversation.whatsappNumberId } },
        select: { id: true },
      });
      if (conversation.customer.optedOut || lineOptOut) {
        if (req.body.confirmOptedOut !== true) {
          return next(new AppError(
            "This patient opted out of marketing messages. Send this offer anyway only if they asked for it.",
            409,
            "OPTED_OUT",
            { scope: conversation.customer.optedOut ? "all" : "line" },
          ));
        }
        logAudit({
          action: "TEMPLATE_SENT_TO_OPTED_OUT",
          actor: req.user,
          targetType: "Customer",
          targetId: conversation.customerId,
          details: { templateId: template.id, templateName: template.name, conversationId: conversation.id },
        });
      }
    }

    // Inside the 24-hour window any template may be sent. Outside it (including a
    // contact who has never written) only a Meta-APPROVED template goes out as a
    // real template send; anything else would be sent as an ad-hoc message,
    // which Meta rejects there. This replaced a rule that blocked re-engagement
    // templates INSIDE the window — though Meta accepts templates at any time —
    // and never checked any other template outside it.
    if (!windowState(conversation.lastCustomerMessageAt).open && !buildTemplateSend(template, conversation.customer, req.user).needsMetaTemplate) {
      return next(windowClosedError(conversation.lastCustomerMessageAt));
    }

    const duplicate = await findDuplicateSend(clientMessageId, conversation.id);
    if (duplicate) return res.status(200).json({ success: true, data: duplicate, duplicate: true });
    assertMayReply(conversation, req.user, req.body.confirmOtherOwner === true);

    // This block used to duplicate utils/templateSend.js inline. Two copies meant
    // every number-aware fix had to be made twice, and a test send would stop
    // being evidence about the real send the moment they drifted.
    const { resolvedBody, templateContent, sendArgs } = buildTemplateSend(
      template,
      conversation.customer,
      req.user,
    );

    let message = await prisma.message.create({
      data: {
        conversationId,
        senderType: "AGENT",
        senderId: parseInt(req.user.id),
        ...(clientMessageId ? { clientMessageId } : {}),
        content: templateContent,
        // Was hardcoded to INTERACTIVE even when the send was a TEMPLATE or TEXT.
        messageType: sendArgs.messageType,
        status: "PENDING",
      },
    });

    try {
      const { whatsappMessageId } = await sendWhatsAppMessage({
        number: credentials,
        to: conversation.customer.phone,
        ...sendArgs,
      });
      message = await prisma.message.update({
        where: { id: message.id },
        data: { whatsappMessageId, status: "SENT" },
      });
    } catch (waErr) {
      console.error("WhatsApp template send failed:", waErr.response?.data || waErr.message);
      message = await prisma.message.update({ where: { id: message.id }, data: { status: "FAILED" } });
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessage: resolvedBody,
        lastMessageAt: new Date(),
        lastSenderType: "AGENT",
        // A person answered: the patient is no longer waiting.
        ...(message.status !== "FAILED" ? { awaitingReplySince: null, lastAgentReplyAt: new Date() } : {}),
      },
    });

    // Replying to an unassigned chat takes it, so it leaves the Unassigned queue
    // and nobody else picks it up too. Only on a successful send: a failed send
    // shouldn't quietly take ownership.
    if (message.status === "SENT") {
      await claimIfUnassigned({ conversationId: conversationId, numberId: conversation.whatsappNumberId, user: req.user });
      await handOffOnAgentReply(conversationId);
    }

    emitToNumber(conversation.whatsappNumberId, "message.created", { message, conversationId });
    emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId });

    res.status(201).json({ success: true, data: message });
  } catch (err) {
    if (isClientIdRace(err, clientMessageId)) {
      const first = await prisma.message.findUnique({ where: { clientMessageId } }).catch(() => null);
      if (first) return res.status(200).json({ success: true, data: first, duplicate: true });
    }
    next(err);
  }
};

module.exports = {
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
};
