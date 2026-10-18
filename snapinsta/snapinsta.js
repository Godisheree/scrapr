/**
 * Name : SnapInsta Scraper (info, download) — Instagram post/reel/tv
 * Owner : Godhumanv2
 * Base Web : https://snapinsta.to (Instagram downloader: post, reels, tv)
 * Type : Scraper
 * Function : Scrape lengkap -> info media (label, thumbnail, daftar link
 *            download) dan download file (MP4/JPG) -> direct download URL +
 *            headers yang dibutuhkan. Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpReq } from "node:http";
import { request as httpsReq } from "node:https";
import { spawn } from "node:child_process";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const SITE = "https://snapinsta.to";
const PAGE_PATH = "/en46";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TIMEOUT = 30_000;
const MAX_SIZE = 500_000;
const DOWNLOAD_MAX_SIZE = 512 * 1024 * 1024;

const CHROME_BINARIES = [
  process.env.CHROME_BIN || "",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
];
const CDP_PORT = 9333;
const CF_WAIT_MS = 90_000;
const RESULT_WAIT_MS = 120_000;
const POLL_MS = 1_000;

const BROWSER_HINT =
  "Butuh binary Chromium/Chrome. Cek CHROME_BIN atau --port kalau port CDP bentrok.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function dec(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function pickChrome() {
  for (const p of CHROME_BINARIES) if (p && existsSync(p)) return p;
  return "";
}

export function normalizeWsUrl(wsUrl, port) {
  try {
    const u = new URL(wsUrl);
    if (!u.port) u.port = String(port);
    return u.toString();
  } catch {
    return String(wsUrl);
  }
}

export function normalizeIg(raw) {
  const u = String(raw ?? "").trim();
  if (!u) throw new Error("URL Instagram kosong");
  if (!/^https?:\/\//i.test(u)) {
    throw new Error("URL harus diawali http(s):// — contoh: https://www.instagram.com/reel/ABC123/");
  }
  const m = u.match(/instagram\.com\/(?:[a-zA-Z]{2,3}\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) {
    throw new Error(
      "URL bukan post/reel Instagram yang valid. Contoh: https://www.instagram.com/p/C2VFqJMtui4/",
    );
  }
  return { url: u, shortcode: m[1] };
}

export function extFor(url, label) {
  let pathname = "";
  try {
    pathname = new URL(String(url)).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  if (pathname.endsWith(".mp4")) return ".mp4";
  if (pathname.endsWith(".png")) return ".png";
  if (pathname.endsWith(".webp")) return ".webp";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return ".jpg";
  const l = String(label ?? "");
  if (/png/i.test(l)) return ".png";
  if (/webp/i.test(l)) return ".webp";
  if (/photo|jpe?g/i.test(l)) return ".jpg";
  return "";
}

export function toOutput(data) {
  const seen = new Set();
  const items = [];
  for (const l of data.links || []) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    items.push({
      index: items.length,
      label: l.label,
      kind: /photo|jpe?g/i.test(l.label) ? "photo" : "video",
      url: l.url,
    });
  }
  return {
    shortcode: data.shortcode,
    source: data.url,
    platform: "instagram",
    thumbnail: (data.thumbs || [])[0] || "",
    items,
    primary: items[0]?.url || "",
    headers: { "User-Agent": UA },
    note: "token link berlaku ±1 jam, ambil ulang sebelum download",
  };
}

export function readyToInteract(snap) {
  if (!snap) return false;
  return (
    snap.readyState === "complete" &&
    snap.hasInput === true &&
    snap.hasButton === true &&
    snap.hasHandler === true
  );
}

const TERMINAL_MESSAGE =
  /no data|error|invalid|not found|try again|cannot|expired|unavailable/i;

export function classifyResult(snap) {
  if (!snap || snap.ready !== true) return "wait";
  if ((snap.links || []).length > 0) return "done";
  const msg = String(snap.message || "");
  if (msg && TERMINAL_MESSAGE.test(msg)) return "error";
  return "wait";
}

export function resolveCommand(positionals) {
  const list = Array.isArray(positionals) ? positionals : [];
  if (!list.length) return null;
  const first = String(list[0]);
  if (/^https?:\/\//i.test(first)) return { cmd: "info", raw: first };
  return { cmd: first, raw: list[1] };
}

export async function waitUntil(read, decide, opts = {}) {
  const { timeoutMs = 60_000, intervalMs = 1_000, sleepFn = sleep, onTimeout } = opts;
  const deadline = Date.now() + timeoutMs;
  let snap = null;
  for (;;) {
    snap = await read();
    const verdict = decide(snap);
    if (verdict !== "wait") return { verdict, snap };
    if (Date.now() >= deadline) break;
    await sleepFn(intervalMs);
  }
  const msg = typeof onTimeout === "function" ? onTimeout(snap) : onTimeout;
  throw new Error(msg ? String(msg) : `waitUntil timeout setelah ${timeoutMs}ms`);
}

export function req(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeout = TIMEOUT,
    maxRedirect = 5,
    maxSize = MAX_SIZE,
  } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`URL tidak valid: ${url}`));
      return;
    }
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
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (rs) => {
        const { statusCode = 0, headers: rh } = rs;
        if (statusCode >= 300 && statusCode < 400 && rh.location) {
          rs.resume();
          if (maxRedirect <= 0) {
            reject(new Error(`redirect melebihi batas (status ${statusCode})`));
            return;
          }
          resolve(
            req(new URL(rh.location, url).toString(), {
              method,
              headers,
              body,
              timeout,
              maxSize,
              maxRedirect: maxRedirect - 1,
            }),
          );
          return;
        }
        const chunks = [];
        let size = 0;
        rs.on("data", (c) => {
          size += c.length;
          if (size > maxSize) {
            rq.destroy();
            reject(new Error(`respons melebihi ${maxSize} byte`));
            return;
          }
          chunks.push(c);
        });
        rs.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: statusCode, headers: rh, body: buf, text: buf.toString("utf8") });
        });
        rs.on("error", reject);
      },
    );
    rq.setTimeout(timeout, () => rq.destroy(new Error(`timeout ${timeout}ms: ${method} ${url}`)));
    rq.on("error", reject);
    if (body) rq.write(body);
    rq.end();
  });
}

export async function reqJson(url, opts) {
  const r = await req(url, opts);
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch {
    json = null;
  }
  return { status: r.status, headers: r.headers, body: r.text, json };
}

const PROBE_READY_JS = `(() => ({
  readyState: document.readyState,
  hasInput: !!document.getElementById('s_input'),
  hasButton: !!document.querySelector('#search-form button'),
  hasHandler: typeof window.ksearchvideo === 'function'
}))()`;

const PROBE_RESULT_JS = `(() => {
  const root = document.getElementById('search-result');
  if (!root) return JSON.stringify({ ready: false, links: [], thumbs: [], message: '' });
  const links = [];
  const seen = {};
  root.querySelectorAll('a[href]').forEach(a => {
    const h = a.href || '';
    if (!/^https?:\\/\\/(dl|i)\\.snapcdn\\.app\\//i.test(h)) return;
    if (seen[h]) return;
    seen[h] = 1;
    links.push({ url: h, label: (a.innerText || '').replace(/\\s+/g, ' ').trim() });
  });
  const thumbs = [];
  root.querySelectorAll('img').forEach(i => {
    const s = i.src || '';
    if (/snapcdn\\.app/i.test(s) && thumbs.indexOf(s) === -1) thumbs.push(s);
  });
  return JSON.stringify({
    ready: true,
    links: links,
    thumbs: thumbs.slice(0, 1),
    message: (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
  });
})()`;

function devtoolsJSON(port, path) {
  return new Promise((resolve, reject) => {
    const rq = httpReq({ host: "127.0.0.1", port, path, method: "GET" }, (rs) => {
      const chunks = [];
      rs.on("data", (c) => chunks.push(c));
      rs.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    rq.setTimeout(5_000, () => rq.destroy(new Error("devtools timeout")));
    rq.on("error", reject);
    rq.end();
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message || "CDP error"));
        else p.res(m.result || {});
      }
    });
    ws.addEventListener("error", () => reject(new Error("gagal konek ke WebSocket CDP")));
    ws.addEventListener("close", () => {
      for (const [, p] of pending) p.rej(new Error("CDP terputus"));
      pending.clear();
    });
    ws.addEventListener("open", () => {
      const send = (method, params = {}, sessionId) =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
          setTimeout(() => {
            if (pending.has(mid)) {
              pending.delete(mid);
              rej(new Error(`CDP timeout: ${method}`));
            }
          }, TIMEOUT);
        });
      resolve({ send, close: () => { try { ws.close(); } catch { return; } } });
    });
  });
}

async function withPage(fn, port) {
  const bin = pickChrome();
  if (!bin) {
    throw new Error(`binary Chromium/Chrome tidak ditemukan. ${BROWSER_HINT}`);
  }

  const chrome = spawn(
    bin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--lang=en-US",
      "--window-size=1280,900",
      `--user-agent=${UA}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  let client;
  try {
    let ver = null;
    for (let i = 0; i < 60; i++) {
      try {
        ver = await devtoolsJSON(port, "/json/version");
        if (ver) break;
      } catch {
        ver = null;
      }
      await sleep(500);
    }
    if (!ver) throw new Error(`Chromium tidak start di port ${port}. ${BROWSER_HINT}`);

    client = await connect(normalizeWsUrl(ver.webSocketDebuggerUrl, port));
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });

    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    await client.send("Network.setUserAgentOverride", { userAgent: UA }, sessionId);

    const evaluate = async (expression) => {
      const r = await client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate gagal");
      return r.result?.value;
    };

    return await fn({ evaluate, sessionId, send: client.send });
  } finally {
    try {
      client?.close();
    } catch {
      void 0;
    }
    chrome.kill("SIGKILL");
  }
}

async function scrape(rawUrl, port) {
  const { url, shortcode } = normalizeIg(rawUrl);

  return withPage(async ({ evaluate }) => {
    await evaluate(`window.location.href = ${JSON.stringify(SITE + PAGE_PATH)}`).catch(() => undefined);

    const readReady = async () => {
      const raw = await evaluate(PROBE_READY_JS);
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    };

    await waitUntil(readReady, (s) => (readyToInteract(s) ? "done" : "wait"), {
      timeoutMs: CF_WAIT_MS,
      intervalMs: POLL_MS,
      onTimeout: () =>
        new Error(`form tidak muncul setelah ${CF_WAIT_MS / 1000}s — Cloudflare masih nge-blankir. ${BROWSER_HINT}`),
    });

    await evaluate(
      `(() => { const i = document.getElementById('s_input'); i.value = ${JSON.stringify(url)}; return i.value; })()`,
    );
    await evaluate(`(() => { document.querySelector('#search-form button').click(); return 1; })()`);

    const readResult = async () => {
      const raw = await evaluate(PROBE_RESULT_JS);
      if (typeof raw !== "string") return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const decide = (snap) => classifyResult(snap);
    const settled = await waitUntil(readResult, decide, {
      timeoutMs: RESULT_WAIT_MS,
      intervalMs: POLL_MS,
      onTimeout: (snap) =>
        new Error(
          `nggak dapat link download setelah ${RESULT_WAIT_MS / 1000}s` +
            (snap?.message ? ` — halaman: ${dec(snap.message)}` : ""),
        ),
    });

    if (settled.verdict === "error") {
      throw new Error(`ditolak server: ${dec(settled.snap.message || "tidak diketahui")}`);
    }
    return { shortcode, url, ...settled.snap };
  }, port);
}

async function downloadFile(url, dest) {
  const dir = dest.replace(/\/[^/]+$/, "");
  if (dir) await mkdir(dir, { recursive: true });
  const r = await req(url, {
    headers: { "User-Agent": UA, Referer: SITE + PAGE_PATH },
    maxSize: DOWNLOAD_MAX_SIZE,
    timeout: 120_000,
  });
  if (r.status !== 200) throw new Error(`download gagal (status ${r.status})`);
  if (!r.body.length) throw new Error("file hasil download kosong");
  await writeFile(dest, r.body);
  const { size } = await stat(dest);
  return size;
}

function usage() {
  return `SnapInsta Scraper — Instagram post/reel/tv

Pakai:
  node snapinsta/snapinsta.js <instagram-url>            (sama kayak "info")
  node snapinsta/snapinsta.js info     <instagram-url>
  node snapinsta/snapinsta.js download <instagram-url> [--out <dir>] [--index <n>]

Contoh:
  node snapinsta/snapinsta.js "https://www.instagram.com/reel/DelnxMyMI-U/"
  node snapinsta/snapinsta.js download "https://www.instagram.com/reel/DelnxMyMI-U/" --out ./downloads

Opsi:
  --out <dir>     folder tujuan download (default: downloads)
  --index <n>     pilih link ke-n dari daftar item (default: 0)
  --port <n>      port Chrome DevTools Protocol (default: ${CDP_PORT})
  --help, -h      tampilkan bantuan ini

Catatan jujur:
  - snapinsta.to di-proteksi Cloudflare *managed challenge*, dan cookie
    clearance-nya di-bind ke sidik jari TLS browser. Dicoba dipakai ulang dari
    node:https atau curl tetap 403 "Just a moment...". Karena itu step scrape
    HARUS lewat Chromium sungguhan yang dikontrol lewat CDP (WebSocket bawaan
    Node 22, tanpa dependency npm).
  - Butuh binary Chromium/Chrome di host. Cek: ${CHROME_BINARIES.filter(Boolean).join(", ")}
  - Balasan API nggak return JSON media. Field data berisi script JS
    ter-obfuscate yang pas dievaluasi nge-render link download ke DOM. Jadi
    script itu dieksekusi browser, lalu hasilnya dibaca dari DOM.
  - Link download berupa token JWT berumur ±1 jam. Ambil ulang tepat sebelum
    download, jangan di-cache. Link itu sendiri nggak di-proteksi Cloudflare,
    jadi setelah didapat file-nya bisa ditarik langsung.
  - Cuma post/reel/tv yang didukung. Scraping profil belum diimplementasikan.`;
}

export async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      index: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = values.help ? null : resolveCommand(positionals)?.cmd;
  if (values.help || !cmd) {
    process.stderr.write(usage() + "\n");
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const port = Number(values.port || CDP_PORT) || CDP_PORT;
  const raw = resolveCommand(positionals).raw;
  if (!raw) throw new Error(`${cmd} butuh <instagram-url>\n\n${usage()}`);

  if (cmd === "info") {
    const out = toOutput(await scrape(raw, port));
    await new Promise((r) => process.stdout.write(JSON.stringify(out, null, 2) + "\n", r));
    return;
  }

  if (cmd === "download") {
    const data = await scrape(raw, port);
    const out = toOutput(data);
    const idx = Number(values.index || 0) || 0;
    const picked = out.items[idx];
    if (!picked) {
      throw new Error(`index ${idx} di luar jangkauan — item yang ada: 0..${out.items.length - 1}`);
    }
    const dir = values.out || "downloads";
    const ext = extFor(picked.url, picked.label) || ".mp4";
    const dest = `${dir.replace(/\/$/, "")}/${out.shortcode}${ext}`;
    const size = await downloadFile(picked.url, dest);
    const res = { ...out, quality: picked.label, saved: dest, bytes: size };
    await new Promise((r) => process.stdout.write(JSON.stringify(res, null, 2) + "\n", r));
    return;
  }

  throw new Error(`command tidak dikenal: ${cmd}\n\n${usage()}`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message || e}\n`);
    process.exitCode = 1;
  });
}
