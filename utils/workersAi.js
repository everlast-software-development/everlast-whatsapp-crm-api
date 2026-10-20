// Cloudflare Workers AI, through its OpenAI-compatible endpoints. Used by the
// AI assistant (utils/aiAssistant.js) for chat, and by the knowledge base
// (utils/knowledge.js) for embeddings.
//
// Configured from Settings → AI assistant → AI model & Cloudflare (the
// `aiProvider` setting), falling back to config.env (CLOUDFLARE_ACCOUNT_ID,
// CLOUDFLARE_AI_TOKEN, AI_CHAT_MODEL, AI_EMBED_MODEL) and then the built-in
// defaults — read live on every call, so a change applies without a restart.
// Without an account ID and token the feature is simply "not configured":
// isConfigured() is false, nothing here is called, and the rest of the app
// works as before.
//
// The token is never logged: errors are rebuilt as a plain WorkersAiError with
// the HTTP status and Cloudflare's own explanation only (see utils/safeError.js
// for why an axios error must never be logged as-is).

const axios = require("axios");
const safeError = require("./safeError");
const secretBox = require("./secretBox");
const { getSavedSetting } = require("./appSettings");
const aiProviderSetting = require("./aiProviderSetting");

const { DEFAULT_CHAT_MODEL, DEFAULT_EMBED_MODEL } = aiProviderSetting;
// Must match KnowledgeChunk.embedding vector(1024) — changing it means a
// schema change, so a model with other dimensions is refused instead.
const EMBED_DIMS = 1024;
const RETRY_DELAY_MS = 1500;
// Texts per embeddings request. A long article is a dozen chunks at most.
const EMBED_BATCH = 20;
const API = "https://api.cloudflare.com/client/v4";

class WorkersAiError extends Error {
  constructor(message, status = null, friendly = null) {
    super(message);
    this.name = "WorkersAiError";
    this.status = status;
    // The explanation alone, for the Settings page.
    this.friendly = friendly || message;
  }
}

// ── Configuration ───────────────────────────────────────────────────────────

// Decrypting on every call is cheap, but there is no need: one entry, keyed by
// the stored ciphertext (a new save means a new ciphertext).
let decryptMemo = { boxed: null, value: null, error: null };
function cachedDecrypt(boxed) {
  if (decryptMemo.boxed !== boxed) {
    try {
      decryptMemo = { boxed, value: secretBox.decrypt(boxed), error: null };
    } catch (err) {
      decryptMemo = { boxed, value: null, error: err };
      console.error("[workersAi] the saved Cloudflare token can't be decrypted:", err.message);
    }
  }
  if (decryptMemo.error) throw decryptMemo.error;
  return decryptMemo.value;
}

/**
 * What is in force right now: { configured, accountId, token, chatModel,
 * embedModel, temperature, maxOutputTokens, topP, debounceMs, historyMessages,
 * retrievalTopK, similarityThreshold, maxToolRounds, maxExtraSearches,
 * maxReplyChars, requestTimeoutMs, …Source }. Holds the token — server-side only.
 */
function getConfig() {
  return aiProviderSetting.resolveFrom(getSavedSetting("aiProvider"), process.env, cachedDecrypt);
}

const isConfigured = (cfg) => Boolean((cfg || getConfig()).configured);
const chatModel = () => getConfig().chatModel;
const embedModel = () => getConfig().embedModel;

// ── Errors ──────────────────────────────────────────────────────────────────

// Cloudflare answers errors as { errors: [{ message }] }, the OpenAI-style
// routes sometimes as { error: { message } }.
function cloudflareDetail(err) {
  const data = err.response?.data;
  const detail =
    data?.errors?.[0]?.message ||
    data?.error?.message ||
    (typeof data?.error === "string" ? data.error : null) ||
    (typeof data === "string" && data.length < 300 ? data : null);
  return detail ? String(detail).slice(0, 300) : null;
}

