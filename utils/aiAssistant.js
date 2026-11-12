// The store's AI answers WhatsApp chats nobody owns.
//
// The store (everlastwellness.com) runs the AI itself — the same one as its
// website chat, with its rules, medical check, prices, cart and payment
// links: POST /api/v1/assistant/whatsapp/message with each message a customer
// writes; it answers with `text` ready to send, and `handover: true` when a
// person should take over. The CRM decides *when* it may answer, relays, and
// hands over. Settings → AI assistant switches it on (staff test phones only,
// or everyone); the store's address and key are Templates → Website's.
//
// When it answers — the gate, checked when the message arrives AND again just
// before sending: switched on for this line (and, in test mode, a staff test
// phone); nobody owns the chat; no flow is running in it; not handed over in
// the quiet time set in Settings (24 h by default); not a STOP, not opted out.
//
// A person takes over → stop(): the call waiting on the store is aborted, and
// a late answer is never sent (the gate is checked again just before). The
// store may keep that answer in its own history; the customer never sees it.
//
// Several messages ("hello." / "can you send me the location?"): the AI waits
// until the customer stops writing — 3 s after each message, 10 s at most —
// and sends them as ONE question, so one answer covers them. (WhatsApp doesn't
// say when someone is typing, so a short wait is the only signal.) The store
// wants one customer's messages one after another, so each chat has a queue;
// if they write again while the store is thinking, that answer isn't sent and
// the new messages go in the next question.
//
// While the AI handles a chat, Conversation.aiActiveAt is set: automatic
// assignment leaves it alone. At hand-over (the store says so, or fails) the
// chat goes to an online agent with the store's summary.
// Every turn is recorded in AiReply. Never throws into message intake.

const prisma = require("../config/prisma");
const { getSetting } = require("./appSettings");
const numbers = require("./whatsappNumbers");
const { sendWhatsAppMessage, sendTypingIndicator } = require("./whatsappClient");
const { emitToNumber, emitToNumberStaff } = require("./socket");
const { botReplied, handedToTeam } = require("./followUp");
const { logError } = require("./errorLog");
const store = require("./storeEvents");
const linkPreview = require("./linkPreview");

const MODEL = "store:whatsapp_chat";
const STORE_TIMEOUT_MS = 60 * 1000; // the store: "wait up to 60 seconds"
const MEDIA_WAIT_MS = 10 * 1000;
const ARABIC_RE = /[؀-ۿ]/;
// The rules admins edit in Settings → AI assistant (utils/appSettings.js):
// quiet time after a hand-over; and, since WhatsApp doesn't tell a business
// when a customer is typing, the wait after each message (a new one restarts
// it) and the longest wait in all — then everything goes as one question.
// (AI_GATHER_MS / AI_MAX_GATHER_MS override the waits for the checks.)
const rules = () => {
  const c = getSetting("aiAssistant") || {};
  return {
    quietMs: (Number.isFinite(c.quietHours) ? c.quietHours : 24) * 60 * 60 * 1000,
    gatherMs: Number(process.env.AI_GATHER_MS) || (Number(c.gatherSeconds) || 3) * 1000,
    maxGatherMs: Number(process.env.AI_MAX_GATHER_MS) || (Number(c.maxGatherSeconds) || 10) * 1000,
  };
};

// Per chat: its queue, the newest message's number, the call in flight, and
// the messages still being gathered.
const pending = new Map(); // conversationId → { items, firstAt, timer, ctx }
const queues = new Map(); // conversationId → promise tail
const latest = new Map(); // conversationId → seq of the newest message
const inFlight = new Map(); // conversationId → AbortController

