// Settings → AI assistant → AI model & Cloudflare: the `aiProvider` setting.
//
// The API token goes in, never out: every response uses publicView(), which
// says whether a token exists, its last four characters and where it comes
// from — never the token or its ciphertext.

const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const safeError = require("../../utils/safeError");
const { emitGlobal } = require("../../utils/socket");
const { getSavedSetting, saveSetting } = require("../../utils/appSettings");
const aiProviderSetting = require("../../utils/aiProviderSetting");
const secretBox = require("../../utils/secretBox");
const workersAi = require("../../utils/workersAi");
const knowledge = require("../../utils/knowledge");

/** The client's view of what is saved and what is in force. */
function aiProviderView() {
  return aiProviderSetting.publicView(getSavedSetting("aiProvider"), workersAi.getConfig());
}

// For the audit log: what changed, without the token's last digits or the
// static bits (defaults, limits).
function auditView(view) {
  const { tokenLast4, defaults, limits, encryptionAvailable, ...rest } = view; // eslint-disable-line no-unused-vars
  return rest;
}

const failureText = (err) => err?.friendly || (err instanceof AppError ? err.message : safeError(err)?.message) || "Unexpected error";

// ─── PUT /api/settings/aiProvider ───────────────────────────────────────────
// Body: the fields of the setting, plus `apiToken` (replace; empty = keep the
// saved one) or `removeToken: true`. A new embedding model is checked first —
// its vectors must fit the database — and then the knowledge base is
// re-indexed in the background with it.
const saveAiProvider = async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const before = aiProviderView();
    const current = workersAi.getConfig();

    // Validate (and see what would be in force) before anything is stored.
    const candidateStored = aiProviderSetting.normalise(body, getSavedSetting("aiProvider"));
    const candidate = aiProviderSetting.resolveFrom(candidateStored, process.env, secretBox.decrypt);

    const embedChanged = candidate.embedModel !== current.embedModel;
    if (embedChanged) {
      if (!candidate.configured) {
        return next(new AppError("Add a working Cloudflare account ID and API token before changing the embedding model — the new model has to be checked first.", 400));
      }
      let dims;
      try {
        const [vector] = await workersAi.embed(["dimension check"], { cfg: candidate, checkDims: false, retry: false });
        dims = vector.length;
      } catch (err) {
        return next(new AppError(`Couldn't check the embedding model "${candidate.embedModel}": ${failureText(err)}`, 400));
      }
      if (dims !== workersAi.EMBED_DIMS) {
        return next(new AppError(`This model's vectors are ${dims}-dimensional; the database expects ${workersAi.EMBED_DIMS}. Choose a ${workersAi.EMBED_DIMS}-dimension model such as ${workersAi.DEFAULT_EMBED_MODEL}.`, 400));
      }
    }

    await saveSetting("aiProvider", body, req.user);

    let reindexing = false;
    let cleared = null;
    if (embedChanged) {
      // Old vectors mean nothing to the new model: drop them, then rebuild.
      cleared = await knowledge.clearAllEmbeddings();
      knowledge
        .startReindexAll({ trigger: "embed_model_changed", whenRunning: "rerun" })
        .then((r) => {
          logAudit({ action: "knowledge.reindexed", actor: req.user, targetType: "KnowledgeArticle", targetId: 0, details: { ...r, trigger: "embed_model_changed" } });
        })
        .catch((err) => console.error("[settings] background re-index failed:", safeError(err).message));
      reindexing = true;
    }

    const after = aiProviderView();
    const tokenChange = String(body.apiToken ?? "").trim() ? "replaced" : body.removeToken === true ? "removed" : null;
    logAudit({
      action: "SETTINGS_UPDATED",
      actor: req.user,
      targetType: "Setting",
      targetId: 0,
      details: {
        key: "aiProvider",
        before: auditView(before),
        after: auditView(after),
        ...(tokenChange ? { token: tokenChange } : {}),
        ...(embedChanged ? { embedModelChanged: { from: current.embedModel, to: candidate.embedModel }, cleared } : {}),
      },
    });
    emitGlobal("settings.changed", { key: "aiProvider" });
    res.status(200).json({ success: true, data: after, reindexing, ...(cleared ? { cleared } : {}) });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/settings/ai/test ─────────────────────────────────────────────
