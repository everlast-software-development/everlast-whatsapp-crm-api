// The `aiProvider` app setting (Settings → AI assistant → AI model &
// Cloudflare): which Cloudflare account and models the AI assistant uses, and
// the numbers that shape its answers. Pure — no database, no network — so the
// checks can exercise it directly.
//
// Precedence for the account ID, the token and the two models:
//   saved in Settings  →  config.env  →  built-in default.
// The behaviour numbers come from Settings once saved, else their defaults
// (the debounce also honours AI_DEBOUNCE_MS until a save, for the checks).
//
// The API token is stored ENCRYPTED (utils/secretBox.js) as `apiTokenEnc`, and
// never leaves the server: publicView() is the only shape the client sees.

const AppError = require("./AppError");
const secretBox = require("./secretBox");

const DEFAULT_CHAT_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_EMBED_MODEL = "@cf/baai/bge-m3";

// The numbers. `min`/`max` are what the Settings page allows.
const BEHAVIOUR = {
  temperature: { default: 0.3, min: 0, max: 2, label: "Temperature" },
  // GLM-4.7-Flash may reason before it answers and the reasoning counts here
  // too, so the default leaves room for it (600 cut answers off).
  maxOutputTokens: { default: 1500, min: 64, max: 4096, integer: true, label: "Max reply tokens" },
  topP: { default: null, min: 0, max: 1, optional: true, label: "Top P" },
  debounceSeconds: { default: 4, min: 1, max: 30, integer: true, label: "Wait before replying" },
  historyMessages: { default: 12, min: 4, max: 30, integer: true, label: "History messages" },
  retrievalTopK: { default: 6, min: 2, max: 12, integer: true, label: "Results per question" },
  similarityThreshold: { default: 0.45, min: 0.2, max: 0.9, label: "Similarity threshold" },
  maxToolRounds: { default: 3, min: 1, max: 5, integer: true, label: "Tool rounds" },
  maxExtraSearches: { default: 2, min: 0, max: 3, integer: true, label: "Extra searches" },
  maxReplyChars: { default: 1500, min: 300, max: 2000, integer: true, label: "Max reply length" },
  requestTimeoutSeconds: { default: 45, min: 10, max: 120, integer: true, label: "Request timeout" },
};
const BEHAVIOUR_KEYS = Object.keys(BEHAVIOUR);
const BEHAVIOUR_DEFAULTS = Object.fromEntries(BEHAVIOUR_KEYS.map((k) => [k, BEHAVIOUR[k].default]));

// What is stored. Empty strings = "not set here" (config.env / default apply).
const DEFAULTS = {
  accountId: "",
  apiTokenEnc: null,
  apiTokenLast4: null,
  chatModel: "",
  embedModel: "",
  ...BEHAVIOUR_DEFAULTS,
};

const MODEL_RE = /^@(cf|hf)\/[A-Za-z0-9._\-/:]+$/;
const TOKEN_RE = /^[A-Za-z0-9_\-.]{20,200}$/;
const ACCOUNT_RE = /^[A-Za-z0-9]{16,64}$/;

const NO_KEY_MESSAGE = "Set SETTINGS_ENCRYPTION_KEY in the server settings first, or put CLOUDFLARE_AI_TOKEN in config.env";

// ── Validators (also used for the unsaved values "Test connection" sends) ──

function validateAccountId(raw) {
  const s = String(raw ?? "").trim();
  if (s && !ACCOUNT_RE.test(s)) {
    throw new AppError("The Cloudflare account ID is the 32-character ID from the Cloudflare dashboard (letters and digits only)", 400);
  }
  return s;
}

function validateModelId(raw, label) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.length > 120) throw new AppError(`${label} is too long`, 400);
  if (!/^@(cf|hf)\//.test(s)) {
    throw new AppError(`${label} must be a Workers AI model ID starting with "@cf/" or "@hf/" (e.g. ${DEFAULT_CHAT_MODEL})`, 400);
  }
  if (!MODEL_RE.test(s)) throw new AppError(`${label} may only contain letters, digits and . _ - / :`, 400);
  return s;
}

function validateToken(raw) {
  const s = String(raw ?? "").trim();
  if (s && !TOKEN_RE.test(s)) {
    throw new AppError("That doesn't look like a Cloudflare API token (20+ characters: letters, digits, - and _)", 400);
  }
  return s;
}

function readNumber(key, v, prev) {
  const spec = BEHAVIOUR[key];
  const raw = v[key] !== undefined ? v[key] : prev && prev[key] !== undefined ? prev[key] : spec.default;
  if (spec.optional && (raw === null || raw === "")) return null;
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  const range = `between ${spec.min} and ${spec.max}`;
  if (raw === null || raw === "" || typeof raw === "boolean" || !Number.isFinite(n)) {
    throw new AppError(`${spec.label} must be a number ${range}`, 400);
  }
  if (spec.integer && !Number.isInteger(n)) throw new AppError(`${spec.label} must be a whole number ${range}`, 400);
  if (n < spec.min || n > spec.max) throw new AppError(`${spec.label} must be ${range}`, 400);
  return spec.integer ? n : Math.round(n * 100) / 100;
}

/**
 * Validates a save. `prev` is what is stored now: fields left out of `v`
 * keep their stored value, and so does the token unless `apiToken` (replace)
 * or `removeToken: true` is sent. An encrypted token is never taken from the
 * request.
 */
