// Single source of truth for template variable handling.
//
// The app authors templates with NAMED placeholders like {{customer_name}}.
// Meta's Cloud API only understands POSITIONAL placeholders ({{1}}, {{2}}) and
// the parameters sent at send-time must line up with those positions IN ORDER
// OF FIRST APPEARANCE in the body. Submit-time conversion and send-time
// parameter building must therefore use the exact same ordering — which is why
// both live here.

// Meta rejects a template parameter that contains a newline or tab, or more
// than four spaces in a row (error 132018 / 100) — and that rejection used to
// look like an account-wide problem and pause the whole campaign over one
// patient's badly typed name. Every value is cleaned to a single line, and an
// empty result falls back to the default.
const cleanParam = (value, fallback) => {
  const v = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return v || fallback;
};

// Blanks the agent fills in when sending from a chat ("your appointment is on
// {{date}} at {{time}}"). A template using any of them can only be sent from a
// chat: campaigns and flows have nobody to fill them (see fillInsOf /
// buildTemplateSend). The value is what the agent typed, cleaned to one line.
const FILL_INS = {
  date: { label: "Date", sample: "Monday 10 November" },
  time: { label: "Time", sample: "4:30 PM" },
  doctor: { label: "Doctor", sample: "Dr. Sara" },
  branch: { label: "Branch", sample: "Jumeirah" },
  details: { label: "Details", sample: "please arrive 10 minutes early" },
};
const FILL_IN_KEYS = Object.keys(FILL_INS);
// Example values Meta needs when a template is submitted for approval.
const FILL_IN_SAMPLES = Object.fromEntries(FILL_IN_KEYS.map((k) => [k, FILL_INS[k].sample]));

const RESOLVERS = {
  first_name: (customer) => cleanParam(cleanParam(customer?.name, "").split(" ")[0], "Customer"),
  customer_name: (customer) => cleanParam(customer?.name, "Customer"),
  agent_name: (_customer, agent) => cleanParam(agent?.name || agent?.username, "Team"),
  ...Object.fromEntries(FILL_IN_KEYS.map((k) => [k, (_c, _a, fields) => cleanParam(fields?.[k], "—")])),
};

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

// Unique, supported variable names in order of first appearance in the text.
const extractOrderedVars = (text) => {
  if (!text) return [];
  const seen = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (RESOLVERS[name] && !seen.includes(name)) seen.push(name);
  }
  return seen;
};

// Convert named placeholders to Meta positional ones ({{1}}, {{2}}, …) using
// order of first appearance. All occurrences of the same variable share an index.
const toMetaPositionalBody = (text) => {
  if (!text) return text;
  const order = extractOrderedVars(text);
  let out = text;
  order.forEach((name, i) => {
    const re = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "gi");
    out = out.replace(re, `{{${i + 1}}}`);
  });
  return out;
};

// Positional parameter VALUES for a Meta template send — same order as
// toMetaPositionalBody, so {{1}} always receives the right value.
const buildTemplateParams = (text, customer, agent, fields) =>
  extractOrderedVars(text).map((name) => RESOLVERS[name](customer, agent, fields));

// Replace named placeholders with resolved values (for the stored/preview copy
// and for GENERAL text/interactive sends that don't use Meta's template format).
const resolveNamedVars = (text, customer, agent, fields) => {
  if (!text) return text;
  return text.replace(VAR_RE, (full, rawName) => {
    const name = rawName.toLowerCase();
    return RESOLVERS[name] ? RESOLVERS[name](customer, agent, fields) : full;
  });
};

// The fill-in blanks a template uses (body and text header), in order.
const fillInsOf = (template) =>
  [...new Set([...extractOrderedVars(template?.headerType === "TEXT" ? template.header : ""), ...extractOrderedVars(template?.body)])]
    .filter((k) => FILL_IN_KEYS.includes(k));

// Every {{...}} in the text, supported or not — for validation.
const ANY_PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const listPlaceholders = (text) => [...String(text || "").matchAll(ANY_PLACEHOLDER_RE)].map((m) => m[1]);
const SUPPORTED_VARS = Object.keys(RESOLVERS);

module.exports = {
  FILL_INS,
  FILL_IN_KEYS,
  FILL_IN_SAMPLES,
  fillInsOf,
  cleanParam,
  SUPPORTED_VARS,
  listPlaceholders,
  extractOrderedVars,
  toMetaPositionalBody,
  buildTemplateParams,
  resolveNamedVars,
};
