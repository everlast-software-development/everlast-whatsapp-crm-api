// Reads a store product page for what a WhatsApp card needs: its picture,
// title and description — so the AI's product links show as photo cards
// without the store sending each picture itself.
//
// Only the store's own pages are read (the hosts of the store address and the
// store API address in Templates → Website): the links come from an AI's
// answer, so any other address is ignored.
//
// WhatsApp takes only JPG or PNG on a card; the store's photos are WebP. A
// photo that isn't JPG/PNG is turned into a JPG and kept in the app's file
// storage, and the result is remembered for a day, so each product's photo is
// converted once.

const axios = require("axios");
const { getSetting } = require("./appSettings");

const PAGE_TIMEOUT_MS = 6000;
const IMAGE_TIMEOUT_MS = 8000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 24 * 60 * 60 * 1000;
const JPG_PNG_RE = /^https:\/\/\S+\.(jpe?g|png)(\?\S*)?$/i;

const cache = new Map(); // page url → { at, value: Promise<{ title, description, image }> }

const hostOf = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

// The store's own hosts (with and without "www.").
function storeHosts() {
  const s = getSetting("storeWebhook") || {};
  const hosts = new Set();
  for (const base of [s.linkBase, s.apiBase]) {
    const h = hostOf(base);
    if (h) {
      hosts.add(h);
      hosts.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`);
    }
  }
  return hosts;
}

const isStorePage = (u) => {
  const h = hostOf(u);
  return !!h && storeHosts().has(h);
};

const decode = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] ?? m[3]) : null;
};

function metaContent(html, keys) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    if (keys.includes(key)) {
      const v = attr(tag, "content");
      if (v) return v;
    }
  }
  return null;
}

function jsonLdImage(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack = [JSON.parse(m[1])];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) { stack.push(...node); continue; }
        if (/product/i.test(String(node["@type"] || "")) && node.image) {
          const img = Array.isArray(node.image) ? node.image[0] : node.image;
          return typeof img === "string" ? img : img?.url || null;
        }
        if (node["@graph"]) stack.push(node["@graph"]);
      }
    } catch {}
  }
  return null;
}

// The page's own picture of the product: og:image, else the product's
// structured data, else the first <img> named after the product (the store's
// main photo carries the product name as its alt text).
function pickImage(html, title) {
  const named = (html.match(/<img\b[^>]*>/gi) || []).find((tag) => {
    const alt = attr(tag, "alt");
    return title && alt && alt.toLowerCase() === title.toLowerCase();
  });
  return (
    metaContent(html, ["og:image", "og:image:secure_url", "twitter:image"]) ||
    jsonLdImage(html) ||
    (named && (attr(named, "src") || attr(named, "data-src"))) ||
    null
  );
}

/** What a page says about itself: { title, description, image } (any may be null). */
function parsePage(html, pageUrl) {
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ||
    decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) ||
    null;
  const description = metaContent(html, ["og:description", "twitter:description", "description"]);
  let image = pickImage(html, title);
  if (image) {
    try {
      image = new URL(image, pageUrl).href;
    } catch {
      image = null;
    }
  }
  return { title, description, image: image && /^https:\/\//i.test(image) ? image : null };
}

// A JPG/PNG at a public https address for `imageUrl`: as is when it already
// is one, else downloaded, turned into a JPG and stored.
async function asCardImage(imageUrl) {
  if (JPG_PNG_RE.test(imageUrl)) return imageUrl;
  const res = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: IMAGE_TIMEOUT_MS,
    maxContentLength: MAX_IMAGE_BYTES,
    maxRedirects: 3,
    headers: { "User-Agent": "EverlastCRM-LinkPreview/1.0" },
  });
  const type = String(res.headers["content-type"] || "");
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "no type"})`);
  const sharp = require("sharp");
  const buffer = await sharp(Buffer.from(res.data))
    .flatten({ background: "#ffffff" }) // a transparent PNG/WebP turns white, not black
    .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const { uploadBuffer } = require("./storage");
  const stored = await uploadBuffer({ buffer, mimetype: "image/jpeg", folder: "ai-cards" });
  return stored.url;
}

async function load(pageUrl) {
  const res = await axios.get(pageUrl, {
    responseType: "text",
    timeout: PAGE_TIMEOUT_MS,
    maxContentLength: MAX_PAGE_BYTES,
    maxRedirects: 3,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EverlastCRM-LinkPreview/1.0)", Accept: "text/html" },
  });
  const meta = parsePage(String(res.data || ""), pageUrl);
  let image = null;
  if (meta.image) {
    try {
      image = await asCardImage(meta.image);
    } catch (err) {
      console.warn(`[LinkPreview] no card picture for ${pageUrl}: ${err.message}`);
    }
  }
  return { ...meta, image };
}

/**
 * The card details of a store page: { title, description, image } — image a
 * JPG/PNG ready for WhatsApp, or null. Never throws; null when the page isn't
 * the store's or can't be read.
 */
async function previewOf(pageUrl) {
  if (!isStorePage(pageUrl)) return null;
  const hit = cache.get(pageUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load(pageUrl).catch((err) => {
    console.warn(`[LinkPreview] couldn't read ${pageUrl}: ${err.message}`);
    cache.delete(pageUrl); // try again next time
    return null;
  });
  cache.set(pageUrl, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

/** A store-sent picture that isn't JPG/PNG (e.g. its WebP), made usable. */
async function cardImageFromUrl(imageUrl) {
  const host = hostOf(imageUrl);
  // Never an internal address: a bare IP, localhost or a one-word name.
  if (!host || !host.includes(".") || /^[\d.]+$|^\[|localhost$|\.local$|\.internal$/i.test(host)) return null;
  const key = `img:${imageUrl}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = asCardImage(imageUrl).catch((err) => {
    console.warn(`[LinkPreview] couldn't use the picture ${imageUrl}: ${err.message}`);
    cache.delete(key);
    return null;
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { previewOf, cardImageFromUrl, parsePage, isStorePage };
