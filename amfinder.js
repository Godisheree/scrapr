/**
 * Name : AM Finder Scraper (cari video preset, Preset Links)
 * Owner : Godhumanv2
 * Base Web : https://amfinder.web.id (AM Preset Finder, cari preset Alight Motion dari link TikTok/YouTube)
 * Type : Scraper
 * Function : Scrape lengkap -> cari video lewat keyword (SSE /api/search) dan Preset Links
 *            tiap video (SSE /api/find: link preset XML, judul, ukuran, rasio, sumber)
 *            -> output JSON ke stdout.
 * Note : error fix sendiri.
 */

import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const SITE = "https://amfinder.web.id";
const API_SEARCH = "/api/search";
const API_FIND = "/api/find";
const SEARCH_MODE = "pick";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TIMEOUT = 120_000;
const TIMEOUT_SHORTS = 90_000;
const MIN_QUERY = 3;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 30;
const FIND_DELAY = 2_500;

function req(url, { method = "GET", headers = {}, body, timeout = TIMEOUT, maxRedirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let target = url;
    let left = maxRedirect;
    const run = () => {
      const u = new URL(target);
      const lib = u.protocol === "https:" ? https : http;
      const rq = lib.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          headers: {
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
            ...headers,
          },
        },
        (rs) => {
          const loc = rs.headers.location;
          if (rs.statusCode >= 300 && rs.statusCode < 400 && loc && left > 0) {
            rs.resume();
            left -= 1;
            target = new URL(loc, target).toString();
            return run();
          }
          const chunks = [];
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", () =>
            resolve({
              status: rs.statusCode,
              headers: rs.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          rs.on("error", reject);
        },
      );
      rq.setTimeout(timeout, () => rq.destroy(new Error("request timeout")));
      rq.on("error", reject);
      if (body) rq.write(body);
      rq.end();
    };
    run();
  });
}

function reqJson(url, opts = {}) {
  return req(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers || {}) },
  }).then((r) => {
    let json = null;
    try {
      json = JSON.parse(r.body);
    } catch {
      json = null;
    }
    return { status: r.status, headers: r.headers, body: r.body, json };
  });
}

function parseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

function reqSse(url, { headers = {}, timeout = TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const rq = lib.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          "User-Agent": UA,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Language": "en-US,en;q=0.9",
          ...headers,
        },
      },
      (rs) => {
        if (rs.statusCode !== 200) {
          const chunks = [];
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", () =>
            reject(
              new Error(
                `HTTP ${rs.statusCode} dari ${u.pathname} (${Buffer.concat(chunks).toString("utf8").slice(0, 200)})`,
              ),
            ),
          );
          return;
        }
        const decoder = new StringDecoder("utf8");
        const events = [];
        let buf = "";
        rs.on("data", (c) => {
          buf += decoder.write(c);
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const ev = parseBlock(buf.slice(0, i));
            buf = buf.slice(i + 2);
            if (ev) events.push(ev);
          }
        });
        rs.on("end", () => {
          buf += decoder.end();
          const last = parseBlock(buf.trim());
          if (last) events.push(last);
          resolve({ status: rs.statusCode, headers: rs.headers, events });
        });
        rs.on("error", reject);
      },
    );
    rq.setTimeout(timeout, () => rq.destroy(new Error("request timeout")));
    rq.on("error", reject);
    rq.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sseFailure(events) {
  const err = events.find((e) => e.event === "error");
  if (!err) return null;
  try {
    const j = JSON.parse(err.data);
    return new Error(j.message || "server balas event error");
  } catch {
    return new Error(String(err.data).slice(0, 200) || "server balas event error");
  }
}

function sseResult(events, label) {
  const fail = sseFailure(events);
  if (fail) throw fail;
  const res = events.find((e) => e.event === "result");
  if (!res) throw new Error(`${label}: stream selesai tanpa event result`);
  try {
    return JSON.parse(res.data);
  } catch {
    throw new Error(`${label}: result bukan JSON`);
  }
}

function headersFor(q) {
  return { Referer: `${SITE}/search?q=${encodeURIComponent(q)}`, Origin: SITE };
}

