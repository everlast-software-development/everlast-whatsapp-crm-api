const r2 = require("./r2");
const cloudinaryStorage = require("./cloudinaryStorage");

// Single entry point for file storage so the rest of the app doesn't care which
// backend is active. Controlled by STORAGE_PROVIDER (default "cloudinary"):
//
//   STORAGE_PROVIDER=cloudinary  -> Cloudinary (the current/backup provider)
//   STORAGE_PROVIDER=r2          -> Cloudflare R2
//
// This lets us keep Cloudinary working while R2 is set up and verified, then
// flip a single env var to cut over — and flip back instantly if anything's
// wrong. Both providers return the same shape from uploadBuffer:
//   { url, key, format, bytes, width, height }
// where `key` is what callers persist as `publicId` and pass back to delete.

const provider = () =>
  (process.env.STORAGE_PROVIDER || "cloudinary").toLowerCase() === "r2"
    ? "r2"
    : "cloudinary";

function activeProvider() {
  return provider();
}

async function uploadBuffer(opts) {
  return provider() === "r2"
    ? r2.uploadBuffer(opts)
    : cloudinaryStorage.uploadBuffer(opts);
}

// mediaType (IMAGE/VIDEO/AUDIO/DOCUMENT) is only needed by Cloudinary, which
// requires the resource_type to delete; R2 deletes purely by key.
async function deleteObject({ key, mediaType }) {
  return provider() === "r2"
    ? r2.deleteObject(key)
    : cloudinaryStorage.deleteObject({ key, mediaType });
}

// The answer an upload route gives when storage throws. Never 502: behind
// Cloudflare a 502 is swapped for its own "Bad gateway" page, so the reason
// never reaches the screen. Missing settings say so plainly.
function uploadFailedError(error) {
  const AppError = require("./AppError");
  if (/not configured/i.test(error?.message || "")) {
    return new AppError(`File storage isn't set up on the server (${provider()} settings missing)`, 503, "STORAGE_NOT_CONFIGURED");
  }
  return new AppError("File upload failed", 500, "UPLOAD_FAILED");
}

module.exports = { uploadBuffer, deleteObject, activeProvider, uploadFailedError };