function serialize(conversationId, fn) {
  const prev = queues.get(conversationId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(conversationId, tail);
  tail.then(() => { if (queues.get(conversationId) === tail) queues.delete(conversationId); });
  return next;
}

const conf = () => getSetting("aiAssistant") || { enabled: false };

/** Why the AI mustn't answer in this chat right now, or null when it may. */
async function gateReason(conversationId, { requireActive = false } = {}) {
  const c = conf();
  if (!c.enabled) return "switched off";
  const { apiBase, apiKey } = store.settings();
  if (!apiBase || !apiKey) return "no store API address or key";
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { assignedAgentId: true, whatsappNumberId: true, aiActiveAt: true, aiHandedOffAt: true, status: true, customer: { select: { id: true, phone: true, optedOut: true } } },
  });
  if (!conv) return "chat gone";
  if (Array.isArray(c.numberIds) && c.numberIds.length && !c.numberIds.includes(conv.whatsappNumberId)) return "not on for this line";
  if (c.mode !== "all" && !(getSetting("testPhones")?.phones || []).includes(conv.customer.phone)) return "test mode: not a staff test phone";
  if (conv.assignedAgentId) return "a person owns the chat";
  if (requireActive && !conv.aiActiveAt) return "stopped";
  if (conv.aiHandedOffAt && Date.now() - conv.aiHandedOffAt.getTime() < rules().quietMs) return "handed over to the team";
  if (conv.customer.optedOut) return "opted out";
  const optOut = await prisma.customerOptOut.findUnique({
    where: { customerId_whatsappNumberId: { customerId: conv.customer.id, whatsappNumberId: conv.whatsappNumberId } },
    select: { id: true },
  });
  if (optOut) return "opted out on this line";
  if (await prisma.flowRun.count({ where: { conversationId, status: "ACTIVE" } })) return "a flow is talking";
  return null;
}

async function record(data) {
  try {
    await prisma.aiReply.create({ data: { model: MODEL, chunkIds: [], ...data } });
  } catch (err) {
    console.error("[AI] record failed:", err.message);
  }
}

/**
 * A person took the chat (assigned, claimed, replied) or the customer opted
 * out: abort the call in flight and stop the AI in this chat. Cheap and safe to
 * call anywhere; never throws.
 */
async function stop(conversationId, reason = "a person took the chat") {
  try {
    // Messages still being gathered are dropped: a person has them now.
    const p = pending.get(conversationId);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(conversationId);
    }
    const ctrl = inFlight.get(conversationId);
    if (ctrl) {
      ctrl.abort(new Error(reason));
      inFlight.delete(conversationId);
    }
    const { count } = await prisma.conversation.updateMany({ where: { id: conversationId, aiActiveAt: { not: null } }, data: { aiActiveAt: null } });
    if (count) {
      const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { whatsappNumberId: true } });
      if (conv) emitToNumber(conv.whatsappNumberId, "conversation.updated", { conversationId });
    }
  } catch (err) {
    console.error("[AI] stop failed:", err.message);
  }
}

// The customer's picture, once the webhook has stored it (it uploads after saving).
async function waitForMediaUrl(messageId) {
  const until = Date.now() + MEDIA_WAIT_MS;
  for (;;) {
    const m = await prisma.message.findUnique({ where: { id: messageId }, select: { mediaUrl: true } });
    if (m?.mediaUrl && /^https:\/\//i.test(m.mediaUrl)) return m.mediaUrl;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// One call to the store; one retry (same message_id: the store answers a
// retry with the same reply, duplicate: true) on a timeout, a network error, a
// 5xx or a 429 (after its Retry-After, at most 30 s).
async function askStore(body, { signal, lang }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await store.storeApi("/api/v1/assistant/whatsapp/message", body, { signal, timeout: STORE_TIMEOUT_MS, lang });
    } catch (err) {
      if (signal.aborted) throw err;
      const status = err.response?.status;
      const retryable = !status || status >= 500 || status === 429;
      if (attempt >= 2 || !retryable) throw err;
      const wait = status === 429 ? Math.min(30, Number(err.response.headers?.["retry-after"]) || 5) * 1000 : 1000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Why the store's answer must not reach a customer, or null when it's fine. AI
// models sometimes break down ("!!!!!!!…", one character repeated, no words,
// pages of text): never sent — the chat goes to a person instead.
const MAX_REPLY_CHARS = 2500;
function brokenReply(text) {
  const t = String(text || "").trim();
  if (!t) return "the answer was empty";
  if (t.length > MAX_REPLY_CHARS) return `the answer was ${t.length} characters long`;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 2) return "the answer had no words";
  if (/(.)\1{14,}/u.test(t.replace(/\s/g, ""))) return "the answer repeated one character over and over";
  const chars = [...t.replace(/\s/g, "")];
  const counts = new Map();
  for (const c of chars) counts.set(c, (counts.get(c) || 0) + 1);
  const top = Math.max(...counts.values());
  if (chars.length >= 20 && top / chars.length > 0.4 && !/\p{L}/u.test([...counts.entries()].find(([, n]) => n === top)[0])) {
    return "the answer was mostly one symbol";
  }
  return null;
}

// One AI message in the chat (a bot message marked AI — "AI" in the inbox):
// `content` is what the inbox shows (text, or the JSON a card/button message
// renders from), `sendArgs` what goes to WhatsApp.
// @returns the message (status SENT or FAILED)
async function sendAiMessage(conversationId, numberId, phone, { messageType, content, sendArgs, preview }) {
  const credentials = await numbers.getCredentials(numberId);
  let message = await prisma.message.create({
    data: { conversationId, senderType: "BOT", senderId: null, origin: "AI", content, messageType, status: "PENDING" },
  });
  try {
    const { whatsappMessageId } = await sendWhatsAppMessage({ number: credentials, to: phone, ...sendArgs });
    message = await prisma.message.update({ where: { id: message.id }, data: { whatsappMessageId, status: "SENT" } });
  } catch (err) {
    const meta = err.response?.data?.error;
    message = await prisma.message.update({
      where: { id: message.id },
      data: { status: "FAILED", errorCode: Number(meta?.code) || null, errorTitle: (meta?.message || err.message).slice(0, 500) },
    });
  }
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessage: preview, lastMessageAt: new Date(), lastSenderType: "BOT" } });
  // The customer is talking to the AI, not waiting for a person.
  await botReplied(conversationId);
  emitToNumber(numberId, "message.created", { message, conversationId });
  emitToNumber(numberId, "conversation.updated", { conversationId });
  return message;
}

