/**
 * Name : SnapInsta Scraper (info media, link link + get, download video/foto)
 * Owner : Godhumanv2
 * Base Web : https://snapinsta.to (Instagram downloader - video, foto, reels,
 *            carousel, tanpa login)
 * Type : Scraper
 * Function : Scrape lengkap -> resolve link Instagram (post/reel/tv/carousel)
 *            jadi daftar item: thumbnail (field "link") + URL download
 *            (field "get", host dl.snapcdn.app) + label tipe (video/foto)
 *            + id media -> direct URL + headers. Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpReq } from 'node:http'
import { request as httpsReq } from 'node:https'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'

const SITE = 'https://snapinsta.to'
const LANDING = SITE + '/en46'
const API_VERIFY = SITE + '/api/userverify'
const API_SEARCH = SITE + '/api/ajaxSearch'
const API_VERSION = 'v2'
const API_LANG = 'en'
const TYPES = ['media', 'video', 'image']
const DEFAULT_TYPE = 'media'
const MEDIA_HOSTS = ['dl.snapcdn.app', 'i.snapcdn.app']
const SKIP_HOSTS = ['play.google.com', 'pagead2.googlesyndication.com']
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT = 30_000
const MEDIA_TIMEOUT = 180_000
const MAX_SIZE = 400_000_000
const RETRY = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function req(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT, maxRedirect = 5 } = {}) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  const run = (cur, hop) =>
    new Promise((resolve, reject) => {
      const u = new URL(cur)
      const mod = u.protocol === 'http:' ? httpReq : httpsReq
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
            'Accept-Language': 'en-US,en;q=0.9',
            ...(payload ? { 'Content-Length': payload.length } : {}),
            ...headers,
          },
          timeout,
        },
        (res) => {
          const chunks = []
          let size = 0
          res.on('data', (c) => {
            size += c.length
            if (size > MAX_SIZE) {
              rq.destroy(new Error('respons melebihi batas ' + MAX_SIZE + ' byte'))
              return
            }
            chunks.push(c)
          })
          res.on('end', () => {
            const out = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }
            const loc = out.headers.location
            if ([301, 302, 303, 307, 308].includes(out.status) && loc && hop < maxRedirect) {
              resolve(run(new URL(loc, cur).toString(), hop + 1))
              return
            }
            resolve(out)
          })
          res.on('error', reject)
        },
      )
      rq.on('timeout', () => rq.destroy(new Error('timeout ' + timeout + 'ms: ' + cur)))
      rq.on('error', reject)
      if (payload) rq.write(payload)
      rq.end()
    })
  return run(url, 0)
}

let curlOk = null
function curlAvailable() {
  if (curlOk === null) {
    const t = spawnSync('curl', ['--version'], { encoding: 'utf8', timeout: 10_000 })
    curlOk = !t.error && t.status === 0
  }
  return curlOk
}

function curlRun(args, { timeout = TIMEOUT, maxBuffer = 40_000_000 } = {}) {
  const t = spawnSync('curl', args.concat(['-w', '\n%{http_code}']), { encoding: 'buffer', timeout, maxBuffer })
  if (t.error) throw new Error('curl gagal dijalankan: ' + t.error.message)
  if (t.status !== 0) {
    const err = Buffer.concat([t.stderr || Buffer.alloc(0)]).toString('utf8').trim()
    throw new Error('curl keluar dengan kode ' + t.status + (err ? ': ' + err : ''))
  }
  const buf = t.stdout
  const cut = buf.lastIndexOf(0x0a)
  const status = Number(buf.slice(cut + 1).toString('utf8').trim())
  return { status, body: buf.slice(0, cut < 0 ? buf.length : cut) }
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&')
}

function apiHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: LANDING,
    Origin: SITE,
    'Content-Type': 'application/x-www-form-urlencoded',
    ...extra,
  }
}

function apiPost(url, form, headers = {}) {
  const hdrs = apiHeaders(headers)
  if (curlAvailable()) {
    const args = ['-s', '-S', '--max-time', String(Math.round(TIMEOUT / 1000))]
    for (const [k, v] of Object.entries(hdrs)) args.push('-H', k + ': ' + v)
    args.push('--data', form, url)
    const r = curlRun(args)
    return { via: 'curl', status: r.status, body: r.body, headers: {} }
  }
  const body = Buffer.from(form)
  return req(url, { method: 'POST', headers: hdrs, body }).then((r) => ({ via: 'node:https', status: r.status, body: r.body, headers: r.headers }))
}

function reqJson(res) {
  const text = res.body.toString('utf8')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, via: res.via, json, text }
}

const stripTags = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

function decodePayload(code) {
  const src = typeof code === 'string' ? code : String(code)
  const at = src.indexOf('eval(function')
  if (at < 0) return src
  const ctx = vm.createContext({})
  try {
    vm.runInContext(src.slice(0, at), ctx, { timeout: 5_000 })
    const call = src.slice(at + 'eval('.length).replace(/\)\s*;?\s*$/, '')
    const out = vm.runInContext('(' + call + ')', ctx, { timeout: 5_000 })
    return typeof out === 'string' ? out : src
  } catch {
    return src
  }
}

function unescapeHtml(src) {
  return String(src)
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function parseItems(html) {
  const text = unescapeHtml(html)
  const chunks = text.split('<div class="download-items">').slice(1)
  const items = []
  for (const chunk of chunks) {
    const block = chunk.split('<div class="download-items__btn">')[0] + (chunk.split('<div class="download-items__btn">')[1] || '')
    const hrefs = [...block.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    const get = hrefs.find((u) => !SKIP_HOSTS.includes(hostOf(u))) || ''
    const imgs = [...block.matchAll(/(?:data-src|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    const link = imgs.find((u) => !SKIP_HOSTS.includes(hostOf(u))) || ''
    if (!get && !link) continue
    const label = (block.match(/title="([^"]+)"/) || [, ''])[1].replace(/^Download /i, '')
    const icon = (block.match(/icon-dl([a-z]+)/) || [, ''])[1]
    const id = (block.match(/id="photo_dl_([0-9_]+)"/) || [, ''])[1]
    const kind = icon === 'video' ? 'video' : icon === 'image' || icon === 'photo' ? 'image' : 'media'
    if (get) items.push({ type: kind, label, link, get, mediaId: id })
  }
  const seen = new Set()
  return items.filter((it) => {
    const key = it.get || it.link
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function shortcodeOf(url) {
  const m = String(url).match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)
  return m ? m[1] : ''
}

async function turnstileToken(url) {
  const res = await apiPost(API_VERIFY, formEncode({ url }))
  const { json, text, status, via } = reqJson(res)
  if (status !== 200) throw new Error('userverify HTTP ' + status + ' via ' + via + (json ? '' : ': ' + stripTags(text).slice(0, 120)))
  const token = json && typeof json.token === 'string' ? json.token : ''
  if (!token) throw new Error('token turnstile tidak diberikan server (via ' + via + ')')
  return { token, via }
}

async function apiSearch(url, token, type) {
  const res = await apiPost(API_SEARCH, formEncode({ q: url, t: type, v: API_VERSION, lang: API_LANG, cftoken: token, html: '' }))
  const out = reqJson(res)
  if (out.status !== 200) throw new Error('ajaxSearch HTTP ' + out.status + ' via ' + out.via)
  if (!out.json) throw new Error('ajaxSearch bukan JSON: ' + stripTags(out.text).slice(0, 120))
  return out
}

async function resolveOnce(url, type) {
  const { token, via } = await turnstileToken(url)
  const res = await apiSearch(url, token, type)
  const json = res.json
  if (json.mess) throw new Error(stripTags(json.mess))
  const payload = json.data || ''
  if (!payload) throw new Error('respons kosong dari ajaxSearch')
  const html = json.v === 'v1' ? unescapeHtml(payload) : decodePayload(payload)
  const items = parseItems(html)
  if (!items.length) throw new Error('tidak ada item media di respons (' + payload.length + ' byte)')
  return { via: [via, res.via], version: json.v || 'v2', media: items }
}

export async function resolve(url, opts = {}) {
  const input = String(url || '').trim()
  if (!/^https?:\/\//i.test(input)) throw new Error('URL tidak valid: ' + input)
  if (!shortcodeOf(input)) throw new Error('link ini bukan post/reel/tv Instagram (profil, story, dan highlights butuh rute private-downloader yang belum didukung): ' + input)
  const type = opts.type && TYPES.includes(opts.type) ? opts.type : DEFAULT_TYPE
  const out = { ok: true, url: input, source: 'snapinsta.to', shortcode: shortcodeOf(input), type, via: [], warnings: [] }
  let last = null
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      const r = await resolveOnce(input, type)
      out.via = r.via
      out.version = r.version
      out.media = r.media.map((m, i) => ({ index: i, type: m.type, label: m.label, link: m.link, get: m.get, mediaId: m.mediaId }))
      break
    } catch (e) {
      last = e
      if (attempt < RETRY) await sleep(attempt * 2_000)
    }
  }
  if (!out.media) throw new Error('gagal resolve: ' + (last ? last.message : 'unknown'))
  const first = out.media[0]
  const kind = out.media.some((m) => m.type === 'video') ? 'video' : out.media.some((m) => m.type === 'image') ? 'photo' : 'media'
  out.result = {
    title: 'Instagram ' + (kind === 'video' ? 'Video' : kind === 'photo' ? 'Photo' : 'Media') + (out.shortcode ? ' ' + out.shortcode : ''),
    author: '',
    thumbnail: first.link || '',
    url: input,
    type: kind,
    quality: 'original',
  }
  out.count = out.media.length
  out.get = first.get
  out.link = first.link
  if (out.media.some((m) => !m.get)) out.warnings.push('sebagian item tidak punya URL download (field get kosong)')
  return out
}

export async function fetchBuffer(url, { timeout = MEDIA_TIMEOUT } = {}) {
  const r = await req(url, { timeout })
  if (r.status >= 400) throw new Error('HTTP ' + r.status + ' saat ambil media: ' + String(url).slice(0, 120))
  return { body: r.body, headers: r.headers, status: r.status }
}

function filenameFrom(headers, fallback) {
  const cd = headers && headers['content-disposition']
  if (cd) {
    const m = cd.match(/filename\*?=(?:utf-8'')?"?([^";]+)"?/i)
    if (m) return decodeURIComponent(m[1]).replace(/[/\\?%*:|"<>]/g, '_')
  }
  return fallback
}

function extFor(type, headers) {
  const ct = (headers && headers['content-type']) || ''
  if (ct.includes('mp4') || ct.includes('video')) return '.mp4'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  if (ct.includes('png')) return '.png'
  if (ct.includes('webp')) return '.webp'
  return type === 'video' ? '.mp4' : '.jpg'
}

function usage() {
  return [
    'SnapInsta Scraper (Instagram: post, reel, carousel, tv)',
    '',
    'Pakai:',
    '  node snapinsta.js info <url> [--type media|video|image]',
    '  node snapinsta.js download <url> [--index 0] [--out ./downloads] [--type ...]',
    '  node snapinsta.js --help',
    '',
    'Contoh:',
    '  node snapinsta.js info "https://www.instagram.com/reel/DLHx_WNoXoY/"',
    '  node snapinsta.js download "https://www.instagram.com/p/DdmURC4iIv8/" --index 3',
    '',
    'Field penting di output:',
    "  media[].link  -> URL foto/thumbnail media (i.snapcdn.app/photo?token=...)",
    '  media[].get   -> URL download sebenarnya (dl.snapcdn.app/get?token=...)',
    '',
    'Catatan jujur:',
    '  - halaman dilindungi Cloudflare Turnstile; token-nya diambil lewat fallback resmi',
    '    milik halaman itu sendiri: POST /api/userverify {url} -> token',
    '    Jadi Turnstile TIDAK di-solve, tidak butuh browser, tidak butuh captcha service.',
    '  - POST /api/ajaxSearch balas payload JS ter-obfuscate (v2) atau HTML (v1);',
    '    payload v2 di-decode statis (vm.runInContext) supaya link-nya kelihatan.',
    '  - endpoint snapinsta.to menolak TLS client Node (403 "Just a moment..."),',
    '    jadi request API dikirim lewat curl; media (dl/i.snapcdn.app) lewat node:https.',
    '  - token ?token=... di link download berumur pendek (~1 jam). Ambil ulang tepat',
    '    sebelum download, jangan di-cache.',
    '  - caption/author tidak disediakan endpoint ini; hanya tipe + link.',
    '  - hanya link post/reel/tv (instagram.com/p/..., /reel/..., /tv/...) yang didukung.',
    '    Link profil dan story ditolak server (rute private-downloader belum didukung).',
  ].join('\n')
}

async function runDownload(data, outDir, index) {
  const items = data.media.filter((m) => m.get)
  if (!items.length) throw new Error('tidak ada item dengan URL download')
  const pick = items[index] || items[0]
  const { body, headers } = await fetchBuffer(pick.get)
  fs.mkdirSync(outDir, { recursive: true })
  const name = filenameFrom(headers, 'snapinsta_' + (data.shortcode || Date.now()) + extFor(pick.type, headers))
  const file = path.join(outDir, name)
  fs.writeFileSync(file, body)
  return [{ index: pick.index, type: pick.type, file, bytes: body.length, url: pick.get }]
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage() + '\n')
    return
  }
  let values = {}
  let positionals = []
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        type: { type: 'string', default: '' },
        out: { type: 'string', default: './downloads' },
        index: { type: 'string', default: '0' },
      },
    }))
  } catch {
    process.stderr.write(usage() + '\n')
    process.exitCode = 1
    return
  }
  const command = positionals[0]
  const url = positionals[1]
  if (!command || !url) {
    process.stderr.write(usage() + '\n')
    process.exitCode = 1
    return
  }
  const opts = {}
  if (values.type) {
    if (!TYPES.includes(values.type)) throw new Error('type tidak dikenal: ' + values.type + ' (pilihan: ' + TYPES.join(', ') + ')')
    opts.type = values.type
  }
  const data = await resolve(url, opts)
  if (command === 'info') {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  if (command === 'download') {
    const index = Number.parseInt(values.index, 10)
    const files = await runDownload(data, values.out, Number.isFinite(index) ? index : 0)
    process.stdout.write(JSON.stringify({ ok: true, url: data.url, shortcode: data.shortcode, files }, null, 2) + '\n')
    return
  }
  throw new Error('command tidak dikenal: ' + command + ' (pilihan: info, download)')
}

function pickSocket(m, ctx) {
  return (ctx && (ctx.sock || ctx.conn || ctx.socket)) || (m && m.sock) || null
}

function pickUrl(m, ctx) {
  const sources = [
    ctx && ctx.text,
    m && m.text,
    m && m.body,
    Array.isArray(m && m.args) ? m.args.join(' ') : m && m.args,
    Array.isArray(ctx && ctx.args) ? ctx.args.join(' ') : ctx && ctx.args,
    m && m.quoted && m.quoted.body,
    m && m.quoted && m.quoted.text,
    m && m.quoted && m.quoted.message && m.quoted.message.conversation,
  ]
  for (const s of sources) {
    if (typeof s !== 'string') continue
    const hit = s.match(/https?:\/\/\S+/i)
    if (hit) return hit[0]
  }
  return ''
}

async function replyText(m, ctx, text) {
  if (m && typeof m.reply === 'function') return m.reply(text)
  const sock = pickSocket(m, ctx)
  if (sock && typeof sock.sendMessage === 'function') return sock.sendMessage(m.chat, { text }, { quoted: m })
  return null
}

function mimeFor(type) {
  return type === 'video' ? 'video/mp4' : 'image/jpeg'
}

const config = {
  name: 'snapinsta',
  alias: ['snapinsta', 'igdl', 'instadl'],
  category: ['scraper'],
  description: 'download video/foto/reels Instagram tanpa login via snapinsta.to',
  usage: '<link instagram>',
  example: '.snapinsta https://www.instagram.com/reel/DLHx_WNoXoY/',
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 8,
  limit: 1,
  energi: 1,
  isEnabled: true,
}

async function handler(m, ctx = {}) {
  const url = pickUrl(m, ctx)
  if (!url) {
    await replyText(m, ctx, 'Kirim link Instagram ya.\n' + usage())
    return
  }
  try {
    const data = await resolve(url, {})
    const first = data.media[0]
    const caption = [
      '*' + data.result.title + '*',
      '📦 ' + data.count + ' media',
      '🎞 ' + data.media.map((x) => x.type).join(', '),
    ].join('\n')
    const sock = pickSocket(m, ctx)
    if (!sock || typeof sock.sendMessage !== 'function') {
      await replyText(m, ctx, caption + '\n' + first.get)
      return
    }
    let body = null
    let sent = first
    for (const cand of data.media) {
      if (!cand.get) continue
      try {
        const r = await fetchBuffer(cand.get)
        body = r.body
        sent = cand
        break
      } catch {
        body = null
      }
    }
    const payload = { caption, mimetype: mimeFor(sent.type) }
    if (sent.type === 'video') payload.video = body || { url: sent.get }
    else payload.image = body || { url: sent.get }
    await sock.sendMessage(m.chat, payload, { quoted: m })
  } catch (e) {
    await replyText(m, ctx, 'Gagal: ' + (e && e.message ? e.message : String(e)))
  }
}

handler.command = /^(snapinsta|igdl|instadl)$/i
handler.tags = ['scraper']
handler.help = ['snapinsta <link instagram>']
handler.limit = 1
handler.premium = false
handler.owner = false
handler.config = config

export { config, handler }
export default handler

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => {
    process.stderr.write('error: ' + (e && e.message ? e.message : String(e)) + '\n')
    process.exitCode = 1
  })
}
