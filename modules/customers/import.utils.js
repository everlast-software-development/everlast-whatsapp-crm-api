// Shared CSV-import helpers used by both the Contacts importer and the Lists
// importer, so the two stay in sync (phone/date/gender parsing, upload limits).
const { parse } = require("csv-parse/sync");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const AppError = require("../../utils/AppError");

// Validate & normalize a phone to WhatsApp-sendable international format (digits,
// no "+"). Mirrors checkPhone in the frontend's lib/customerImport.ts.
//   1. With its own code ("+20…", "0020…", or the bare digits "20122…") the
//      number is read as international — any country, the whole Arab world
//      included.
//   2. Otherwise it is a local number: tried as the chosen country first, then
//      the clinic's two home countries, UAE then Egypt ("0501229822",
//      "501229822", "01012345678" all resolve).
// Only mobile numbers pass — a landline can't receive WhatsApp.
// Returns { phone } on success or { error } otherwise.
const LOCAL_FALLBACK = ["AE", "EG"];

function readMobile(text, country) {
  let pn;
  try { pn = country ? parsePhoneNumberFromString(text, country) : parsePhoneNumberFromString(text); } catch { pn = null; }
  return pn && pn.isValid() ? pn : null;
}

function normalizeImportPhone(raw, country) {
  const s = (raw ?? "").toString().trim();
  if (!s) return { error: "Missing phone number" };
  const intl = s.replace(/^00/, "+"); // a leading 00 is the international prefix
  const digits = intl.replace(/\D/g, "");
  let pn = null;
  if (intl.startsWith("+")) pn = readMobile("+" + digits);
  // International digits without the "+". 10+ digits and no leading 0, so a
  // real local number (UAE mobile without its 0 is 9 digits) isn't misread.
  if (!pn && /^[1-9]\d{9,14}$/.test(digits)) pn = readMobile("+" + digits);
  if (!pn) {
    const tryOrder = [...new Set([country && country !== "auto" ? country : null, ...LOCAL_FALLBACK].filter(Boolean))];
    for (const c of tryOrder) {
      pn = readMobile(intl, c);
      if (pn && pn.getType() !== "FIXED_LINE") break;
      pn = null;
    }
  }
  if (pn) {
    if (pn.getType() === "FIXED_LINE") return { error: "Landline — can't receive WhatsApp" };
    return { phone: pn.number.replace(/^\+/, "") };
  }
  return { error: "Invalid or unmessageable phone number" };
}

// ─── Field parsers ────────────────────────────────────────────────────────────

// Normalise gender input to the Prisma enum (MALE | FEMALE), or null.
function parseGender(value) {
  if (value == null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  if (["male", "m", "man", "men", "boy", "mr", "ذكر"].includes(v)) return "MALE";
  if (["female", "f", "woman", "women", "girl", "mrs", "ms", "miss", "أنثى", "انثى"].includes(v)) return "FEMALE";
  return undefined; // signal invalid
}

// Parse a date-only value (YYYY-MM-DD or any Date-parseable string) to a Date, or null.
function parseDate(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return undefined; // signal invalid
  return d;
}

// Flexible date parser for imports. format: "auto" | "dmy" | "mdy" | "ymd".
// Returns a Date, null (empty), or undefined (unparseable). Mirrors lib/customerImport.ts.
function buildDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return dt;
}

function parseFlexibleDate(value, format = "auto") {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); // year-first
  if (m) return buildDate(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // day/month then year
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    let day, month;
    if (format === "mdy") { month = a; day = b; }
    else if (format === "dmy") { day = a; month = b; }
    else if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else { day = a; month = b; } // prefer day-first
    return buildDate(y, month, day);
  }

  const parsed = new Date(s); // month-name formats
  if (!isNaN(parsed.getTime())) return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
  return undefined;
}

// Coerce departments/tags into a trimmed string array.
function toStringArray(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

// Split a semicolon/comma-delimited CSV cell into a trimmed string array.
function splitList(val) {
  if (!val) return [];
  const delimiter = val.includes(";") ? ";" : ",";
  return val.split(delimiter).map((t) => t.trim()).filter(Boolean);
}

// Parse a CSV upload into row objects (shared by validate + import endpoints).
function parseUpload(req) {
  if (!req.file) throw new AppError("CSV file is required", 400);
  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch {
    throw new AppError("Invalid CSV format", 400);
  }
  if (rows.length === 0) throw new AppError("CSV file is empty", 400);
  if (rows.length > 20000) throw new AppError("CSV cannot exceed 20000 rows per import", 400);
  return rows;
}

module.exports = {
  normalizeImportPhone,
  parseGender,
  parseDate,
  parseFlexibleDate,
  toStringArray,
  splitList,
  parseUpload,
};
