// The AI assistant: answers patients' WhatsApp questions from the clinic's
// approved knowledge base (utils/knowledge.js), and hands everything else to
// the team.
//
// One turn, after a patient writes:
//   1. GATE — the webhook calls handleInbound for every saved inbound message,
//      after the flow engine. The assistant only ever speaks when Workers AI is
//      configured, it is switched on for the line, no flow has the chat, the
//      patient hasn't opted out, no person is handling the chat (assigned, or
//      a staff reply within quietAfterAgentReplyHours), and the assistant
//      hasn't already handed this chat over (see gateDecision).
//   2. WAIT — patients send several messages in a row: the turn starts
//      "wait before replying" (Settings, default 4 s) after the latest one and
//      answers them together.
//   3. URGENT — red-flag words (severe pain, bleeding, تورم…) are checked by
//      plain matching before any model call: the urgent message goes out and
//      the medical team is alerted. No model involved.
//   4. ANSWER — the model sees the system prompt below, the list of topics the
//      knowledge base covers, the sources retrieved for this message and the
//      last few messages. It either answers (checked by guardReply first) or
//      calls handoff_to_agent.
//   5. HAND-OFF — the hand-over message goes to the patient, then the same
//      alert a flow's Assign step raises (flowEngine.handToTeam), with the
//      reason and the model's summary.
// Every turn is recorded in AiReply. A provider failure is recorded and
// otherwise invisible: the message simply waits in the inbox like any other.
//
// Never allowed to break message intake: handleInbound returns at once and
// every failure is logged, never thrown.

const prisma = require("../config/prisma");
const workersAi = require("./workersAi");
const knowledge = require("./knowledge");
const numbers = require("./whatsappNumbers");
const logAudit = require("./audit");
const { getSetting } = require("./appSettings");
const { sendTypingIndicator } = require("./whatsappClient");
const { handedToTeam } = require("./followUp");
const { sendBot, handToTeam, serialize } = require("./flowEngine");

// The tunables — how long to wait before answering (debounceMs), how many
// messages the model sees (historyMessages), tool rounds, extra searches, the
// token limit, temperature, the longest reply the guard lets through
// (maxReplyChars) — come from Settings → AI assistant → AI model & Cloudflare,
// read live through workersAi.getConfig() (utils/aiProviderSetting.js has the
// defaults and ranges). One turn reads them once, so it runs on one config.

// The guard's default limit when no config is given (the checks). The prompt
// asks for ~600; anything much longer is not a WhatsApp answer.
const DEFAULT_MAX_REPLY_CHARS = 1500;

const HANDOFF_REASONS = ["booking", "not_covered", "patient_request", "complaint", "medical", "other"];

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(settings, titles) {
  const topics = titles.length
    ? titles.map((t) => `- ${t.title}${t.category ? ` (${t.category})` : ""}`).join("\n")
    : "- (nothing approved yet — hand every clinic question to the team)";
  const note = String(settings.outOfHoursNote || "").trim();
  return `You are ${settings.assistantName}, the WhatsApp assistant of Everlast, an aesthetic and medical clinic in Dubai. You answer patients' questions about the clinic's treatments and services, and you pass everything else to the clinic's team.

# Who you are
- You are an automated assistant — not a person, not a doctor, not a nurse. If anyone asks, say so plainly.
- The clinic's team can always take over; offering that is never wrong.

# Language
- Reply in the language of the patient's latest message.
- Arabic: natural, warm Modern Standard Arabic that reads easily for Gulf patients — not stiff or formal, no heavy dialect.
- English: simple, friendly, plain English.

# WhatsApp style
- Short: usually 1–4 short sentences, never more than about 600 characters.
- Plain text. Use *single asterisks* for bold, sparingly. Short "-" lists are fine.
- No markdown headings, no tables, no links unless a source contains them, no source numbers or citations.
- At most one emoji, only when it fits.

# What you may say
- ONLY what the knowledge sources given in this conversation say, plus ordinary courtesy (greetings, thanks, asking what they'd like to know).
- If the sources don't clearly answer the question, do not guess: call handoff_to_agent with reason "not_covered".
- If the sources given don't cover the question, you may first call search_knowledge with a better query (for example the treatment's name in English).
- Prices, offers and durations: only when a source states them, quoted exactly. Otherwise hand over.
- Never invent treatments, prices, offers, opening hours, doctors, results or anything else.

# Never
- Never diagnose, prescribe, recommend a medicine, product or dose, or tell a patient whether a symptom, side effect or photo is normal.
- Never promise or guarantee results.
- Never give medical advice beyond what the approved text says, and never adapt it to the patient's own situation (pregnancy, conditions, medication, allergies…) — hand over with reason "medical".

# Hand over (call handoff_to_agent) when
- they want to book, reschedule or cancel, or ask about availability → reason "booking" (the team books appointments);
- they ask for a person, a doctor or a call → "patient_request";
- they complain or are unhappy → "complaint";
- they ask about their own symptoms, results, health or medication → "medical";
- the sources don't answer the question → "not_covered";
- anything else you can't answer safely → "other".
When you call handoff_to_agent, write no reply yourself: the patient automatically gets a hand-over message. The summary is one short line in English for the team: what the patient wants.

# Topics in the clinic's knowledge base
${topics}${note ? `\n\n# Clinic note\n${note}` : ""}`;
}