async function apiSearch(keyword) {
  const q = keyword.trim();
  if (q.length < MIN_QUERY)
    throw new Error(`keyword minimal ${MIN_QUERY} karakter (rules: <${MIN_QUERY} diabaikan situs)`);
  const url = `${SITE}${API_SEARCH}?mode=${SEARCH_MODE}&q=${encodeURIComponent(q)}`;
  const { events } = await reqSse(url, { headers: headersFor(q), timeout: TIMEOUT_SHORTS });
  const fail = sseFailure(events);
  if (fail) throw fail;
  const cands = events.find((e) => e.event === "candidates");
  if (!cands) throw new Error("tidak ada event candidates");
  let payload;
  try {
    payload = JSON.parse(cands.data);
  } catch {
    throw new Error("candidates bukan JSON");
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  return { query: payload.query ?? q, fromCache: !!payload.fromCache, count: items.length, items };
}

async function apiFind(mediaUrl) {
  const url = `${SITE}${API_FIND}?url=${encodeURIComponent(mediaUrl)}`;
  const { events } = await reqSse(url, { headers: headersFor(""), timeout: TIMEOUT });
  return sseResult(events, "find");
}

function slimItem(it) {
  return {
    url: it.url,
    handle: it.handle ?? null,
    kind: it.kind ?? "video",
    snippet: it.snippet ?? "",
    thumb: it.thumb ?? null,
    duration: it.duration ?? null,
    stats: it.stats ?? null,
  };
}

function slimFind(j) {
  const v = j.video || {};
  return {
    input: j.input ?? null,
    ok: j.ok !== false,
    found: !!j.found,
    author: j.author ?? null,
    videoId: j.videoId ?? v.id ?? null,
    video: {
      url: v.url ?? j.videoUrl ?? null,
      description: v.description ?? "",
      cover: v.cover ?? null,
      duration: v.duration ?? null,
      createTime: v.createTime ?? null,
      stats: v.stats ?? null,
      playUrl: v.playUrl ?? null,
      playUrlNoWm: v.playUrlNoWm ?? null,
    },
    context: j.context ?? null,
    presetLinks: Array.isArray(j.presetLinks) ? j.presetLinks : [],
    otherLinks: Array.isArray(j.otherLinks) ? j.otherLinks : [],
    scanned: j.scanned ?? null,
  };
}

async function cmdSearch(keyword) {
  const r = await apiSearch(keyword);
  return {
    ok: true,
    site: SITE,
    query: r.query,
    fromCache: r.fromCache,
    count: r.count,
    items: r.items.map(slimItem),
    hint: "pakai `find <url>` untuk Preset Links, atau `presets <keyword>` untuk sekaligus ambil preset link tiap hasil",
  };
}

async function cmdFind(mediaUrl) {
  const r = await apiFind(mediaUrl);
  return { ok: true, site: SITE, ...slimFind(r) };
}

async function cmdPresets(keyword, limit, delay) {
  const s = await apiSearch(keyword);
  const picked = s.items.slice(0, limit);
  const out = [];
  for (let i = 0; i < picked.length; i += 1) {
    const it = picked[i];
    const base = { url: it.url, handle: it.handle ?? null, snippet: it.snippet ?? "" };
    try {
      const r = await apiFind(it.url);
      const slim = slimFind(r);
      out.push({ ...base, ...slim, presetCount: slim.presetLinks.length });
    } catch (e) {
      out.push({ ...base, ok: false, error: e.message || String(e), presetCount: 0 });
    }
    if (i < picked.length - 1) await sleep(delay);
  }
  return {
    ok: true,
    site: SITE,
    query: s.query,
    searched: s.count,
    limit,
    withPreset: out.filter((o) => o.presetCount > 0).length,
    results: out,
  };
}

function usage() {
  return `AM Finder Scraper - ${SITE}

Pakai:
  node amfinder/amfinder.js search <keyword>
  node amfinder/amfinder.js find <url-tiktok-atau-youtube>
  node amfinder/amfinder.js presets <keyword> [-n <limit>] [-d <delay>]

Opsi:
  -n, --limit <n>   jumlah video yang di-find (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})
  -d, --delay <ms>  jeda antar panggilan find (default ${FIND_DELAY})
  -s, --short       output ringkas: cuma url/handle + presetLinks (type,url,title,size,ratio)
  -h, --help        tampilkan ini

Contoh:
  node amfinder/amfinder.js search neon
  node amfinder/amfinder.js find "https://www.tiktok.com/@edit36652/video/7696198315662216456"
  node amfinder/amfinder.js presets "alight motion preset" -n 3

Output JSON ke stdout, error ke stderr.

Catatan jujur:
  - search & find itu Server-Sent Events, bukan JSON biasa. Di-stream parsed di dalam.
  - Keyword minimal ${MIN_QUERY} karakter, itu rules situsnya sendiri.
  - Backend situs pakai mirror video gratis yang kena rate limit, jadi perintah
    presets bisa occasional dapat presetCount 0 atau timeout. Naikkan -d kalau
    mau lebih aman.
  - Preset link yang dikembalikan sering berupa link share Google Drive atau file host
    lain. Scraper ini hanya mengeluarkan direct URL-nya, tidak mengunduh file preset.`;
}

function compactLink(p) {
  return {
    type: p.type ?? null,
    url: p.url ?? null,
    title: p.title ?? null,
    size: p.size ?? null,
    ratio: p.ratio ?? null,
    source: p.source ?? null,
  };
}

function compact(out, cmd) {
  if (cmd === "search") {
    return {
      ok: out.ok,
      query: out.query,
      count: out.count,
      items: (out.items || []).map((it) => ({ url: it.url, handle: it.handle, snippet: it.snippet })),
    };
  }
  if (cmd === "find") {
    return {
      ok: out.ok,
      input: out.input,
      found: out.found,
      author: out.author,
      presetLinks: (out.presetLinks || []).map(compactLink),
    };
  }
  if (cmd === "presets") {
    return {
      ok: out.ok,
      query: out.query,
      searched: out.searched,
      withPreset: out.withPreset,
      results: (out.results || []).map((r) => ({
        url: r.url,
        handle: r.handle,
        presetCount: r.presetCount,
        presetLinks: (r.presetLinks || []).map(compactLink),
      })),
    };
  }
  return out;
}

export async function resolve(mediaUrl) {
  const r = await cmdFind(mediaUrl);
  const v = r.video || {};
  const media = [];
  for (const u of [v.playUrlNoWm, v.playUrl, v.url]) {
    if (u && /^https?:\/\//i.test(u) && !media.some((x) => x.url === u)) {
      media.push({ url: u, type: "video", quality: "no-watermark" });
    }
  }
  for (const p of r.presetLinks || []) {
    const u = p && (p.url || p.link);
    if (u && /^https?:\/\//i.test(u) && !media.some((x) => x.url === u)) {
      media.push({ url: u, type: "video", quality: p.name || p.label || "preset" });
    }
  }
  const primary = media[0] || null;
  const title = v.description || r.author || "Media";
  return {
    platform: "amfinder",
    title,
    author: r.author || "",
    thumbnail: v.cover || null,
    duration: v.duration || null,
    media,
    result: {
      title,
      author: r.author || "",
      thumbnail: v.cover || null,
      duration: v.duration || null,
      url: primary ? primary.url : null,
      type: "video",
      quality: primary ? primary.quality : null,
      formats: media,
    },
  };
}

export async function search(keyword) {
  return cmdSearch(keyword);
}

function caption(user, r, media) {
  return [
    `╭━━━ *${user}*`,
    "┃ *AMFINDER*",
    "╰━━━━━━━━━━━━━━",
    "",
    `▸ title : ${r.title || "-"}`,
    r.author ? `▸ author : ${r.author}` : null,
    r.duration ? `▸ duration : ${r.duration}` : null,
    media?.quality ? `▸ source : ${media.quality}` : null,
    `▸ link : ${(media?.url || "").slice(0, 44)}...`,
    "",
    "> powered by scraper-bot-kit",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

const USAGE_BOT =
  "╭━━━ *AMFINDER* ━━━╮\n\n▸ pakai: .amfind <link media>\n▸ contoh: .amfind https://www.tiktok.com/@user/video/123\n\n▸ atau pakai command search:\n▸ .amsearch <keyword>\n╰━━━━━━━━━━━━━━━";

export default {
  name: "amfind",
  command: ["amfind"],
  alias: [],
  category: ["scraper"],
  description: "ambil link media + preset links dari amfinder",
  usage: "<link>",
  example: ".amfind <link>",
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
      const media = r.media[0];
      if (!media?.url) throw new Error("media tidak ditemukan");
      await m.react("✅").catch(() => {});
      return m.sendVideo(media.url, caption(sender, r, media));
    } catch (error) {
      await m.react("❌").catch(() => {});
      return m.reply(
        `╭━━━ *AMFINDER* ━━━╮\n\n▸ gagal: ${error.message || "tidak diketahui"}\n▸ cek link-nya, atau coba lagi nanti\n╰━━━━━━━━━━━━━━━`,
      );
    }
  },
};

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

async function main() {
  let argv;
  try {
    argv = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        limit: { type: "string", short: "n" },
        delay: { type: "string", short: "d" },
        short: { type: "boolean", short: "s", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`${usage()}\n`);
    throw new Error(e.message);
  }
  const { values, positionals } = argv;
  const cmd = positionals[0];
  if (values.help || !cmd) {
    const out = usage();
    if (values.help && cmd) process.stdout.write(`${out}\n`);
    else process.stderr.write(`${out}\n`);
    if (!values.help) process.exitCode = 1;
    return;
  }
  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(values.limit, 10) || DEFAULT_LIMIT));
  }
  let delay = FIND_DELAY;
  if (values.delay !== undefined) {
    delay = Math.max(0, Number.parseInt(values.delay, 10) || 0);
  }
  let out;
  if (cmd === "search") {
    if (!positionals[1]) throw new Error("keyword wajib diisi");
    out = await cmdSearch(positionals[1]);
  } else if (cmd === "find") {
    if (!positionals[1]) throw new Error("url wajib diisi");
    out = await cmdFind(positionals[1]);
  } else if (cmd === "presets") {
    if (!positionals[1]) throw new Error("keyword wajib diisi");
    out = await cmdPresets(positionals[1], limit, delay);
  } else {
    throw new Error(`command tidak dikenal: ${cmd}`);
  }
  if (values.short) out = compact(out, cmd);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message || e}\n`);
    process.exitCode = 1;
  });
}

export { cmdSearch, cmdFind, cmdPresets, usage };