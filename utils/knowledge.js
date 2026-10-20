// The knowledge base the AI assistant answers from.
//
// Staff write an article per treatment or topic in fixed sections (overview,
// before, after, downtime…). Only APPROVED articles are ever searchable: on
// approval (or an edit to an approved article) the article is cut into one
// chunk per section, each chunk is embedded with bge-m3 (utils/workersAi.js),
// and the chunks go into KnowledgeChunk with their vectors. Moving an article
// back to draft, archiving or deleting it removes its chunks.
//
// The embedding column is a pgvector type Prisma can't read or write, so every
// statement touching it is raw SQL, with the vector passed as text
// ('[0.1,0.2,…]') and cast with ::vector.

const prisma = require("../config/prisma");
const workersAi = require("./workersAi");

// In the order the editor shows them and the chunks are written.
const SECTIONS = [
  { key: "summary", label: "Overview" },
  { key: "before", label: "Before the treatment" },
  { key: "after", label: "After the treatment (aftercare)" },
  { key: "downtime", label: "Downtime / recovery" },
  { key: "notSuitableFor", label: "Not suitable for" },
  { key: "faq", label: "FAQ" },
  { key: "other", label: "Other information" },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);

// A section longer than this is split on paragraph boundaries, so one chunk
// stays about one idea and its embedding stays meaningful.
const MAX_CHUNK_CHARS = 1500;

// Cosine similarity a chunk needs to count as relevant — the default for the
// "Similarity threshold" in Settings → AI model & Cloudflare. bge-m3 puts
// unrelated text around 0.3–0.4 and a real match well above 0.5; lower it if
// good questions find nothing, raise it if unrelated sources show up in the
// "Test the assistant" panel.
const DEFAULT_MIN_SCORE = 0.45;

// Words that say nothing about WHICH treatment a question is about — left out
// of the title keyword match so "what is the price of the treatment" doesn't
// pull in every article with "Treatment" in its title.
const STOPWORDS = new Set([
  "what", "when", "where", "which", "while", "with", "have", "does", "much", "many", "price", "prices",
  "cost", "costs", "after", "before", "about", "your", "this", "that", "there", "their", "they", "from",
  "treatment", "treatments", "please", "hello", "thanks", "thank", "clinic", "would", "could", "should",
  "will", "need", "want", "know", "like", "also", "some", "session", "sessions", "long", "take", "make",
  "كيف", "ماذا", "متى", "عندكم", "السلام", "عليكم", "شكرا", "شكراً", "ممكن", "اريد", "أريد", "ابغى", "أبغى",
  "بكم", "سعر", "السعر", "الاسعار", "الأسعار", "العلاج", "علاج", "جلسة", "الجلسة", "جلسات", "بعد", "قبل",
  "هل", "لو", "سمحت", "مرحبا", "اهلا", "أهلا", "العيادة", "عيادة", "الله", "انا", "أنا", "عندي",
]);

// ── Chunking (pure) ─────────────────────────────────────────────────────────

/** Splits text longer than `max` on paragraph (then sentence) boundaries. */
function splitLong(text, max = MAX_CHUNK_CHARS) {
  const clean = String(text || "").trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const pieces = [];
  let current = "";
  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (const para of clean.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > max) {
      // One huge paragraph: by sentence, and as a last resort a hard cut.
      flush();
      for (const sentence of p.split(/(?<=[.!?؟。])\s+/)) {
        if (sentence.length > max) {
          flush();
          for (let i = 0; i < sentence.length; i += max) pieces.push(sentence.slice(i, i + max).trim());
          continue;
        }
        if (current && current.length + sentence.length + 1 > max) flush();
        current = current ? `${current} ${sentence}` : sentence;
      }
      flush();
      continue;
    }
    if (current && current.length + p.length + 2 > max) flush();
    current = current ? `${current}\n\n${p}` : p;
  }
  flush();
  return pieces;
}

/**
 * The chunks an article is searched by: one per non-empty section (more when
 * a section is long), each carrying the article's title, category and section
 * label so it makes sense on its own.
 * @returns [{ section, content }]
 */
function chunkArticle(article) {
  const sections = article?.sections && typeof article.sections === "object" ? article.sections : {};
  const title = String(article?.title || "").trim();
  const category = String(article?.category || "").trim() || "General";
  const chunks = [];
  for (const { key, label } of SECTIONS) {
    const parts = splitLong(sections[key]);
    parts.forEach((text, i) => {
      const section = parts.length > 1 ? `${label} (part ${i + 1})` : label;
      chunks.push({
        section,
        content: `Treatment/topic: ${title}\nCategory: ${category}\nSection: ${section}\n\n${text}`,
      });
    });
  }
  return chunks;
}

/** Keeps only the known section keys, as trimmed strings. */
function normaliseSections(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : {};
  for (const key of SECTION_KEYS) {
    const v = src[key];
    out[key] = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "";
  }
  return out;
}

