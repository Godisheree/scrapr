/**
 * Name : All In Download Scraper (info, download multi-platform)
 * Owner : Godhumanv2
 * Base Web : https://allindownload.com (all-in-one video downloader)
 * Type : Scraper
 * Function : Scrape lengkap -> info video (judul, author, platform, cover,
 *            daftar kualitas) dan download file MP4/MP3/M4A -> direct
 *            download URL + headers yang dibutuhkan. Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpReq } from "node:http";
import { request as httpsReq } from "node:https";
import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const SITE = "https://allindownload.com";
const API_DOWNLOAD = "/api/download";
const API_FILE = "/api/file";
const UA = "Mozilla/5.0";
const TIMEOUT = 30_000;
const MAX_SIZE = 500_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();

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
        headers: { "User-Agent": UA, ...headers },
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

function normalizeUrl(input) {
  let s = String(input ?? "").trim();
  if (!s) throw new Error("URL kosong");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`URL tidak valid: ${s}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Protocol tidak didukung: ${u.protocol}`);
  return u.toString();
}

function safeName(s) {
  return (
    (s || "video")
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .slice(0, 60) || "video"
  );
}

async function fetchInfo(url, tries = 4, delay = 3000) {
  const clean = normalizeUrl(url);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await reqJson(`${SITE}${API_DOWNLOAD}?url=${encodeURIComponent(clean)}`);
      if (r.json) {
        if (r.json.ok) return r.json;
        lastErr = new Error(r.json.message || `Gagal proses link (status ${r.status})`);
      } else {
        lastErr = new Error(`Respons bukan JSON (status ${r.status}): ${r.body.slice(0, 120)}`);
      }
    } catch (e) {
      if (e.message.startsWith("URL")) throw e;
      lastErr = e;
    }
    if (i < tries - 1) await sleep(delay * (i + 1));
  }
  throw lastErr;
}

function pickLink(data, quality) {
  const links = Array.isArray(data.links) ? data.links.filter((l) => l && l.url) : [];
  if (!links.length) throw new Error("Tidak ada link download untuk link ini");
  const q = quality ? String(quality).trim() : "";
  if (!q) return links[0];
  const exact = links.find((l) => l.label === q);
  if (exact) return exact;
  const loose = links.find((l) => l.label.toLowerCase().includes(q.toLowerCase()));
  if (loose) return loose;
  throw new Error(`Kualitas "${q}" tidak tersedia (pilihan: ${links.map((l) => l.label).join(", ")})`);
}

function toOutput(data, link) {
  return {
    platform: data.platform,
    title: dec(data.title),
    author: dec(data.author),
    cover: data.cover || "",
    direct: !!data.direct,
    formats: (data.links || [])
      .filter((l) => l && l.url)
      .map((l) => ({ label: l.label, ext: l.ext || ".mp4" })),
    selected: link ? { label: link.label, ext: link.ext || ".mp4", url: link.url } : null,
    headers: { "User-Agent": UA },
  };
}

function fetchToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? httpReq : httpsReq;
    const rq = lib(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": UA },
      },
      (rs) => {
        const { statusCode = 0, headers: rh } = rs;
        if (statusCode >= 300 && statusCode < 400 && rh.location) {
          rs.resume();
          const next = new URL(rh.location, url).toString();
          return resolve(fetchToFile(next, dest));
        }
        if (statusCode !== 200) {
          rs.resume();
          return reject(new Error(`download gagal (status ${statusCode})`));
        }
        const cd = rh["content-disposition"] || "";
        const mStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
        const mQ = cd.match(/filename="?([^";]+)"?/i);
        let name = dest;
        if (mStar) name = dest.replace(/[/\\][^/\\]+$/, `${"/"}${decodeURIComponent(mStar[1])}`);
        else if (mQ && /^\/api\/file\//.test(new URL(url).pathname)) {
          name = dest.replace(/[/\\][^/\\]+$/, `/${dec(mQ[1])}`);
        }
        const chunks = [];
        let n = 0;
        rs.on("data", (c) => {
          n += c.length;
          if (n > 500_000_000) {
            rs.destroy();
            return reject(new Error("file terlalu besar (>500MB), batal"));
          }
          chunks.push(c);
        });
        rs.on("end", async () => {
          try {
            await mkdir(name.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
            await writeFile(name, Buffer.concat(chunks));
            resolve({ status: statusCode, headers: rh, size: n, saved: name });
          } catch (e) {
            reject(e);
          }
        });
        rs.on("error", reject);
      }
    );
    rq.setTimeout(180_000, () => rq.destroy(new Error("timeout download")));
    rq.on("error", reject);
    rq.end();
  });
}

function proxyUrl(linkUrl, platform, fileName) {
  const q = `url=${encodeURIComponent(linkUrl)}&name=${encodeURIComponent(fileName)}&ref=${encodeURIComponent(platform || "")}`;
  return `${SITE}${API_FILE}?${q}`;
}

function usage() {
  return `All In Download Scraper

Usage:
  node alldownload.js info <link>
  node alldownload.js download <link> [--quality <label>] [--out <folder>] [--proxy]

Contoh:
  node alldownload.js info "https://www.tiktok.com/@user/video/1234567890"
  node alldownload.js download "https://youtu.be/dQw4w9WgXcQ" --quality 1080p
  node alldownload.js download "https://www.tiktok.com/@user/video/123" --out ./downloads
  node alldownload.js download "https://youtu.be/dQw4w9WgXcQ" --quality "Audio only" --proxy

Catatan:
  - Endpoint publik, tanpa token. Cukup ${SITE}/api/download?url=<link>.
  - UA sengaja polos ("Mozilla/5.0"). UA browser lengkap bikin TikTok ditolak.
  - Endpoint TikTok flaky: retry 4x dengan jeda 3/6/9 detik. Jangan dipakin.
  - --quality pakai label persis dari output info (mis. "1080p HD (video only)").
  - Default tanpa --quality: link PERTAMA yang dikembalikan server.
  - --proxy pakai /api/file; tanpa flag ini scraper coba direct dulu, lalu
    otomatis fallback ke /api/file kalau gagal (tikcdn.io nukang Node TLS).
  - Field "via" di output ngasih tahu file ini diambil lewat mana.
  - Label YouTube "video only" = tanpa audio; pakai "(with audio)" buat ada suaranya.
  - Output JSON ke stdout, error ke stderr.`;
}

export async function resolve(rawUrl, opts = {}) {
  const data = await fetchInfo(rawUrl);
  const link = pickLink(data, opts.quality);
  const title = dec(data.title) || "Media";
  const author = dec(data.author) || "";
  const media = (data.links || [])
    .filter((l) => l && l.url)
    .map((l) => {
      const audio = /mp3|m4a|opus|audio/i.test(`${l.ext || ""} ${l.label || ""}`);
      return {
        url: l.url,
        type: audio ? "audio" : "video",
        quality: l.label || null,
      };
    });

  return {
    platform: data.platform,
    title,
    author,
    thumbnail: data.cover || null,
    media,
    result: {
      title,
      author,
      thumbnail: data.cover || null,
      url: link.url,
      type: /\.(mp3|m4a|opus|ogg)$/i.test(link.ext || "") ? "audio" : "video",
      quality: link.label || null,
      formats: media,
    },
  };
}

function caption(user, r, media) {
  return [
    `╭━━━ *${user}*`,
    "┃ *AIO DOWNLOADER*",
    "╰━━━━━━━━━━━━━━━",
    "",
    `▸ platform : ${r.platform || "-"}`,
    `▸ title : ${r.title || "-"}`,
    r.author ? `▸ author : ${r.author}` : null,
    media?.quality ? `▸ quality : ${media.quality}` : null,
    "",
    "> powered by scraper-bot-kit",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

const USAGE_BOT =
  "╭━━━ *AIO DOWNLOADER* ━━━╮\n\n▸ pakai: .aio <link>\n▸ contoh: .aio https://vm.tiktok.com/ZMxxxx/\n\n> tiktok + youtube\n╰━━━━━━━━━━━━━━━";

export default {
  name: "aio",
  command: ["aio"],
  alias: [],
  category: ["scraper"],
  description: "ambil media dari tiktok dan youtube",
  usage: "<link>",
  example: ".aio <link>",
  async run({ m, args, q }) {
    const quotedText =
      q?.text ||
      q?.message?.conversation ||
      q?.message?.extendedTextMessage?.text ||
      q?.raw?.message?.conversation ||
      q?.raw?.message?.extendedTextMessage?.text ||
      "";
    const candidate =
      args.find((v) => /^https?:\/\//i.test(v)) || quotedText.match(/https?:\/\/\S+/i)?.[0];

    if (!candidate) return m.reply(USAGE_BOT);

    const sender = String(m.sender || "").split("@")[0];
    await m.react("🕐").catch(() => {});

    try {
      const r = await resolve(candidate);
      const wantAudio = args.some((v) => String(v).toLowerCase() === "audio");
      const media = wantAudio
        ? r.media.find((i) => i.type === "audio") || r.media[0]
        : r.media.find((i) => i.type === "video") || r.media[0];
      if (!media?.url) throw new Error("tidak ada link download");
      await m.react("✅").catch(() => {});
      if (media.type === "audio") return m.sendAudio(media.url, { mimetype: "audio/mpeg" });
      return m.sendVideo(media.url, caption(sender, r, media));
    } catch (error) {
      await m.react("❌").catch(() => {});
      return m.reply(
        `╭━━━ *AIO DOWNLOADER* ━━━╮\n\n▸ gagal: ${error.message || "tidak diketahui"}\n▸ cek link-nya, atau coba lagi nanti\n╰━━━━━━━━━━━━━━━`,
      );
    }
  },
};

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      quality: { type: "string", short: "q" },
      out: { type: "string", short: "o" },
      proxy: { type: "boolean", short: "p" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stderr.write(usage() + "\n");
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  if (cmd !== "info" && cmd !== "download") {
    throw new Error(`command tidak dikenal: ${cmd}\n\n${usage()}`);
  }

  const raw = positionals[1];
  if (!raw) throw new Error(`${cmd} butuh <link>`);

  let out;
  if (cmd === "info") {
    const data = await fetchInfo(raw);
    out = toOutput(data, null);
  } else if (cmd === "download") {
    const data = await fetchInfo(raw);
    const link = pickLink(data, values.quality);
    const dir = (values.out || "downloads").replace(/\/$/, "");
    const ext = link.ext || ".mp4";
    const base = `${dir}/${safeName(data.title)}`;
    const proxied = () => proxyUrl(link.url, data.platform, `${safeName(data.title)}${ext}`);
    let r;
    let via;
    if (values.proxy) {
      r = await fetchToFile(proxied(), `${base}${ext}`);
      via = "proxy";
    } else {
      try {
        r = await fetchToFile(link.url, `${base}${ext}`);
        via = "direct";
      } catch (e) {
        r = await fetchToFile(proxied(), `${base}${ext}`);
        via = `proxy (fallback: ${e.message})`;
      }
    }
    out = { ...toOutput(data, link), saved: r.saved, bytes: r.size, via };
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

export { fetchInfo, pickLink, toOutput, fetchToFile, usage };
