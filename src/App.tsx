import { useEffect, useRef } from 'react';
import html2canvas from 'html2canvas';
import { STAGE_MARKUP, PANELS_MARKUP } from './markup';

// ==== Helper untuk Export Frame ====
// html2canvas TIDAK BISA render <video> (cuma nge-skip/kosong) dan TIDAK support
// backdrop-filter (dipakai buat efek blur wallpaper ala Control Center/iOS).
// Solusinya: sebelum di-screenshot, kita "bekukan" frame video saat ini jadi gambar
// statis, dan kita hitung sendiri hasil blur-nya pakai Canvas 2D (ctx.filter = blur),
// lalu suntikkan sebagai <img> pengganti supaya html2canvas tinggal nge-capture
// gambar biasa (yang memang didukung penuh).

// Ambil frame video yang sedang tampil saat ini, ditempatkan ke kotak targetW x targetH
// dengan logika object-fit: cover (sama seperti CSS video wallpaper aslinya).
function captureVideoFrame(video: HTMLVideoElement, targetW: number, targetH: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context tidak tersedia');
  const vw = video.videoWidth || targetW;
  const vh = video.videoHeight || targetH;
  const scale = Math.max(targetW / vw, targetH / vh); // cover
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (targetW - dw) / 2;
  const dy = (targetH - dh) / 2;
  ctx.drawImage(video, dx, dy, dw, dh);
  return canvas.toDataURL('image/png');
}

// Blur + dim manual pakai Canvas 2D filter (didukung browser modern), meniru
// backdrop-filter: blur(...) + overlay hitam semi-transparan. Gambar sumber di-extend
// dulu ke kanvas yang dipadding sebelum di-blur, supaya tepi hasil blur tidak jadi
// gelap/pudar (efek umum kalau blur langsung mepet ke tepi kanvas).
function blurAndDim(
  srcDataUrl: string,
  w: number,
  h: number,
  blurPx: number,
  dimAlpha: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const pad = Math.ceil(blurPx * 2.5);
        const padded = document.createElement('canvas');
        padded.width = w + pad * 2;
        padded.height = h + pad * 2;
        const pctx = padded.getContext('2d');
        if (!pctx) throw new Error('Canvas context tidak tersedia');
        // extend-edge murah: gambar sumber diregangkan menutupi area padding juga,
        // nanti area padding ini dibuang lagi setelah di-blur.
        pctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);

        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const octx = out.getContext('2d');
        if (!octx) throw new Error('Canvas context tidak tersedia');
        octx.filter = `blur(${blurPx}px)`;
        octx.drawImage(padded, -pad, -pad);
        octx.filter = 'none';
        octx.fillStyle = `rgba(0,0,0,${dimAlpha})`;
        octx.fillRect(0, 0, w, h);
        resolve(out.toDataURL('image/png'));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Gagal memuat gambar untuk diblur'));
    img.src = srcDataUrl;
  });
}

