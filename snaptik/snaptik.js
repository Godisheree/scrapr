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

const SITE = "https://snaptik.app";
const API_TOKEN = "/api/token";
const API_EXTRACT = "/api/extract";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT = 30_000;
const MAX_SIZE = 500_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Secret challenge: disusun dari char-code yang diambil dari bundle JS asli. */
function secret() {
  const l = [115, 110, 52, 112].map((c) => String.fromCharCode(c)).join(""); // "sn4p"
  const s = [...  "s0j^"].map((c) => String.fromCharCode(c.charCodeAt(0) + 1)).join(""); // "t1k_"
  const n = Buffer.from("djNyMQ==", "base64").toString("utf8"); // "v3r1"
  const g = "fy20";
  const d = [50, 54].map((c) => String.fromCharCode(c)).join(""); // "26"
  return l + s + n + g + d;
}

/** AES-256-CBC decrypt (key = SHA256(secret:id), IV = 16 byte pertama). */
function decryptPayload(id, p) {
  const raw = Buffer.from(p, "base64");
  const iv = raw.subarray(0, 16);
  const ct = raw.subarray(16);
  const key = createHash("sha256").update(`${secret()}:${id}`).digest();
  const dec = createDecipheriv("aes-256-cbc", key, iv);
  const pt = Buffer.concat([dec.update(ct), dec.final()]);
  return pt.toString("utf8").replace(/\0+$/, "").trim();
}

/** Jawab challenge sesuai tipe yang dikirim server. */
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

/** POST /api/token -> decrypt -> X-Verify: "id:hasil:_e:_h". */
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

/** Validasi input: hanya izinkan domain TikTok/Douyin yang didukung. */
function normalizeUrl(input) {
  const s = String(input).trim();
  if (!/^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//i.test(s) &&
      !/^https?:\/\/(www\.|v\.)?douyin\.com\//i.test(s)) {
    throw new Error(`link TikTok/Douyin tidak dikenali: ${s}`);
  }
  return s;
}

/** GET /api/extract -> metadata + download URL. */
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

/** Unduh file ke disk (streaming, ikut redirect). */
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

/** HTTP native: GET/POST JSON, ikut redirect (max 5), batas ukuran response. */
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
  } catch {
    /* not json */
  }
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

main().catch((e) => {
  process.stderr.write(`error: ${e.message || e}\n`);
  process.exitCode = 1;
});