const sendAiText = (conversationId, numberId, phone, text) =>
  sendAiMessage(conversationId, numberId, phone, { messageType: "TEXT", content: text, sendArgs: { content: text, messageType: "TEXT" }, preview: text });

// ── Rich answers: product cards, a pay button, a location pin ──────────────
// The store's answer comes with `links` ({ type, title, price, url, image?,
// latitude?, longitude?, name?, address? }). Products become a swipeable row
// of cards (one product: one card) with a "View" button; a payment link a
// "Pay now" button; a location a real map pin. WhatsApp needs a JPG or PNG on
// every card: the store's own image, else the photo read from the product's
// page, else the card picture set in Settings → AI assistant; without any,
// the plain text goes as before.

const IMAGE_RE = /^https:\/\/\S+\.(jpe?g|png)(\?\S*)?$/i;
const isHttps = (u) => /^https:\/\/\S+$/i.test(String(u || ""));
const cut = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ""));

const PREVIEW_BUDGET_MS = 10 * 1000;

// A card's picture and details, best first: the store's own JPG/PNG; the
// store's picture in another format, turned into a JPG; the photo on the
// product's page (utils/linkPreview.js); the card picture in Settings.
async function cardFor(link) {
  const preview = await linkPreview.previewOf(link.url);
  let img = IMAGE_RE.test(String(link.image || "")) ? link.image : null;
  if (!img && link.image) img = await linkPreview.cardImageFromUrl(link.image);
  if (!img) img = preview?.image || null;
  if (!img) {
    const fallback = conf().cardImageUrl;
    img = IMAGE_RE.test(String(fallback || "")) ? fallback : null;
  }
  return { ...link, title: link.title || preview?.title || null, img };
}

// All cards at once, and never longer than PREVIEW_BUDGET_MS: a slow page
// leaves its card without a picture (→ the plain text) rather than holding
// the answer up.
async function cardsFor(products) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PREVIEW_BUDGET_MS); });
  const cards = await Promise.all(products.map((p) => Promise.race([cardFor(p).catch(() => null), late]).then((c) => c || { ...p, img: null })));
  clearTimeout(timer);
  return cards;
}