const hasContent = (sections) => SECTION_KEYS.some((k) => String(sections?.[k] || "").trim());

const toVector = (v) => `[${v.map((x) => Number(x)).join(",")}]`;

// Words worth matching against titles: 4+ letters (any script), no stopwords.
function keywordsOf(query) {
  const words = String(query || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)))].slice(0, 8);
}

// ── Indexing ────────────────────────────────────────────────────────────────

// One reindex per article at a time: two overlapping ones (approve, then a
// quick edit) would otherwise both delete and both insert.
const reindexQueues = new Map();
function serializeArticle(id, fn) {
  const prev = reindexQueues.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  reindexQueues.set(id, tail);
  tail.then(() => { if (reindexQueues.get(id) === tail) reindexQueues.delete(id); });
  return next;
}

/**
 * Bring an article's chunks in line with its status. APPROVED → re-chunked and
 * re-embedded; anything else → no chunks. The vectors are computed BEFORE the
 * old chunks are removed, so a failed embedding leaves the article as it was
 * (and still says when it was last embedded).
 *
 * @returns { indexed: boolean, chunks?: number, reason?: "missing" |
 *   "not_approved" | "not_configured" | "error", error?: string }
 */
function reindexArticle(id) {
  return serializeArticle(id, async () => {
    const article = await prisma.knowledgeArticle.findUnique({ where: { id } });
    if (!article) return { indexed: false, reason: "missing" };

    if (article.status !== "APPROVED") {
      await prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({ where: { articleId: id } }),
        prisma.knowledgeArticle.update({ where: { id }, data: { embeddedAt: null } }),
      ]);
      return { indexed: false, reason: "not_approved" };
    }

    if (!workersAi.isConfigured()) {
      // Nothing searchable can exist without embeddings — clear any stale ones.
      await prisma.$transaction([
        prisma.knowledgeChunk.deleteMany({ where: { articleId: id } }),
        prisma.knowledgeArticle.update({ where: { id }, data: { embeddedAt: null } }),
      ]);
      return { indexed: false, reason: "not_configured" };
    }

    const chunks = chunkArticle(article);
    let vectors;
    try {
      vectors = chunks.length ? await workersAi.embed(chunks.map((c) => c.content)) : [];
    } catch (err) {
      console.error(`[knowledge] embedding article ${id} failed:`, err.message);
      return { indexed: false, reason: "error", error: err.message };
    }

    await prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({ where: { articleId: id } }),
      ...chunks.map(
        (c, i) => prisma.$executeRaw`
          INSERT INTO "KnowledgeChunk" ("articleId", "section", "content", "embedding")
          VALUES (${id}, ${c.section}, ${c.content}, ${toVector(vectors[i])}::vector)`,
      ),
      prisma.knowledgeArticle.update({ where: { id }, data: { embeddedAt: new Date() } }),
    ]);
    return { indexed: true, chunks: chunks.length };
  });
}

// Progress of the current (or last) full re-index, for the Settings page.
const reindexState = {
  running: false,
  trigger: null,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  indexed: 0,
  skipped: 0,
  failed: 0,
  errors: [],
  error: null,
};
let reindexRun = null;
let rerunRequested = false;

const reindexStatus = () => ({ ...reindexState, errors: [...reindexState.errors] });

async function runReindexAll(trigger) {
  Object.assign(reindexState, {
    running: true,
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    done: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    error: null,
  });
  try {
    const rows = await prisma.knowledgeArticle.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    reindexState.total = rows.length;
    for (const { id } of rows) {
      const r = await reindexArticle(id);
      if (r.indexed) reindexState.indexed++;
      else if (r.reason === "error") {
        reindexState.failed++;
        if (reindexState.errors.length < 20) reindexState.errors.push({ id, error: r.error });
      } else reindexState.skipped++;
      reindexState.done++;
    }
  } catch (err) {
    reindexState.error = String(err.message || err).slice(0, 300);
    console.error("[knowledge] re-index failed:", reindexState.error);
  } finally {
    reindexState.running = false;
    reindexState.finishedAt = new Date().toISOString();
  }
  const { total, indexed, skipped, failed, errors, error } = reindexState;
  return { total, indexed, skipped, failed, errors: [...errors], error };
}

/**
 * Re-index every article (after configuring Workers AI, or changing models).
 * One run at a time: while one runs, another request either waits for it
 * (`whenRunning: "join"`) or queues one more run after it (`"rerun"` — used
 * after the embedding model changes mid-run, so nothing keeps old vectors).
 * @returns the run's promise of { total, indexed, skipped, failed, errors, error }
 */
function startReindexAll({ trigger = "manual", whenRunning = "join" } = {}) {
  if (reindexRun) {
    if (whenRunning === "rerun") rerunRequested = true;
    return reindexRun;
  }
  reindexRun = (async () => {
    let result;
    do {
      rerunRequested = false;
      result = await runReindexAll(trigger);
    } while (rerunRequested);
    return result;
  })().finally(() => {
    reindexRun = null;
  });
  return reindexRun;
}