/** A failed request, in words an admin can act on. */
function friendlyError({ status, detail, code, timeoutMs }) {
  const said = detail ? ` Cloudflare said: "${detail}"` : "";
  if (status === null || status === undefined) {
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
      return `No answer from Cloudflare within ${Math.round((timeoutMs || 0) / 1000)} seconds (timeout). Try again, or raise the request timeout.`;
    }
    return `Couldn't reach Cloudflare (${code || "network error"}). Check the server's internet connection.`;
  }
  if (status === 401 || /authenticat/i.test(detail || "")) {
    return `Cloudflare rejected the API token (${status}) — check it was copied in full and hasn't expired or been revoked.${said}`;
  }
  if (status === 403) {
    return `The API token isn't allowed to use Workers AI on this account (403) — create a token with the "Workers AI" Read and Edit permissions for this account.${said}`;
  }
  if (status === 404) return `Cloudflare doesn't know this model or account (404) — check the account ID and the model ID.${said}`;
  if (status === 429) return `Cloudflare's rate limit was reached (429) — wait a minute and try again.${said}`;
  if (status >= 500) return `Cloudflare Workers AI had a server error (HTTP ${status}) — try again shortly.${said}`;
  if (/model/i.test(detail || "")) return `Cloudflare didn't accept the model (HTTP ${status}).${said}`;
  return `Cloudflare refused the request (HTTP ${status}).${said}`;
}

