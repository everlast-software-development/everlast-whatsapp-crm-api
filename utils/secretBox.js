// Encrypts a secret (e.g. the Cloudflare AI token saved from Settings) before
// it is stored in the database, so a database dump or backup alone doesn't
// give it away.
//
// AES-256-GCM. The key is SETTINGS_ENCRYPTION_KEY from config.env (at least 32
// characters), stretched to 32 bytes with SHA-256. Without that key nothing
// can be encrypted, and the Settings page refuses to save a secret.
//
// Stored form: "v1.<iv>.<tag>.<ciphertext>", each part base64url. GCM's tag
// means a wrong key (or a tampered value) fails loudly instead of returning
// garbage.

const crypto = require("crypto");

const MIN_KEY_CHARS = 32;
const PREFIX = "v1";

class SecretBoxError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretBoxError";
  }
}

const rawKey = (override) => (override !== undefined ? override : process.env.SETTINGS_ENCRYPTION_KEY) || "";

/** Whether a usable key is set (≥ 32 characters). */
function isAvailable(keyOverride) {
  return rawKey(keyOverride).length >= MIN_KEY_CHARS;
}

function deriveKey(keyOverride) {
  const k = rawKey(keyOverride);
  if (!k) throw new SecretBoxError("SETTINGS_ENCRYPTION_KEY is not set");
  if (k.length < MIN_KEY_CHARS) throw new SecretBoxError(`SETTINGS_ENCRYPTION_KEY must be at least ${MIN_KEY_CHARS} characters`);
  return crypto.createHash("sha256").update(k, "utf8").digest();
}

/** Encrypts a string. Throws SecretBoxError when no usable key is set. */
function encrypt(plaintext, keyOverride) {
  const key = deriveKey(keyOverride);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Decrypts what encrypt() produced. Throws SecretBoxError on a wrong key or a damaged value. */
function decrypt(boxed, keyOverride) {
  const parts = String(boxed || "").split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new SecretBoxError("Not an encrypted value");
  const key = deriveKey(keyOverride);
  try {
    const [, iv, tag, ct] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Never echo the value or the key.
    throw new SecretBoxError("The saved secret can't be decrypted — SETTINGS_ENCRYPTION_KEY has changed or the value is damaged");
  }
}

module.exports = { isAvailable, encrypt, decrypt, SecretBoxError, MIN_KEY_CHARS };
