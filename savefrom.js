/**
 * Name : SaveFrom.co.id Scraper (resolve link -> info media + link download)
 * Owner : Godhumanv2
 * Base Web : https://savefrom.co.id (downloader video/musik multi platform)
 * Type : Scraper
 * Function : Scrape lengkap -> resolve link jadi info media (judul, durasi,
 *            author, thumbnail, kualitas) -> pilih format (video 720p, audio
 *            terbaik) -> direct signed download URL + headers yang dibutuhkan.
 *            Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpsReq } from 'node:https'
import { request as httpReq } from 'node:http'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SITE = 'https://savefrom.co.id'
const API = 'https://api-wh.savefrom.co.id'
const API_CONVERT = '/api/convert'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MEDIA_UA = 'Mozilla/5.0'
const TIMEOUT = 45_000
const RETRIES = 3
const MEDIA_CURL_TIMEOUT = 150_000
const MEDIA_ROUNDS = 4
const SIGN_SALT = 'f798d44177a88668ccff03b58ff945f002bc6ae2eea4901ba9596e3be5367706'
const SIGN_BASE_TS = 1791197287300
const NO_TRACK = { url: null, quality: null, sizeBytes: null, hasAudio: null, hasVideo: null }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const NAV = {
  'X-Requested-With': 'XMLHttpRequest',
  Origin: SITE,
  Referer: `${SITE}/`,
  'Accept-Language': 'en-US,en;q=0.9',
}

function req(url, { method = 'GET', headers = {}, body, maxRedirect = 5, timeout = TIMEOUT, retries = RETRIES } = {}) {
  let cur = url
  return (async () => {
    for (let hop = 0; hop <= maxRedirect; hop++) {
      const u = new URL(cur)
      const mod = u.protocol === 'http:' ? httpReq : httpsReq
      let out = null
      for (let i = 0; i <= retries; i++) {
        out = await new Promise((resolve) => {
          const rq = mod(
            {
              protocol: u.protocol,
              hostname: u.hostname,
              port: u.port || (u.protocol === 'http:' ? 80 : 443),
              path: u.pathname + u.search,
              method,
              servername: u.hostname,
              headers: {
                'User-Agent': UA,
                Accept: '*' + '/' + '*',
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
                ...headers,
              },
            },
            (res) => {
              const chunks = []
              res.on('data', (c) => chunks.push(c))
              res.on('end', () =>
                resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  body: Buffer.concat(chunks),
                  finalUrl: cur,
                })
              )
            }
          )
          rq.setTimeout(timeout, () => rq.destroy(new Error('timeout')))
          rq.on('error', (e) => resolve({ status: 0, error: e.message }))
          if (body) rq.write(body)
          rq.end()
        })
        if ((out.status === 0 || out.status === 429 || out.status >= 500) && i < retries) {
          await sleep(900 * (i + 1))
          continue
        }
        break
      }
      const loc = out.headers?.location
      if (method === 'GET' && loc && out.status >= 300 && out.status < 400) {
        cur = new URL(loc, cur).toString()
        continue
      }
      return out
    }
    throw new Error('gagal: kebanyakan redirect')
  })()
}

function reqJson(url, opts) {
  return req(url, opts).then((r) => {
    const text = r.body ? r.body.toString('utf8') : ''
    let json = null
    try {
      json = JSON.parse(text)
    } catch { }
    return { status: r.status, headers: r.headers, body: text, json, finalUrl: r.finalUrl }
  })
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

function form(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

function signedFields(url) {
  return {
    sf_url: url,
    ts: 'NaN',
    _ts: SIGN_BASE_TS,
    _tsc: 'NaN',
    _s: sha256(`${url}NaN${SIGN_SALT}`),
  }
}

function extractError(text) {
  if (!text) return null
  let msg = null
  const m = /\\"html\\":\\"(.*?)\\"(,|\})/.exec(text)
  if (m) msg = m[1]
  else {
    const alt = /"html":"(.*?)"/.exec(text)
    if (alt) msg = alt[1]
  }
  if (!msg) return null
  const inv = /"invalid_request":(true|false)/.exec(text)
  return {
    message: msg.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
    invalid: inv ? inv[1] === 'true' : null,
  }
}

function toNum(v) {
  if (Number.isFinite(v)) return v
  const s = String(v ?? '')
  return /^\d+$/.test(s) ? Number(s) : null
}

function shapeFormat(u) {
  return {
    type: u.type ?? null,
    ext: u.ext ?? null,
    quality: u.quality ?? null,
    qualityNumber: toNum(u.qualityNumber) ?? toNum(u.quality),
    videoCodec: u.videoCodec ?? null,
    audioCodec: u.audioCodec ?? null,
    audio: u.audio === true,
    noAudio: u.no_audio === true,
    sizeBytes: toNum(u.contentLength),
    itag: u.itag ?? null,
    converter: u.isConverterUI === true,
    url: u.url ?? null,
  }
}

function isAudio(f) {
  return f.audio === true || /\baudio\b/i.test(String(f.type)) || /^(?:m4a|opus|mp3|aac)$/i.test(String(f.ext))
}

function isVideo(f) {
  return !isAudio(f) && f.ext !== 'mp3'
}

function videoRank(f) {
  return [f.converter ? 0 : 1, f.ext === 'mp4' ? 0 : 1, f.noAudio ? 1 : 0]
}

function cmpArr(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function pickVideo(formats, want) {
  const vids = formats.filter(isVideo)
  if (!vids.length) return null
  const wanted = String(want).toLowerCase()
  if (wanted !== 'best' && wanted !== 'max') {
    const n = toNum(want)
    const hit = vids.filter((f) => f.qualityNumber === n)
    if (!hit.length) return null
    return hit.sort((a, b) => cmpArr(videoRank(a), videoRank(b)))[0]
  }
  const top = Math.max(...vids.map((f) => f.qualityNumber || 0))
  return vids
    .filter((f) => f.qualityNumber === top)
    .sort((a, b) => cmpArr(videoRank(a), videoRank(b)))[0]
}

function pickAudio(formats, want) {
  const auds = formats.filter(isAudio)
  if (!auds.length) return null
  const w = String(want).toLowerCase()
  const limited = /^(?:m4a|mp3|aac|opus|webm)$/.test(w) ? auds.filter((f) => String(f.ext).toLowerCase() === w) : auds
  if (!limited.length) return null
  return limited.sort((a, b) => {
    const d = (b.qualityNumber || 0) - (a.qualityNumber || 0)
    if (d) return d
    const n = (b.sizeBytes || 0) - (a.sizeBytes || 0)
    if (n) return n
    return String(b.ext).localeCompare(String(a.ext))
  })[0]
}

function pick(formats, { video, audio, audioFmt } = {}) {
  const out = []
  if (video) {
    const v = pickVideo(formats, video)
    if (!v) throw new Error(`kualitas video "${video}" nggak ada di daftar ini`)
    out.push(v)
  }
  if (audio) {
    const a = pickAudio(formats, audioFmt || 'best')
    if (!a) throw new Error(`track audio "${audioFmt || 'best'}" nggak ada di daftar ini`)
    out.push(a)
  }
  return out
}

function slug(s) {
  return (
    String(s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'media'
  )
}

async function convert(rawUrl, { log } = {}) {
  const url = String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('link harus http(s)')

  log?.('kirim request convert')
  const res = await reqJson(`${API}${API_CONVERT}`, {
    method: 'POST',
    headers: { ...NAV, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form(signedFields(url)),
  })

  if (res.status !== 200) throw new Error(`HTTP ${res.status} dari api convert`)
  if (!res.json || !Array.isArray(res.json.url)) {
    const e = extractError(res.body)
    if (e) throw new Error(`${e.message}${e.invalid ? ' (invalid_request)' : ''}`)
    throw new Error('respons api tak bisa dibaca')
  }

  const d = res.json
  return {
    source: url,
    page: `${SITE}/`,
    api: `${API}${API_CONVERT}`,
    id: d.id ?? null,
    hosting: d.hosting ?? null,
    title: d.meta?.title ?? null,
    duration: d.meta?.duration ?? null,
    author: d.meta?.author ?? null,
    thumbnail: d.thumb ?? null,
    videoQuality: Array.isArray(d.video_quality) ? d.video_quality : [],
    formats: d.url.map(shapeFormat),
  }
}

function curlGet(url, timeout = MEDIA_CURL_TIMEOUT) {
  const r = spawnSync(
    'curl',
    ['-s', '-L', '--max-time', String(Math.round(timeout / 1000)), '-A', MEDIA_UA, '-w', '\\n%{http_code}', url],
    { maxBuffer: 1024 * 1024 * 1024 }
  )
  if (r.error || r.status !== 0) {
    return { status: 0, error: r.error?.message || `curl exit ${r.status}`, body: Buffer.alloc(0) }
  }
  const cut = r.stdout.lastIndexOf(Buffer.from('\n'))
  return { status: parseInt(r.stdout.slice(cut + 1).toString('utf8'), 10) || 0, body: r.stdout.slice(0, cut) }
}

function looksLikeHtml(buf) {
  const head = buf.slice(0, 200).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

async function fetchMedia(url, log) {
  let why = 'HTTP 0'
  for (let round = 0; round < MEDIA_ROUNDS; round++) {
    if (round > 0) log?.(`percobaan ${round + 1}/${MEDIA_ROUNDS} (${why})`)
    const c = curlGet(url)
    if (c.status === 200 && c.body.length && !looksLikeHtml(c.body)) {
      log?.('unduh via curl')
      return { buffer: c.body, headers: c.headers, via: 'curl' }
    }
    why = c.status === 0 ? `curl ${c.error || 'gagal'}` : looksLikeHtml(c.body) ? 'HTML (konversi belum jadi)' : `curl HTTP ${c.status}`
    if (round < MEDIA_ROUNDS - 1) await sleep(4000 * (round + 1))
  }
  throw new Error(`gagal unduh setelah ${MEDIA_ROUNDS} percobaan (${why})`)
}

function targetPath(outArg, count, fileName) {
  if (!outArg) return null
  const trailing = /[\\/]$/.test(outArg)
  const exists = fs.existsSync(outArg)
  const isDir = count > 1 || trailing || (exists && fs.statSync(outArg).isDirectory())
  if (!isDir) return outArg
  const dir = outArg.replace(/[\\/]+$/, '')
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, fileName)
}

async function fetchOne(info, f, log) {
  const got = await fetchMedia(f.url, log)
  const cd = got.headers?.['content-disposition'] || ''
  const fromCd = /^filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd)
  const ext = String(f.ext || '').replace(/[^a-z0-9]/gi, '') || 'bin'
  const kind = isAudio(f) ? 'audio' : `p${f.qualityNumber || ''}`
  const fileName = fromCd ? decodeURIComponent(fromCd[1]) : `${slug(info.title)}_${kind}.${ext}`
  return {
    kind: isAudio(f) ? 'audio' : 'video',
    type: f.type,
    ext,
    quality: f.quality,
    qualityNumber: f.qualityNumber,
    videoCodec: f.videoCodec,
    audioCodec: f.audioCodec,
    bundledAudio: f.audio === true || f.noAudio === false,
    itag: f.itag,
    sizeBytes: got.buffer.length,
    fileName,
    via: got.via,
    buffer: got.buffer,
  }
}

async function download(rawUrl, { out, video, audio, audioFmt, log } = {}) {
  const info = await convert(rawUrl, { log })
  const wanted = pick(info.formats, { video, audio, audioFmt })
  if (!wanted.length) return { ...info, picked: [], saved: [] }

  const saved = []
  for (let i = 0; i < wanted.length; i++) {
    log?.(`unduh ${i + 1}/${wanted.length}: ${wanted[i].type} ${wanted[i].quality ?? ''}`)
    const r = await fetchOne(info, wanted[i], log)
    const dest = targetPath(out, wanted.length, r.fileName)
    if (dest) {
      fs.writeFileSync(dest, r.buffer)
      log?.(`tulis ${dest} (${r.buffer.length} byte)`)
    }
    const { buffer, ...rest } = r
    saved.push({ ...rest, savedTo: dest, url: wanted[i].url })
  }

  return {
    source: info.source,
    title: info.title,
    duration: info.duration,
    author: info.author,
    thumbnail: info.thumbnail,
    hosting: info.hosting,
    picked: saved,
    saved,
  }
}

function listTable(info) {
  const rows = info.formats.map((f) => ({
    type: f.type,
    q: f.quality,
    qn: f.qualityNumber,
    vcodec: f.videoCodec,
    acodec: f.audioCodec,
    audio: f.audio,
    noAudio: f.noAudio,
    size: f.sizeBytes,
    converter: f.converter,
    itag: f.itag,
  }))
  return { source: info.source, title: info.title, duration: info.duration, hosting: info.hosting, n: rows.length, formats: rows }
}

function stripUrl(f) {
  const { url, ...rest } = f
  return rest
}

const USAGE = `pakai:
  node savefrom.js info "<link>"                 info lengkap + semua link
  node savefrom.js list "<link>"                tabel ringkas, TANPA link panjang
  node savefrom.js get "<link>" --video 720     hanya mp4 720p (progressif, audio ikut)
  node savefrom.js get "<link>" --video best    video resolusi tertinggi yang ada
  node savefrom.js get "<link>" --audio         hanya track audio terbaik
  node savefrom.js get "<link>" --video 720 --audio --out ./dl
                                                video 720p + audio terbaik -> 2 file

download:
  node savefrom.js save "<link>" --video 720 --out ./video.mp4
  node savefrom.js save "<link>" --video 720 --audio --out ./dl/

opsi:
  --video <n|best>   pilih video: resolusi (720, 1080, 2160) atau "best"
  --audio            ikut ambil track audio terbaik
  --audio-fmt <ext>  batasi audio ke m4a / opus / mp3
  --out <path>       "save" saja. 1 hasil -> nama file, >1 hasil -> folder
  --full             "info" tetap tampilkan semua link (default info memang full)
  -q                 matiin log di stderr (stdout tetap JSON)

cara baca --video:
  Entry "mp4" (converter) = MP4 progresif milik savefrom, SUDAH berisi audio,
  pilih itu kalau mau satu file mp4 yang langsung bunyi.
  Entry "mp4 dash"/"webm dash" = video-only (noAudio true), wajib digabung
  dengan --audio kalau dipakai.

cara baca audio:
  qualityNumber di track audio itu BITRATE, bukan resolusi. Yang paling bagus
  biasanya opus 137; m4a 131 Runner-up.

catatan:
  - API di api-wh.savefrom.co.id, bukan di domain utama.
  - Field signature (ts/_ts/_tsc/_s) dari bundle link.chunk.js.
    _s = sha256(sf_url + ts + SALT).
  - Time check punya bug di sisi mereka: ts/_tsc berupa "NaN" lolos validasi.
    Jangan diubah ke angka, nanti dapat "there is a problem with your time
    settings".
  - Host media sf-converter.com nolak TLS client Node (hang, bukan error) tapi
    200 buat curl. Jadi probe direct dibatasi 10 detik lalu fallback curl;
    field "via" ngasih tahu file diambil lewat mana.
  - du.sf-converter.com/convert itu 302 ke file asli, dan kalau konversinya
    belum jadi dia balas HTTP 200 tapi isinya HTML SPA ("<title>Converter
    </title>") -- bukan error, jadi HARUS dicek isinya, bukan cuma status.
  - Link /get?payload=..., /convert?payload=... dan googlevideo
    ?videoplayback=... berumur pendek -- jangan di-cache, ambil ulang persis
    sebelum download.`

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

export async function resolve(rawUrl, opts = {}) {
  const info = await convert(rawUrl, opts)
  const wanted = pick(info.formats, {
    video: opts.video || 'best',
    audio: opts.audio === true,
    audioFmt: opts.audioFmt,
  })
  const video = wanted.find((f) => isVideo(f))
  const primary = video || wanted[0] || null
  const authorName = info.author?.unique_id || info.author?.nickname || info.author?.name || null
  return {
    platform: 'savefrom',
    method: 'convert',
    title: info.title || 'SaveFrom Media',
    author: authorName || '',
    thumbnail: info.thumbnail,
    duration: info.duration,
    hosting: info.hosting,
    media: wanted.map((f) => ({
      url: f.url,
      type: isAudio(f) ? 'audio' : 'video',
      quality: String(f.quality ?? f.qualityNumber ?? ''),
    })),
    result: {
      title: info.title || 'SaveFrom Media',
      author: authorName || '',
      thumbnail: info.thumbnail,
      duration: info.duration,
      hosting: info.hosting,
      url: primary ? primary.url : null,
      type: primary ? (isAudio(primary) ? 'audio' : 'video') : null,
      quality: primary ? String(primary.quality ?? primary.qualityNumber ?? '') : null,
      formats: info.formats.map((f) => ({
        url: f.url,
        type: isAudio(f) ? 'audio' : 'video',
        quality: String(f.quality ?? f.qualityNumber ?? ''),
      })),
    },
  }
}

function caption(user, r, media) {
  return [
    `╭━━━ *${user}*`,
    '┃ *SAVEFROM*',
    '╰━━━━━━━━━━━━━',
    '',
    `▸ title : ${r.title || '-'}`,
    r.author ? `▸ author : ${r.author}` : null,
    r.duration ? `▸ duration : ${r.duration}` : null,
    media?.quality ? `▸ quality : ${media.quality}` : null,
    `▸ type : ${media?.type || '-'}`,
    '',
    '> powered by scraper-bot-kit',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const USAGE_BOT = '╭━━━ *SAVEFROM* ━━━╮\n\n▸ pakai: .savefrom <link>\n▸ contoh: .savefrom https://www.tiktok.com/@user/video/123\n\n> supported: multi platform\n╰━━━━━━━━━━━━━━━'

export default {
  name: 'savefrom',
  command: ['savefrom', 'sf'],
  alias: ['sf'],
  category: ['scraper'],
  description: 'ambil media dari savefrom.co.id',
  usage: '<link>',
  example: '.savefrom <link>',
  async run({ m, args, q }) {
    const quotedText =
      q?.text ||
      q?.message?.conversation ||
      q?.message?.extendedTextMessage?.text ||
      q?.raw?.message?.conversation ||
      q?.raw?.message?.extendedTextMessage?.text ||
      ''
    const candidate =
      args.find((value) => /^https?:\/\//i.test(value)) || quotedText.match(/https?:\/\/\S+/i)?.[0]

    if (!candidate) return m.reply(USAGE_BOT)

    const sender = String(m.sender || '').split('@')[0]
    await m.react('🕐').catch(() => {})

    try {
      const r = await resolve(candidate)
      const media = r.media.find((item) => item.type === 'video') || r.media[0]
      if (!media?.url) throw new Error('media tidak ditemukan')

      await m.react('✅').catch(() => {})
      return m.sendVideo(media.url, caption(sender, r, media))
    } catch (error) {
      await m.react('❌').catch(() => {})
      return m.reply(`╭━━━ *SAVEFROM* ━━━╮\n\n▸ gagal: ${error.message || 'tidak diketahui'}\n▸ cek link-nya, atau coba lagi nanti\n╰━━━━━━━━━━━━━━━`)
    }
  },
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  const { values: v, positionals } = parseArgs({
    options: {
      video: { type: 'string', default: '' },
      audio: { type: 'boolean', default: false },
      'audio-fmt': { type: 'string', default: '' },
      out: { type: 'string', default: '' },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
    allowPositionals: true,
  })
  const log = v.quiet ? null : (m) => process.stderr.write(`[*] ${m}\n`)
  const [cmd, arg] = positionals

  if (cmd === 'help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  if (!cmd) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(1)
  }
  if (!arg) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(1)
  }

  const filter = { video: v.video || undefined, audio: v.audio, audioFmt: v['audio-fmt'] || undefined }

  let out
  if (cmd === 'info') {
    const info = await convert(arg, { log })
    if (v.video || v.audio) {
      const chosen = pick(info.formats, filter).map((f) => ({ ...stripUrl(f), url: f.url }))
      out = { ...info, formats: chosen }
    } else {
      out = info
    }
  } else if (cmd === 'list') {
    out = listTable(await convert(arg, { log }))
  } else if (cmd === 'get') {
    out = await download(arg, { log, ...filter })
  } else if (cmd === 'save') {
    out = await download(arg, { log, out: v.out, ...filter })
  } else {
    throw new Error(`command tak dikenal: ${cmd}`)
  }

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
}

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message || e}\n`)
    process.exitCode = 1
  })
}

export { convert, download, listTable, pick, pickVideo, pickAudio, isAudio, isVideo, shapeFormat, req, reqJson, curlGet }