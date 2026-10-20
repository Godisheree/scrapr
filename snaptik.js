/**
 * Name : SnapTik TikTok Scraper (info, download video)
 * Owner : Godhumanv2
 * Base Web : https://snaptik.app (TikTok downloader, tanpa watermark)
 * Type : Scraper
 * Function : Scrape lengkap -> info video (id, judul, author, username,
 *            thumbnail, durasi, stats) dan download MP4 -> direct download
 *            URL + headers yang dibutuhkan. Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpReq } from "node:http";
import { request as httpsReq } from "node:https";
import { createHash } from "node:crypto";
import { createDecipheriv } from "node:crypto";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = "https://snaptik.app";
const API_TOKEN = "/api/token";
const API_EXTRACT = "/api/extract";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT = 30_000;
const MAX_SIZE = 500_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function secret() {
  const l = [115, 110, 52, 112].map((c) => String.fromCharCode(c)).join("");
  const s = [...  "s0j^"].map((c) => String.fromCharCode(c.charCodeAt(0) + 1)).join("");
  const n = Buffer.from("djNyMQ==", "base64").toString("utf8");
  const g = "fy20";
  const d = [50, 54].map((c) => String.fromCharCode(c)).join("");
  return l + s + n + g + d;
}

function decryptPayload(id, p) {
  const raw = Buffer.from(p, "base64");
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const key = createHash("sha256").update(`${secret()}:${id}`).digest();
  const dec = createDecipheriv("aes-256-cbc", key, iv);
  const pt = Buffer.concat([dec.update(ct), dec.final()]);
  return pt.toString("utf8").replace(/\0+$/, "").trim();
}

function evalChallenge(ch) {
  switch (ch.t) {
    case "b":
      return (ch.a ^ ch.b) >> ch.s & 255;
    case "r":
      return ch.n.reduce((a, b) => a + b, 0) * 2 + 1;
    case "c":
      return ch.w.charCodeAt(ch.i) * ch.m;
    case "m":
      return ((ch.a + ch.b) % 100) * ch.c;
    case "n":
      return ch.a * ch.b + ch.b * ch.c + ch.c * ch.a - ch.a;
    default:
      throw new Error(`tipe challenge tidak dikenal: ${ch.t}`);
  }
}

async function fetchVerify() {
  const r = await reqJson(`${SITE}${API_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.json || !r.json.id || !r.json.p) {
    throw new Error(`token gagal (status ${r.status}): ${r.body.slice(0, 160)}`);
  }
  const data = JSON.parse(decryptPayload(r.json.id, r.json.p));
  const e = data._e;
  const h = data._h;
  delete data._e;
  delete data._h;
  return `${r.json.id}:${evalChallenge(data)}:${e}:${h}`;
}

function normalizeUrl(input) {
  const s = String(input).trim();
  if (!/^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//i.test(s) &&
      !/^https?:\/\/(www\.|v\.)?douyin\.com\//i.test(s)) {
    throw new Error(`link TikTok/Douyin tidak dikenali: ${s}`);
  }
  return s;
}

async function extract(url, tries = 3) {
  const clean = normalizeUrl(url);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const verify = await fetchVerify();
    const r = await reqJson(`${SITE}${API_EXTRACT}?url=${encodeURIComponent(clean)}`, {
      headers: { "X-Verify": verify },
    });
    if (r.json && r.json.success) return r.json.data || r.json;
    const msg = r.json?.error || r.body.slice(0, 160);
    lastErr = new Error(`extract gagal (status ${r.status}): ${msg}`);
    if (r.status === 403 || r.status === 429) {
      if (i < tries - 1) await sleep(800 * (i + 1));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

function pickVideoUrl(data) {
  if (data.downloadUrl) return { url: data.downloadUrl, label: "no-watermark" };
  return { url: "", label: "" };
}

function toOutput(data) {
  return {
    id: data.id,
    type: data.type,
    title: data.title,
    author: data.author?.name,
    username: data.author?.username,
    thumbnail: data.thumbnail,
    duration: data.videoDuration,
    stats: data.stats || {},
    downloadUrl: data.downloadUrl,
    hdDownloadUrl: data.hdDownloadUrl ? `${SITE}${data.hdDownloadUrl}` : "",
    headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" },
  };
}

async function downloadFile(url, dest) {
  const u = new URL(url);
  const lib = u.protocol === "http:" ? httpReq : httpsReq;
  await new Promise((resolve, reject) => {
    const rq = lib(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" },
      },
      (rs) => {
        const { statusCode = 0, headers: rh } = rs;
        if (statusCode >= 300 && statusCode < 400 && rh.location) {
          rs.resume();
          const next = new URL(rh.location, url).toString();
          return resolve(downloadFile(next, dest));
        }
        if (statusCode !== 200) {
          rs.resume();
          return reject(new Error(`download gagal (status ${statusCode})`));
        }
        const chunks = [];
        let n = 0;
        rs.on("data", (c) => {
          n += c.length;
          if (n > 300_000_000) {
            rs.destroy();
            return reject(new Error("file terlalu besar (>300MB), batal"));
          }
          chunks.push(c);
        });
        rs.on("end", async () => {
          await mkdir(dest.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
          await writeFile(dest, Buffer.concat(chunks));
          resolve();
        });
        rs.on("error", reject);
      }
    );
    rq.setTimeout(120_000, () => rq.destroy(new Error("timeout download")));
    rq.on("error", reject);
    rq.end();
  });
  return dest;
}

async function fetchBuffer(url, maxBytes = 200_000_000) {
  const u = new URL(url);
  const lib = u.protocol === "http:" ? httpReq : httpsReq;
  return new Promise((resolve, reject) => {
    const rq = lib(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest" },
      },
      (rs) => {
        const { statusCode = 0, headers: rh } = rs;
        if (statusCode >= 300 && statusCode < 400 && rh.location) {
          rs.resume();
          return resolve(fetchBuffer(new URL(rh.location, url).toString(), maxBytes));
        }
        if (statusCode !== 200) {
          rs.resume();
          return reject(new Error(`download gagal (status ${statusCode})`));
        }
        const chunks = [];
        let n = 0;
        rs.on("data", (c) => {
          n += c.length;
          if (n > maxBytes) {
            rs.destroy();
            return reject(new Error("file terlalu besar, batal"));
          }
          chunks.push(c);
        });
        rs.on("end", () => resolve(Buffer.concat(chunks)));
        rs.on("error", reject);
      }
    );
    rq.setTimeout(120_000, () => rq.destroy(new Error("timeout download")));
    rq.on("error", reject);
    rq.end();
  });
}

function req(url, { method = "GET", headers = {}, body, timeout = TIMEOUT, maxRedirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? httpReq : httpsReq;
    const rq = lib(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: {
          "User-Agent": UA,
          "X-Requested-With": "XMLHttpRequest",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (rs) => {
        const { statusCode = 0, headers: rh } = rs;
        if (statusCode >= 300 && statusCode < 400 && rh.location && maxRedirect > 0) {
          rs.resume();
          const next = new URL(rh.location, url).toString();
          return resolve(req(next, { method: "GET", headers, body: undefined, timeout, maxRedirect: maxRedirect - 1 }));
        }
        const chunks = [];
        let n = 0;
        rs.on("data", (c) => {
          n += c.length;
          if (n > MAX_SIZE) {
            rs.resume();
            return resolve({
              status: statusCode,
              headers: rh,
              body: Buffer.concat(chunks).toString("utf8"),
              truncated: true,
            });
          }
          chunks.push(c);
        });
        rs.on("end", () =>
          resolve({
            status: statusCode,
            headers: rh,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    rq.setTimeout(timeout, () => rq.destroy(new Error("timeout")));
    rq.on("error", reject);
    if (body) rq.write(body);
    rq.end();
  });
}

async function reqJson(url, opts = {}) {
  const r = await req(url, opts);
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {}
  return { ...r, json: j };
}

function usage() {
  return `SnapTik TikTok Scraper

Usage:
  node snaptik.js info <tiktok-link>
  node snaptik.js download <tiktok-link> [--out <folder>]

Contoh:
  node snaptik.js info "https://www.tiktok.com/@user/video/1234567890"
  node snaptik.js download "https://vm.tiktok.com/ZMxxxxxx/"
  node snaptik.js download "https://www.tiktok.com/@user/video/1234567890" --out ./downloads

Catatan:
  - Butuh solve token challenge (POST /api/token -> AES-256-CBC) tiap request.
  - downloadUrl punya TTL pendek, ambil ulang tepat sebelum download.
  - HD tidak dipakai: /api/hd balas 403 (gated "Watch Ad" di web aslinya).
  - Output JSON ke stdout, error ke stderr.`;
}

export async function resolve(rawUrl) {
  const data = await extract(rawUrl);
  const o = toOutput(data);
  const v = pickVideoUrl(data);
  const title = o.title || "TikTok Video";
  const author = o.author || o.username || "";
  return {
    platform: "snaptik",
    title,
    author,
    thumbnail: o.thumbnail,
    duration: o.duration,
    media: v.url ? [{ url: v.url, type: "video", quality: v.label }] : [],
    result: {
      title,
      author,
      thumbnail: o.thumbnail,
      duration: o.duration,
      url: v.url || null,
      type: "video",
      quality: v.label || null,
    },
  };
}

function caption(user, r, media) {
  return [
    `╭━━━ *${user}*`,
    "┃ *SNAPTIK*",
    "╰━━━━━━━━━━━━━━",
    "",
    `▸ title : ${r.title || "-"}`,
    r.author ? `▸ author : @${r.author}` : null,
    r.duration ? `▸ duration : ${r.duration}` : null,
    media?.quality ? `▸ quality : ${media.quality}` : null,
    "",
    "> no watermark • powered by scraper-bot-kit",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

const USAGE_BOT =
  "╭━━━ *SNAPTIK* ━━━╮\n\n▸ pakai: .snaptik <link tiktok>\n▸ contoh: .snaptik https://www.tiktok.com/@user/video/123\n\n>免 watermark\n╰━━━━━━━━━━━━━━━";

const config = {
  name: "snaptik",
  alias: ["snap", "snt"],
  category: "downloader",
  description: "download video TikTok tanpa watermark via snaptik.app",
  usage: "<link>",
  example: ".snaptik https://www.tiktok.com/@user/video/123",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 10,
  limit: 1,
  energi: 1,
  isEnabled: true,
};

function pickSocket(m, ctx) {
  return ctx?.sock || ctx?.conn || ctx?.socket || m?.sock || null;
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

async function sendText(m, ctx, text) {
  if (typeof m?.reply === "function") return m.reply(text);
  const sock = pickSocket(m, ctx);
  if (sock?.sendMessage) return sock.sendMessage(m.chat, { text }, { quoted: m });
  return null;
}

async function sendReaction(m, ctx, emoji) {
  try {
    if (typeof m?.react === "function") return await m.react(emoji);
    const sock = pickSocket(m, ctx);
    if (sock?.sendMessage) {
      return await sock.sendMessage(m.chat, { react: { text: emoji, key: m.key } });
    }
  } catch {}
  return null;
}

async function sendVideo(m, ctx, url, captionText) {
  const sock = pickSocket(m, ctx);
  if (!sock?.sendMessage) return null;
  try {
    const buf = await fetchBuffer(url);
    return await sock.sendMessage(
      m.chat,
      { video: buf, mimetype: "video/mp4", caption: captionText },
      { quoted: m },
    );
  } catch {
    return sock.sendMessage(
      m.chat,
      { video: { url }, mimetype: "video/mp4", caption: captionText },
      { quoted: m },
    );
  }
}

async function handler(m, ctx = {}) {
  const url = pickUrl(m, ctx);
  if (!url) return sendText(m, ctx, USAGE_BOT);

  const sender = String(m?.sender || "").split("@")[0];
  await sendReaction(m, ctx, "🕐");

  try {
    const r = await resolve(url);
    const media = r.media[0];
    if (!media?.url) throw new Error("tidak dapat download url");
    const sent = await sendVideo(m, ctx, media.url, caption(sender, r, media));
    if (!sent) throw new Error("tidak bisa kirim media");
    await sendReaction(m, ctx, "✅");
    return sent;
  } catch (error) {
    await sendReaction(m, ctx, "❌");
    return sendText(
      m,
      ctx,
      `╭━━━ *SNAPTIK* ━━━╮\n\n▸ gagal: ${error.message || "tidak diketahui"}\n▸ cek link-nya, atau coba lagi nanti\n╰━━━━━━━━━━━━━━━`,
    );
  }
}

handler.command = /^(snaptik|snap|snt)$/i;
handler.tags = ["downloader"];
handler.help = ["snaptik <link>"];
handler.limit = 1;
handler.premium = false;
handler.owner = false;
handler.config = config;

export { config, handler };
export default handler;

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stderr.write(usage() + "\n");
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  let out;
  if (cmd === "info") {
    const raw = positionals[1];
    if (!raw) throw new Error("info butuh <tiktok-link>");
    out = toOutput(await extract(raw));
  } else if (cmd === "download") {
    const raw = positionals[1];
    if (!raw) throw new Error("download butuh <tiktok-link>");
    const data = await extract(raw);
    const picked = pickVideoUrl(data);
    if (!picked.url) throw new Error("tidak dapat download url dari server");
    const dir = values.out || "downloads";
    const dest = `${dir.replace(/\/$/, "")}/${data.id || basename(picked.url) || "video"}.mp4`;
    await downloadFile(picked.url, dest);
    const { size } = await stat(dest);
    out = {
      ...toOutput(data),
      quality: picked.label,
      saved: dest,
      bytes: size,
    };
  } else {
    throw new Error(`command tidak dikenal: ${cmd}\n\n${usage()}`);
  }

  const s = JSON.stringify(out, null, 2) + "\n";
  await new Promise((r) => process.stdout.write(s, r));
}

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message || e}\n`);
    process.exitCode = 1;
  });
}

export { extract, toOutput, pickVideoUrl, downloadFile, usage };
