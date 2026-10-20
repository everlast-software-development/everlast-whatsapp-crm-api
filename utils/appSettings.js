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
const aiProviderSetting = require("./aiProviderSetting");

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

  // The AI assistant that answers patients from the knowledge base
  // (utils/aiAssistant.js). Off until an admin turns it on for chosen lines.
  // The *Ar texts are sent instead when the patient writes in Arabic; empty =
  // the English text is used for everyone.
  aiAssistant: {
    defaults: {
      enabled: false,
      numberIds: [],
      assistantName: "Everlast Assistant",
      handoffMessage: "Thank you! I'm connecting you with our team now — someone will reply shortly.",
      urgentMessage:
        "I'm sorry to hear that. I'm alerting our medical team right now so they can help you as soon as possible. If it's an emergency, please call 999 or go to the nearest emergency department.",
      handoffMessageAr: "شكراً لك! سأحوّلك الآن إلى فريقنا، وسيرد عليك أحد الزملاء قريباً.",
      urgentMessageAr:
        "نأسف لسماع ذلك. سأنبّه فريقنا الطبي الآن ليساعدك في أقرب وقت ممكن. إذا كانت حالة طارئة، يرجى الاتصال على 999 أو التوجه إلى أقرب قسم طوارئ.",
      outOfHoursNote: "",
      quietAfterAgentReplyHours: 24,
    },
    normalise(v) {
      if (!v || typeof v !== "object") throw new AppError("AI assistant settings must be an object", 400);
      const text = (field, label, { required = false, max = 1000 } = {}) => {
        const s = String(v[field] ?? "").trim();
        if (required && !s) throw new AppError(`${label} can't be empty`, 400);
        if (s.length > max) throw new AppError(`${label} must be at most ${max} characters`, 400);
        return s;
      };
      if (!Array.isArray(v.numberIds)) throw new AppError("numberIds must be a list of line ids", 400);
      const numberIds = [...new Set(v.numberIds.map(Number))];
      if (numberIds.some((id) => !Number.isInteger(id) || id <= 0) || numberIds.length > 50) {
        throw new AppError("numberIds must be WhatsApp line ids", 400);
      }
      const hours = Number(v.quietAfterAgentReplyHours ?? 24);
      if (!Number.isInteger(hours) || hours < 0 || hours > 168) {
        throw new AppError("Quiet after a team reply must be a whole number of hours between 0 and 168", 400);
      }
      return {
        enabled: v.enabled === true,
        numberIds,
        assistantName: text("assistantName", "The assistant's name", { required: true, max: 60 }),
        handoffMessage: text("handoffMessage", "The hand-over message", { required: true }),
        urgentMessage: text("urgentMessage", "The urgent message", { required: true }),
        handoffMessageAr: text("handoffMessageAr", "The Arabic hand-over message"),
        urgentMessageAr: text("urgentMessageAr", "The Arabic urgent message"),
        outOfHoursNote: text("outOfHoursNote", "The out-of-hours note"),
        quietAfterAgentReplyHours: hours,
      };
    },
  },

  // Which Cloudflare account and models the AI assistant uses, and the numbers
  // that shape its answers (Settings → AI assistant → AI model & Cloudflare).
  // The token is stored encrypted and never sent to the client — see
  // utils/aiProviderSetting.js. Normalised against what is stored, so a save
  // without a token keeps the saved one.
  aiProvider: {
    defaults: aiProviderSetting.DEFAULTS,
    normalise: aiProviderSetting.normalise,
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

/**
 * The stored value only — no defaults merged in; undefined when never saved.
 * (The AI provider's precedence needs to know what was actually set.)
 */
function getSavedSetting(key) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting ${key}`);
  if (testOverrides.has(key)) return testOverrides.get(key);
  if (process.env.APP_SETTINGS_IGNORE_SAVED === "1") return undefined;
  refreshIfStale();
  return cache.get(key);
}

async function saveSetting(key, value, user) {
  if (!SETTINGS[key]) throw new AppError(`Unknown setting "${key}"`, 400);
  // Normalised against the stored value, for settings that keep fields the
  // request leaves out (the AI provider's token).
  const clean = SETTINGS[key].normalise(value, cache.get(key));
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: clean, updatedById: user?.id ?? null },
    create: { key, value: clean, updatedById: user?.id ?? null },
  });
  cache.set(key, clean);
  return clean;
}

module.exports = { loadSettings, getSetting, getSavedSetting, saveSetting, overrideSettingForTest, SETTING_KEYS: Object.keys(SETTINGS) };