function toError(label, err, timeoutMs) {
  const status = err.response?.status ?? null;
  const friendly = friendlyError({ status, detail: cloudflareDetail(err), code: err.code, timeoutMs });
  return new WorkersAiError(`Workers AI ${label} failed: ${friendly}`, status, friendly);
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function requireConfigured(cfg) {
  if (!cfg.accountId || !cfg.token) {
    const msg = "Cloudflare Workers AI is not configured — add the account ID and API token in Settings → AI assistant";
    throw new WorkersAiError(msg, null, msg);
  }
}

const accountUrl = (cfg) => `${API}/accounts/${encodeURIComponent(cfg.accountId)}`;

async function post(path, body, { cfg, timeout, retry = true }) {
  requireConfigured(cfg);
  const url = `${accountUrl(cfg)}/ai/v1/${path}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        timeout,
      });
      return data;
    } catch (err) {
      const status = err.response?.status ?? null;
      // One retry on rate limits, server errors and network failures (incl.
      // timeouts); a 4xx means the request itself is wrong.
      const retryable = status === null || status === 429 || status >= 500;
      if (retry && attempt === 0 && retryable) {
        console.warn(`[workersAi] ${path} failed (${status ?? err.code ?? "network"}), retrying once`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      if (status === null) console.error(`[workersAi] ${path} failed:`, safeError(err).message);
      throw toError(path, err, timeout);
    }
  }
}

// ── Chat & embeddings ───────────────────────────────────────────────────────

// GLM may put its reasoning in the content; the patient must never see it.
// Also handles a reply whose opening <think> was cut off.
function stripThinking(text) {
  let out = String(text || "");
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) out = out.slice(close + "</think>".length);
  const open = out.toLowerCase().indexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

function parseArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // not JSON — the caller decides what that means
  }
}

/**
 * One chat completion. Model, token limit, temperature, top P and timeout come
 * from `cfg` (default: the live settings) unless given.
 * @returns { content, toolCalls: [{ id, name, args (object, or null when the
 *   arguments weren't JSON) }], assistantMessage (to send back with tool
 *   results), usage: { inputTokens, outputTokens }, finishReason, model }
 */
async function chat({ messages, tools, maxTokens, temperature, topP, cfg, retry = true }) {
  const c = cfg || getConfig();
  const model = c.chatModel;
  const body = {
    model,
    messages,
    max_completion_tokens: maxTokens ?? c.maxOutputTokens,
    temperature: temperature ?? c.temperature,
  };
  const p = topP !== undefined ? topP : c.topP;
  if (p !== null && p !== undefined) body.top_p = p;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: "function", function: t }));
    body.tool_choice = "auto";
  }
  const data = await post("chat/completions", body, { cfg: c, timeout: c.requestTimeoutMs, retry });
  // Some Workers AI routes wrap the answer in { result: ... }.
  const root = data?.choices ? data : data?.result || {};
  const choice = root.choices?.[0] || {};
  const msg = choice.message || {};
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls = rawCalls
    .filter((call) => call && call.function && call.function.name)
    .map((call, i) => ({
      id: call.id || `call_${i}`,
      name: String(call.function.name),
      args: parseArguments(call.function.arguments),
      rawArguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
    }));
  const content = stripThinking(typeof msg.content === "string" ? msg.content : "");
  return {
    content,
    toolCalls,
    assistantMessage: {
      role: "assistant",
      content,
      ...(toolCalls.length
        ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.rawArguments } })) }
        : {}),
    },
    usage: {
      inputTokens: Number(root.usage?.prompt_tokens) || 0,
      outputTokens: Number(root.usage?.completion_tokens) || 0,
    },
    finishReason: choice.finish_reason || null,
    model,
  };
}

/**
 * Embeds texts with the embedding model in force (or cfg's). Returns one
 * vector per text, in order. With checkDims (the default) every vector must
 * have EMBED_DIMS numbers — what the database column holds.
 */
async function embed(texts, { cfg, checkDims = true, retry = true } = {}) {
  const c = cfg || getConfig();
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || ""));
  const timeout = Math.min(c.requestTimeoutMs, 60_000);
  const out = [];
  for (let i = 0; i < list.length; i += EMBED_BATCH) {
    const batch = list.slice(i, i + EMBED_BATCH);
    const data = await post("embeddings", { model: c.embedModel, input: batch }, { cfg: c, timeout, retry });
    const rows = data?.data || data?.result?.data;
    if (!Array.isArray(rows) || rows.length !== batch.length) {
      const msg = `The embedding model returned ${Array.isArray(rows) ? rows.length : "no"} vectors for ${batch.length} texts — is "${c.embedModel}" an embedding model?`;
      throw new WorkersAiError(`Workers AI embeddings failed: ${msg}`, null, msg);
    }
    // The API may not keep order; `index` says which input each one is.
    const sorted = rows.every((r) => Number.isInteger(r?.index)) ? [...rows].sort((a, b) => a.index - b.index) : rows;
    for (const r of sorted) {
      const v = r?.embedding;
      if (!Array.isArray(v) || !v.length || !v.every((x) => Number.isFinite(x))) {
        const msg = `The embedding model returned no usable vector — is "${c.embedModel}" an embedding model?`;
        throw new WorkersAiError(`Workers AI embeddings failed: ${msg}`, null, msg);
      }
      if (checkDims && v.length !== EMBED_DIMS) {
        const msg = `This model's vectors are ${v.length}-dimensional; the database expects ${EMBED_DIMS} (e.g. ${DEFAULT_EMBED_MODEL}).`;
        throw new WorkersAiError(`Workers AI embeddings failed: ${msg}`, null, msg);
      }
      out.push(v);
    }
  }
  return out;
}

// ── Model catalog ───────────────────────────────────────────────────────────

const CATALOG_TTL_MS = 60 * 60 * 1000;
const catalogCache = new Map(); // accountId → { at, models }

// When the catalog can't be read (not configured, no permission, offline).
const FALLBACK_MODELS = [
  { id: DEFAULT_CHAT_MODEL, task: "Text Generation", description: "Zhipu GLM-4.7 Flash — fast, multilingual, function calling.", contextWindow: null, functionCalling: true, properties: {} },
  { id: "@cf/moonshotai/kimi-k2.6", task: "Text Generation", description: "Moonshot Kimi K2.6.", contextWindow: null, functionCalling: true, properties: {} },
  { id: "@cf/google/gemma-4-26b-a4b-it", task: "Text Generation", description: "Google Gemma 4 26B A4B instruct.", contextWindow: null, functionCalling: null, properties: {} },
  { id: DEFAULT_EMBED_MODEL, task: "Text Embeddings", description: "BAAI bge-m3 — multilingual embeddings, 1024 dimensions.", contextWindow: null, functionCalling: null, properties: {} },
];

