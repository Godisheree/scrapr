# scrapr — kumpulan scraper JavaScript

> **Untuk AI agent.** Repo ini dikerjakan oleh AI agent. Treat README ini sebagai
> kontrak: kalau scraper baru nggak ikut aturan di bawah, itu belum selesai.

1 folder = 1 scraper. 1 file = 1 scraper. JavaScript/Node.js. Tanpa dependency.

```bash
node <nama-scraper>/<nama>.js <command> <args>
```

---

## ATURAN KERAS

1. **Satu folder, satu file `.js`.** Nggak ada `lib/`, `utils/`, `config/`,
   `package.json`, `node_modules`. Butuh helper? Taruh di file yang sama.
2. **Node.js doang.** Pakai `node:http`/`node:https`. **Dilarang** `fetch()`,
   `axios`, `cheerio`, atau dependency lain — konsistensi + jalan di host
   yang nggak punya `fetch`.
3. **Output stdout = JSON doang.** Error ke stderr format `error: <pesan>` +
   `process.exitCode = 1`. JSON harus bisa di-pipe ke `jq` tanpa tercampur.
4. **Tanpa argumen → usage ke stderr, exit 1.** `--help` → usage, exit 0.
5. **Semua URL dari konstanta atas.** Nggak ada URL/endpoint yang di-hardcode di
   tengah file.
6. **Nggak boleh ngeclaim yang belum dites.** Jalankan sendiri, lihat output
   beneran, baru bilang selesai.

---

## FORMAT HEADER (wajib, 6 field)

```js
/**
 * Name : <Nama Tool> Scraper (<fitur-fitur>)
 * Owner : <Nama Kamu>
 * Base Web : <https://domain.com> (deskripsi singkat situs target)
 * Type : Scraper
 * Function : Scrape lengkap -> <aksi 1>, <aksi 2>
 *            -> direct URL + headers yang dibutuhkan. Output JSON ke stdout.
 * Note : error fix sendiri.
 */
```

`Type` yang dipakai: `Scraper` / `Downloader` / `Apifier`.

`Function` harus **cuma nyebut yang beneran jalan**. Kalau ada fitur yang
dipaksa atau gated, jangan ditulis di header — tulis di `usage()` sebagai
catatan jujur.

### Contoh nyata (yang sudah diverifikasi jalan)

```js
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
```

---

## POLA KODE (urutan wajib)

**1 — Konstanta di paling atas**

```js
const SITE = "https://target.com";
const API_INFO = "/path/info";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...";
const TIMEOUT = 30_000;
const MAX_SIZE = 500_000;
```

**2 — `req()`**: HTTP native, auto-redirect (max 5), timeout, cap ukuran respons.

```js
function req(url, { method = "GET", headers = {}, body, timeout = TIMEOUT, maxRedirect = 5 } = {})
```

**3 — `reqJson()`**: parse JSON, return `{ status, headers, body, json }`.
`json === null` berarti responsnya bukan JSON (biasanya bot check).

