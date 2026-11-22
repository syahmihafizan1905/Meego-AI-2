# MEEGO AI — website

Signal & news app (gaya NewsX) dengan login member, pakej Basic / Pro / Ultimate, mailbox, Chart Scanner AI dan harga pasaran live.

- **Website (frontend):** folder `public/` — dihoskan percuma di **GitHub Pages**.
- **Login, data, AI, harga:** **Supabase** (database + 2 fungsi server: `ai` dan `candles`).
- Kunci API (Anthropic, Twelve Data) disimpan sebagai *secret* di Supabase. **Tak pernah** masuk ke GitHub atau browser.

---

## Langkah 1 — Supabase (login + data)

1. Daftar di **supabase.com** → **New project** (pilih region Singapore). Simpan password database.
2. **SQL Editor → New query** → salin semua isi `supabase/schema.sql` → **Run**.
3. **Project Settings → API**: salin **Project URL** dan **anon public key**.
4. Buka `public/config.js`, ganti `YOUR-PROJECT` dan `YOUR-ANON-KEY` dengan nilai tadi. (Anon key memang untuk umum — data dilindungi oleh peraturan database.)
5. **Authentication → URL Configuration**: letak alamat website anda (contoh `https://namaanda.github.io/meego-ai/`) dalam **Site URL** dan **Redirect URLs**.

## Langkah 2 — Fungsi server (AI + harga)

Dalam Supabase: **Edge Functions → Deploy a new function → Via editor**.

1. Nama **`ai`** → tampal isi `supabase/functions/ai/index.ts` → **Deploy**.
2. Nama **`candles`** → tampal isi `supabase/functions/candles/index.ts` → **Deploy**.
3. **Edge Functions → Secrets** → tambah:
   - `ANTHROPIC_API_KEY` — dari **console.anthropic.com → API Keys** (bayar ikut guna).
   - `TWELVEDATA_API_KEY` — dari **twelvedata.com** (pelan percuma: 8 panggilan/minit, 800/hari).
   - (pilihan) `AI_DAILY_LIMIT` — had guna AI sehari untuk setiap member (asal 30). Admin tiada had.

## Langkah 3 — GitHub Pages (website)

1. Repo ini → **Settings → Pages** → *Source*: **GitHub Actions**. Workflow `.github/workflows/pages.yml` akan publish folder `public/` setiap kali anda push.
2. Selepas siap, link website: `https://NAMA-GITHUB-ANDA.github.io/NAMA-REPO/`.
3. **Domain sendiri** (contoh `meegoai.com`): beli domain → **Settings → Pages → Custom domain** → ikut arahan DNS GitHub. Kemas kini Site URL di Supabase juga.

## Langkah 4 — Jadikan diri anda Owner

1. Buka website → **Create account** dengan emel anda → sahkan emel.
2. Supabase **SQL Editor**, jalankan (tukar emel):
   ```sql
   update public.profiles set role = 'owner' where email = 'emel-anda@contoh.com';
   ```
3. Refresh website → menu **Customer Management**, post signal rasmi dan Mailbox kini terbuka untuk anda.

## Urus pelanggan

- Pelanggan **Create account** sendiri di website.
- Anda buka **Customer Management** → isi butiran → di **Member account**, cari emel mereka → pilih pakej (**Basic / Pro / Ultimate**) dan tarikh tamat → **Add**.
- **Basic/Pro**: nampak signal intraday & mailbox. **Ultimate**: juga nampak **Priority Swing**. Sekatan ini dikuatkuasa di database (bukan sekadar sorok di skrin).
- Pakej tamat → akses signal ditutup automatik. Tekan **+30 days** untuk sambung.

## Pasang di telefon (ikon MEEGO AI)

- **iPhone (Safari):** buka website → butang **Share** → **Add to Home Screen**.
- **Android (Chrome):** buka website → menu **⋮** → **Install app** / **Add to Home screen**.

Ikon emas MEEGO akan keluar automatik — tiada nama lain.

## Kemas kini app

Sumber app ada di `src/app.html`. Selepas ubah, jalankan:

```
python tools/build.py
```

Kemudian commit & push — GitHub Pages update sendiri.

## Kos anggaran

| Servis | Kos |
|---|---|
| GitHub Pages | Percuma |
| Supabase | Percuma (pelan Free) |
| Twelve Data | Percuma (8 panggilan/minit). Ramai pengguna atau banyak pair → pertimbang pelan berbayar |
| Anthropic API | Bayar ikut guna (Chart Scanner & analisis AI). Kawal dengan `AI_DAILY_LIMIT` |
| Domain sendiri | ~RM40–60 setahun (pilihan) |

> Signal dan analisis dalam app ini ialah alat bantu, bukan nasihat kewangan.