const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";

// Cloudflare lists properties as [{ property_id, value }]; be defensive about
// the exact field names and keep everything raw too.
function modelView(m, task) {
  const props = {};
  if (Array.isArray(m?.properties)) {
    for (const p of m.properties) {
      const key = p?.property_id ?? p?.id ?? p?.name;
      if (key) props[String(key)] = p?.value ?? null;
    }
  } else if (m?.properties && typeof m.properties === "object") {
    Object.assign(props, m.properties);
  }
  const ctx = Number(props.context_window ?? props.max_input_tokens ?? props.max_total_tokens);
  const fc = props.function_calling ?? props.tool_calling ?? props.tools;
  return {
    id: String(m?.name || m?.id || ""),
    task: String(m?.task?.name || (typeof m?.task === "string" ? m.task : "") || task),
    description: String(m?.description || "").slice(0, 500),
    contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
    functionCalling: fc === undefined ? null : truthy(fc),
    beta: props.beta === undefined ? null : truthy(props.beta),
    deprecated: Boolean(props.planned_deprecation_date || props.deprecated),
    properties: props,
  };
}

async function searchModels(cfg, task) {
  const perPage = 50;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    let data;
    try {
      ({ data } = await axios.get(`${accountUrl(cfg)}/ai/models/search`, {
        params: { task, page, per_page: perPage },
        headers: { Authorization: `Bearer ${cfg.token}` },
        timeout: 20_000,
      }));
    } catch (err) {
      throw toError("models", err, 20_000);
    }
    const rows = Array.isArray(data?.result) ? data.result : Array.isArray(data?.result?.models) ? data.result.models : [];
    for (const m of rows) {
      const v = modelView(m, task);
      if (v.id) out.push(v);
    }
    const total = Number(data?.result_info?.total_count ?? data?.result_info?.count);
    if (rows.length < perPage || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

/**
 * The live Workers AI catalog (chat + embedding models), cached for an hour.
 * @returns { models, source: "cloudflare" | "fallback", error?, fetchedAt }
 */
async function listModels({ refresh = false } = {}) {
  const cfg = getConfig();
  if (!cfg.configured) {
    return { models: FALLBACK_MODELS, source: "fallback", error: "Add the Cloudflare account ID and API token to load the live model list.", fetchedAt: null };
  }
  const hit = catalogCache.get(cfg.accountId);
  if (!refresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) {
    return { models: hit.models, source: "cloudflare", fetchedAt: new Date(hit.at).toISOString() };
  }
  try {
    const [chatModels, embedModels] = await Promise.all([searchModels(cfg, "Text Generation"), searchModels(cfg, "Text Embeddings")]);
    const models = [...chatModels, ...embedModels].sort((a, b) => a.task.localeCompare(b.task) || a.id.localeCompare(b.id));
    if (!models.length) throw new WorkersAiError("Cloudflare returned an empty model list", null, "Cloudflare returned an empty model list.");
    const at = Date.now();
    catalogCache.set(cfg.accountId, { at, models });
    return { models, source: "cloudflare", fetchedAt: new Date(at).toISOString() };
  } catch (err) {
    console.warn("[workersAi] model catalog unavailable:", err.friendly || safeError(err).message);
    return { models: FALLBACK_MODELS, source: "fallback", error: err.friendly || "Couldn't load the model list from Cloudflare.", fetchedAt: null };
  }
}

module.exports = {
  getConfig,
  isConfigured,
  chat,
  embed,
  chatModel,
  embedModel,
  listModels,
  stripThinking,
  parseArguments,
  friendlyError,
  modelView,
  WorkersAiError,
  EMBED_DIMS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
  FALLBACK_MODELS,
};
