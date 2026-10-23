# Duit Tracker

Penjejak kewangan peribadi. Semua data disimpan dalam peranti (IndexedDB) dan tiada server.

## Struktur fail

| Fail | Isi |
|------|-----|
| `index.html` | Markup semua skrin dan modal |
| `css/tailwind.css` | Tailwind yang dah di-compile. Hanya kelas yang ada dalam fail ini boleh digunakan |
| `css/app.css` | Gaya tersuai, mod gelap, dan utiliti tambahan |
| `js/i18n.js` | Kamus Bahasa Melayu dan fungsi `tr()` |
| `js/app.js` | Semua logik app |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA: boleh dipasang ke home screen dan berfungsi offline |

## Cara jalankan

Dwi-klik `index.html` masih berfungsi, tetapi untuk **install sebagai app** dan **guna offline**, fail-fail ini perlu dihidangkan melalui http(s). Contohnya:

- Hos percuma: GitHub Pages, Netlify atau Cloudflare Pages (upload seluruh folder)
- Uji di komputer: `npx serve .` dalam folder ini, kemudian buka alamat yang dipaparkan

Bila ubah senarai fail app, naikkan `CACHE_VERSION` dalam `sw.js`.

## Format backup

Backup versi 2 (`.json`) mengandungi semua akaun, transaksi, kategori, bajet, transaksi berulang, matlamat simpanan dan tetapan paparan. PIN **tidak** disimpan dalam backup. Backup versi 1 yang lama masih boleh diimport.
