/**
 * Name : Lunara Pro Scraper (upload file -> link berbagi permanen)
 * Owner : Godhumanv2
 * Base Web : https://lunara.softbotz.my.id (berbagi file & hosting statis)
 * Type : Apifier
 * Function : Scrape lengkap -> upload file ke endpoint /upload -> link
 *            berbagi permanen (file_url) + id/size/permanent. Output JSON
 *            ke stdout.
 * Note : error fix sendiri.
 */

import { request as httpsReq } from 'node:https'
import { request as httpReq } from 'node:http'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SITE = 'https://lunara.softbotz.my.id'
const API_UPLOAD = '/upload'
const RAW_QUERY = '?raw=1'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT = 120_000
const MAX_SIZE = 100 * 1000 * 1000
const RETRIES = 2

const NAV = {
  Origin: SITE,
  Referer: `${SITE}/`,
  'Accept-Language': 'id-ID,id;q=0.9',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), finalUrl: cur })
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

function multipart(fields, file) {
  const boundary = `----lunara${crypto.randomBytes(16).toString('hex')}`
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'))
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      'utf8'
    )
  )
  parts.push(file.data)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

function readDetail(res) {
  if (res.json?.detail) {
    const d = res.json.detail
    if (Array.isArray(d)) return d.map((x) => x?.msg || String(x)).join(', ')
    if (typeof d === 'string') return d
  }
  if (res.status === 413) return 'file melebihi batas 100 MB'
  if (res.status === 429) return 'terlalu banyak permintaan, tunggu sebentar lalu ulang'
  return `server merespons status ${res.status}`
}

export async function uploadBuffer(data, fileName = 'file.bin', opts = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (buf.length === 0) throw new Error('file kosong, server tolak')
  if (buf.length > MAX_SIZE) {
    throw new Error(`file ${(buf.length / 1000 / 1000).toFixed(1)} MB melebihi batas 100 MB`)
  }
  const { permanent = true, displayName, log } = opts
  const file = { name: path.basename(String(fileName || 'file.bin')), data: buf }
  const { body, contentType } = multipart(
    { permanent: permanent ? 'true' : 'false', filename: displayName },
    file
  )

  log?.(`upload ${file.name} (${buf.length} byte)`)
  const res = await reqJson(`${SITE}${API_UPLOAD}`, {
    method: 'POST',
    headers: { ...NAV, 'Content-Type': contentType, Accept: 'application/json' },
    body,
    timeout: TIMEOUT,
  })

  if (res.status < 200 || res.status >= 300) throw new Error(readDetail(res))
  if (!res.json?.file_url) throw new Error('server tidak mengembalikan file_url')

  log?.('upload berhasil')
  return {
    url: res.json.file_url,
    rawUrl: `${res.json.file_url}${RAW_QUERY}`,
    id: res.json.id ?? null,
    size: res.json.size ?? null,
    permanent: res.json.permanent ?? null,
    expiresAt: res.json.expires_at ?? null,
    page: `${SITE}/`,
    api: `${SITE}${API_UPLOAD}`,
  }
}

export async function upload(filePath, opts = {}) {
  const abs = path.resolve(filePath)
  if (!fs.existsSync(abs)) throw new Error(`file nggak ada: ${filePath}`)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error(`bukan file: ${filePath}`)
  return uploadBuffer(fs.readFileSync(abs), path.basename(abs), opts)
}

export const resolve = uploadBuffer

const USAGE = `pakai:
  node lunara.js upload <file>            -> JSON link berbagi
contoh:
  node lunara.js upload ./video.mp4
  node lunara.js upload ./cat.png --name "nama-tampil"
opsi:
  --name <teks>      nilai field filename (opsional, buat link sementara yang bisa kedaluwarsa)
  --temporary        permanent=false,(expiresAt bakal terisi)
  -q                 matiin log di stderr (stdout tetap JSON)
keluaran:
  url      link berbagi, dibuka di browser (file teks dirender sebagai halaman)
  rawUrl   sama dengan url + ?raw=1, buat ambil isi mentah tanpa viewer
catatan:
  - Endpoint POST multipart/form-data ke /upload: field "file" +
    "permanent=true" + "filename" (opsional).
  - Batas server 100 MB desimal (100 * 1000 * 1000). Lebih dari itu: 413.
  - File kosong ditolak 400 {"detail":"File is empty"}.
  - Error FastAPI punya bentuk {"detail": "..."} atau {"detail":[{"msg":...}]}.
  - Cuma bagian berbagi file yang dipakai. Fitur hosting HTML statis di
    situs itu sengaja nggak disentuh.
  - Nol file ditulis ke disk; output cuma JSON. Link hasil upload emang
    publik dan bisa dihapus dari sisi server kapan aja.`

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

function pickMessageMedia(message) {
  const candidates = [
    ['documentMessage', 'document'],
    ['videoMessage', 'video'],
    ['imageMessage', 'image'],
    ['audioMessage', 'audio'],
    ['stickerMessage', 'sticker'],
  ]
  for (const [key, type] of candidates) {
    if (message?.[key]) return { type, node: message[key] }
  }
  return null
}

function caption(user, out, fileName) {
  return [
    `╭━━━ *${user}*`,
    '┃ *LUNARA*',
    '╰━━━━━━━━━━━━━',
    '',
    `▸ file : ${fileName}`,
    `▸ size : ${out.size ?? '?'} byte`,
    out.permanent ? '▸ tipe : permanen' : '▸ tipe : sementara',
    '',
    out.url,
    '',
    `▸ mentah: ${out.rawUrl}`,
    '',
    '> powered by scraper-bot-kit',
  ].join('\n')
}

const USAGE_BOT =
  '╭━━━ *LUNARA* ━━━╮\n\n▸ kirim file (dokumen/foto/video/audio), lalu balas dengan .lunara\n▸ atau .lunara reply\n\n▸ batas 100 MB\n╰━━━━━━━━━━━━━━'

export default {
  name: 'lunara',
  command: ['lunara'],
  alias: ['lunarafile'],
  category: ['scraper'],
  description: 'upload file ke lunara dan balas link berbagi',
  usage: '<reply file>',
  example: '.lunara (reply sebuah file)',
  async run({ m, q }) {
    const sender = String(m.sender || '').split('@')[0]
    const source = q?.raw || q
    const found = pickMessageMedia(source)

    if (!found) return m.reply(USAGE_BOT)

    await m.react('🕐').catch(() => {})
    try {
      const { downloadContentFromMessage } = await import('baileys')
      const stream = await downloadContentFromMessage(found.node, found.type)
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      const buffer = Buffer.concat(chunks)

      const out = await uploadBuffer(buffer, found.node?.fileName || `file-${Date.now()}.bin`)
      await m.react('✅').catch(() => {})
      return m.reply(caption(sender, out, found.node?.fileName || 'file.bin'))
    } catch (error) {
      await m.react('❌').catch(() => {})
      return m.reply(`╭━━━ *LUNARA* ━━━╮\n\n▸ gagal: ${error.message || 'tidak diketahui'}\n╰━━━━━━━━━━━━━━━`)
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
      name: { type: 'string', default: '' },
      temporary: { type: 'boolean', default: false },
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
  if (cmd !== 'upload') throw new Error(`command tak dikenal: ${cmd}`)
  if (!arg) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(1)
  }

  const out = await upload(arg, {
    permanent: !v.temporary,
    displayName: v.name || undefined,
    log,
  })
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
}

if (isMain) {
  main().catch((e) => {
    process.stderr.write(`error: ${e.message || e}\n`)
    process.exitCode = 1
  })
}

export { multipart, req, reqJson }