// "Test connection": one embedding and one tiny chat, with the values on the
// form (saved or not) — blank fields use what is in force. Nothing is saved.
const TEST_LIMIT = 10;
const TEST_WINDOW_MS = 60 * 1000;
const testLog = new Map();

const testAiConnection = async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const current = workersAi.getConfig();

    const accountId = aiProviderSetting.validateAccountId(body.accountId) || current.accountId;
    const token = aiProviderSetting.validateToken(body.apiToken) || current.token;
    const chatModel = aiProviderSetting.validateModelId(body.chatModel, "The chat model") || current.chatModel;
    const embedModel = aiProviderSetting.validateModelId(body.embedModel, "The embedding model") || current.embedModel;
    let requestTimeoutMs = current.requestTimeoutMs;
    if (body.requestTimeoutSeconds !== undefined && body.requestTimeoutSeconds !== "") {
      const s = Number(body.requestTimeoutSeconds);
      const { min, max } = aiProviderSetting.BEHAVIOUR.requestTimeoutSeconds;
      if (!Number.isInteger(s) || s < min || s > max) return next(new AppError(`Request timeout must be a whole number between ${min} and ${max}`, 400));
      requestTimeoutMs = s * 1000;
    }
    if (!accountId || !token) {
      return next(new AppError("Enter the Cloudflare account ID and API token first (or set them in config.env)", 400, "AI_NOT_CONFIGURED"));
    }

    const now = Date.now();
    const recent = (testLog.get(req.user.id) || []).filter((t) => now - t < TEST_WINDOW_MS);
    if (recent.length >= TEST_LIMIT) return next(new AppError("Too many tests — wait a minute and try again", 429));
    testLog.set(req.user.id, [...recent, now]);

    const cfg = { ...current, accountId, token, chatModel, embedModel, requestTimeoutMs, configured: true };

    const runChat = async () => {
      const started = Date.now();
      try {
        const r = await workersAi.chat({
          messages: [{ role: "user", content: "Reply with OK" }],
          maxTokens: 512,
          temperature: 0,
          topP: null,
          cfg,
          retry: false,
        });
        const sample = r.content.slice(0, 200);
        return {
          ok: true,
          model: chatModel,
          latencyMs: Date.now() - started,
          sample,
          finishReason: r.finishReason,
          ...(sample ? {} : { note: `The model answered with no text${r.finishReason ? ` (finish reason: ${r.finishReason})` : ""} — it may need a higher "Max reply tokens".` }),
        };
      } catch (err) {
        return { ok: false, model: chatModel, latencyMs: Date.now() - started, sample: null, error: failureText(err) };
      }
    };
    const runEmbed = async () => {
      const started = Date.now();
      try {
        const [vector] = await workersAi.embed(["test"], { cfg, checkDims: false, retry: false });
        const dims = vector.length;
        const ok = dims === workersAi.EMBED_DIMS;
        return {
          ok,
          model: embedModel,
          dims,
          latencyMs: Date.now() - started,
          ...(ok ? {} : { error: `This model's vectors are ${dims}-dimensional; the database expects ${workersAi.EMBED_DIMS}.` }),
        };
      } catch (err) {
        return { ok: false, model: embedModel, dims: null, latencyMs: Date.now() - started, error: failureText(err) };
      }
    };

    const [chat, embed] = await Promise.all([runChat(), runEmbed()]);
    res.status(200).json({ success: true, data: { ok: chat.ok && embed.ok, chat, embed } });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/settings/ai/models ────────────────────────────────────────────
// The live Workers AI catalog (cached an hour; ?refresh=1 to reload), or a
// small built-in list when Cloudflare can't be asked.
const listAiModels = async (req, res, next) => {
  try {
    const r = await workersAi.listModels({ refresh: req.query.refresh === "1" });
    res.status(200).json({ success: true, data: r.models, source: r.source, error: r.error || null, fetchedAt: r.fetchedAt });
  } catch (err) {
    next(err);
  }
};

module.exports = { aiProviderView, saveAiProvider, testAiConnection, listAiModels };
