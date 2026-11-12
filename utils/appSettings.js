// Workspace settings changed from the Settings page, stored in AppSetting.
//
// Read synchronously (quiet hours are checked inside tight send loops), so the
// rows live in an in-memory cache: loaded at startup, replaced on every save
// from this process, and re-read every minute so a save made by another
// instance is picked up too. Anything never saved uses DEFAULTS below.
//
// Each setting is validated by its own normaliser before it is stored, so the
// rest of the app can trust the shape it reads.

const prisma = require("../config/prisma");
const AppError = require("./AppError");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const SETTINGS = {
  // The daily window in which no campaign message is sent. Until someone
  // saves it here, the server config (QUIET_HOURS_* in config.env, else
  // 21:00–09:00 Asia/Dubai) applies — see utils/quietHours.js.
  quietHours: {
    defaults: null,
    normalise(v) {
      if (!v || typeof v !== "object") throw new AppError("Quiet hours must be an object", 400);
      const enabled = v.enabled !== false;
      const start = String(v.start || "").trim();
      const end = String(v.end || "").trim();
      const timezone = String(v.timezone || "Asia/Dubai").trim();
      if (!HHMM.test(start) || !HHMM.test(end)) throw new AppError("Start and end must be times like 21:00", 400);
      if (start === end) throw new AppError("Start and end can't be the same time", 400);
      if (!isTimeZone(timezone)) throw new AppError(`Unknown time zone "${timezone}"`, 400);
      return { enabled, start, end, timezone };
    },
  },

  // Limits that protect the number's reputation with Meta.
  campaignSafety: {
    defaults: { frequencyCapDays: 0, qualityAutoPause: true, qualityPauseAt: "YELLOW" },
    normalise(v) {
      if (!v || typeof v !== "object") throw new AppError("Campaign safety must be an object", 400);
      // Required, so an empty save can't quietly reset the settings.
      if (v.frequencyCapDays === undefined || v.frequencyCapDays === null || v.frequencyCapDays === "") {
        throw new AppError("frequencyCapDays is required (0 = no limit)", 400);
      }
      const days = Number(v.frequencyCapDays);
      if (!Number.isInteger(days) || days < 0 || days > 90) {
        throw new AppError("The limit must be a whole number of days between 0 (off) and 90", 400);
      }
      const at = String(v.qualityPauseAt || "YELLOW").toUpperCase();
      if (!["YELLOW", "RED"].includes(at)) throw new AppError("Pause when quality is YELLOW or RED", 400);
      return { frequencyCapDays: days, qualityAutoPause: v.qualityAutoPause !== false, qualityPauseAt: at };
    },
  },

  // Giving each new chat to one online agent automatically (utils/autoAssign.js).
  // On unless an admin turns it off; off = the first person to reply takes it.
  autoAssign: {
    defaults: { enabled: true },
    normalise(v) {
      if (!v || typeof v !== "object" || typeof v.enabled !== "boolean") {
        throw new AppError("Send { enabled: true } or { enabled: false }", 400);
      }
      return { enabled: v.enabled };
    },
  },

  // The online store's connection (Templates → Website; utils/storeEvents.js).
  // secret: the key the store signs every message with — made and replaced
  // only by POST /api/store/settings/rotate, never typed in. numberId: the line
  // website messages go out on (null = the default line). linkBase: how every
  // store link starts — link buttons are built on it. apiBase + apiKey: the
  // store's API and the access key it gave us (Bearer ak_…, Level 4), for the
  // delivery reports sent back.
  storeWebhook: {
    defaults: { enabled: false, secret: null, numberId: null, linkBase: "https://everlastwellness.com/", apiBase: null, apiKey: null },
    normalise(v, prev = {}) {
      if (!v || typeof v !== "object") throw new AppError("Store settings must be an object", 400);
      const out = { enabled: false, secret: null, numberId: null, linkBase: "https://everlastwellness.com/", apiBase: null, apiKey: null, ...prev };
      if (v.apiBase !== undefined) {
        const base = String(v.apiBase || "").trim().replace(/\/+$/, "");
        if (base && !/^https:\/\/[^\s/]+\.[^\s/]+/i.test(base)) throw new AppError("The store's API address must start with https://", 400);
        out.apiBase = base || null;
      }
      if (v.apiKey !== undefined) {
        const key = String(v.apiKey || "").trim();
        if (key && (key.length < 10 || key.length > 300 || /\s/.test(key))) throw new AppError("That doesn't look like an access key (ak_…)", 400);
        out.apiKey = key || null;
      }
      if (v.enabled !== undefined) out.enabled = v.enabled === true;
      if (v.secret !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(String(v.secret))) throw new AppError("Bad secret", 400);
        out.secret = v.secret;
      }
      if (v.numberId !== undefined) {
        const id = v.numberId === null || v.numberId === "" ? null : Number(v.numberId);
        if (id !== null && !Number.isInteger(id)) throw new AppError("Choose a WhatsApp line", 400);
        out.numberId = id;
      }
      if (v.linkBase !== undefined) {
        let base = String(v.linkBase || "").trim();
        if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(base)) throw new AppError("The store address must start with https://, e.g. https://everlastwellness.com/", 400);
        if (!base.endsWith("/")) base += "/";
        out.linkBase = base;
      }
      // Set once the starter website drafts were made (modules/store → seedStarterDraftsOnce).
      if (v.starterSeeded !== undefined) out.starterSeeded = v.starterSeeded === true;
      if (out.enabled && !out.secret) throw new AppError("Make a secret key first", 400);
      return out;
    },
  },

  // The store's AI answering chats nobody owns (utils/aiAssistant.js).
  // mode "test": only staff test phones (Settings → Campaign safety) get AI
  // answers — for trying it safely; "all": every customer. numberIds: the lines
  // it answers on ([] = every line). Uses the store API address + key from
  // Templates → Website (storeWebhook).
  // The rules, editable by admins: quietHours — how long the AI stays out of a
  // chat after handing it to the team (0 = none); gatherSeconds — the wait
  // after each message before answering; maxGatherSeconds — the longest wait
  // in all for someone who keeps writing.
  aiAssistant: {
    defaults: { enabled: false, mode: "test", numberIds: [], quietHours: 24, gatherSeconds: 3, maxGatherSeconds: 10 },
    normalise(v, prev = {}) {
      if (!v || typeof v !== "object") throw new AppError("AI settings must be an object", 400);
      const out = { enabled: false, mode: "test", numberIds: [], quietHours: 24, gatherSeconds: 3, maxGatherSeconds: 10, ...prev };
      const num = (key, min, max, label) => {
        if (v[key] === undefined) return;
        const n = Number(v[key]);
        if (!Number.isFinite(n) || n < min || n > max) throw new AppError(`${label} must be between ${min} and ${max}`, 400);
        out[key] = Math.round(n * 10) / 10;
      };
      num("quietHours", 0, 168, "The quiet time after a hand-over (hours)");
      num("gatherSeconds", 1, 10, "The wait after each message (seconds)");
      num("maxGatherSeconds", 1, 30, "The longest wait (seconds)");
      if (out.maxGatherSeconds < out.gatherSeconds) throw new AppError("The longest wait can't be shorter than the wait after each message", 400);
      if (v.enabled !== undefined) out.enabled = v.enabled === true;
      if (v.mode !== undefined) {
        if (!["test", "all"].includes(v.mode)) throw new AppError('mode must be "test" or "all"', 400);
        out.mode = v.mode;
      }
      if (v.numberIds !== undefined) {
        if (!Array.isArray(v.numberIds) || v.numberIds.some((n) => !Number.isInteger(Number(n)))) throw new AppError("numberIds must be a list of line ids", 400);
        out.numberIds = [...new Set(v.numberIds.map(Number))];
      }
      return out;
    },
  },

  // Staff phones a campaign test send may go to (Settings → Campaign safety).
  // A test send goes nowhere else, so "test" can't be used to message a
  // patient outside a reviewed campaign. Stored as E.164 digits, no "+".
  testPhones: {
    defaults: { phones: [] },
    normalise(v) {
      if (!v || typeof v !== "object" || !Array.isArray(v.phones)) {
        throw new AppError("Test numbers must be a list (phones: [...])", 400);
      }
      if (v.phones.length > 20) throw new AppError("At most 20 test numbers", 400);
      const phones = [];
      for (const raw of v.phones) {
        const parsed = parsePhoneNumberFromString(String(raw || "").trim(), "AE");
        if (!parsed || !parsed.isValid()) {
          throw new AppError(`"${String(raw).slice(0, 30)}" isn't a valid phone number. Include the country code, e.g. +971 50 123 4567.`, 400);
        }
        const digits = parsed.number.replace("+", "");
        if (!phones.includes(digits)) phones.push(digits);
      }
      return { phones };
    },
  },
};