const TOOLS = [
  {
    name: "search_knowledge",
    description:
      "Search the clinic's approved knowledge base again with a better query, when the sources you were given don't cover the patient's question.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, e.g. the treatment's name and the topic (aftercare, downtime, price). English or Arabic." },
      },
      required: ["query"],
    },
  },
  {
    name: "handoff_to_agent",
    description: "Pass the conversation to the clinic's team. The patient is told a person will reply shortly.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: HANDOFF_REASONS, description: "Why the team is needed." },
        summary: { type: "string", description: "One short line in English for the team: what the patient wants. At most 200 characters." },
      },
      required: ["reason", "summary"],
    },
  },
];

// ── Text helpers (pure) ─────────────────────────────────────────────────────

// Arabic spelled many ways: hamza forms, taa marbuta, alif maqsura, diacritics.
function normaliseArabic(text) {
  return String(text || "")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

const toWesternDigits = (s) =>
  String(s || "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

/** True when most of the letters are Arabic. */
function isArabic(text) {
  const s = String(text || "");
  const arabic = (s.match(/[؀-ۿ]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  return arabic > 0 && arabic >= latin;
}

// Two levels, both checked before any model call (the model never answers
// these):
//   URGENT  — clear danger: the patient gets the urgent message and agents a
//             red alert.
//   MEDICAL — symptoms that are often normal aftercare questions ("is swelling
//             normal after filler?"): a normal hand-over to the team, no
//             urgent message.
const RED_FLAGS_EN = [
  /\b(severe|extreme|unbearable|terrible|intense|excruciating)(ly)?\s+(pain|painful|ache)/,
  /\b(a lot of|so much|lots of)\s+pain\b/,
  /\b(heavy|heavily|a lot of|won'?t stop|wont stop|keeps?)\s+bleed/, /\bbleed(ing|s)?\s+(a lot|heavily|won'?t stop|nonstop|non-stop)\b/,
  /\bpus\b/, /\bfever\b/,
  /\ballergic\b/, /\banaphyla/, /\bhives\b/,
  /\b(can'?t|cannot|can not|unable to|hard to|difficult to|struggling to|trouble|difficulty)\s+(breath|breathing)/,
  /\bshort(ness)?\s+of\s+breath\b/,
  /\b(blurred|blurry|double|lost|loss of|losing)\s+(vision|sight)\b/, /\bvision\s+(loss|problem|problems)\b/, /\bcan'?t see\b/,
  /\bnecros/,
  /\bemergency\b/, /\bambulance\b/,
];
const MEDICAL_FLAGS_EN = [
  /\bswelling\b/, /\bswollen\b/, /\bswelled\b/,
  /\bbleed(ing|s)?\b/, /\bbled\b/,
  /\binfect(ion|ions|ed)?\b/, /\bredness\b/, /\bbruis(e|es|ed|ing)\b/,
  /\bblister(s|ed|ing)?\b/, /(?<!fat\s)\bburn(s|ed|t|ing)?\b/,
  /\b(it|still)\s+hurts?\b/, /\bpain(ful)?\b/, /\bitch(y|ing)?\b/, /\brash\b/, /\bnumb(ness)?\b/, /\blump(s|y)?\b/,
];
// Arabic: multi-word phrases match as substrings; single words match a word,
// with or without a leading و/ف/ب/ل/ال, and (4+ letters) any ending.
const RED_FLAGS_AR = [
  "ألم شديد", "الم قوي", "وجع شديد", "وجع قوي", "ألم فظيع", "ألم لا يحتمل",
  "نزيف شديد", "نزيف قوي", "ما يوقف النزيف", "صديد", "قيح", "حمى", "حساسية",
  "ضيق تنفس", "ضيق في التنفس", "صعوبة في التنفس", "صعوبة تنفس", "ما اقدر اتنفس", "مش قادر اتنفس", "لا استطيع التنفس",
  "زغللة", "تشوش الرؤية", "رؤية ضبابية", "فقدان البصر",
  "نخر", "طوارئ", "اسعاف", "إسعاف",
].map((t) => normaliseArabic(t));
const MEDICAL_FLAGS_AR = [
  "تورم", "متورم", "انتفاخ", "منتفخ", "نزيف", "ينزف", "تنزف", "التهاب", "ملتهب", "حرارة", "سخونة",
  "احمرار", "كدمة", "كدمات", "ازرقاق", "بثور", "فقاعات", "حروق", "حرق", "انحرق", "حكة", "هرش", "طفح", "ألم", "وجع", "تنميل", "كتلة",
].map((t) => normaliseArabic(t));
const AR_PREFIXES = ["وال", "بال", "فال", "لل", "ال", "و", "ف", "ب", "ل"];

/** The urgent red-flag word or phrase found in the text, or null. */
function detectUrgent(text) {
  return matchFlags(text, RED_FLAGS_EN, RED_FLAGS_AR);
}

/** A symptom word that needs a person (not urgent), or null. */
function detectMedical(text) {
  return matchFlags(text, MEDICAL_FLAGS_EN, MEDICAL_FLAGS_AR);
}

function matchFlags(text, enList, arList) {
  const en = String(text || "").toLowerCase().replace(/[’‘`]/g, "'");
  for (const re of enList) {
    const m = en.match(re);
    if (m) return m[0].trim();
  }
  const ar = normaliseArabic(text).replace(/\s+/g, " ");
  const tokens = ar.split(/[^ء-ي]+/).filter(Boolean);
  for (const term of arList) {
    if (term.includes(" ")) {
      if (ar.includes(term)) return term;
      continue;
    }
    for (const token of tokens) {
      const forms = [token, ...AR_PREFIXES.filter((p) => token.startsWith(p) && token.length - p.length >= 3).map((p) => token.slice(p.length))];
      if (forms.some((f) => f === term || (term.length >= 4 && f.startsWith(term)))) return term;
    }
  }
  return null;
}

/** What the model wrote, as WhatsApp text: markdown bold/headings/tables and citations removed. */
function formatForWhatsApp(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s*(.+)$/gm, "*$1*")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split("|").map((c) => c.trim()).filter(Boolean).join(" — "))
    .replace(/\s?【[^】]*】/g, "")
    .replace(/\s?\[(?:S|source\s*)?\d+(?:\s*,\s*(?:S)?\d+)*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DOSE_RE = /(\d+(?:[.,]\d+)?)\s?(mg|mcg|ml|cc|units?|iu)\b/gi;
const DOSE_RE_AR = /(\d+(?:[.,]\d+)?)\s?(ملغ|مجم|ملجم|مل|وحدة|وحده|وحدات)/g;
const DOSE_UNITS = [
  ["unit", "iu", "وحدة", "وحده", "وحدات"],
  ["ml", "cc", "مل"],
  ["mg", "ملغ", "مجم", "ملجم"],
];
const CURRENCY ="(?:aed|dhs?|dirhams?|درهم|دراهم|د\\.إ|usd|\\$)";
const PRICE_RE = new RegExp(`${CURRENCY}\\s?(\\d[\\d,]*(?:\\.\\d+)?)|(\\d[\\d,]*(?:\\.\\d+)?)\\s?${CURRENCY}`, "gi");
const PRICE_WORDS = /\b(price|prices|cost|costs|fee|fees|charge|offer)\b|سعر|بسعر|السعر|تكلفة|التكلفه|التكلفة|يكلف|رسوم/i;

const numbersIn = (text) => new Set((toWesternDigits(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "")));

/**
 * Checks a drafted reply before it can reach a patient: not empty, not too
 * long, and every dose and price it mentions appears in the sources it was
 * given (the model must never produce a number of its own).
 * @returns { ok: true } | { ok: false, reason }
 */
function guardReply(reply, sourcesText, maxChars = DEFAULT_MAX_REPLY_CHARS) {
  const text = toWesternDigits(String(reply || "")).trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > maxChars) return { ok: false, reason: "too_long" };
  const src = toWesternDigits(String(sourcesText || "")).toLowerCase();
  const srcNumbers = numbersIn(src);

  for (const re of [DOSE_RE, DOSE_RE_AR]) {
    for (const m of text.matchAll(re)) {
      const num = m[1].replace(",", ".");
      const unit = m[2].toLowerCase().replace(/s$/, "");
      const escaped = num.replace(/\./g, "[.,]");
      // The same unit in either language ("20 units" in the source, "٢٠ وحدة" in an Arabic reply).
      const unitRe = DOSE_UNITS.find((u) => u.includes(unit)) || [unit];
      if (!new RegExp(`(^|[^\\d.,])${escaped}\\s?(${unitRe.join("|")})`, "i").test(src)) return { ok: false, reason: "dose" };
    }
  }
  for (const m of text.matchAll(PRICE_RE)) {
    const num = (m[1] || m[2] || "").replace(/,/g, "");
    if (num && !srcNumbers.has(num)) return { ok: false, reason: "price" };
  }
  // A price written without a currency ("it costs 1500").
  if (PRICE_WORDS.test(text)) {
    for (const n of numbersIn(text)) {
      if (Number(n) >= 50 && !srcNumbers.has(n)) return { ok: false, reason: "price" };
    }
  }
  return { ok: true };
}

// ── Gate (pure) ─────────────────────────────────────────────────────────────

/**
 * Whether the assistant may answer. Every field is optional — one that isn't
 * given isn't checked — so the same rules serve the quick check when the
 * message arrives and the full one when the turn starts.
 * @returns { ok: boolean, reason: string | null }
 */
function gateDecision(s) {
  const no = (reason) => ({ ok: false, reason });
  if (s.configured === false) return no("not_configured");
  if (!s.settings?.enabled) return no("disabled");
  if (!(s.settings.numberIds || []).includes(s.numberId)) return no("line_not_enabled");
  if (s.rawType !== undefined && s.rawType !== "text") return no("not_text");
  if (s.optIntent) return no("opt_keyword");
  if (s.flowConsumed) return no("flow");
  if (s.activeFlowRun) return no("flow_active");
  if (s.optedOut) return no("opted_out");
  if (s.lastSenderType !== undefined && s.lastSenderType !== "CUSTOMER") return no("not_waiting");
  if (s.lastMessageType !== undefined && s.lastMessageType !== "TEXT") return no("not_text");
  if (s.assignedAgentId) return no("assigned");
  if (s.recentStaffReply) return no("staff_replied");
  if (s.recentFlowHandoff) return no("flow_handed_off");
  if (s.aiHandedOff) return no("ai_handed_off");
  return { ok: true, reason: null };
}

// ── Prompt pieces ───────────────────────────────────────────────────────────

const MEDIA_LABEL = { IMAGE: "[image]", VIDEO: "[video]", AUDIO: "[voice message]", DOCUMENT: "[document]", STICKER: "[sticker]" };

// A message as the model sees it. Interactive and template sends are stored as
// JSON; their body is what the patient read.
function messageText(m) {
  if (MEDIA_LABEL[m.messageType]) {
    const caption = String(m.content || "").trim();
    const real = caption && !/^https?:\/\//.test(caption) && caption !== "[media message]" && caption !== "[sticker]";
    return real ? `${MEDIA_LABEL[m.messageType]} ${caption}` : MEDIA_LABEL[m.messageType];
  }
  let text = String(m.content || "");
  if (m.messageType === "INTERACTIVE" || m.messageType === "TEMPLATE") {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") text = parsed.body || parsed.text || parsed.resolvedBody || "";
    } catch {
      // stored as plain text
    }
  }
  return text.trim().slice(0, 1000);
}

/** Recent messages (newest first, as queried) → chat messages, oldest first. */
function buildHistory(recentDesc) {
  const out = [];
  for (const m of [...recentDesc].reverse()) {
    const text = messageText(m);
    if (!text) continue;
    const role = m.senderType === "CUSTOMER" ? "user" : "assistant";
    const content = m.senderType === "AGENT" && m.senderId ? `[Clinic team member] ${text}` : text;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  }
  // The conversation the model continues must start with the patient.
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// "Treatment/topic: …\nCategory: …\nSection: …\n\n" is for the embedding; the
// model gets the title and section once, in the source's heading.
const chunkBody = (content) => String(content || "").replace(/^Treatment\/topic:[^\n]*\nCategory:[^\n]*\nSection:[^\n]*\n\n/, "");

function formatSources(list) {
  return list.map((s) => `[${s.n}] ${s.title} — ${s.section}\n${chunkBody(s.content)}`).join("\n\n");
}

// ── One turn (no side effects) ──────────────────────────────────────────────

/**
 * Decide what to tell the patient. Reads the knowledge base and calls the
 * model; sends nothing and writes nothing — shared by live turns and the
 * "Test the assistant" panel.
 *
 * @param history     chat messages, oldest first, ending with the patient
 * @param patientText the patient's latest message(s), for urgency and search
 * @returns { outcome: ANSWERED | HANDED_OFF | URGENT | ERROR, reply, draft,
 *   reason, summary, sources, chunkIds, toolCalls, usage, model, latencyMs, error }
 */
async function think({ history, patientText, settings, cfg }) {
  const started = Date.now();
  // The whole turn runs on one snapshot of the AI settings, so the model
  // recorded on the AiReply is the one that actually answered.
  const config = cfg || workersAi.getConfig();
  const sources = [];
  const toolCalls = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const done = (fields) => ({
    reply: null,
    draft: null,
    reason: null,
    summary: null,
    error: null,
    model: config.chatModel,
    ...fields,
    sources: sources.map(({ chunkId, articleId, title, section, score, n }) => ({ n, chunkId, articleId, title, section, score })),
    chunkIds: sources.map((s) => s.chunkId),
    toolCalls,
    usage,
    latencyMs: Date.now() - started,
  });

  const urgent = detectUrgent(patientText);
  if (urgent) {
    return done({ outcome: "URGENT", model: "rules", reason: "red_flag", summary: `Possible medical concern — the patient wrote "${urgent}".` });
  }
  const medical = detectMedical(patientText);
  if (medical) {
    return done({ outcome: "HANDED_OFF", model: "rules", reason: "medical", summary: `Symptom question — the patient wrote "${medical}". Needs a person, not urgent.` });
  }
  if (!workersAi.isConfigured(config)) return done({ outcome: "ERROR", error: "Cloudflare Workers AI is not configured" });

  // Adds search results not seen yet this turn; returns the new ones, numbered.
  const addSources = (found) => {
    const fresh = [];
    for (const s of found) {
      if (sources.some((x) => x.chunkId === s.chunkId)) continue;
      const numbered = { ...s, n: sources.length + 1 };
      sources.push(numbered);
      fresh.push(numbered);
    }
    return fresh;
  };
  const sourcesText = () => [...sources.map((s) => s.content), settings.outOfHoursNote || ""].join("\n");

  try {
    // A bare "price?" or "and after?" says little on its own: search with the
    // last thing the assistant said as context.
    let query = String(patientText || "").slice(-1000);
    if (query.trim().length < 20) {
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) query = `${lastAssistant.content.slice(0, 300)}\n${query}`;
    }
    const [titles, initial] = await Promise.all([knowledge.listApprovedTitles(), knowledge.searchKnowledge(query, { cfg: config })]);
    const first = addSources(initial);

    const messages = [
      { role: "system", content: buildSystemPrompt(settings, titles) },
      {
        role: "system",
        content: first.length
          ? `Knowledge sources for the patient's latest message (approved by the clinic — answer only from these):\n\n${formatSources(first)}`
          : "No approved knowledge source matched the patient's latest message. Search again with search_knowledge, answer with ordinary courtesy only, or hand over.",
      },
      ...history,
    ];

    let extraSearches = 0;
    for (let round = 0; round <= config.maxToolRounds; round++) {
      // Token limit, temperature, top P and timeout from config.
      const res = await workersAi.chat({ messages, tools: TOOLS, cfg: config });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;

      if (!res.toolCalls.length) {
        const reply = formatForWhatsApp(res.content);
        const guard = guardReply(reply, sourcesText(), config.maxReplyChars);
        if (!guard.ok) {
          return done({
            outcome: "HANDED_OFF",
            reason: `guard_${guard.reason}`,
            draft: reply || null,
            summary: `The assistant's answer was held back (${guard.reason === "empty" ? "no answer" : guard.reason}) — please reply.`,
          });
        }
        return done({ outcome: "ANSWERED", reply });
      }

      const handoff = res.toolCalls.find((c) => c.name === "handoff_to_agent");
      if (handoff) {
        const reason = HANDOFF_REASONS.includes(handoff.args?.reason) ? handoff.args.reason : "other";
        const summary = String(handoff.args?.summary || "").replace(/\s+/g, " ").trim().slice(0, 200) || null;
        toolCalls.push({ name: "handoff_to_agent", args: { reason, summary } });
        return done({ outcome: "HANDED_OFF", reason, summary });
      }
      if (round === config.maxToolRounds) break;

      messages.push(res.assistantMessage);
      for (const call of res.toolCalls) {
        let content;
        if (call.name === "search_knowledge") {
          const q = String(call.args?.query || "").trim().slice(0, 300);
          toolCalls.push({ name: "search_knowledge", args: { query: q } });
          if (!q) content = 'Invalid arguments — call search_knowledge with {"query": "..."}.';
          else if (extraSearches >= config.maxExtraSearches) content = "Search limit reached. Answer from the sources you have, or call handoff_to_agent.";
          else {
            extraSearches++;
            const fresh = addSources(await knowledge.searchKnowledge(q, { cfg: config }));
            content = fresh.length
              ? `New sources (approved by the clinic):\n\n${formatSources(fresh)}`
              : "Nothing new found in the approved knowledge base for that query.";
          }
        } else {
          toolCalls.push({ name: call.name, args: call.args });
          content = `There is no tool called "${call.name}".`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
    return done({ outcome: "HANDED_OFF", reason: "tool_rounds", summary: "The assistant couldn't settle on an answer — please reply." });
  } catch (err) {
    return done({ outcome: "ERROR", error: String(err.message || err).slice(0, 500) });
  }
}

/** The hand-over / urgent text for this patient, in their language when one is set. */
function patientNotice(settings, outcome, arabic) {
  if (outcome === "URGENT") return (arabic && settings.urgentMessageAr) || settings.urgentMessage;
  return (arabic && settings.handoffMessageAr) || settings.handoffMessage;
}

// ── Test mode ───────────────────────────────────────────────────────────────

/**
 * POST /api/knowledge/ask — the whole pipeline on a typed question, without
 * a conversation: nothing is sent and nothing is saved.
 */
async function ask({ question }) {
  const settings = getSetting("aiAssistant");
  const text = String(question || "").trim().slice(0, 2000);
  const result = await think({ history: [{ role: "user", content: text }], patientText: text, settings });
  const reply =
    result.outcome === "ANSWERED"
      ? result.reply
      : result.outcome === "HANDED_OFF" || result.outcome === "URGENT"
        ? patientNotice(settings, result.outcome, isArabic(text))
        : null;
  return { ...result, reply };
}

// ── Live turns ──────────────────────────────────────────────────────────────

async function logReply(data) {
  try {
    await prisma.aiReply.create({ data });
  } catch (err) {
    console.error("[ai] could not record the turn:", err.message);
  }
}

// What the full gate needs, read fresh when the turn starts.
async function loadGateState(conversation, settings, recent) {
  const id = conversation.id;
  const hours = settings.quietAfterAgentReplyHours;
  const quietSince = hours > 0 ? new Date(Date.now() - hours * 60 * 60 * 1000) : null;

  const [activeRuns, lineOptOut, staffReplies, flowHandoff, lastHandoff] = await Promise.all([
    prisma.flowRun.count({ where: { conversationId: id, status: "ACTIVE" } }),
    prisma.customerOptOut.count({ where: { customerId: conversation.customerId, whatsappNumberId: conversation.whatsappNumberId } }),
    // A person on the team (not a campaign send — those have no sender).
    quietSince
      ? prisma.message.count({ where: { conversationId: id, senderType: "AGENT", senderId: { not: null }, deletedAt: null, createdAt: { gt: quietSince } } })
      : 0,
    quietSince
      ? prisma.flowRun.count({ where: { conversationId: id, status: "HANDED_OFF", completedAt: { gt: quietSince } } })
      : 0,
    prisma.aiReply.findFirst({
      where: { conversationId: id, outcome: { in: ["HANDED_OFF", "URGENT"] } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // After the assistant hands a chat over it stays out until the team marks
  // it Resolved (a later message from the patient then reopens it — see the
  // webhook). Both moves are in the audit log.
  let aiHandedOff = false;
  if (lastHandoff) {
    const resolvedSince = await prisma.auditLog.count({
      where: {
        targetType: "conversation",
        targetId: id,
        action: "conversation.status_changed",
        createdAt: { gt: lastHandoff.createdAt },
        OR: [{ details: { path: ["status"], equals: "RESOLVED" } }, { details: { path: ["previousStatus"], equals: "RESOLVED" } }],
      },
    });
    aiHandedOff = resolvedSince === 0;
  }

  return {
    configured: workersAi.isConfigured(),
    settings,
    numberId: conversation.whatsappNumberId,
    activeFlowRun: activeRuns > 0,
    optedOut: Boolean(conversation.customer?.optedOut) || lineOptOut > 0,
    lastSenderType: recent[0]?.senderType,
    lastMessageType: recent[0]?.messageType,
    assignedAgentId: conversation.assignedAgentId,
    recentStaffReply: staffReplies > 0,
    recentFlowHandoff: flowHandoff > 0,
    aiHandedOff,
  };
}

const RECENT_SELECT = { id: true, senderType: true, senderId: true, content: true, messageType: true, whatsappMessageId: true };

async function runTurn(conversationId) {
  const settings = getSetting("aiAssistant");
  const config = workersAi.getConfig();
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { customer: true } });
  if (!conversation) return;
  const recent = await prisma.message.findMany({
    where: { conversationId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: config.historyMessages,
    select: RECENT_SELECT,
  });
  const gate = gateDecision(await loadGateState(conversation, settings, recent));
  if (!gate.ok) {
    console.log(`[ai] conversation ${conversationId}: staying silent (${gate.reason})`);
    return;
  }

  // Everything the patient wrote since anyone last answered, oldest first.
  const pending = [];
  for (const m of recent) {
    if (m.senderType !== "CUSTOMER") break;
    pending.unshift(m);
  }
  const latest = recent[0];
  const patientText = pending.map(messageText).filter(Boolean).join("\n");
  const numberId = conversation.whatsappNumberId;
  const ctx = { numberId, customer: conversation.customer, conversation, typed: true };

  // "typing…" while the model works (it also blue-ticks the message).
  if (latest.whatsappMessageId) {
    try {
      const credentials = await numbers.getCredentials(numberId);
      await sendTypingIndicator({ number: credentials, messageId: latest.whatsappMessageId });
    } catch (err) {
      console.warn("[ai] typing indicator failed:", err.response?.data?.error?.message || err.message);
    }
  }

  const result = await think({ history: buildHistory(recent), patientText, settings, cfg: config });
  const record = {
    conversationId,
    whatsappNumberId: numberId,
    inboundMessageId: latest.id,
    model: result.model,
    outcome: result.outcome,
    reason: result.reason,
    chunkIds: result.chunkIds,
    inputTokens: result.usage.inputTokens || null,
    outputTokens: result.usage.outputTokens || null,
    latencyMs: result.latencyMs,
    error: result.error,
  };

  if (result.outcome === "ERROR") {
    // Invisible to the patient: the message waits in the inbox as usual.
    console.error(`[ai] conversation ${conversationId}: turn failed — ${result.error}`);
    return logReply(record);
  }

  // The chat may have moved on while the model was thinking: a newer message
  // (that one gets its own turn), a reply from the team, or an assignment.
  const now = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true } });
  const newest = await prisma.message.findFirst({
    where: { conversationId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!now || now.assignedAgentId || newest?.id !== latest.id) {
    console.log(`[ai] conversation ${conversationId}: answer dropped — the chat moved on`);
    return logReply({ ...record, outcome: "ERROR", error: "superseded: the chat moved on before the answer was sent" });
  }

  const text = result.outcome === "ANSWERED" ? result.reply : patientNotice(settings, result.outcome, isArabic(patientText));
  try {
    const sent = await sendBot(ctx, { kind: "message", text, ai: true });
    record.replyMessageId = sent.id;
  } catch (err) {
    record.replyMessageId = err.messageId ?? null;
    record.error = String(err.message).slice(0, 500);
    console.error(`[ai] conversation ${conversationId}: send failed — ${err.message}`);
    // The bot's send cleared the waiting clock; nobody actually answered.
    if (result.outcome === "ANSWERED") await handedToTeam(conversationId).catch(() => {});
  }

  if (result.outcome === "HANDED_OFF" || result.outcome === "URGENT") {
    const urgent = result.outcome === "URGENT";
    try {
      await handToTeam(ctx, {
        alert: { flowName: "AI assistant", interest: null, source: "ai", urgent, reason: result.reason, summary: result.summary },
      });
    } catch (err) {
      console.error(`[ai] conversation ${conversationId}: hand-off alert failed — ${err.message}`);
    }
    logAudit({
      action: "ai.handed_off",
      actor: null,
      targetType: "conversation",
      targetId: conversationId,
      details: { reason: result.reason, urgent, summary: result.summary },
    });
  }
  console.log(`[ai] conversation ${conversationId}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""} in ${result.latencyMs}ms`);
  return logReply(record);
}

// Waiting turns: conversationId → timer. In-process, like the flow engine's
// queue — the API runs as a single instance.
const waiting = new Map();

function schedule(conversationId) {
  clearTimeout(waiting.get(conversationId));
  const timer = setTimeout(() => {
    waiting.delete(conversationId);
    // Its own lane (not the flow engine's), so a slow model call never holds
    // up a flow in the same chat; one turn at a time per chat.
    serialize(`ai:${conversationId}`, () => runTurn(conversationId)).catch((err) => {
      console.error(`[ai] conversation ${conversationId}: turn crashed —`, err.message);
    });
  }, workersAi.getConfig().debounceMs);
  timer.unref?.();
  waiting.set(conversationId, timer);
}

/**
 * Called by the webhook for every saved inbound customer message, right after
 * flowEngine.handleInbound. Returns at once; never throws.
 *
 * @param flowDone the flow engine's promise of { consumed }
 */
function handleInbound({ numberId, conversation, inbound, optIntent, flowDone }) {
  (async () => {
    const settings = getSetting("aiAssistant");
    const quick = gateDecision({ configured: workersAi.isConfigured(), settings, numberId, rawType: inbound.rawType, optIntent });
    if (!quick.ok) return;
    const flow = await flowDone;
    if (flow?.consumed) return;
    schedule(conversation.id);
  })().catch((err) => console.error("[ai] inbound handling failed (message kept):", err.message));
}

module.exports = {
  handleInbound,
  ask,
  // Pure parts, for the checks.
  detectUrgent,
  detectMedical,
  guardReply,
  gateDecision,
  formatForWhatsApp,
  buildHistory,
  isArabic,
  normaliseArabic,
  buildSystemPrompt,
};
