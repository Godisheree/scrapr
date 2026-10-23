/**
 * Name : Ddownr YouTube to MP3 Scraper (ytmp3 via ddownr.org, fallback mirror ddownr.net)
 * Owner : Godhumanv2
 * Base Web : https://ddownr.org (YouTube to MP3 converter tanpa registration)
 * Type : Downloader
 * Function : Scrape lengkap -> info judul + thumbnail YouTube, dan resolve URL
 *            download MP3 via halaman /button/ ddownr.org; kalau job diblokir
 *            (Turnstile token server-side), jatuh ke mirror ddownr.net
 *            (p.savenow.to API proof-of-work, tanpa cookie). Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const SITE_ORG = "https://ddownr.org";
const ORG_MP3_PAGE = "/button/";
const SITE_MIRROR_WEB = "https://ddownr.net";
const SITE_API = "https://p.savenow.to";
const API_KEY = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const POW_CHALLENGE = "/api/pow/challenge";
const POW_VERIFY = "/api/pow/verify";
const API_DOWNLOAD = "/api/v2/download";
const API_PROGRESS = "/api/progress";
const NOEMBED = "https://noembed.com/embed";
const YT_THUMB = "https://i.ytimg.com/vi/";
const FORMAT_MP3 = "mp3";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT = 40_000;
const MAX_BYTES = 300_000_000;
const POLL_STEPS = 40;
const POLL_MS = 2_000;

function req(url, { method = "GET", headers = {}, body, timeout = TIMEOUT, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const rq = lib.request(
      u,
      {
        method,
        timeout,
        headers: {
          "User-Agent": UA,
          "Accept": url.includes("/convert/") ? "application/json" : "text/html",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (rs) => {
        const chunks = [];
        rs.on("data", (c) => {
          chunks.push(c);
          if (Buffer.concat(chunks).length > maxBytes) rs.destroy(new Error(`respons melebihi ${maxBytes} byte`));
        });
        rs.on("end", () => resolve({ status: rs.statusCode, headers: rs.headers, body: Buffer.concat(chunks) }));
        rs.on("error", (e) => resolve({ status: 0, error: e.message, body: Buffer.alloc(0) }));
      }
    );
    rq.on("error", (e) => resolve({ status: 0, error: e.message, body: Buffer.alloc(0) }));
    rq.on("timeout", () => { rq.destroy(new Error(`timeout ${timeout}ms`)); });
    if (body) rq.write(body);
    rq.end();
  });
}

function reqJson(url, opts = {}) {
  return req(url, opts).then((r) => {
    let json = null;
    try { json = JSON.parse(r.body.toString("utf8")); } catch {}
    return { status: r.status, headers: r.headers, body: r.body.toString("utf8"), json, error: r.error };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function ytId(url) {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/|live\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

function thumb(id) {
  return id ? `${YT_THUMB}${id}/maxresdefault.jpg` : "";
}

async function metaTitle(url) {
  try {
    const r = await reqJson(`${NOEMBED}?url=${encodeURIComponent(url)}`);
    if (r.status === 200 && r.json && r.json.title) return r.json.title;
  } catch {}
  return "";
}

async function powToken() {
  const ch = await reqJson(`${SITE_API}${POW_CHALLENGE}`);
  if (!ch.json || !ch.json.salt) throw new Error(`pow challenge gagal (${ch.status || ch.error})`);
  const difficulty = Number(ch.json.difficulty) || 0;
  const pre = "0".repeat(difficulty);
  let nonce = 0;
  do { nonce += 1; } while (!sha256(`${ch.json.salt}:${nonce}`).startsWith(pre));
  const v = await reqJson(
    `${SITE_API}${POW_VERIFY}`,
    {
      method: "POST",
      body: JSON.stringify({ salt: ch.json.salt, difficulty, expires_at: ch.json.expires_at, signature: ch.json.signature, nonce }),
      headers: { "Content-Type": "application/json" },
    }
  );
  if (!v.json || !v.json.success || !v.json.token) throw new Error(`pow verify gagal (${v.json?.message || v.status || v.error})`);
  return v.json.token;
}

function apiErrorText(j, status, raw) {
  if (j && j.message) return j.message;
  if (j && j.errors && Object.values(j.errors).some(Boolean)) {
    const flat = Object.values(j.errors).flat().join(", ");
    return flat;
  }
  return `api savenow status ${status}${raw ? `: ${raw.slice(0, 120)}` : ""}`;
}

async function mirrorFlow(url, format, label) {
  const token = await powToken();
  const dl = await reqJson(
    `${SITE_API}${API_DOWNLOAD}?apikey=${API_KEY}&url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}`,
    { headers: { Authorization: "Bearer " + token } }
  );
  if (!dl.json || dl.json.success !== true || !dl.json.id) throw new Error(`mirror ${label}: ${apiErrorText(dl.json, dl.status, dl.body)}`);
  const id = dl.json.id;
  let last = null;
  for (let i = 0; i < POLL_STEPS; i++) {
    await sleep(POLL_MS);
    const p = await reqJson(`${SITE_API}${API_PROGRESS}?id=${encodeURIComponent(id)}`, { headers: { Authorization: "Bearer " + token } });
    if (!p.json) continue;
    last = p.json;
    if (p.json.download_url) {
      return { id, download_url: p.json.download_url, title: p.json.info?.title || dl.json.title || "", thumbnail: p.json.thumbnail_url || p.json.info?.image || dl.json.thumbnail_url || "" };
    }
    if (p.json.error) throw new Error(`mirror ${label}: ${p.json.error}`);
  }
  throw new Error(`mirror ${label}: ${last?.text || last?.message || "progress timeout"}`);
}

function stripTurnstileBody(body) {
  const t1 = (body.match(/'token_id':\s*'([^']+)'/) || [])[1];
  const t2 = (body.match(/'token_validto':\s*'([^']+)'/) || [])[1];
  return { t1, t2 };
}

async function orgFlow(url) {
  const enc = encodeURIComponent(url);
  const page = await req(`${SITE_ORG}${ORG_MP3_PAGE}?url=${enc}`, { headers: { Origin: SITE_ORG, Referer: `${SITE_ORG}/` } });
  if (page.status !== 200) throw new Error(`ddownr.org halaman (${page.status || page.error})`);
  const html = page.body.toString("utf8");
  if (/turn?tstile/i.test(html)) {
    throw new Error("turnstile: halaman ada tapi token tidak bisa diruntung tanpa browser");
  }
  const { t1, t2 } = stripTurnstileBody(html);
  if (!t1) throw new Error("ddownr.org: token_id tidak ditemukan di halaman (struktur berubah)");
  const conv = await reqJson(`${SITE_ORG}/convert/`, {
    method: "POST",
    body: `url=${enc}&convert=gogogo&token_id=${t1}&token_validto=${t2 || ""}`,
    headers: { Origin: SITE_ORG, Referer: `${SITE_ORG}/` },
  });
  if (!conv.json || !conv.json.jobid) throw new Error(`ddownr.org convert: ${apiErrorText(conv.json, conv.status, conv.body)}`);
  const jobid = conv.json.jobid;
  const mcookie = ((conv.headers["set-cookie"] || []).join(";")).match(/PHPSESSID=([^;]+)/);
  const cookie = mcookie ? { Cookie: `PHPSESSID=${mcookie[1]}` } : {};
  let last = null;
  for (let i = 0; i < 20; i++) {
    await sleep(2_500);
    const p = await reqJson(`${SITE_ORG}/convert/?jobid=${encodeURIComponent(jobid)}&time=${Date.now()}`, { headers: { ...cookie, Origin: SITE_ORG, Referer: `${SITE_ORG}/` } });
    if (!p.json) continue;
    last = p.json;
    if (p.json.ready || p.json.dlurl) return { id: jobid, download_url: p.json.dlurl || p.json.url || "", title: "", thumbnail: "" };
    if (p.json.error) throw new Error(`ddownr.org poll: ${p.json.error}`);
  }
  throw new Error(`ddownr.org poll: ${last?.message || "timeout"}`);
}

export async function resolve(url, opts = {}) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("url http/https diperlukan");
  let title = "";
  let raw = null;
  let via = "";
  const errors = [];
  try {
    raw = await orgFlow(url);
    via = "ddownr.org";
  } catch (e) {
    errors.push(`org: ${e.message || e}`);
    raw = null;
  }
  if (!raw || !raw.download_url) {
    try {
      raw = await mirrorFlow(url, FORMAT_MP3, "mp3");
      via = "ddownr.net mirror (proof-of-work)";
    } catch (e) {
      errors.push(`mirror: ${e.message || e}`);
    }
  }
  if (!raw || !raw.download_url) throw new Error(errors.join(" | ") || "tidak ada download_url");
  if (!raw.title) raw.title = await metaTitle(url);
  const id = ytId(url);
  return {
    via,
    raw,
    result: {
      title: raw.title || "",
      author: "",
      thumbnail: raw.thumbnail || thumb(id),
      url,
      type: "audio",
      quality: FORMAT_MP3,
      downloadUrl: raw.download_url,
      duration: "",
    },
  };
}

function usage() {
  return [
    "usage: node ddownrmp3.js <command> <url>",
    "",
    "commands:",
    "  info <url>      info judul + thumbnail",
    "  download <url>  resolve URL download MP3",
    "",
    "options:",
    "  --help          tampilkan bantuan ini (exit 0)",
    "",
    "contoh:",
    '  node ddownrmp3.js info "https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
    '  node ddownrmp3.js download "https://www.youtube.com/watch?v=aqz-KE-bpKQ"',
    "",
    "catatan:",
    "  - via utama = halaman mp3 ddownr.org; kalau diblok (turnstile/job expired)",
    "    otomatis ke mirror ddownr.net (API proof-of-work, tanpa cookie).",
    "  - downloadUrl TTL pendek, jangan di-cache; ambil ulang sebelum download.",
  ].join("\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const vals = {};
  const pos = [];
  for (const a of args) {
    if (a.startsWith("--")) vals[a.slice(2)] = true;
    else pos.push(a);
  }
  return { vals, pos };
}

async function main() {
  const { vals, pos } = parseArgs();
  if (vals.help || vals.h) {
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }
  if (pos.length < 2) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
    return;
  }
  const [cmd, url] = pos;
  const r = await resolve(url);
  if (cmd === "info") {
    process.stdout.write(JSON.stringify({ result: { title: r.result.title, thumbnail: r.result.thumbnail, author: r.result.author, url, type: r.result.type, quality: r.result.quality }, via: r.via }, null, 2) + "\n");
  } else if (cmd === "download") {
    process.stdout.write(JSON.stringify({ result: { ...r.result, downloadUrl: r.raw?.download_url }, via: r.via }, null, 2) + "\n");
  } else {
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
  }
}

function pickSocket(m, ctx) {
  return ctx?.sock || ctx?.conn || ctx?.socket || m?.sock || null;
}

async function reply(m, ctx, text) {
  if (m?.reply) return m.reply(text);
  const sock = pickSocket(m, ctx);
  if (sock?.sendMessage) return sock.sendMessage(m.chat, { text }, { quoted: m });
}

async function react(m, ctx, emoji) {
  if (m?.react) return m.react(emoji);
  const sock = pickSocket(m, ctx);
  if (sock?.sendMessage) return sock.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
}

function pickUrl(m, ctx) {
  const sources = [
    ctx?.text,
    m?.text,
    m?.body,
    Array.isArray(m?.args) ? m.args.join(" ") : m?.args,
    Array.isArray(ctx?.args) ? ctx.args.join(" ") : ctx?.args,
    m?.quoted?.body,
    m?.quoted?.text,
    m?.quoted?.message?.conversation,
  ];
  for (const s of sources) {
    if (typeof s !== "string") continue;
    const hit = s.match(/https?:\/\/\S+/i);
    if (hit) return hit[0];
  }
  return "";
}

async function handler(m, ctx = {}) {
  const url = pickUrl(m, ctx);
  if (!url) {
    await reply(m, ctx, "usage: .ddownrmp3 <link youtube>");
    return;
  }
  await react(m, ctx, "⏳");
  try {
    const r = await resolve(url);
    await reply(
      m,
      ctx,
      `*Ddownr MP3*\nJudul: ${r.result.title || "-"}\nVia: ${r.via}\n\n${r.raw?.download_url || r.result.downloadUrl || ""}`
    );
  } catch (e) {
    await reply(m, ctx, `Error: ${e.message || e}`);
  } finally {
    await react(m, ctx, "✅");
  }
}

const config = {
  name: "ddownrmp3",
  alias: ["ytmp3", "dmp3"],
  category: ["downloader"],
  description: "YouTube ke MP3 via ddownr.org, fallback mirror ddownr.net (proof-of-work)",
  usage: "<link-youtube>",
  example: ".ddownrmp3 https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 15,
  limit: 1,
  energi: 1,
  isEnabled: true,
};

handler.command = /^(ddownrmp3|dmp3|ytmp3)$/i;
handler.tags = ["downloader"];
handler.help = ["ddownrmp3 <link-youtube>"];
handler.limit = 1;
handler.premium = false;
handler.owner = false;
handler.config = config;

export { config, handler };
export default handler;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message || e}\n`);
    process.exitCode = 1;
  });
}