function readLinks(data) {
  const links = Array.isArray(data.links) ? data.links.filter((l) => l && typeof l === "object") : [];
  const lat = (l) => Number(l.latitude ?? l.lat);
  const lng = (l) => Number(l.longitude ?? l.lng ?? l.lon);
  return {
    products: links.filter((l) => l.type !== "payment" && l.type !== "location" && isHttps(l.url)),
    payments: links.filter((l) => l.type === "payment" && isHttps(l.url)),
    locations: links
      .filter((l) => l.type === "location" && Number.isFinite(lat(l)) && Number.isFinite(lng(l)) && Math.abs(lat(l)) <= 90 && Math.abs(lng(l)) <= 180)
      .map((l) => ({ latitude: lat(l), longitude: lng(l), name: l.name || l.title || null, address: l.address || null })),
  };
}

/**
 * Send the store's answer the best way WhatsApp allows: product cards, a pay
 * button, a pin — else the plain text. A rich message WhatsApp refuses falls
 * back to the plain text, so the customer always gets the answer.
 * @returns the first message saved (for the AiReply record)
 */
async function sendAnswer(conversationId, numberId, phone, data) {
  const fullText = String(data.text || "").trim();
  const reply = String(data.reply || "").trim() || fullText;
  const ar = ARABIC_RE.test(reply);
  const { products, payments, locations } = readLinks(data);
  const cards = await cardsFor(products.slice(0, 10));
  const canCards = cards.length > 0 && cards.every((c) => c.img && c.title);
  if (!canCards && !payments.length && !locations.length) return sendAiText(conversationId, numberId, phone, fullText);

  const sent = [];
  const view = ar ? "عرض" : "View";
  const cardBody = (c) => cut([c.title, c.price].filter(Boolean).join("\n"), 160);
  if (canCards && cards.length >= 2) {
    // One message: the AI's sentence above a swipeable row of cards.
    const carousel = cards.map((c, i) => ({ mediaType: "IMAGE", mediaUrl: c.img, body: cardBody(c), buttons: [{ id: `p${i}`, type: "URL", title: view, url: c.url }] }));
    sent.push(await sendAiMessage(conversationId, numberId, phone, {
      messageType: "INTERACTIVE",
      content: JSON.stringify({ body: cut(reply, 1024), cards: carousel }),
      sendArgs: { content: cut(reply, 1024), messageType: "INTERACTIVE", carousel },
      preview: reply,
    }));
  } else if (canCards) {
    // One product: its picture, the AI's sentence, and a View button.
    const c = cards[0];
    const body = cut(`${reply}\n\n${cardBody(c)}`, 1024);
    const buttons = [{ id: "view", type: "URL", title: view, url: c.url }];
    sent.push(await sendAiMessage(conversationId, numberId, phone, {
      messageType: "INTERACTIVE",
      content: JSON.stringify({ headerType: "IMAGE", headerMediaUrl: c.img, body, buttons }),
      sendArgs: { content: body, messageType: "INTERACTIVE", headerType: "IMAGE", headerMediaUrl: c.img, buttons },
      preview: reply,
    }));
  } else {
    // No cards possible: the AI's sentence alone (the pay button / pin follow).
    sent.push(await sendAiText(conversationId, numberId, phone, products.length ? fullText : reply));
  }
  for (const p of payments.slice(0, 1)) {
    const buttons = [{ id: "pay", type: "URL", title: ar ? "ادفع الآن" : "Pay now", url: p.url }];
    const body = cut(p.title || (ar ? "رابط الدفع الآمن" : "Your secure payment link"), 1024);
    sent.push(await sendAiMessage(conversationId, numberId, phone, {
      messageType: "INTERACTIVE",
      content: JSON.stringify({ body, buttons }),
      sendArgs: { content: body, messageType: "INTERACTIVE", buttons },
      preview: body,
    }));
  }
  for (const loc of locations.slice(0, 1)) {
    const mapUrl = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
    const shown = ["📍 " + (loc.name || (ar ? "الموقع" : "Location")), loc.address, mapUrl].filter(Boolean).join("\n");
    sent.push(await sendAiMessage(conversationId, numberId, phone, {
      messageType: "TEXT",
      content: shown,
      sendArgs: { content: shown, messageType: "TEXT", location: loc },
      preview: shown,
    }));
  }
  // WhatsApp refused a rich message: the customer gets the plain text instead.
  if (sent.some((m) => m.status === "FAILED") && fullText) {
    console.warn("[AI] a rich answer was refused — sent as plain text");
    return sendAiText(conversationId, numberId, phone, fullText);
  }
  return sent[0];
}

