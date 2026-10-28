const storage = require("../../utils/storage");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const dns = require("dns").promises;
const net = require("net");
const axios = require("axios");
const { getMessageType, ALLOWED_MIMETYPES, MAX_FILE_SIZE } = require("../../utils/mediaHelpers");

const VALID_TYPES = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"];

// How many active templates currently point their header at each of these
// URLs — lets the library warn "used on N templates" before someone deletes
// a file that's still referenced.
async function usageCountsByUrl(urls) {
  if (urls.length === 0) return new Map();
  const usage = await prisma.template.groupBy({
    by: ["headerMediaUrl"],
    where: { headerMediaUrl: { in: urls }, isActive: true },
    _count: { _all: true },
  });
  return new Map(usage.map((u) => [u.headerMediaUrl, u._count._all]));
}

const getAllMedia = async (req, res, next) => {
  try {
    const where = {};
    if (req.query.type) {
      if (!VALID_TYPES.includes(req.query.type)) {
        return next(new AppError(`Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`, 400));
      }
      where.mediaType = req.query.type;
    }
    const media = await prisma.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" } });
    const usageByUrl = await usageCountsByUrl(media.map((m) => m.url));

    res.status(200).json({
      success: true,
      data: media.map((m) => ({ ...m, usageCount: usageByUrl.get(m.url) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
};

// Uploads to R2 (same folder structure as the ad-hoc chat uploader) and
// persists a MediaAsset row so it can be reused later — e.g. picked as a
// template header — instead of re-uploading the same file every time.
const uploadMedia = async (req, res, next) => {
  if (!req.file) return next(new AppError("No file provided", 400));
  try {
    const filename = req.body?.name?.trim() || req.file.originalname || null;
    const asset = await saveToLibrary({ buffer: req.file.buffer, mimetype: req.file.mimetype, filename, user: req.user });
    res.status(201).json({ success: true, data: asset });
  } catch (err) {
    next(err);
  }
};

// Stores an uploaded or imported file and records it in the library.
async function saveToLibrary({ buffer, mimetype, filename, user }) {
  let result;
  try {
    result = await storage.uploadBuffer({ buffer, mimetype, folder: "everlast-crm/library" });
  } catch (error) {
    console.error("Storage upload error:", error.message);
    throw storage.uploadFailedError(error);
  }
  const asset = await prisma.mediaAsset.create({
    data: {
      url: result.url,
      publicId: result.key,
      mediaType: getMessageType(mimetype),
      format: result.format,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      filename,
      createdById: user.id,
    },
  });
  logAudit({
    action: "media.uploaded", actor: user, targetType: "MediaAsset", targetId: asset.id,
    details: { filename: asset.filename, mediaType: asset.mediaType, bytes: asset.bytes },
  });
  return { ...asset, usageCount: 0 };
}

// A link to somewhere this server must never fetch for a user: itself, the
// private network, or the cloud metadata address.
const isPrivateAddress = (ip) =>
  net.isIPv4(ip)
    ? /^(0|10|127)\./.test(ip) || /^169\.254\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
    : ip === "::1" || ip === "::" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || /^::ffff:/i.test(ip) && isPrivateAddress(ip.replace(/^::ffff:/i, ""));

async function assertPublicHost(hostname) {
  const addresses = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length) throw new AppError(`Couldn't find "${hostname}" — check the link`, 400);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new AppError("That link points to a private address", 400);
}

// POST /api/media-library/import { url, name? } — copies a file from any public
// link (another website, a shared Drive/Dropbox link, an image address) into
// the library, so what WhatsApp fetches is our own copy and can't vanish or
// change when the other site does.
const importMedia = async (req, res, next) => {
  try {
    const raw = String(req.body?.url || "").trim();
    let link;
    try {
      link = new URL(raw);
    } catch {
      return next(new AppError("Paste a full link starting with https://", 400));
    }
    if (!["http:", "https:"].includes(link.protocol)) return next(new AppError("Paste a full link starting with https://", 400));

    // Redirects are followed by hand so every hop gets the same check.
    let response;
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicHost(link.hostname);
      try {
        response = await axios.get(link.href, {
          responseType: "arraybuffer",
          maxRedirects: 0,
          timeout: 20_000,
          maxContentLength: MAX_FILE_SIZE,
          maxBodyLength: MAX_FILE_SIZE,
          validateStatus: (s) => s < 400,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; EverlastCRM/1.0)", Accept: "image/*,video/*,application/pdf,*/*;q=0.5" },
        });
      } catch (err) {
        if (err.code === "ERR_BAD_RESPONSE" || /maxContentLength/i.test(err.message)) {
          return next(new AppError("That file is bigger than 16 MB", 400));
        }
        const status = err.response?.status;
        return next(new AppError(status ? `The other site answered ${status} — is the link public?` : "Couldn't download that link — is it public?", 400));
      }
      if (response.status >= 300 && response.headers.location) {
        link = new URL(response.headers.location, link);
        response = null;
        continue;
      }
      break;
    }
    if (!response) return next(new AppError("That link redirects too many times", 400));

    const mimetype = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_MIMETYPES.includes(mimetype)) {
      return next(new AppError(
        mimetype.startsWith("text/html")
          ? "That link opens a web page, not a file — right-click the image and choose “Copy image address”"
          : `That link is a ${mimetype || "file of unknown type"} — WhatsApp takes JPEG, PNG, MP4, PDF and the like`,
        400,
      ));
    }
    const fromPath = decodeURIComponent(link.pathname.split("/").pop() || "").slice(0, 120);
    const filename = String(req.body?.name || "").trim() || fromPath || link.hostname;
    const asset = await saveToLibrary({ buffer: Buffer.from(response.data), mimetype, filename, user: req.user });
    res.status(201).json({ success: true, data: asset });
  } catch (err) {
    next(err);
  }
};

// Rename the library's display label — purely cosmetic, doesn't touch the
// underlying R2 object or its key.
const updateMedia = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { filename } = req.body;
    if (filename !== undefined && !String(filename).trim()) {
      return next(new AppError("Filename can't be empty", 400));
    }
    const asset = await prisma.mediaAsset.update({
      where: { id },
      data: { filename: filename !== undefined ? String(filename).trim() : undefined },
    });
    logAudit({ action: "media.renamed", actor: req.user, targetType: "MediaAsset", targetId: id, details: { filename: asset.filename } });
    const usageByUrl = await usageCountsByUrl([asset.url]);
    res.status(200).json({ success: true, data: { ...asset, usageCount: usageByUrl.get(asset.url) ?? 0 } });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Media not found", 404));
    next(err);
  }
};

const deleteMedia = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const asset = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) return next(new AppError("Media not found", 404));

    try {
      // publicId holds the active provider's object key / public_id. If a row
      // was created under the other provider, this delete is a harmless miss
      // (wrong key for the current backend) — tolerated by the catch below.
      await storage.deleteObject({ key: asset.publicId, mediaType: asset.mediaType });
    } catch (err) {
      // Don't block removing the library entry on a storage-side hiccup — an
      // orphaned remote file is a smaller problem than a stuck UI record.
      console.error("Storage delete error:", err.message);
    }

    await prisma.mediaAsset.delete({ where: { id } });
    logAudit({
      action: "media.deleted", actor: req.user, targetType: "MediaAsset", targetId: id,
      details: { filename: asset.filename, mediaType: asset.mediaType },
    });
    res.status(200).json({ success: true, message: "Media deleted" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Media not found", 404));
    next(err);
  }
};

module.exports = { getAllMedia, uploadMedia, importMedia, updateMedia, deleteMedia };