**4 — Helper kecil**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (s) => /* decode HTML entities */;
```

**5 — Fungsi API**: satu per aksi. Tiap fungsi yang nyentuh jaringan retries
dengan backoff.

**6 — `usage()`**: return string multi-line.

**7 — `main()`**: `parseArgs` dari `node:util`, switch per command, print JSON.

**8 — Error handler di akhir file**

```js
main().catch((e) => {
  process.stderr.write(`error: ${e.message || e}\n`);
  process.exitCode = 1;
});
```

---

## JEBAKAN YANG SUDAH TERBUKTI DI TEMPAT

Ini bukan teori — semuanya ketemu pas nulis `snaptik/`.

### `Transfer-Encoding: chunked` ditolak

`rq.write(body)` + `rq.end()` tanpa `Content-Length` bikin Node pakai chunked
encoding. Server bisa nolak dengan `403`. Set manual:

```js
headers: {
  "User-Agent": UA,
  ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
  ...headers,
}
```

### `X-Requested-With` itu penentu, bukan hiasan

Tanpa `X-Requested-With: XMLHttpRequest`, responsnya `403 {"error":"Invalid
request type"}` — bukan 403 generik. Kalau dapat JSON error aneh, cek header
dulu sebelum nyangka kena Cloudflare.

### UTF-8 rusak kalau string += per chunk

```js
data += chunk;              // ❌ byte multi-byte kepotong di batas chunk
Buffer.concat(chunks)       // ✅
```

Gejalanya: `—` jadi `���` di judul. Fix: `Buffer.concat(chunks).toString("utf8")`.

### URL download expire

`?token=...` punya TTL. Cache = file rusak. Ambil ulang persis sebelum download.

### Job async harus di-poll, dan stop saat gagal

API convert biasanya balas `{job_id}`, endpoint progress ngasih
`{download_url}`. Poll dengan batas waktu — dan **stop** kalau status `failed`.
Jangan poll 90x ke API yang sudah bilang gagal.

### Retry 403/429 = token basi

Kalau endpoint butuh token yang dibuat per-request, 403 artinya token-nya
kadaluarsa, bukan kamu kena block. Ambil token baru, ulang.

### HD gated itu fitur yang nggak boleh diklaim

`snaptik` mengembalikan `hdDownloadUrl`, tapi `/api/hd` balas **403** (di web
aslinya ada flow "Watch Ad"). Jadi flag `--hd` sengaja nggak ada.

---

## CHECKLIST SEBELUM COMMIT

- [ ] Header 6 field lengkap, `Function` cuma nyebut fitur yang jalan
- [ ] Udah `node file.js <command> <contoh>` → JSON asli keluar
- [ ] Semua URL & nama field diverifikasi dari live, bukan dari ingatan
- [ ] Header wajib lengkap (X-Requested-With / Referer / Origin / token)
- [ ] Token/challenge di-solve saat runtime, bukan di-hardcode
- [ ] `Content-Length` di-set kalau ada body
- [ ] Buffer response pakai `Buffer.concat`, bukan `string +=`
- [ ] stdout JSON, stderr `error: <pesan>`, `process.exitCode = 1`
- [ ] Tanpa argumen → usage exit 1; `--help` → usage exit 0
- [ ] Nggak ada `fetch()`/`axios` — konsisten pakai `req()`
- [ ] Nggak ada URL di-hardcode di tengah file
- [ ] Semua file di folder belongsto scraper itu aja
- [ ] Tambahin baris di tabel **Daftar Scraper**

---

## TAMBAH SCRAPER BARU

1. Deteksi target: `curl -s <url> -A 'Mozilla/5.0' | head -c 2000`
2. Cari API dulu, HTML belakangan:
   ```bash
   curl -s <url> | grep -oE '<script[^>]*src="[^"]*"'
   curl -s <url>/js/main.js | grep -oE 'fetch\("[^"]+"|/api/[a-z-]+'
   ```
3. Kalau ada `atob(` / `crypto.subtle` → ada challenge, reverse dari literal
   di bundle JS. JANGAN nebak.
4. Bikin folder + 1 file, port `req()`/`reqJson()`/`usage()`/`main()` dari sini.
5. Jalankan beneran, lihat output.
6. Update tabel di bawah, commit, push.

---

## BATAS YANG GA BOLEH DILANGGAR

- **Nggak boleh bypass login/captcha/paywall.** Target yang butuh auth → jangan
  scrape sama sekali.
- **Nggak boleh bulk download.** Satu request = satu pilihan user.
- **Nggak boleh re-upload** ke file host buat bikin link. Pakai URL asli target.
- **Credit** pemilik situs di `Base Web`. Kalau owner komplain, hapus file-nya.

---

## DAFTAR SCRAPER

| Folder | File | Base Web | Type | Fungsi |
|---|---|---|---|---|
| `snaptik/` | `snaptik.js` | https://snaptik.app | Scraper | info video TikTok + download MP4 no watermark |

Owner: **Godhumanv2**

```bash
node snaptik/snaptik.js info "https://www.tiktok.com/@user/video/1234567890"
node snaptik/snaptik.js download "https://www.tiktok.com/@user/video/1234567890" --out ./downloads
```

> `downloadUrl` dari snaptik berumur pendek — jangan di-cache, ambil ulang tepat
> sebelum download.