// To the team: the AI stays quiet here for the quiet time, the waiting clock starts, and
// the chat goes to an online agent (or waits in Unassigned) with the reason.
async function handOver(conversationId, numberId, summary) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { aiActiveAt: null, aiHandedOffAt: new Date() } });
  await handedToTeam(conversationId);
  if (summary) {
    await prisma.conversationNote
      .create({ data: { conversationId, authorId: null, body: `AI hand-over: ${summary}` } })
      .catch(() => {});
  }
  emitToNumber(numberId, "conversation.updated", { conversationId });
  const agent = await require("./autoAssign").autoAssign(conversationId, { reason: "AI hand-over", note: summary || null });
  // Nobody to give it to (no agent online, or automatic assignment off): the
  // whole team on the line is alerted instead — the alert flows raise — so a
  // supervisor or admin can take it. It waits in Unassigned meanwhile.
  if (!agent) {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { customer: { select: { name: true, phone: true } } } });
    emitToNumberStaff(numberId, "flow.handoff", {
      conversationId,
      customerName: conv?.customer?.name || null,
      customerPhone: conv?.customer?.phone || "",
      agentId: null,
      agentUsername: null,
      flowName: "AI assistant",
      interest: summary || null,
      at: new Date().toISOString(),
    });
  }
}