const reindexAll = () => startReindexAll({ trigger: "manual" });

/**
 * After the embedding model changes, every stored vector is from the old
 * model and means nothing to the new one: remove them all and mark every
 * article as needing re-indexing. Until the re-index finishes the assistant
 * finds nothing and hands questions to the team — the safe failure.
 */
async function clearAllEmbeddings() {
  const [chunks, articles] = await prisma.$transaction([
    prisma.knowledgeChunk.deleteMany({}),
    prisma.knowledgeArticle.updateMany({ where: { embeddedAt: { not: null } }, data: { embeddedAt: null } }),
  ]);
  return { chunks: chunks.count, articles: articles.count };
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Hybrid search over APPROVED articles: the nearest chunks by meaning
 * (cosine similarity ≥ minScore), plus every chunk of up to two articles whose
 * TITLE contains a word of the question — so "Profhilo aftercare?" always
 * finds the Profhilo article even when the wording is far from its text.
 *
 * @returns [{ chunkId, articleId, title, section, content, score, keyword? }]
 *   best first.
 */
async function searchKnowledge(query, { k, minScore, cfg } = {}) {
  const text = String(query || "").trim().slice(0, 2000);
  if (!text) return [];
  // Results per question and the threshold come from Settings → AI model.
  const c = cfg || workersAi.getConfig();
  k = k ?? c.retrievalTopK ?? 6;
  minScore = minScore ?? c.similarityThreshold ?? DEFAULT_MIN_SCORE;
  const [vector] = await workersAi.embed([text], { cfg: c });
  const vec = toVector(vector);

  const nearest = await prisma.$queryRaw`
    SELECT c."id" AS "chunkId", c."articleId", a."title", c."section", c."content",
           1 - (c."embedding" <=> ${vec}::vector) AS "score"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeArticle" a ON a."id" = c."articleId"
    WHERE a."status" = 'APPROVED' AND c."embedding" IS NOT NULL
    ORDER BY c."embedding" <=> ${vec}::vector
    LIMIT ${k * 3}`;

  const byId = new Map();
  for (const row of nearest) {
    const score = Number(row.score);
    if (score >= minScore && byId.size < k) byId.set(row.chunkId, { ...row, score });
  }

  const words = keywordsOf(text);
  if (words.length) {
    const patterns = words.map((w) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const keywordRows = await prisma.$queryRaw`
      SELECT c."id" AS "chunkId", c."articleId", a."title", c."section", c."content",
             1 - (c."embedding" <=> ${vec}::vector) AS "score"
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeArticle" a ON a."id" = c."articleId"
      WHERE a."status" = 'APPROVED' AND c."embedding" IS NOT NULL
        AND a."id" IN (
          SELECT "id" FROM "KnowledgeArticle"
          WHERE "status" = 'APPROVED' AND "title" ILIKE ANY(${patterns}::text[])
          ORDER BY "updatedAt" DESC
          LIMIT 2
        )`;
    for (const row of keywordRows) {
      if (!byId.has(row.chunkId)) byId.set(row.chunkId, { ...row, score: Number(row.score), keyword: true });
    }
  }

  return [...byId.values()]
    .map((r) => ({
      chunkId: Number(r.chunkId),
      articleId: Number(r.articleId),
      title: r.title,
      section: r.section,
      content: r.content,
      score: Math.round(r.score * 1000) / 1000,
      ...(r.keyword ? { keyword: true } : {}),
    }))
    .sort((a, b) => b.score - a.score);
}

/** What the knowledge base covers — always shown to the model. */
async function listApprovedTitles() {
  return prisma.knowledgeArticle.findMany({
    where: { status: "APPROVED" },
    select: { title: true, category: true },
    orderBy: [{ category: "asc" }, { title: "asc" }],
  });
}

/** For Settings → AI assistant: approved and searchable article counts. */
async function knowledgeCounts() {
  try {
    const [approved, indexed] = await Promise.all([
      prisma.knowledgeArticle.count({ where: { status: "APPROVED" } }),
      prisma.knowledgeArticle.count({ where: { status: "APPROVED", embeddedAt: { not: null } } }),
    ]);
    return { approved, indexed };
  } catch (err) {
    // E.g. the Prisma client predates the knowledge tables.
    console.error("[knowledge] counts failed:", err.message);
    return { approved: null, indexed: null };
  }
}

module.exports = {
  SECTIONS,
  SECTION_KEYS,
  MAX_CHUNK_CHARS,
  DEFAULT_MIN_SCORE,
  splitLong,
  chunkArticle,
  normaliseSections,
  hasContent,
  keywordsOf,
  reindexArticle,
  reindexAll,
  startReindexAll,
  reindexStatus,
  clearAllEmbeddings,
  searchKnowledge,
  listApprovedTitles,
  knowledgeCounts,
};
