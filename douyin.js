/**
 * Name : Douyin Scraper (info post, info akun, download video/foto/audio)
 * Owner : Godhumanv2
 * Base Web : https://www.douyin.com (Douyin - share video, note/foto, profil user)
 * Type : Scraper
 * Function : Scrape lengkap -> info post Douyin (judul/deskripsi, hashtag,
 *            id post, durasi, waktu upload, statistik, musik, cover) + info
 *            akun (nickname, douyin id, signature, follower, following,
 *            jumlah like, jumlah post, avatar) -> link download (video MP4
 *            multi kualitas, audio MP3, galeri foto) -> direct URL + headers
 *            yang dibutuhkan. Output JSON ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpsReq } from 'node:https'
import { request as httpReq } from 'node:http'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const API_LIST = (process.env.DOUYIN_API || 'https://demo.douyin.wtf')
  .split(',')
  .map((x) => x.trim().replace(/\/+$/, ''))
  .filter(Boolean)
const SITE = 'https://www.douyin.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT = 60_000
const MAX_SIZE = 300_000_000
const POLL_MAX = 40
const POLL_GAP = 2_500
const HOSTS = ['douyin.com', 'iesdouyin.com', 'amemv.com']

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
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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

async function fetchBuffer(url, { timeout = 180_000, headers = {} } = {}) {
  const r = await req(url, { timeout, headers })
  if (r.status >= 400) throw new Error('HTTP ' + r.status + ' saat ambil media: ' + url.slice(0, 120))
  return r.body
}

const sessionState = { base: null, cookie: null }

async function login(base) {
  const demo = await reqJson(base + '/api/v1/auth/demo')
  const cred = demo.json && demo.json.data
  if (!cred || !cred.username) throw new Error('kredensial demo API tidak tersedia di ' + base)
  const res = await req(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cred.username, password: cred.password }),
  })
  const raw = res.headers['set-cookie']
  const cookie = (Array.isArray(raw) ? raw[0] : raw || '').split(';')[0]
  if (!cookie) throw new Error('login API gagal di ' + base + ', tidak ada session cookie')
  return cookie
}

async function apiCallOnce(base, cookie, pathname, query) {
  const target = base + pathname + (query ? '?' + query : '')
  const r = await reqJson(target, { headers: { Cookie: cookie } })
  const json = r.json
  if (r.status === 202 && json && json.data && json.data.task_id) {
    const taskId = json.data.task_id
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_GAP)
      const t = await reqJson(base + '/api/v1/tasks/' + taskId, { headers: { Cookie: cookie } })
      const state = t.json && t.json.data && t.json.data.state
      if (state === 'done') return t.json.data.data
      if (state === 'failed') {
        const e = (t.json.data && t.json.data.error) || {}
        throw new Error('API gagal: ' + (e.message || e.code || 'tidak diketahui'))
      }
    }
    throw new Error('API timeout menunggu task ' + taskId)
  }
  if (!json || json.success === false) {
    const e = (json && json.error) || {}
    const code = e.code || ''
    if (code === 'UNAUTHENTICATED') {
      sessionState.cookie = null
      throw new Error('sesi API kedaluwarsa di ' + base)
    }
    throw new Error('API: ' + (e.message || 'respons tidak dikenali'))
  }
  return json.data
}

async function apiCall(pathname, params = {}) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&')
  let last = null
  for (let i = 0; i < API_LIST.length; i++) {
    const base = API_LIST[i]
    try {
      let cookie = sessionState.base === base ? sessionState.cookie : null
      if (!cookie) cookie = await login(base)
      sessionState.base = base
      sessionState.cookie = cookie
      return await apiCallOnce(base, cookie, pathname, query)
    } catch (e) {
      last = e
      sessionState.cookie = null
      if (i < API_LIST.length - 1) await sleep(700 * (i + 1))
    }
  }
  throw new Error(
    'semua instance API gagal (' + API_LIST.join(', ') + '): ' + (last ? last.message : 'tidak diketahui'),
  )
}

function isDouyin(url) {
  const u = String(url).toLowerCase()
  return HOSTS.some((h) => u.includes(h))
}

function classify(url) {
  const u = String(url)
  const idMatch = u.match(/(?:video|note|n|slides)\/(\d{6,})/i) || u.match(/modal_id=(\d{6,})/i) || u.match(/aweme\/v1\/aweme\/(\d{6,})/i)
  const userMatch = u.match(/\/user\/([A-Za-z0-9_-]{10,})/i)
  const id = idMatch ? idMatch[1] : null
  const secUid = userMatch ? userMatch[1] : null
  if (id) return { type: 'post', id, secUid }
  if (secUid) return { type: 'user', id: null, secUid }
  if (u.includes('douyin.com')) return { type: 'short', id: null, secUid: null }
  return { type: 'unknown', id: null, secUid: null }
}

function urlList(item) {
  if (!item) return []
  if (Array.isArray(item)) return item.filter((x) => typeof x === 'string')
  if (typeof item === 'string') return [item]
  if (Array.isArray(item.url_list)) return item.url_list.filter((x) => typeof x === 'string')
  if (typeof item.url_list === 'string') return [item.url_list]
  if (typeof item.url === 'string') return [item.url]
  if (Array.isArray(item.UrlList)) return item.UrlList.filter((x) => typeof x === 'string')
  if (typeof item.UrlList === 'string') return [item.UrlList]
  if (typeof item.Url === 'string') return [item.Url]
  return []
}

function pushUrl(list, url, label, extra) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
  if (list.some((x) => x.url === url)) return
  list.push(Object.assign({ url, label: label || 'Media' }, extra || {}))
}

function collectQualities(raw) {
  const out = []
  const rv = (raw && raw.video) || {}
  for (const br of rv.bit_rate || []) {
    const pa = br.play_addr || {}
    const w = pa.width || null
    const h = pa.height || null
    for (const u of urlList(pa)) {
      pushUrl(out, u, 'Video ' + (br.gear_name || br.quality_type || ''), {
        quality: w && h ? w + 'x' + h : null,
        width: w,
        height: h,
        bitrate: br.bit_rate || null,
      })
    }
  }
  out.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))
  return out
}

function collectMedia(data, raw) {
  const media = []
  const qualities = collectQualities(raw)
  for (const q of qualities) media.push(Object.assign({ type: 'video', source: 'api' }, q))
  const music = (raw && raw.music && raw.music.play_url && raw.music.play_url.url) || null
  for (const u of urlList(music)) pushUrl(media, u, 'Audio ' + ((raw.music && raw.music.title) || ''), { type: 'audio', source: 'api' })
  const mv = data && data.media
  if (mv && Array.isArray(mv.images)) {
    mv.images.forEach((im, i) => {
      for (const u of urlList(im)) pushUrl(media, u, 'Foto ' + (i + 1), { type: 'image', source: 'api' })
    })
  }
  const cover = mv && Array.isArray(mv.covers) && mv.covers[0] ? mv.covers[0].url : null
  return { media, qualities, cover }
}

function extractHashtags(raw, description) {
  const tags = new Set()
  const extra = (raw && raw.text_extra) || []
  for (const t of extra) {
    const name = t.hashtag_name || (t.hashtag_info && t.hashtag_info.hashtag_name)
    if (name) tags.add(name)
  }
  const matches = String(description || '').matchAll(/#([^\s#@]+)/g)
  for (const m of matches) tags.add(m[1])
  return [...tags]
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return ''
  const s = Math.round(ms / 1000)
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

export async function resolve(url, opts = {}) {
  const input = String(url || '').trim()
  if (!/^https?:\/\//i.test(input)) throw new Error('URL tidak valid: ' + input)
  if (!isDouyin(input)) throw new Error('bukan link Douyin: ' + input)
  const kind = classify(input)
  if (kind.type === 'user') return profile(input)
  const data = await apiCall('/api/v1/douyin/video', { url: input, include_raw: true })
  const raw = data.raw || {}
  const { media, qualities, cover } = collectMedia(data, raw)
  const author = data.author || {}
  const stats = data.stats || raw.statistics || {}
  const description = data.description || raw.desc || raw.item_title || ''
  const durationMs = data.duration_ms || raw.duration || null
  const primary = media.find((m) => m.type === 'video') || media[0] || null
  const createdAt = data.created_at || (raw.create_time ? new Date(raw.create_time * 1000).toISOString() : null)
  const anchor = Array.isArray(raw.anchors) && raw.anchors.length ? raw.anchors[0] : null

  return {
    ok: true,
    platform: 'douyin',
    url: input,
    via: ['demo.douyin.wtf'],
    result: {
      title: data.title || description,
      description,
      author: author.nickname || '',
      thumbnail: cover || (media.find((m) => m.type === 'image') || {}).url || null,
      url: primary ? primary.url : null,
      type: primary ? primary.type : null,
      quality: primary ? primary.quality || null : null,
      postId: raw.aweme_id || raw.group_id || data.content_id || null,
      kind: data.kind || null,
      mediaType: raw.media_type === 2 || raw.aweme_type === 68 ? 'image_album' : 'video',
      awemeType: raw.aweme_type === 68 ? 'image_album' : raw.aweme_type === 0 ? 'video' : raw.aweme_type,
      isStory: raw.is_story === 1 || raw.is_24_story === 1 || raw.is_25_story === 1,
      durationMs,
      durationLabel: fmtDuration(durationMs),
      createdAt,
      hashtags: extractHashtags(raw, description),
      location: data.location || (anchor && anchor.title) || (raw.city ? raw.city : null),
      stats: {
        likes: stats.digg_count === undefined ? null : stats.digg_count,
        plays: stats.play_count === undefined ? null : stats.play_count,
        comments: stats.comment_count === undefined ? null : stats.comment_count,
        shares: stats.share_count === undefined ? null : stats.share_count,
        collects: stats.collect_count === undefined ? null : stats.collect_count,
      },
      music: data.music
        ? { title: data.music.title || null, author: data.music.author || null, url: data.music.play_url || null, durationMs: data.music.duration_ms || null }
        : null,
      account: {
        username: author.unique_id || null,
        nickname: author.nickname || null,
        signature: author.signature || null,
        verified: author.verified === true,
        followers: author.stats ? author.stats.follower_count : null,
        following: author.stats ? author.stats.following_count : null,
        likes: author.stats ? author.stats.total_digg : null,
        posts: author.stats ? author.stats.content_count : null,
        avatar: author.avatar && author.avatar.url ? author.avatar.url : null,
        secUid: author.sec_uid || null,
        uid: author.uid || null,
        url: author.web_url || null,
      },
      risk: raw.risk_infos ? { warn: raw.risk_infos.warn === true, content: raw.risk_infos.content || '' } : null,
      shareUrl: (raw.share_info && raw.share_info.share_url) || raw.share_url || null,
      webUrl: data.web_url || null,
    },
    qualities: qualities.map((q) => ({ label: q.label, quality: q.quality, width: q.width, height: q.height, url: q.url })),
    media,
  }
}

export async function profile(url) {
  const input = String(url || '').trim()
  if (!isDouyin(input)) throw new Error('bukan link Douyin: ' + input)
  const data = await apiCall('/api/v1/douyin/user', { url: input })
  const author = data || {}
  return {
    ok: true,
    platform: 'douyin',
    url: input,
    via: ['demo.douyin.wtf'],
    result: {
      title: author.nickname || '',
      author: author.nickname || '',
      description: author.signature || '',
      thumbnail: author.avatar && author.avatar.url ? author.avatar.url : null,
      url: author.web_url || null,
      type: 'user',
      quality: null,
      account: {
        username: author.unique_id || null,
        nickname: author.nickname || null,
        signature: author.signature || null,
        verified: author.verified === true,
        followers: author.stats ? author.stats.follower_count : null,
        following: author.stats ? author.stats.following_count : null,
        likes: author.stats ? author.stats.total_digg : null,
        posts: author.stats ? author.stats.content_count : null,
        avatar: author.avatar && author.avatar.url ? author.avatar.url : null,
        secUid: author.sec_uid || null,
        uid: author.uid || null,
        url: author.web_url || null,
      },
    },
  }
}

export async function posts(url, count = 20, cursor = '') {
  const input = String(url || '').trim()
  if (!isDouyin(input)) throw new Error('bukan link Douyin: ' + input)
  const data = await apiCall('/api/v1/douyin/user/posts', { url: input, count, cursor })
  const items = (data && data.items) || []
  return {
    ok: true,
    platform: 'douyin',
    url: input,
    via: ['demo.douyin.wtf'],
    cursor: (data && data.cursor) || '',
    hasMore: Boolean(data && data.has_more),
    count: items.length,
    posts: items.map((it) => ({
      id: it.content_id || null,
      title: it.title || it.description || '',
      kind: it.kind || null,
      createdAt: it.created_at || null,
      durationMs: it.duration_ms || null,
      thumbnail: it.media && it.media.covers && it.media.covers[0] ? it.media.covers[0].url : null,
      images: it.media && it.media.images ? it.media.images.length : 0,
      url: 'https://www.douyin.com/' + (it.kind === 'image_album' ? 'note/' : 'video/') + (it.content_id || ''),
    })),
  }
}

function extFor(type, url) {
  if (type === 'audio') return 'mp3'
  if (type === 'image') {
    const m = String(url).match(/\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i)
    return m ? m[1].toLowerCase().replace('jpg', 'jpeg') : 'webp'
  }
  const m = String(url).match(/\.(mp4|webm|mov)(?:$|[?#])/i)
  return m ? m[1].toLowerCase() : 'mp4'
}

function slugOf(text) {
  const base = String(text || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base.length >= 3 ? base.slice(0, 60) : 'douyin'
}

async function saveItem(item, buf, outDir, slug, index, many) {
  const name = slug + (many ? '-' + String(index + 1).padStart(2, '0') : '') + '.' + extFor(item.type, item.url)
  const file = path.resolve(outDir, name)
  fs.writeFileSync(file, buf)
  return { file, sizeBytes: buf.length, type: item.type, url: item.url, label: item.label, quality: item.quality || null }
}

async function runDownload(data, outDir, want, quality) {
  const type = want || (data.result.mediaType === 'image_album' ? 'image' : 'video')
  let candidates = data.media.filter((m) => m.type === type)
  if (quality) {
    const hit = candidates.filter((m) => String(m.quality || '').includes(String(quality)))
    if (hit.length) candidates = hit
  }
  if (!candidates.length) throw new Error('tidak ada media ' + type + ' untuk post ini')
  fs.mkdirSync(outDir, { recursive: true })
  const slug = slugOf(data.result.title || data.result.postId || 'douyin')
  const files = []
  if (type === 'image') {
    for (const item of candidates) {
      let buf = null
      try {
        buf = await fetchBuffer(item.url)
      } catch {
        continue
      }
      files.push(await saveItem(item, buf, outDir, slug, files.length, true))
    }
    if (!files.length) throw new Error('gagal mengunduh foto')
    return files
  }
  let last = null
  for (const item of candidates) {
    try {
      const buf = await fetchBuffer(item.url)
      return [await saveItem(item, buf, outDir, slug, 0, false)]
    } catch (e) {
      last = e
    }
  }
  throw last || new Error('gagal mengunduh media')
}

function usage() {
  return [
    'Douyin Scraper - info post, info akun, download video/foto/audio',
    '',
    'Pakai:',
    '  node douyin.js info <link douyin>',
    '  node douyin.js download <link douyin> [--type video|image|audio] [--quality 1080] [--out ./downloads]',
    '  node douyin.js profile <link profil douyin>',
    '  node douyin.js posts <link profil douyin> [--count 20]',
    '  node douyin.js --help',
    '',
    'Contoh:',
    '  node douyin.js info "https://www.douyin.com/video/7126745726494821640"',
    '  node douyin.js info "https://v.douyin.com/L4NpDJ6/"',
    '  node douyin.js info "https://www.douyin.com/note/7696841602635211429"',
    '  node douyin.js download "https://v.douyin.com/L4NpDJ6/" --out ./dl',
    '  node douyin.js profile "https://www.douyin.com/user/MS4wLjABAAAA..."',
    '',
    'Sumber data:',
    '  demo.douyin.wtf  -> API publik Douyin_TikTok_Download_API (repo Evil0ctal)',
    '                     kredensial demo diambil otomatis tiap jalan, task async di-poll',
    '',
    'Ganti instance (pisah koma, dipakai berurutan sebagai cadangan):',
    '  DOUYIN_API="https://demo.douyin.wtf,https://instance-kamu.example" node douyin.js info <link>',
    '',
    'Catatan jujur:',
    '  - link /video/ = video, /note/ = galeri foto, /user/ = profil',
    '  - instance demo itu milik orang lain: bisa dimatikan kapan saja tanpa',
    '    pemberitahuan. Self-host repo-nya kalau butuh jaminan (docker compose up).',
  ].join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage() + '\n')
    return
  }
  let values = { type: '', out: './downloads', count: '20', quality: '' }
  let positionals = []
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        type: { type: 'string', default: '' },
        out: { type: 'string', default: './downloads' },
        count: { type: 'string', default: '20' },
        quality: { type: 'string', default: '' },
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
  if (command === 'info') {
    const data = await resolve(url, {})
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  if (command === 'profile') {
    const data = await profile(url)
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  if (command === 'posts') {
    const data = await posts(url, Number(values.count) || 20)
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  if (command === 'download') {
    const data = await resolve(url, {})
    const files = await runDownload(data, values.out, values.type || null, values.quality || null)
    process.stdout.write(JSON.stringify({ ok: true, url: data.url, postId: data.result.postId, files }, null, 2) + '\n')
    return
  }
  throw new Error('command tidak dikenal: ' + command + ' (pilihan: info, download, profile, posts)')
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
  name: 'douyin',
  alias: ['douyindl', 'douyinvideo', 'dy'],
  category: ['scraper'],
  description: 'Scrape Douyin: info post + info akun, download video/foto/audio tanpa watermark',
  usage: '<link douyin>',
  example: '.douyin https://www.douyin.com/video/7126745726494821640',
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
    await replyText(m, ctx, 'Kirim link Douyin ya.\n' + usage())
    return
  }
  try {
    const data = await resolve(url, {})
    const type = data.result.mediaType === 'image_album' ? 'image' : 'video'
    const candidates = data.media.filter((x) => x.type === type)
    const item = candidates[0]
    if (!item) {
      await replyText(m, ctx, 'Media tidak ditemukan untuk link itu.')
      return
    }
    const account = data.result.account || {}
    const caption = [
      '*' + (data.result.title || 'Douyin') + '*',
      data.result.author ? '👤 ' + data.result.author : '',
      account.username ? '🎵 @' + account.username : '',
      account.followers ? '⭐ ' + account.followers + ' followers' : '',
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
    const payload = { caption, mimetype: sent.type === 'image' ? 'image/webp' : 'video/mp4' }
    if (sent.type === 'image') payload.image = buf || { url: sent.url }
    else payload.video = buf || { url: sent.url }
    await sock.sendMessage(m.chat, payload, { quoted: m })
  } catch (e) {
    await replyText(m, ctx, 'Gagal: ' + (e && e.message ? e.message : String(e)))
  }
}

handler.command = /^(douyin|douyindl|douyinvideo|dy)$/i
handler.tags = ['scraper']
handler.help = ['douyin <link douyin>']
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
