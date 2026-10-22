/**
 * Name : SaveTik Scraper (info post, download video/mp3/foto/story, info akun)
 * Owner : Godhumanv2
 * Base Web : https://savetik.org (SaveTik - downloader TikTok/Douyin tanpa
 *            watermark; domain savetik.co diblokir Cloudflare challenge)
 * Type : Scraper
 * Function : Scrape lengkap -> info post (judul/deskripsi, author, akun:
 *            username, follower, signature, avatar, thumbnail, durasi,
 *            statistik, musik) -> link download (video MP4, audio MP3,
 *            galeri foto, story) -> direct URL + headers yang dibutuhkan.
 *            Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpsReq } from 'node:https'
import { request as httpReq } from 'node:http'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const SITE = 'https://savetik.org'
const WP_AJAX = SITE + '/wp-admin/admin-ajax.php'
const TOOL_ROUTES = {
  video: '/id/',
  douyin: '/id/douyin-downloader/',
  slideshow: '/id/download-photo/',
  story: '/id/download-story/',
  mp3: '/id/tiktok-mp3-downloader/',
  notes: '/id/download-tiktok-notes/',
}
const DT_API = 'https://demo.douyin.wtf'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT = 60_000
const MAX_SIZE = 300_000_000
const POLL_MAX = 40
const POLL_GAP = 2_500
const HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function req(url, { method = 'GET', headers = {}, body, maxRedirect = 5, timeout = TIMEOUT } = {}) {
  let cur = url
  return (async () => {
    for (let hop = 0; hop <= maxRedirect; hop++) {
      const u = new URL(cur)
      const mod = u.protocol === 'http:' ? httpReq : httpsReq
      const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      const hdrs = {
        'User-Agent': UA,
        ...HEADERS,
        ...(payload ? { 'Content-Length': payload.length } : {}),
        ...headers,
      }
      const out = await new Promise((resolve, reject) => {
        const rq = mod(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method,
            servername: u.hostname,
            headers: hdrs,
            timeout,
          },
          (res) => {
            const chunks = []
            let size = 0
            res.on('data', (c) => {
              size += c.length
              if (size > MAX_SIZE) {
                rq.destroy()
                reject(new Error('respons melebihi batas ukuran ' + MAX_SIZE))
                return
              }
              chunks.push(c)
            })
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
            res.on('error', reject)
          },
        )
        rq.on('timeout', () => rq.destroy(new Error('timeout ' + timeout + 'ms')))
        rq.on('error', reject)
        if (payload) rq.write(payload)
        rq.end()
      })
      const redirect = [301, 302, 303, 307, 308].includes(out.status) && out.headers.location
      if (redirect && hop < maxRedirect) {
        cur = new URL(out.headers.location, cur).toString()
        continue
      }
      return out
    }
    throw new Error('terlalu banyak redirect')
  })()
}

function reqJson(url, opts = {}) {
  return (async () => {
    const r = await req(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } })
    const text = r.body.toString('utf8')
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('respons bukan JSON (HTTP ' + r.status + '): ' + text.slice(0, 200))
    }
    return { status: r.status, headers: r.headers, json }
  })()
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&')
}

async function fetchBuffer(url, { timeout = 180_000, headers = {} } = {}) {
  const r = await req(url, { timeout, headers })
  if (r.status >= 400) throw new Error('HTTP ' + r.status + ' saat ambil media: ' + url.slice(0, 120))
  return r.body
}

function detectPlatform(url) {
  const u = String(url).toLowerCase()
  if (u.includes('douyin')) return 'douyin'
  if (u.includes('tiktok')) return 'tiktok'
  return 'tiktok'
}

function detectTool(url, platform) {
  const u = String(url).toLowerCase()
  if (platform === 'douyin') return 'douyin'
  if (u.includes('/photo/')) return 'slideshow'
  if (u.includes('/story/')) return 'story'
  if (u.includes('/note/')) return 'notes'
  return 'video'
}

async function savetikPage(route) {
  const r = await req(SITE + route)
  if (r.status >= 400) throw new Error('halaman ' + route + ' balas HTTP ' + r.status)
  const html = r.body.toString('utf8')
  const nonce = html.match(/"nonce":"([A-Za-z0-9]+)"/)
  const tool = html.match(/name="tool"[^>]*value="([a-z]+)"/)
  if (!nonce) throw new Error('nonce tidak ditemukan di ' + route)
  return { nonce: nonce[1], tool: tool ? tool[1] : '' }
}

async function savetikResolve(url, tool) {
  const route = TOOL_ROUTES[tool] || TOOL_ROUTES.video
  const page = await savetikPage(route)
  const body = formEncode({
    action: 'mtd_download',
    nonce: page.nonce,
    url,
    tool: page.tool || tool,
  })
  const r = await req(WP_AJAX, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      Referer: SITE + route,
      Origin: SITE,
    },
    body,
  })
  const text = r.body.toString('utf8')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('admin-ajax balas bukan JSON (HTTP ' + r.status + '): ' + text.slice(0, 200))
  }
  if (!json.success) {
    const msg = json.data && (json.data.message || json.data.code)
    throw new Error(msg ? String(msg) : 'savetik menolak: ' + text.slice(0, 200))
  }
  return { data: json.data || {}, tool: page.tool || tool, route }
}

async function dtSession() {
  const demo = await reqJson(DT_API + '/api/v1/auth/demo')
  const cred = demo.json && demo.json.data
  if (!cred || !cred.username) throw new Error('kredensial demo API publik tidak tersedia')
  const login = await req(DT_API + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cred.username, password: cred.password }),
  })
  const raw = login.headers['set-cookie']
  const cookie = (Array.isArray(raw) ? raw[0] : raw || '').split(';')[0]
  if (!cookie) throw new Error('login API publik gagal, tidak ada session cookie')
  return cookie
}

async function dtResolve(cookie, url, platform) {
  const target = DT_API + '/api/v1/' + platform + '/video?url=' + encodeURIComponent(url) + '&include_raw=true'
  const r = await reqJson(target, { headers: { Cookie: cookie } })
  const json = r.json
  if (r.status === 202 && json && json.data && json.data.task_id) {
    const taskId = json.data.task_id
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_GAP)
      const t = await reqJson(DT_API + '/api/v1/tasks/' + taskId, { headers: { Cookie: cookie } })
      const state = t.json && t.json.data && t.json.data.state
      if (state === 'done') return t.json.data.data
      if (state === 'failed') {
        const e = t.json.data.error || {}
        throw new Error('API publik gagal: ' + (e.message || e.code || 'tidak diketahui'))
      }
    }
    throw new Error('API publik timeout menunggu task ' + taskId)
  }
  if (!json || json.success === false) {
    const e = (json && json.error) || {}
    throw new Error('API publik: ' + (e.message || 'respons tidak dikenali'))
  }
  return json.data
}

function pushUrl(list, url, label, extra) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
  if (list.some((x) => x.url === url)) return
  list.push(Object.assign({ url, label: label || 'Media' }, extra || {}))
}

function rawCandidates(raw, platform) {
  const out = { video: [], audio: [], image: [] }
  if (!raw) return out
  const rv = raw.video || {}
  if (platform === 'douyin') {
    const pa = rv.play_addr || {}
    for (const u of pa.url_list || []) pushUrl(out.video, u, 'Video original')
    for (const br of rv.bit_rate || []) {
      const b = br.play_addr || {}
      for (const u of b.url_list || []) {
        pushUrl(out.video, u, 'Video ' + (br.gear_name || br.quality_type || ''), {
          quality: b.width && b.height ? b.width + 'x' + b.height : null,
          width: b.width || null,
          height: b.height || null,
        })
      }
    }
    const da = rv.download_addr || {}
    for (const u of da.url_list || []) pushUrl(out.video, u, 'Video (ada watermark)')
    const mu = raw.music && raw.music.play_url && raw.music.play_url.url
    for (const u of (mu && mu.url_list) || []) pushUrl(out.audio, u, 'Audio ' + ((raw.music && raw.music.title) || ''))
    for (const im of raw.image_list || []) for (const u of im.url_list || []) pushUrl(out.image, u, 'Foto')
    for (const im of raw.images || []) for (const u of im.url_list || []) pushUrl(out.image, u, 'Foto')
  } else {
    pushUrl(out.video, rv.playAddr, 'Video original')
    for (const b of rv.bitrateInfo || []) {
      const pa = b.PlayAddr || {}
      const list = Array.isArray(pa.UrlList) ? pa.UrlList : pa.UrlList ? [pa.UrlList] : []
      for (const u of list) {
        pushUrl(out.video, u, 'Video ' + (b.GearName || ''), {
          quality: pa.Width && pa.Height ? pa.Width + 'x' + pa.Height : null,
          width: pa.Width || null,
          height: pa.Height || null,
        })
      }
    }
    pushUrl(out.audio, raw.music && raw.music.playUrl, 'Audio ' + ((raw.music && raw.music.title) || ''))
    const ip = raw.imagePost || {}
    for (const im of ip.images || []) {
      for (const u of (im.imageURL && im.imageURL.urlList) || []) pushUrl(out.image, u, 'Foto')
    }
    for (const u of (ip.cover && ip.cover.imageURL && ip.cover.imageURL.urlList) || []) pushUrl(out.image, u, 'Cover')
  }
  return out
}

function pickMedia(media, tool) {
  const want = tool === 'mp3' ? 'audio' : tool === 'slideshow' ? 'image' : null
  if (want) {
    const hit = media.filter((x) => x.type === want)
    if (hit.length) return hit[0]
  }
  const order = ['video', 'image', 'audio']
  for (const t of order) {
    const hit = media.find((x) => x.type === t)
    if (hit) return hit
  }
  return media[0] || null
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return ''
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m + ':' + String(r).padStart(2, '0')
}

export async function resolve(url, opts = {}) {
  const input = String(url || '').trim()
  if (!/^https?:\/\//i.test(input)) throw new Error('URL tidak valid: ' + input)
  const platform = opts.platform && ['douyin', 'tiktok'].includes(opts.platform) ? opts.platform : detectPlatform(input)
  const tool = opts.tool && TOOL_ROUTES[opts.tool] ? opts.tool : detectTool(input, platform)

  const out = { ok: true, url: input, platform, tool, via: [], warnings: [] }
  let api = null
  let sv = null

  try {
    const cookie = await dtSession()
    api = await dtResolve(cookie, input, platform)
    out.via.push('demo.douyin.wtf')
  } catch (e) {
    out.warnings.push('api-publik: ' + e.message)
  }

  try {
    sv = await savetikResolve(input, tool)
    out.via.push('savetik.org')
  } catch (e) {
    out.warnings.push('savetik.org: ' + e.message)
  }

  if (!api && !sv) throw new Error(out.warnings.join(' | '))

  const media = []
  if (sv) {
    for (const d of sv.data.downloads || []) {
      if (!d || !d.url) continue
      media.push({
        type: d.type || 'video',
        url: d.url,
        label: d.label || d.filename || 'Download',
        filename: d.filename || null,
        source: 'savetik.org',
      })
    }
  }
  if (api) {
    const v = api.media && api.media.video
    if (v && v.url) {
      media.push({
        type: 'video',
        url: v.url,
        label: 'Video original',
        quality: v.width && v.height ? v.width + 'x' + v.height : 'original',
        width: v.width || null,
        height: v.height || null,
        sizeBytes: v.size_bytes || null,
        watermark: v.watermark === true,
        source: 'api-publik',
      })
    }
    if (api.music && api.music.play_url) {
      media.push({
        type: 'audio',
        url: api.music.play_url,
        label: 'Audio (' + (api.music.title || 'sound') + ')',
        durationMs: api.music.duration_ms || null,
        source: 'api-publik',
      })
    }
    const images = (api.media && api.media.images) || []
    images.forEach((im, i) => {
      if (im && im.url) media.push({ type: 'image', url: im.url, label: 'Foto ' + (i + 1), source: 'api-publik' })
    })
    const raw = rawCandidates(api.raw, platform)
    for (const item of raw.video) media.push(Object.assign({ type: 'video', source: 'api-publik' }, item))
    for (const item of raw.audio) media.push(Object.assign({ type: 'audio', source: 'api-publik' }, item))
    for (const item of raw.image) media.push(Object.assign({ type: 'image', source: 'api-publik' }, item))
  }

  const primary = pickMedia(media, tool)
  const cover = api && api.media && api.media.covers && api.media.covers[0] ? api.media.covers[0].url : null
  const author = (api && api.author) || {}
  const durationMs = (api && api.duration_ms) || (sv && sv.data.duration ? sv.data.duration * 1000 : null)
  const title = (api && (api.description || api.title)) || (sv && sv.data.title) || ''

  out.result = {
    title,
    author: author.nickname || (sv && sv.data.author) || '',
    thumbnail: (sv && sv.data.thumbnail) || cover || (media.find((m) => m.type === 'image') || {}).url || null,
    url: primary ? primary.url : null,
    type: primary ? primary.type : null,
    quality: primary ? primary.quality || null : null,
    description: (api && api.description) || (sv && sv.data.title) || '',
    account: {
      username: author.unique_id || null,
      nickname: author.nickname || null,
      signature: author.signature || null,
      verified: author.verified === true,
      followers: (author.stats && author.stats.follower_count) || null,
      likes: (author.stats && author.stats.total_digg) || null,
      avatar: author.avatar && author.avatar.url ? author.avatar.url : null,
      url: author.web_url || null,
    },
    kind: (api && api.kind) || null,
    durationMs,
    durationLabel: (sv && sv.data.duration_label) || fmtDuration(durationMs),
    stats: (api && api.stats) || null,
    music: api && api.music ? { title: api.music.title, author: api.music.author, url: api.music.play_url } : null,
    location: (api && api.location) || null,
    createdAt: (api && api.created_at) || null,
    webUrl: (api && api.web_url) || null,
    tags: (api && api.tags) || [],
  }
  out.media = media
  out.savetik = sv
    ? {
        tool: sv.tool,
        route: sv.route,
        title: sv.data.title || null,
        author: sv.data.author || null,
        thumbnail: sv.data.thumbnail || null,
        duration: sv.data.duration || null,
        durationLabel: sv.data.duration_label || null,
        downloads: (sv.data.downloads || []).map((d) => ({ label: d.label, type: d.type, url: d.url, filename: d.filename })),
      }
    : null
  return out
}

function usage() {
  return [
    'SaveTik Scraper (TikTok + Douyin) - info post, info akun, link download',
    '',
    'Pakai:',
    '  node savetik.js info <url> [--tool video|mp3|slideshow|story|notes|douyin]',
    '  node savetik.js download <url> [--tool ...] [--out ./downloads]',
    '  node savetik.js --help',
    '',
    'Contoh:',
    '  node savetik.js info "https://www.tiktok.com/@user/video/123"',
    '  node savetik.js info "https://v.douyin.com/abc123/" --tool douyin',
    '  node savetik.js download "https://www.tiktok.com/@user/photo/123" --tool slideshow --out ./dl',
    '',
    'Sumber data:',
    '  savetik.org        -> link download SaveTik (video/mp3/foto/story/notes)',
    '  demo.douyin.wtf   -> API publik Douyin_TikTok_Download_API (info akun + URL CDN asli)',
    '',
    'Catatan jujur:',
    '  - domain savetik.co diblokir Cloudflare challenge (butuh browser), jadi pakai savetik.org',
    '  - tool douyin di savetik.org butuh cookie server, jadi data Douyin diambil dari API publik',
  ].join('\n')
}

function extFor(type, url) {
  if (type === 'audio') return 'mp3'
  if (type === 'image') {
    const m = String(url).match(/\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i)
    return m ? m[1].toLowerCase() : 'jpg'
  }
  const m = String(url).match(/\.(mp4|webm|mov)(?:$|[?#])/i)
  return m ? m[1].toLowerCase() : 'mp4'
}

function slugOf(data) {
  const base = String((data.result && data.result.title) || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base.length >= 3 ? base.slice(0, 60) : 'savetik-' + (data.platform || 'media')
}

async function saveItem(item, buf, outDir, data, index, many) {
  const slug = slugOf(data)
  const name = item.filename
    ? item.filename
    : slug + (many ? '-' + String(index + 1).padStart(2, '0') : '') + '.' + extFor(item.type, item.url)
  const file = path.resolve(outDir, name)
  fs.writeFileSync(file, buf)
  return { file, sizeBytes: buf.length, type: item.type, url: item.url, label: item.label }
}

function wantedType(tool) {
  return tool === 'mp3' ? 'audio' : tool === 'slideshow' ? 'image' : 'video'
}

function groupBySource(items) {
  const groups = []
  for (const item of items) {
    const key = item.source || 'api-publik'
    let g = groups.find((x) => x.key === key)
    if (!g) {
      g = { key, items: [] }
      groups.push(g)
    }
    g.items.push(item)
  }
  return groups
}

async function runDownload(data, outDir) {
  const want = wantedType(data.tool)
  const candidates = data.media.filter((m) => m.type === want)
  if (!candidates.length) throw new Error('tidak ada media ' + want + ' untuk link itu')
  fs.mkdirSync(outDir, { recursive: true })
  if (want === 'image') {
    let last = null
    for (const g of groupBySource(candidates)) {
      const files = []
      for (const item of g.items) {
        let buf = null
        try {
          buf = await fetchBuffer(item.url)
        } catch (e) {
          last = e
          continue
        }
        files.push(await saveItem(item, buf, outDir, data, files.length, true))
      }
      if (files.length) return files
    }
    throw last || new Error('gagal mengunduh foto')
  }
  let last = null
  for (const item of candidates) {
    try {
      const buf = await fetchBuffer(item.url)
      return [await saveItem(item, buf, outDir, data, 0, false)]
    } catch (e) {
      last = e
    }
  }
  throw last || new Error('gagal mengunduh media')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage() + '\n')
    return
  }
  let values = { tool: '', out: './downloads' }
  let positionals = []
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        tool: { type: 'string', default: '' },
        out: { type: 'string', default: './downloads' },
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
  if (values.tool) {
    if (!TOOL_ROUTES[values.tool]) {
      throw new Error('tool tidak dikenal: ' + values.tool + ' (pilihan: ' + Object.keys(TOOL_ROUTES).join(', ') + ')')
    }
    opts.tool = values.tool
  }
  const data = await resolve(url, opts)
  if (command === 'info') {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  if (command === 'download') {
    const files = await runDownload(data, values.out)
    process.stdout.write(JSON.stringify({ ok: true, url: data.url, tool: data.tool, files }, null, 2) + '\n')
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
  if (sock && typeof sock.sendMessage === 'function') {
    return sock.sendMessage(m.chat, { text }, { quoted: m })
  }
  return null
}

const config = {
  name: 'savetik',
  alias: ['savetik', 'savetikdl', 'savetikdownload'],
  category: ['scraper'],
  description: 'Scrape SaveTik: info post + info akun TikTok/Douyin, download video/mp3/foto/story',
  usage: '<link tiktok|douyin>',
  example: '.savetik https://www.tiktok.com/@user/video/1234567890',
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
    await replyText(m, ctx, 'Kirim link TikTok atau Douyin ya.\n' + usage())
    return
  }
  try {
    const data = await resolve(url, {})
    const want = wantedType(data.tool)
    const candidates = data.media.filter((m) => m.type === want)
    const item = candidates[0]
    if (!item) {
      await replyText(m, ctx, 'Media tidak ditemukan untuk link itu.')
      return
    }
    const caption = [
      '*' + (data.result.title || 'SaveTik') + '*',
      data.result.author ? '👤 ' + data.result.author : '',
      data.result.account && data.result.account.username ? '🎵 @' + data.result.account.username : '',
      data.result.account && data.result.account.followers ? '⭐ ' + data.result.account.followers + ' followers' : '',
      data.result.durationLabel ? '⏱ ' + data.result.durationLabel : '',
    ]
      .filter(Boolean)
      .join('\n')
    const sock = pickSocket(m, ctx)
    if (!sock || typeof sock.sendMessage !== 'function') {
      await replyText(m, ctx, caption + '\n' + item.url)
      return
    }
    let buf = null
    let sent = item
    for (const cand of candidates) {
      try {
        buf = await fetchBuffer(cand.url)
        sent = cand
        break
      } catch {
        buf = null
      }
    }
    const payload = { caption, mimetype: mimeFor(sent.type) }
    if (sent.type === 'video') payload.video = buf || { url: sent.url }
    else if (sent.type === 'audio') payload.audio = buf || { url: sent.url }
    else payload.image = buf || { url: sent.url }
    await sock.sendMessage(m.chat, payload, { quoted: m })
  } catch (e) {
    await replyText(m, ctx, 'Gagal: ' + (e && e.message ? e.message : String(e)))
  }
}

function mimeFor(type) {
  if (type === 'audio') return 'audio/mpeg'
  if (type === 'image') return 'image/jpeg'
  return 'video/mp4'
}

handler.command = /^(savetik|savetikdl|savetikdownload)$/i
handler.tags = ['scraper']
handler.help = ['savetik <link tiktok|douyin>']
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