// One message's text for the store: typed text and button taps; a photo's caption.
const textOf = ({ message, rawType, content }) => {
  if (message.messageType === "TEXT" || rawType === "interactive" || rawType === "button") return String(content || "").trim();
  if (message.messageType === "IMAGE" && content && !/^\[/.test(content)) return String(content).trim();
  return "";
};

// items: the customer's messages since the last answer, oldest first — sent
// as ONE question ("hello." + "can you send me the location?"), under the
// newest message's id.
async function turn({ conversationId, numberId, phone, name, items, seq }) {
  const message = items[items.length - 1].message;
  const started = Date.now();
  const base = { conversationId, whatsappNumberId: numberId, inboundMessageId: message.id };
  const before = await gateReason(conversationId, { requireActive: true });
  if (before) return record({ ...base, outcome: "SKIPPED", reason: before });

  const ctrl = new AbortController();
  inFlight.set(conversationId, ctrl);
  try {
    // "typing…" on their message while the store thinks. Never blocks the turn.
    numbers
      .getCredentials(numberId)
      .then((credentials) => sendTypingIndicator({ number: credentials, messageId: message.whatsappMessageId }))
      .catch(() => {});

    // Their messages joined, one per line; the latest photo among them, if any.
    const text = items.map(textOf).filter(Boolean).join("\n");
    const lastImage = [...items].reverse().find((i) => i.message.messageType === "IMAGE");
    const imageUrl = lastImage ? await waitForMediaUrl(lastImage.message.id) : null;
    const body = {
      customer_phone: `+${phone}`,
      message_id: message.whatsappMessageId,
      text: text || "",
      image_url: imageUrl,
      ...(name ? { name } : {}),
    };
    const res = await askStore(body, { signal: ctrl.signal, lang: ARABIC_RE.test(text || "") ? "ar" : "en" });
    const data = res?.data || {};
    const latencyMs = Date.now() - started;
    const extra = { externalConversationId: Number.isInteger(data.conversation_id) ? data.conversation_id : null, latencyMs };

    if (ctrl.signal.aborted) return record({ ...base, ...extra, outcome: "CANCELLED", reason: String(ctrl.signal.reason?.message || "stopped") });
    // A newer message is waiting: its answer covers this one (a hand-over still counts).
    if (latest.get(conversationId) !== seq && !data.handover) return record({ ...base, ...extra, outcome: "SKIPPED", reason: "a newer message was answered instead" });
    const after = await gateReason(conversationId, { requireActive: true });
    if (after) return record({ ...base, ...extra, outcome: "CANCELLED", reason: after });

    // duplicate: the store had answered this message already. After our own
    // retry (the first try timed out) the customer never saw it: send it. Only
    // if this message was already answered here is it skipped.
    const answeredHere = data.duplicate
      ? await prisma.aiReply.count({ where: { inboundMessageId: message.id, outcome: { in: ["ANSWERED", "HANDED_OFF"] } } })
      : 0;
    // A broken answer ("!!!!…") is never sent: the chat goes to a person.
    const broken = !answeredHere && !data.handover ? brokenReply(data.text) : null;
    if (broken) {
      logError({ source: "api", message: `The store's AI sent a broken answer — not sent, the chat went to the team: ${broken}`, details: { sample: String(data.text || "").slice(0, 200) }, conversationId });
      await handOver(conversationId, numberId, null);
      return record({ ...base, ...extra, outcome: "ERROR", reason: "broken answer", error: `${broken}: ${String(data.text || "").slice(0, 200)}` });
    }
    let reply = null;
    if (typeof data.text === "string" && data.text.trim() && !answeredHere && !brokenReply(data.text)) {
      reply = await sendAnswer(conversationId, numberId, phone, data);
    }
    if (data.handover) {
      await handOver(conversationId, numberId, data.summary || null);
      return record({ ...base, ...extra, replyMessageId: reply?.id ?? null, outcome: "HANDED_OFF", reason: data.summary || "the customer wants a person" });
    }
    return record({
      ...base, ...extra, replyMessageId: reply?.id ?? null, outcome: "ANSWERED",
      reason: answeredHere ? "already answered here (repeat)" : items.length > 1 ? `${items.length} messages answered together` : null,
    });
  } catch (err) {
    if (ctrl.signal.aborted) return record({ ...base, outcome: "CANCELLED", reason: String(ctrl.signal.reason?.message || "stopped"), latencyMs: Date.now() - started });
    const status = err.response?.status;
    const why = err.code === "NOT_CONFIGURED" ? err.message : `${status ? `${status} ` : ""}${err.response?.data?.error?.message || err.message}`;
    logError({ source: "api", message: `The store's AI didn't answer — the chat went to the team: ${why}`, error: err, conversationId });
    await record({ ...base, outcome: "ERROR", error: why.slice(0, 500), latencyMs: Date.now() - started });
    // Nothing is sent to the customer; the chat simply goes to the team.
    await handOver(conversationId, numberId, null).catch(() => {});
  } finally {
    if (inFlight.get(conversationId) === ctrl) inFlight.delete(conversationId);
  }
}

// The wait is over: what they wrote goes to the store as one question, after
// any answer already in progress (one customer's messages one after another).
function flush(conversationId) {
  const p = pending.get(conversationId);
  if (!p) return;
  pending.delete(conversationId);
  const seq = latest.get(conversationId);
  serialize(conversationId, () => turn({ conversationId, ...p.ctx, items: p.items, seq })).catch((err) =>
    console.error("[AI] turn failed:", err.message),
  );
}

/**
 * A customer's message arrived (the webhook, after the flow engine had its say).
 * @returns true when the AI takes it (automatic assignment must wait), else false.
 */
async function handleInbound({ numberId, conversation, customer, message, rawType, content, name, optIntent }) {
  try {
    if (optIntent === "OUT" || optIntent === "OUT_ALL") {
      await stop(conversation.id, "the customer opted out");
      return false;
    }
    const why = await gateReason(conversation.id);
    if (why) return false;
    const id = conversation.id;
    await prisma.conversation.update({ where: { id }, data: { aiActiveAt: new Date() } });
    emitToNumber(numberId, "conversation.updated", { conversationId: id });
    // A newer message: an answer still on its way for the earlier ones isn't sent
    // (these go in the next question, which covers them).
    latest.set(id, (latest.get(id) || 0) + 1);
    // Wait for the customer to finish: each message restarts a short wait, never
    // more than the longest wait in all; then everything they wrote goes as one.
    let p = pending.get(id);
    if (!p) {
      p = { items: [], firstAt: Date.now(), timer: null };
      pending.set(id, p);
    }
    p.items.push({ message, rawType, content });
    p.ctx = { numberId, phone: customer.phone, name: name || customer.name || null };
    clearTimeout(p.timer);
    const { gatherMs, maxGatherMs } = rules();
    const wait = Math.max(0, Math.min(gatherMs, p.firstAt + maxGatherMs - Date.now()));
    p.timer = setTimeout(() => flush(id), wait);
    return true;
  } catch (err) {
    console.error("[AI] handleInbound failed:", err.message);
    return false;
  }
}

module.exports = { handleInbound, stop, gateReason };