const cache = new Map();
let loadedAt = 0;
const REFRESH_MS = 60 * 1000;

async function loadSettings() {
  const rows = await prisma.appSetting.findMany();
  cache.clear();
  for (const r of rows) if (SETTINGS[r.key]) cache.set(r.key, r.value);
  loadedAt = Date.now();
}

// Kept fresh without blocking readers: a stale read is at most a minute old.
function refreshIfStale() {
  if (Date.now() - loadedAt < REFRESH_MS) return;
  loadedAt = Date.now();
  loadSettings().catch((err) => console.error("[Settings] refresh failed:", err.message));
}

// For the checks: values set in memory only, never saved, and the saved rows
// ignored (APP_SETTINGS_IGNORE_SAVED=1) so an admin's real settings can't
// change a check's outcome.
const testOverrides = new Map();
function overrideSettingForTest(key, value) {
  if (value === undefined) testOverrides.delete(key);
  else testOverrides.set(key, SETTINGS[key].normalise(value, testOverrides.get(key)));
}

function getSetting(key) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting ${key}`);
  const defaults0 = SETTINGS[key].defaults;
  if (testOverrides.has(key)) return defaults0 ? { ...defaults0, ...testOverrides.get(key) } : testOverrides.get(key);
  if (process.env.APP_SETTINGS_IGNORE_SAVED === "1") return defaults0 && { ...defaults0 };
  refreshIfStale();
  const saved = cache.get(key);
  const defaults = SETTINGS[key].defaults;
  if (saved === undefined) return defaults && { ...defaults };
  return defaults ? { ...defaults, ...saved } : saved;
}

async function saveSetting(key, value, user) {
  if (!SETTINGS[key]) throw new AppError(`Unknown setting "${key}"`, 400);
  const clean = SETTINGS[key].normalise(value, cache.get(key));
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: clean, updatedById: user?.id ?? null },
    create: { key, value: clean, updatedById: user?.id ?? null },
  });
  cache.set(key, clean);
  return clean;
}

module.exports = { loadSettings, getSetting, saveSetting, overrideSettingForTest, SETTING_KEYS: Object.keys(SETTINGS) };