export default function App() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Helper query scoped ke container komponen ini (menghindari bentrok id kalau ada instance lain di halaman)
    const $ = <T extends Element = HTMLElement>(id: string) =>
      root.querySelector<T>(`#${id}`)!;

    const stage = $('stage');
    const hint = $('hint');

    // Kartu audio kanan atas (buka music player)
    const audioCard = root.querySelector<SVGRectElement>(
      '.cc-hit[x="233"][y="155"]'
    );

    const cleanupFns: Array<() => void> = [];
    const on = <K extends keyof HTMLElementEventMap>(
      el: Element,
      type: K,
      handler: (e: any) => void
    ) => {
      el.addEventListener(type, handler as EventListener);
      cleanupFns.push(() => el.removeEventListener(type, handler as EventListener));
    };

    // ==== Toggle panel Customize (collapse/expand biar hemat tempat) ====
    const customizeToggle = $('customizeToggle');
    const panelStack = $('panelStack');
    on(customizeToggle, 'click', (e: Event) => {
      e.stopPropagation();
      const nowCollapsed = panelStack.classList.toggle('collapsed');
      customizeToggle.classList.toggle('open', !nowCollapsed);
    });

    const openHandler = (e: Event) => {
      e.stopPropagation();
      stage.classList.add('open');
      hint.textContent = 'Klik di mana saja untuk kembali ke Control Center';
    };
    if (audioCard) on(audioCard, 'click', openHandler);

    const stageCloseHandler = () => {
      if (stage.classList.contains('open')) {
        stage.classList.remove('open');
        hint.textContent = 'Klik kartu audio kanan atas untuk membuka Music Player';
      }
    };
    on(stage, 'click', stageCloseHandler);

    // ==== Customize panel: rounded / smoothing / panjang / lebar / opacity kartu music player ====
    const DEFAULTS = {
      radius: 125,
      smoothing: 100,
      height: 78,
      width: 89,
      opacity: 20,
      rotate: 177.6,
      length: 345,
      coverRadius: 70,
      coverSmooth: 100,
      ccOpacity: 20,
    };

    const ctrlRadius = $<HTMLInputElement>('ctrlRadius');
    const ctrlSmooth = $<HTMLInputElement>('ctrlSmooth');
    const ctrlHeight = $<HTMLInputElement>('ctrlHeight');
    const ctrlWidth = $<HTMLInputElement>('ctrlWidth');
    const ctrlOpacity = $<HTMLInputElement>('ctrlOpacity');
    const ctrlLength = $<HTMLInputElement>('ctrlLength');
    const valRadius = $('valRadius');
    const valSmooth = $('valSmooth');
    const valHeight = $('valHeight');
    const valWidth = $('valWidth');
    const valOpacity = $('valOpacity');
    const valRotate = $('valRotate');
    const valLength = $('valLength');
    const ctrlCoverRadius = $<HTMLInputElement>('ctrlCoverRadius');
    const ctrlCoverSmooth = $<HTMLInputElement>('ctrlCoverSmooth');
    const valCoverRadius = $('valCoverRadius');
    const valCoverSmooth = $('valCoverSmooth');
    const albumArtClipPath = $<SVGPathElement>('albumArtClipPath');
    const albumArtPlaceholderPath = $<SVGPathElement>('albumArtPlaceholderPath');
    const resetBtn = $('resetBtn');
    const cardBgRect = $<SVGPathElement>('cardBgRect');
    const cardBorderRect = $<SVGPathElement>('cardBorderRect');
    const cardClipPath = $<SVGPathElement>('cardClipPath');
    const mpBorderGradient = $<SVGLinearGradientElement>('mpBorder');
    const knobRotate = $('knobRotate');
    const knobIndicator = $<HTMLElement>('knobIndicator');
    let rotateDeg = DEFAULTS.rotate;

    // Kartu digambar di viewBox lokal 336x600 (lihat elemen <svg> #player)
    const CARD_LOCAL_W = 336,
      CARD_LOCAL_H = 600;

    // Path rounded-rect superellipse ("squircle") — sudut lebih smooth/continuous
    // daripada arc lingkaran biasa, mirip -electron-corner-smoothing / iOS / Figma.
    // n=2 = sudut bulat biasa, makin besar n makin "squircle".
    function squirclePath(
      x0: number,
      y0: number,
      w: number,
      h: number,
      r: number,
      n: number
    ) {
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      if (r < 0.5) return `M ${x0} ${y0} H ${x0 + w} V ${y0 + h} H ${x0} Z`;
      const STEPS = 14,
        HALF_PI = Math.PI / 2;
      const pow = (v: number) => Math.pow(Math.max(0, v), 2 / n);
      const pt = (x: number, y: number) =>
        `L ${(x0 + x).toFixed(2)} ${(y0 + y).toFixed(2)} `;
      let d = `M ${(x0 + r).toFixed(2)} ${y0.toFixed(2)} L ${(x0 + w - r).toFixed(
        2
      )} ${y0.toFixed(2)} `;
      for (let i = 0; i <= STEPS; i++) {
        // top-right
        const t = (i / STEPS) * HALF_PI;
        d += pt(w - r + r * pow(Math.sin(t)), r - r * pow(Math.cos(t)));
      }
      d += pt(w, h - r);
      for (let i = 0; i <= STEPS; i++) {
        // bottom-right
        const t = (i / STEPS) * HALF_PI;
        d += pt(w - r + r * pow(Math.cos(t)), h - r + r * pow(Math.sin(t)));
      }
      d += pt(r, h);
      for (let i = 0; i <= STEPS; i++) {
        // bottom-left
        const t = (i / STEPS) * HALF_PI;
        d += pt(r - r * pow(Math.sin(t)), h - r + r * pow(Math.cos(t)));
      }
      d += pt(0, r);
      for (let i = 0; i <= STEPS; i++) {
        // top-left
        const t = (i / STEPS) * HALF_PI;
        d += pt(r - r * pow(Math.cos(t)), r - r * pow(Math.sin(t)));
      }
      return d + 'Z';
    }

    // Putar arah gradient garis tepi (highlight kaca) di sekitar titik tengah kartu
    function setBorderRotation(deg: number) {
      rotateDeg = ((deg % 360) + 360) % 360;
      const rad = (rotateDeg * Math.PI) / 180;
      const cx = CARD_LOCAL_W / 2,
        cy = CARD_LOCAL_H / 2,
        R = Number(ctrlLength.value);
      const x1 = cx + R * Math.sin(rad),
        y1 = cy - R * Math.cos(rad);
      const x2 = cx - R * Math.sin(rad),
        y2 = cy + R * Math.cos(rad);
      mpBorderGradient.setAttribute('x1', x1.toFixed(2));
      mpBorderGradient.setAttribute('y1', y1.toFixed(2));
      mpBorderGradient.setAttribute('x2', x2.toFixed(2));
      mpBorderGradient.setAttribute('y2', y2.toFixed(2));
      knobIndicator.style.transform = `rotate(${rotateDeg}deg)`;
      valRotate.textContent = Math.round(rotateDeg) + '°';
      valLength.textContent = String(R);
    }

    function applyCardStyle() {
      const r = Number(ctrlRadius.value),
        sm = Number(ctrlSmooth.value);
      const h = ctrlHeight.value,
        w = ctrlWidth.value,
        o = ctrlOpacity.value;
      const n = 2 + (sm / 100) * 3; // 0% -> lingkaran biasa, 100% -> squircle penuh

      cardBgRect.setAttribute('d', squirclePath(0, 0, CARD_LOCAL_W, CARD_LOCAL_H, r, n));
      cardBorderRect.setAttribute(
        'd',
        squirclePath(0.375, 0.375, CARD_LOCAL_W - 0.75, CARD_LOCAL_H - 0.75, Math.max(0, r - 0.375), n)
      );
      // Clip blur/backdrop pakai bentuk PERSIS sama dengan kartu, jadi tidak pernah menutupi garis tepi
      cardClipPath.setAttribute('d', squirclePath(0, 0, CARD_LOCAL_W, CARD_LOCAL_H, r, n));

      stage.style.setProperty('--card-h', h + '%');
      stage.style.setProperty('--card-w', w + '%');
      // "Opacity" = seberapa solid/padat permukaan kartu (aslinya cuma 8%, kaca transparan)
      cardBgRect.setAttribute('fill-opacity', String(Number(o) / 100));
      valRadius.textContent = r + 'px';
      valSmooth.textContent = sm + '%';
      valHeight.textContent = h + '%';
      valWidth.textContent = w + '%';
      valOpacity.textContent = o + '%';
    }

    function applyAlbumArtStyle() {
      const r = Number(ctrlCoverRadius.value),
        sm = Number(ctrlCoverSmooth.value);
      const n = 2 + (sm / 100) * 3;
      const d = squirclePath(27, 27, 282, 282, r, n);
      albumArtClipPath.setAttribute('d', d);
      albumArtPlaceholderPath.setAttribute('d', d);
      valCoverRadius.textContent = r + 'px';
      valCoverSmooth.textContent = sm + '%';
    }

    [ctrlCoverRadius, ctrlCoverSmooth].forEach((el) => {
      on(el, 'input', applyAlbumArtStyle);
      on(el, 'click', (e: Event) => e.stopPropagation());
    });

    [ctrlRadius, ctrlSmooth, ctrlHeight, ctrlWidth, ctrlOpacity].forEach((el) => {
      on(el, 'input', applyCardStyle);
      on(el, 'click', (e: Event) => e.stopPropagation());
    });

    on(ctrlLength, 'input', () => setBorderRotation(rotateDeg));
    on(ctrlLength, 'click', (e: Event) => e.stopPropagation());

    on(resetBtn, 'click', (e: Event) => {
      e.stopPropagation();
      ctrlRadius.value = String(DEFAULTS.radius);
      ctrlSmooth.value = String(DEFAULTS.smoothing);
      ctrlHeight.value = String(DEFAULTS.height);
      ctrlWidth.value = String(DEFAULTS.width);
      ctrlOpacity.value = String(DEFAULTS.opacity);
      ctrlLength.value = String(DEFAULTS.length);
      ctrlCoverRadius.value = String(DEFAULTS.coverRadius);
      ctrlCoverSmooth.value = String(DEFAULTS.coverSmooth);
      renderDuration();
      applyCardStyle();
      applyAlbumArtStyle();
      setBorderRotation(DEFAULTS.rotate);
    });

    // Knob putar (drag) untuk arah garis tepi
    function angleFromPointer(e: PointerEvent) {
      const rect = knobRotate.getBoundingClientRect();
      const cx = rect.left + rect.width / 2,
        cy = rect.top + rect.height / 2;
      return Math.atan2(e.clientX - cx, -(e.clientY - cy)) * (180 / Math.PI);
    }
    let dragging = false;
    on(knobRotate, 'pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      dragging = true;
      knobRotate.setPointerCapture(e.pointerId);
      setBorderRotation(angleFromPointer(e));
    });
    on(knobRotate, 'pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      e.stopPropagation();
      setBorderRotation(angleFromPointer(e));
    });
    on(knobRotate, 'pointerup', (e: PointerEvent) => {
      dragging = false;
      e.stopPropagation();
    });
    on(knobRotate, 'click', (e: Event) => e.stopPropagation());

    const firstControlPanel = root.querySelector('.control-panel');
    if (firstControlPanel) on(firstControlPanel, 'click', (e: Event) => e.stopPropagation());

    // ==== Panel terpisah: opacity semua kartu Control Center ====
    const ctrlCcOpacity = $<HTMLInputElement>('ctrlCcOpacity');
    const valCcOpacity = $('valCcOpacity');
    const resetCcBtn = $('resetCcBtn');
    const ccCardSurfaces = Array.from(
      root.querySelectorAll<SVGRectElement>('.cc svg rect[fill-opacity="0.08"]')
    );

    function applyCcOpacity() {
      const opacity = Number(ctrlCcOpacity.value);
      ccCardSurfaces.forEach((card) => card.setAttribute('fill-opacity', String(opacity / 100)));
      valCcOpacity.textContent = opacity + '%';
    }

    on(ctrlCcOpacity, 'input', applyCcOpacity);
    on(ctrlCcOpacity, 'click', (e: Event) => e.stopPropagation());
    on(resetCcBtn, 'click', (e: Event) => {
      e.stopPropagation();
      ctrlCcOpacity.value = String(DEFAULTS.ccOpacity);
      applyCcOpacity();
    });

    // ==== Upload gambar custom untuk album art ====
    const ctrlAlbumArt = $<HTMLInputElement>('ctrlAlbumArt');
    const uploadArtBtn = $('uploadArtBtn');
    const removeArtBtn = $<HTMLElement>('removeArtBtn');
    const albumArtImage = $<SVGImageElement>('albumArtImage');
    const albumArtPlaceholder = $<SVGElement>('albumArtPlaceholder');

    on(uploadArtBtn, 'click', (e: Event) => {
      e.stopPropagation();
      ctrlAlbumArt.click();
    });
    on(removeArtBtn, 'click', (e: Event) => {
      e.stopPropagation();
      albumArtImage.setAttribute('href', '');
      albumArtImage.setAttribute('xlink:href', '');
      albumArtImage.setAttribute('opacity', '0');
      albumArtPlaceholder.setAttribute('opacity', '0.25');
      removeArtBtn.style.display = 'none';
      ctrlAlbumArt.value = '';
    });
    on(ctrlAlbumArt, 'click', (e: Event) => e.stopPropagation());
    on(ctrlAlbumArt, 'change', () => {
      const file = ctrlAlbumArt.files && ctrlAlbumArt.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        albumArtImage.setAttribute('href', dataUrl);
        albumArtImage.setAttribute('xlink:href', dataUrl);
        albumArtImage.setAttribute('opacity', '1');
        albumArtPlaceholder.setAttribute('opacity', '0');
        removeArtBtn.style.display = 'block';
      };
      reader.readAsDataURL(file);
    });

    // ==== Custom judul & artis ====
    const ctrlSongTitle = $<HTMLInputElement>('ctrlSongTitle');
    const ctrlSongArtist = $<HTMLInputElement>('ctrlSongArtist');
    const songTitle = $('songTitle');
    const songArtist = $('songArtist');
    const ctrlMusicFont = $<HTMLSelectElement>('ctrlMusicFont');

    function applyMusicFont() {
      const font = ctrlMusicFont.value === 'black' ? 'SF Pro Display Black' : 'SF Pro Display Medium';
      [songTitle, songArtist, $('timeElapsed'), $('timeRemaining')].forEach((el) =>
        el.setAttribute('font-family', `'${font}', sans-serif`)
      );
    }
    on(ctrlMusicFont, 'change', applyMusicFont);
    on(ctrlMusicFont, 'click', (e: Event) => e.stopPropagation());
    on(ctrlSongTitle, 'input', () => {
      songTitle.textContent = ctrlSongTitle.value || ' ';
    });
    on(ctrlSongArtist, 'input', () => {
      songArtist.textContent = ctrlSongArtist.value || ' ';
    });
    [ctrlSongTitle, ctrlSongArtist].forEach((el) => on(el, 'click', (e: Event) => e.stopPropagation()));

    // ==== Export / Import Settings — simpan hasil customize jadi file, biar gak perlu atur manual lagi ====
    const exportSettingsBtn = $('exportSettingsBtn');
    const importSettingsBtn = $('importSettingsBtn');
    const ctrlImportSettings = $<HTMLInputElement>('ctrlImportSettings');

    type ExportedSettings = {
      version: 1;
      card: {
        radius: number;
        smoothing: number;
        height: number;
        width: number;
        opacity: number;
        rotate: number;
        length: number;
      };
      cover: { radius: number; smoothing: number };
      ccOpacity: number;
      song: { title: string; artist: string; font: string };
      albumArt: string | null;
    };

    function collectSettings(): ExportedSettings {
      return {
        version: 1,
        card: {
          radius: Number(ctrlRadius.value),
          smoothing: Number(ctrlSmooth.value),
          height: Number(ctrlHeight.value),
          width: Number(ctrlWidth.value),
          opacity: Number(ctrlOpacity.value),
          rotate: rotateDeg,
          length: Number(ctrlLength.value),
        },
        cover: {
          radius: Number(ctrlCoverRadius.value),
          smoothing: Number(ctrlCoverSmooth.value),
        },
        ccOpacity: Number(ctrlCcOpacity.value),
        song: {
          title: ctrlSongTitle.value,
          artist: ctrlSongArtist.value,
          font: ctrlMusicFont.value,
        },
        // href SVG kosong ("") dianggap "tidak ada album art custom"
        albumArt: albumArtImage.getAttribute('href') || null,
      };
    }

    function applySettings(data: ExportedSettings) {
      ctrlRadius.value = String(data.card.radius);
      ctrlSmooth.value = String(data.card.smoothing);
      ctrlHeight.value = String(data.card.height);
      ctrlWidth.value = String(data.card.width);
      ctrlOpacity.value = String(data.card.opacity);
      ctrlLength.value = String(data.card.length);
      ctrlCoverRadius.value = String(data.cover.radius);
      ctrlCoverSmooth.value = String(data.cover.smoothing);
      ctrlCcOpacity.value = String(data.ccOpacity);
      ctrlSongTitle.value = data.song.title;
      ctrlSongArtist.value = data.song.artist;
      ctrlMusicFont.value = data.song.font;

      songTitle.textContent = data.song.title || ' ';
      songArtist.textContent = data.song.artist || ' ';

      if (data.albumArt) {
        albumArtImage.setAttribute('href', data.albumArt);
        albumArtImage.setAttribute('xlink:href', data.albumArt);
        albumArtImage.setAttribute('opacity', '1');
        albumArtPlaceholder.setAttribute('opacity', '0');
        removeArtBtn.style.display = 'block';
      } else {
        albumArtImage.setAttribute('href', '');
        albumArtImage.setAttribute('xlink:href', '');
        albumArtImage.setAttribute('opacity', '0');
        albumArtPlaceholder.setAttribute('opacity', '0.25');
        removeArtBtn.style.display = 'none';
      }

      applyCardStyle();
      applyAlbumArtStyle();
      applyCcOpacity();
      applyMusicFont();
      setBorderRotation(data.card.rotate);
    }

    on(exportSettingsBtn, 'click', (e: Event) => {
      e.stopPropagation();
      const data = collectSettings();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'control-center-settings.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    on(importSettingsBtn, 'click', (e: Event) => {
      e.stopPropagation();
      ctrlImportSettings.click();
    });
    on(ctrlImportSettings, 'click', (e: Event) => e.stopPropagation());
    on(ctrlImportSettings, 'change', () => {
      const file = ctrlImportSettings.files && ctrlImportSettings.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(String(ev.target?.result)) as ExportedSettings;
          applySettings(data);
        } catch {
          alert('File settings tidak valid atau rusak.');
        }
        ctrlImportSettings.value = '';
      };
      reader.readAsText(file);
    });

    // ==== Toggle Play / Pause ====
    const playIcon = $<HTMLElement>('playIcon');
    const pauseIcon = $<HTMLElement>('pauseIcon');
    const playPauseHit = $('playPauseHit');
    const playPauseIconGroup = $('playPauseIconGroup');
    let isPlaying = false;

    // ==== Durasi lagu: waktu berjalan & sisa durasi ====
    const timeElapsed = $('timeElapsed');
    const timeRemaining = $('timeRemaining');
    const progressFill = $<SVGRectElement>('progressFill');
    const SONG_TOTAL = 225; // total durasi 3:45
    let elapsed = 113; // posisi awal 1:53 (sesuai progress di desain)
    let tickTimer: ReturnType<typeof setInterval> | null = null;

    function fmtTime(sec: number) {
      sec = Math.max(0, Math.round(sec));
      return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    function renderDuration() {
      timeElapsed.textContent = fmtTime(elapsed);
      timeRemaining.textContent = '-' + fmtTime(SONG_TOTAL - elapsed);
      progressFill.setAttribute('width', ((282 * elapsed) / SONG_TOTAL).toFixed(2));
    }
    function startTick() {
      stopTick();
      tickTimer = setInterval(() => {
        elapsed = elapsed + 1;
        if (elapsed > SONG_TOTAL) elapsed = 0;
        renderDuration();
      }, 1000);
    }
    function stopTick() {
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }
    on(playPauseIconGroup, 'animationend', () => {
      playPauseIconGroup.classList.remove('bounce');
    });
    on(playPauseHit, 'click', (e: Event) => {
      e.stopPropagation();
      isPlaying = !isPlaying;
      playIcon.style.opacity = isPlaying ? '0' : '1';
      pauseIcon.style.opacity = isPlaying ? '1' : '0';
      // restart animasi bounce
      playPauseIconGroup.classList.remove('bounce');
      void playPauseIconGroup.offsetWidth; // reflow biar animasi bisa diulang
      playPauseIconGroup.classList.add('bounce');
      if (isPlaying) startTick();
      else stopTick();
    });

    // ==== Export Frame: capture tampilan HP saat ini jadi PNG rasio 9:16 (1080x1920) ====
    const exportFrameBtn = $<HTMLButtonElement>('exportFrameBtn');
    const EXPORT_H = 1920; // tinggi target hasil export (lebar dihitung otomatis dari rasio layar HP)
    on(exportFrameBtn, 'click', async (e: Event) => {
      e.stopPropagation();
      const originalLabel = exportFrameBtn.textContent || 'Export Frame (PNG 1080x1920)';
      exportFrameBtn.disabled = true;
      exportFrameBtn.textContent = 'Membuat gambar...';
      let cloneWrap: HTMLDivElement | null = null;
      try {
        const rect = stage.getBoundingClientRect();
        // Render stage pada skala yang membuat tingginya pas 1920px, biar hasil tajam & rasio aslinya (450:920) otomatis kebagi rata di dalam kanvas 1080x1920.
        const scale = EXPORT_H / rect.height;

        // ==== 1. Bekukan frame video wallpaper saat ini + siapkan lapisan blur pengganti backdrop-filter ====
        const videoEl = root.querySelector<HTMLVideoElement>('.wallpaper-video');
        const videoFO = videoEl?.closest('foreignObject') || null;
        const wx = Number(videoFO?.getAttribute('x') ?? 24);
        const wy = Number(videoFO?.getAttribute('y') ?? 23);
        const ww = Number(videoFO?.getAttribute('width') ?? 402);
        const wh = Number(videoFO?.getAttribute('height') ?? 874);
        const CAPTURE_SCALE = 2.5; // resolusi capture wallpaper, independen dari skala export akhir
        const cw = Math.round(ww * CAPTURE_SCALE);
        const ch = Math.round(wh * CAPTURE_SCALE);

        let rawWallpaperUrl: string | null = null;
        let ccBlurUrl: string | null = null; // pengganti backdrop-filter blur(12px) + hitam 50% (selalu aktif di Control Center)
        let openBlurUrl: string | null = null; // pengganti stage::after blur(18px) + hitam 15% (aktif saat Music Player terbuka)

        if (videoEl && videoEl.readyState >= 2) {
          rawWallpaperUrl = captureVideoFrame(videoEl, cw, ch);
          ccBlurUrl = await blurAndDim(rawWallpaperUrl, cw, ch, 12 * CAPTURE_SCALE, 0.5);
          if (stage.classList.contains('open')) {
            openBlurUrl = await blurAndDim(ccBlurUrl, cw, ch, 18 * CAPTURE_SCALE, 0.15);
          }
        }

        // ==== 2. Clone stage (biar modifikasi di bawah ini tidak mengganggu tampilan asli & video yang lagi jalan) ====
        cloneWrap = document.createElement('div');
        cloneWrap.className = 'export-frame-clone';
        cloneWrap.style.cssText =
          'position:fixed;left:-99999px;top:0;width:' + rect.width + 'px;height:' + rect.height + 'px;pointer-events:none;';

        const stageClone = stage.cloneNode(true) as HTMLElement;
        stageClone.removeAttribute('id');
        // Matikan blur bawaan CSS punya clone ini: backdrop-filter tidak pernah kebawa html2canvas,
        // tapi warna hitam datarnya (rgba tanpa blur) tetap bisa ke-render & bikin dobel gelap
        // di atas lapisan pengganti yang kita suntikkan manual di bawah.
        const styleOverride = document.createElement('style');
        styleOverride.textContent = '.export-frame-clone .stage::after { display: none !important; }';
        cloneWrap.appendChild(styleOverride);
        cloneWrap.appendChild(stageClone);
        document.body.appendChild(cloneWrap);

        // Ganti <video> jadi <img> beku (frame saat ini)
        const cloneVideoEl = stageClone.querySelector<HTMLVideoElement>('.wallpaper-video');
        const cloneVideoFO = cloneVideoEl?.closest('foreignObject');
        if (cloneVideoFO && rawWallpaperUrl) {
          cloneVideoFO.innerHTML = `<img xmlns="http://www.w3.org/1999/xhtml" src="${rawWallpaperUrl}" style="width:100%;height:100%;object-fit:cover;display:block" />`;
        }

        // Ganti div backdrop-filter (blur Control Center yang selalu aktif) dengan gambar hasil blur manual.
        // foreignObject-nya disamakan ukurannya dgn kotak wallpaper biar tidak perlu clip-path lagi.
        const cloneBackdropDiv = stageClone.querySelector<HTMLElement>(
          'foreignObject div[style*="backdrop-filter"]'
        );
        const backdropFO = cloneBackdropDiv?.closest('foreignObject');
        if (backdropFO && ccBlurUrl) {
          backdropFO.setAttribute('x', String(wx));
          backdropFO.setAttribute('y', String(wy));
          backdropFO.setAttribute('width', String(ww));
          backdropFO.setAttribute('height', String(wh));
          backdropFO.innerHTML = `<img xmlns="http://www.w3.org/1999/xhtml" src="${ccBlurUrl}" style="width:100%;height:100%;object-fit:cover;display:block" />`;
        }

        // Path tint hitam 50% datar (fallback figma) dimatikan karena sudah kebawa di dalam ccBlurUrl,
        // kalau dibiarkan nyala dobel jadi lebih gelap dari aslinya.
        const flatTintPath = stageClone.querySelector('path[data-figma-bg-blur-radius]');
        if (flatTintPath) flatTintPath.setAttribute('fill-opacity', '0');

        // Kalau Music Player sedang terbuka, tambahkan lapisan dim+blur ekstra persis
        // menggantikan .stage::after (blur 18px + hitam 15% di atas wallpaper yang sudah diblur tahap 1)
        if (openBlurUrl) {
          const afterLayer = document.createElement('div');
          afterLayer.style.cssText =
            'position:absolute;left:5.33%;top:2.5%;width:89.33%;height:95%;z-index:1;pointer-events:none;overflow:hidden;border-radius:13.5%/6.2%;';
          const afterImg = document.createElement('img');
          afterImg.src = openBlurUrl;
          afterImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
          afterLayer.appendChild(afterImg);
          stageClone.appendChild(afterLayer);
        }

        // Tunggu semua <img> pengganti kelar dimuat sebelum di-screenshot
        const injectedImgs = Array.from(stageClone.querySelectorAll('img'));
        await Promise.all(
          injectedImgs.map(
            (img) =>
              new Promise<void>((resolve) => {
                if (img.complete) return resolve();
                img.onload = () => resolve();
                img.onerror = () => resolve();
              })
          )
        );

        // ==== 3. Screenshot clone yang sudah "dibekukan" (video jadi gambar, blur sudah di-bake manual) ====
        const captured = await html2canvas(stageClone, {
          backgroundColor: null,
          useCORS: true,
          scale,
        });

        // ==== 4. Crop: buang frame/bezel HP, sisain area layarnya aja (wx,wy,ww,wh — persis kotak yang sama
        // dipakai wallpaper/blur di atas). Stage full = viewBox 450x920, jadi posisinya tinggal dihitung
        // proporsional terhadap ukuran hasil capture (yang sudah proporsional 450:920 juga).
        const cropX = (wx / 450) * captured.width;
        const cropY = (wy / 920) * captured.height;
        const cropW = (ww / 450) * captured.width;
        const cropH = (wh / 920) * captured.height;

        // Output disamakan rasionya dengan area layar itu sendiri (~402:874), tinggi target tetap ~1920px
        // biar tajam, tanpa nambah background/letterbox — sudut yang membulat otomatis transparan.
        const outH = EXPORT_H;
        const outW = Math.round(outH * (ww / wh));

        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('Canvas context tidak tersedia');
        ctx.drawImage(captured, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

        const blob: Blob | null = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Gagal membuat PNG');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `control-center-frame-${outW}x${outH}.png`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Export frame gagal:', err);
        alert('Gagal export gambar. Coba lagi.');
      } finally {
        if (cloneWrap && cloneWrap.parentNode) cloneWrap.parentNode.removeChild(cloneWrap);
        exportFrameBtn.disabled = false;
        exportFrameBtn.textContent = originalLabel;
      }
    });

    applyCardStyle();
    applyAlbumArtStyle();
    applyCcOpacity();
    applyMusicFont();
    setBorderRotation(DEFAULTS.rotate);
    // Buka player otomatis supaya perubahan customize langsung terlihat
    stage.classList.add('open');
    hint.textContent = 'Klik di mana saja pada HP untuk kembali ke Control Center';

    return () => {
      stopTick();
      cleanupFns.forEach((fn) => fn());
    };
  }, []);

  return (
    <div className="page-wrap" ref={rootRef}>
      <div className="stage stage-col" id="stage" dangerouslySetInnerHTML={{ __html: STAGE_MARKUP }} />
      <div className="customize-wrap">
        <button type="button" className="customize-toggle" id="customizeToggle">
          <span>Customize</span>
          <span className="chevron" id="customizeChevron">⌄</span>
        </button>
        <div className="panel-stack collapsed" id="panelStack" dangerouslySetInnerHTML={{ __html: PANELS_MARKUP }} />
      </div>
    </div>
  );
}
