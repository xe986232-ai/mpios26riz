# Control Center Music Player — Vite + TSX

Konversi dari `control-center_v2-font-options.html` (single-file HTML) menjadi project Vite + React + TypeScript. Fitur export gambar (PNG) sudah dihapus sesuai permintaan.

## Menjalankan
```bash
npm install
npm run dev
```

## Struktur
- `src/App.tsx` — komponen utama; semua logic interaktif (customize kartu, knob rotate, upload album art, play/pause, timer durasi, dll) dijalankan lewat `useEffect` yang meng-attach event listener ke markup SVG.
- `src/markup.ts` — markup SVG Control Center & Music Player asli (disuntik via `dangerouslySetInnerHTML` karena ukurannya besar & berisi aset gambar base64 — konversi penuh ke JSX akan berisiko merusak SVG kompleks ini).
- `src/App.css` — seluruh styling asli (dipindah dari `<style>` di head).

## Catatan penting
- Fitur **export gambar PNG** (tombol "Unduh Gambar" + dependency `html2canvas`) sudah **dihapus total**, termasuk panel "Export Gambar" di UI.
- Dua `@font-face` (`SF Pro Display Black/Medium`) masih menunjuk ke path `/__l5e/assets-v1/...` dari environment asal file HTML — path itu tidak akan resolve di project berdiri sendiri ini. Font akan otomatis fallback ke system font (`-apple-system` dsb) sampai kamu ganti `src:` di `src/App.css` dengan file font sendiri atau CDN.
- Sudah dites: `npm run build` (tsc + vite build) sukses tanpa error.