function normalise(v, prev) {
  if (!v || typeof v !== "object") throw new AppError("AI model settings must be an object", 400);
  const keep = (field) => (v[field] !== undefined ? v[field] : prev?.[field] ?? DEFAULTS[field]);

  const out = {
    accountId: validateAccountId(keep("accountId")),
    apiTokenEnc: prev?.apiTokenEnc ?? null,
    apiTokenLast4: prev?.apiTokenLast4 ?? null,
    chatModel: validateModelId(keep("chatModel"), "The chat model"),
    embedModel: validateModelId(keep("embedModel"), "The embedding model"),
  };
  for (const key of BEHAVIOUR_KEYS) out[key] = readNumber(key, v, prev);

  const token = validateToken(v.apiToken);
  if (token) {
    if (!secretBox.isAvailable()) {
      const short = process.env.SETTINGS_ENCRYPTION_KEY && !secretBox.isAvailable();
      throw new AppError(
        short ? `SETTINGS_ENCRYPTION_KEY must be at least ${secretBox.MIN_KEY_CHARS} characters. ${NO_KEY_MESSAGE}.` : NO_KEY_MESSAGE,
        400,
        "ENCRYPTION_KEY_MISSING",
      );
    }
    out.apiTokenEnc = secretBox.encrypt(token);
    out.apiTokenLast4 = token.slice(-4);
  } else if (v.removeToken === true) {
    out.apiTokenEnc = null;
    out.apiTokenLast4 = null;
  }
  return out;
}

// ── Precedence ──────────────────────────────────────────────────────────────

const envNumber = (raw) => (raw === undefined || raw === null || String(raw).trim() === "" ? null : Number(raw));

/**
 * What is in force. `saved` is the stored row (undefined when never saved),
 * `env` usually process.env, `decrypt` secretBox.decrypt (may throw).
 */
function resolveFrom(saved, env = {}, decrypt = secretBox.decrypt) {
  const s = saved && typeof saved === "object" ? saved : {};
  const b = { ...BEHAVIOUR_DEFAULTS, ...pickBehaviour(s) };

  let token = null;
  let tokenSource = null;
  let tokenLast4 = null;
  let tokenError = null;
  if (s.apiTokenEnc) {
    try {
      token = decrypt(s.apiTokenEnc);
      tokenSource = "settings";
      tokenLast4 = s.apiTokenLast4 || token.slice(-4);
    } catch (err) {
      tokenError = err?.message || "The saved token can't be decrypted";
    }
  }
  if (!token && env.CLOUDFLARE_AI_TOKEN) {
    token = String(env.CLOUDFLARE_AI_TOKEN).trim();
    tokenSource = "env";
    tokenLast4 = token.slice(-4);
  }

  const pick = (savedValue, envValue, fallback) =>
    savedValue ? [savedValue, "settings"] : envValue ? [String(envValue).trim(), "env"] : [fallback, fallback ? "default" : null];
  const [accountId, accountIdSource] = pick(s.accountId, env.CLOUDFLARE_ACCOUNT_ID, "");
  const [chatModel, chatModelSource] = pick(s.chatModel, env.AI_CHAT_MODEL, DEFAULT_CHAT_MODEL);
  const [embedModel, embedModelSource] = pick(s.embedModel, env.AI_EMBED_MODEL, DEFAULT_EMBED_MODEL);

  const envDebounce = envNumber(env.AI_DEBOUNCE_MS);
  const debounceMs =
    s.debounceSeconds != null ? s.debounceSeconds * 1000 : Number.isFinite(envDebounce) && envDebounce >= 0 ? envDebounce : b.debounceSeconds * 1000;

  return {
    configured: Boolean(accountId && token),
    accountId: accountId || "",
    accountIdSource: accountId ? accountIdSource : null,
    token,
    tokenSource,
    tokenLast4,
    tokenError,
    chatModel,
    chatModelSource,
    embedModel,
    embedModelSource,
    temperature: b.temperature,
    maxOutputTokens: b.maxOutputTokens,
    topP: b.topP,
    debounceMs,
    historyMessages: b.historyMessages,
    retrievalTopK: b.retrievalTopK,
    similarityThreshold: b.similarityThreshold,
    maxToolRounds: b.maxToolRounds,
    maxExtraSearches: b.maxExtraSearches,
    maxReplyChars: b.maxReplyChars,
    requestTimeoutMs: b.requestTimeoutSeconds * 1000,
  };
}

function pickBehaviour(s) {
  const out = {};
  for (const k of BEHAVIOUR_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

/**
 * The only shape the client ever gets: the stored fields WITHOUT the token,
 * plus what is in force and where it comes from.
 */
function publicView(saved, resolved) {
  const s = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  return {
    accountId: s.accountId || "",
    chatModel: s.chatModel || "",
    embedModel: s.embedModel || "",
    ...pickBehaviour(s),
    hasToken: Boolean(resolved.token),
    tokenLast4: resolved.tokenLast4 || null,
    tokenSource: resolved.tokenSource,
    savedToken: Boolean(s.apiTokenEnc),
    tokenError: resolved.tokenError,
    encryptionAvailable: secretBox.isAvailable(),
    configured: resolved.configured,
    effective: { accountId: resolved.accountId, chatModel: resolved.chatModel, embedModel: resolved.embedModel },
    sources: { accountId: resolved.accountIdSource, chatModel: resolved.chatModelSource, embedModel: resolved.embedModelSource },
    defaults: { chatModel: DEFAULT_CHAT_MODEL, embedModel: DEFAULT_EMBED_MODEL, ...BEHAVIOUR_DEFAULTS },
    limits: Object.fromEntries(BEHAVIOUR_KEYS.map((k) => [k, { min: BEHAVIOUR[k].min, max: BEHAVIOUR[k].max }])),
  };
}

module.exports = {
  DEFAULTS,
  BEHAVIOUR,
  BEHAVIOUR_KEYS,
  BEHAVIOUR_DEFAULTS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
  NO_KEY_MESSAGE,
  normalise,
  resolveFrom,
  publicView,
  validateAccountId,
  validateModelId,
  validateToken,
};
