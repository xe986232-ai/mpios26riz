import { useEffect, useRef } from 'react';
import html2canvas from 'html2canvas';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
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

// Seek <video> ke waktu tertentu dan tunggu sampai frame di waktu itu benar-benar siap digambar
// (event 'seeked'), supaya tiap frame video yang di-capture akurat sesuai posisi yang diminta —
// bukan posisi lama yang kebetulan masih nyangkut di buffer.
function seekVideoTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
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
      stageZoom: 112,
      stageOffsetY: 0,
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

    // ==== Panel: Zoom & Posisi Konten — kontrol --stage-zoom / --stage-offset-y yang dipakai .stage di App.css ====
    const ctrlStageZoom = $<HTMLInputElement>('ctrlStageZoom');
    const ctrlStageOffsetY = $<HTMLInputElement>('ctrlStageOffsetY');
    const valStageZoom = $('valStageZoom');
    const valStageOffsetY = $('valStageOffsetY');
    const resetStageBtn = $('resetStageBtn');

    function applyStageTransform() {
      const zoom = Number(ctrlStageZoom.value);
      const offsetY = Number(ctrlStageOffsetY.value);
      stage.style.setProperty('--stage-zoom', String(zoom));
      stage.style.setProperty('--stage-offset-y', String(offsetY));
      valStageZoom.textContent = zoom + '%';
      valStageOffsetY.textContent = offsetY + '%';
    }

    on(ctrlStageZoom, 'input', applyStageTransform);
    on(ctrlStageOffsetY, 'input', applyStageTransform);
    [ctrlStageZoom, ctrlStageOffsetY].forEach((el) => on(el, 'click', (e: Event) => e.stopPropagation()));
    on(resetStageBtn, 'click', (e: Event) => {
      e.stopPropagation();
      ctrlStageZoom.value = String(DEFAULTS.stageZoom);
      ctrlStageOffsetY.value = String(DEFAULTS.stageOffsetY);
      applyStageTransform();
    });

    // ==== Upload gambar custom untuk album art ====
    const ctrlAlbumArt = $<HTMLInputElement>('ctrlAlbumArt');
    const uploadArtBtn = $('uploadArtBtn');
    const removeArtBtn = $<HTMLElement>('removeArtBtn');
    const albumArtImage = $<SVGImageElement>('albumArtImage');
    const albumArtPlaceholder = $<SVGElement>('albumArtPlaceholder');
    // Gambar kecil yang sama, ditampilkan juga di kartu widget Control Center kanan atas
    const widgetAlbumArtImage = $<SVGImageElement>('widgetAlbumArtImage');

    // Set (atau kosongkan) album art sekaligus di Music Player & kartu widget, biar selalu sinkron.
    function setAlbumArt(dataUrl: string) {
      const hasArt = dataUrl !== '';
      albumArtImage.setAttribute('href', dataUrl);
      albumArtImage.setAttribute('xlink:href', dataUrl);
      albumArtImage.setAttribute('opacity', hasArt ? '1' : '0');
      albumArtPlaceholder.setAttribute('opacity', hasArt ? '0' : '0.25');
      widgetAlbumArtImage.setAttribute('href', dataUrl);
      widgetAlbumArtImage.setAttribute('xlink:href', dataUrl);
      widgetAlbumArtImage.setAttribute('opacity', hasArt ? '1' : '0');
      removeArtBtn.style.display = hasArt ? 'block' : 'none';
    }

    on(uploadArtBtn, 'click', (e: Event) => {
      e.stopPropagation();
      ctrlAlbumArt.click();
    });
    on(removeArtBtn, 'click', (e: Event) => {
      e.stopPropagation();
      setAlbumArt('');
      ctrlAlbumArt.value = '';
    });
    on(ctrlAlbumArt, 'click', (e: Event) => e.stopPropagation());
    on(ctrlAlbumArt, 'change', () => {
      const file = ctrlAlbumArt.files && ctrlAlbumArt.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setAlbumArt(dataUrl);
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
      stage?: { zoom: number; offsetY: number };
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
        stage: {
          zoom: Number(ctrlStageZoom.value),
          offsetY: Number(ctrlStageOffsetY.value),
        },
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
      ctrlStageZoom.value = String(data.stage?.zoom ?? DEFAULTS.stageZoom);
      ctrlStageOffsetY.value = String(data.stage?.offsetY ?? DEFAULTS.stageOffsetY);
      ctrlSongTitle.value = data.song.title;
      ctrlSongArtist.value = data.song.artist;
      ctrlMusicFont.value = data.song.font;

      songTitle.textContent = data.song.title || ' ';
      songArtist.textContent = data.song.artist || ' ';

      if (data.albumArt) {
        setAlbumArt(data.albumArt);
      } else {
        setAlbumArt('');
      }

      applyCardStyle();
      applyAlbumArtStyle();
      applyCcOpacity();
      applyStageTransform();
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
    // Ikon play/pause versi kecil di kartu widget (Control Center)
    const widgetPlayIcon = $<HTMLElement>('widgetPlayIcon');
    const widgetPauseIcon = $<HTMLElement>('widgetPauseIcon');
    const widgetPlayPauseHit = $('widgetPlayPauseHit');
    const widgetPlayPauseIconGroup = $('widgetPlayPauseIconGroup');

    // ==== Durasi lagu: waktu berjalan & sisa durasi — mengikuti audio asli yang di-upload ====
    const timeElapsed = $('timeElapsed');
    const timeRemaining = $('timeRemaining');
    const progressFill = $<SVGRectElement>('progressFill');
    const progressTrack = $<SVGRectElement>('progressTrack');
    const progressHit = $<SVGRectElement>('progressHit');
    const PROGRESS_BAR_WIDTH = 282; // lebar track dalam unit SVG (bukan px layar)
    let songDuration = 0; // durasi total, ikut durasi file audio yang di-upload (0 = belum ada audio)
    let elapsed = 0; // posisi berjalan, dalam detik
    // tickingEnabled dipakai buat "mematikan sementara" sinkronisasi ke audio asli
    // waktu proses export video (di situ elapsed di-advance manual, frame demi frame).
    let tickingEnabled = true;

    function fmtTime(sec: number) {
      sec = Math.max(0, Math.round(sec));
      return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    function renderDuration() {
      const dur = Math.max(0, songDuration);
      const pos = Math.min(Math.max(0, elapsed), dur);
      timeElapsed.textContent = fmtTime(pos);
      timeRemaining.textContent = '-' + fmtTime(dur - pos);
      progressFill.setAttribute('width', dur > 0 ? ((PROGRESS_BAR_WIDTH * pos) / dur).toFixed(2) : '0');
    }
    // Dipanggil tiap kali durasi audio yang sebenarnya berubah/diketahui (metadata audio ke-load).
    function updateSongDuration() {
      const audioDur = audioPreviewEl.duration;
      const validAudioDur = Number.isFinite(audioDur) && audioDur > 0 ? audioDur : 0;
      songDuration = validAudioDur || (loadedAudioBuffer ? loadedAudioBuffer.duration : 0);
      renderDuration();
    }
    function startTick() {
      tickingEnabled = true;
    }
    function stopTick() {
      tickingEnabled = false;
    }
    on(playPauseIconGroup, 'animationend', () => {
      playPauseIconGroup.classList.remove('bounce');
    });
    on(widgetPlayPauseIconGroup, 'animationend', () => {
      widgetPlayPauseIconGroup.classList.remove('bounce');
    });

    // Ikon play/pause di Music Player & kartu widget sekarang cuma "cerminan" dari state
    // audio asli (audioPreviewEl) — dipanggil dari event play/pause audio-nya, bukan dari klik langsung.
    function reflectPlayingState(isPlayingNow: boolean) {
      playIcon.style.opacity = isPlayingNow ? '0' : '1';
      pauseIcon.style.opacity = isPlayingNow ? '1' : '0';
      playPauseIconGroup.classList.remove('bounce');
      void playPauseIconGroup.offsetWidth; // reflow biar animasi bisa diulang
      playPauseIconGroup.classList.add('bounce');

      widgetPlayIcon.style.opacity = isPlayingNow ? '0' : '1';
      widgetPauseIcon.style.opacity = isPlayingNow ? '1' : '0';
      widgetPlayPauseIconGroup.classList.remove('bounce');
      void widgetPlayPauseIconGroup.offsetWidth;
      widgetPlayPauseIconGroup.classList.add('bounce');

      if (isPlayingNow) startTick();
      else stopTick();
    }

    // ==== Audio Canvas: upload file audio, render waveform, preview play/pause ====
    const audioWaveformCanvas = $<HTMLCanvasElement>('audioWaveformCanvas');
    const audioCanvasEmpty = $('audioCanvasEmpty');
    const audioCanvasInfo = $('audioCanvasInfo');
    const audioUploadInput = $<HTMLInputElement>('audioUploadInput');
    const audioUploadBtn = $<HTMLButtonElement>('audioUploadBtn');
    const audioReplaceBtn = $<HTMLButtonElement>('audioReplaceBtn');
    const audioFileNameEl = $('audioFileName');
    const audioFileDurationEl = $('audioFileDuration');
    const audioPreviewEl = $<HTMLAudioElement>('audioPreviewEl');
    const audioPlayPauseBtn = $<HTMLButtonElement>('audioPlayPauseBtn');
    const audioPlayIcon = $('audioPlayIcon');
    const audioPauseIcon = $('audioPauseIcon');

    // Disimpan di closure biar bisa dipakai fitur lain nanti (mis. sinkron ke Export Video)
    let loadedAudioBuffer: AudioBuffer | null = null;
    let waveformPeaks: Array<{ min: number; max: number }> | null = null; // cache biar nggak dihitung ulang tiap frame playhead
    let audioObjectUrl: string | null = null;
    let playheadRaf: number | null = null;

    function fmtAudioTime(sec: number) {
      sec = Math.max(0, Math.round(sec));
      return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }

    // Hitung min/max per kolom pixel sekali aja saat file baru di-load / kanvas di-resize.
    function computeWaveformPeaks(buffer: AudioBuffer, width: number) {
      const data = buffer.getChannelData(0); // channel pertama cukup buat preview visual
      const w = Math.max(1, Math.round(width));
      const samplesPerPixel = Math.max(1, Math.floor(data.length / w));
      const peaks: Array<{ min: number; max: number }> = [];
      for (let x = 0; x < w; x++) {
        const start = x * samplesPerPixel;
        let min = 1;
        let max = -1;
        for (let i = 0; i < samplesPerPixel; i++) {
          const v = data[start + i] || 0;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        peaks.push({ min, max });
      }
      return peaks;
    }

    // Gambar ulang dari cache peaks (murah, aman dipanggil tiap frame buat playhead) + garis posisi putar.
    function renderWaveformCanvas(playheadRatio?: number) {
      if (!waveformPeaks) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = audioWaveformCanvas.getBoundingClientRect();
      audioWaveformCanvas.width = Math.max(1, Math.round(rect.width * dpr));
      audioWaveformCanvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = audioWaveformCanvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const mid = h / 2;
      const playedUpTo = playheadRatio !== undefined ? playheadRatio * w : -1;
      for (let x = 0; x < waveformPeaks.length; x++) {
        const { min, max } = waveformPeaks[x];
        const yTop = mid + min * mid;
        const barH = Math.max(1, (max - min) * mid);
        ctx.fillStyle = x <= playedUpTo ? '#fff' : '#0a84ff';
        ctx.fillRect(x, yTop, 1, barH);
      }
      if (playheadRatio !== undefined) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(Math.min(w - 1.5, playedUpTo), 0, 1.5, h);
      }
    }

    function drawWaveform(buffer: AudioBuffer) {
      const rect = audioWaveformCanvas.getBoundingClientRect();
      waveformPeaks = computeWaveformPeaks(buffer, rect.width);
      renderWaveformCanvas(0);
    }

    function setPlayIconState(isPlayingAudio: boolean) {
      audioPlayIcon.style.display = isPlayingAudio ? 'none' : 'block';
      audioPauseIcon.style.display = isPlayingAudio ? 'block' : 'none';
    }

    function stopPlayheadLoop() {
      if (playheadRaf !== null) {
        cancelAnimationFrame(playheadRaf);
        playheadRaf = null;
      }
    }

    function startPlayheadLoop() {
      stopPlayheadLoop();
      const tick = () => {
        const dur = audioPreviewEl.duration || 0;
        renderWaveformCanvas(dur > 0 ? audioPreviewEl.currentTime / dur : 0);
        // Sinkronkan progress bar & label durasi di Music Player ke posisi audio asli,
        // tiap frame (lebih halus daripada event 'timeupdate' yang cuma ~4x/detik).
        if (tickingEnabled) {
          elapsed = audioPreviewEl.currentTime;
          renderDuration();
        }
        playheadRaf = requestAnimationFrame(tick);
      };
      playheadRaf = requestAnimationFrame(tick);
    }

    async function handleAudioFile(file: File) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const decodeCtx = new AudioCtx();
        const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
        loadedAudioBuffer = decoded;
        void decodeCtx.close();

        // Sumber pemutaran preview: <audio> biasa via object URL (lebih ringan daripada re-decode ke Web Audio API tiap play)
        if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
        audioObjectUrl = URL.createObjectURL(file);
        audioPreviewEl.pause();
        audioPreviewEl.src = audioObjectUrl;
        setPlayIconState(false);
        stopPlayheadLoop();

        // Reset posisi & set durasi awal dari hasil decode (nanti disempurnakan lagi
        // begitu metadata elemen <audio> asli ke-load lewat updateSongDuration()).
        elapsed = 0;
        songDuration = decoded.duration;
        renderDuration();

        audioCanvasEmpty.style.display = 'none';
        audioWaveformCanvas.style.display = 'block';
        drawWaveform(decoded);
        audioCanvasInfo.style.display = 'flex';
        audioFileNameEl.textContent = file.name;
        audioFileDurationEl.textContent = fmtAudioTime(decoded.duration);
      } catch (err) {
        console.error('Gagal memuat audio:', err);
        alert('Gagal memuat file audio. Coba file lain.');
      }
    }

    on(audioUploadBtn, 'click', (e: Event) => {
      e.stopPropagation();
      audioUploadInput.click();
    });
    on(audioReplaceBtn, 'click', (e: Event) => {
      e.stopPropagation();
      audioUploadInput.click();
    });
    on(audioUploadInput, 'change', () => {
      const file = audioUploadInput.files && audioUploadInput.files[0];
      if (file) void handleAudioFile(file);
      audioUploadInput.value = '';
    });

    // Satu fungsi play/pause buat audio asli — dipakai bareng oleh tombol di Music Player,
    // tombol di kartu widget Control Center, DAN tombol kecil di canvas audio, biar semuanya
    // ngontrol pemutaran yang sama (bukan cuma animasi kosmetik lagi).
    function requestTogglePlayback() {
      if (!loadedAudioBuffer) return; // belum ada audio yang di-upload, gak ada yang bisa di-play
      if (audioPreviewEl.paused) void audioPreviewEl.play();
      else audioPreviewEl.pause();
    }

    on(audioPlayPauseBtn, 'click', (e: Event) => {
      e.stopPropagation();
      requestTogglePlayback();
    });
    on(playPauseHit, 'click', (e: Event) => {
      e.stopPropagation();
      requestTogglePlayback();
    });
    on(widgetPlayPauseHit, 'click', (e: Event) => {
      e.stopPropagation(); // jangan sampai membuka Music Player, cuma toggle play/pause
      requestTogglePlayback();
    });
    on(audioPreviewEl, 'play', () => {
      setPlayIconState(true);
      reflectPlayingState(true);
      startPlayheadLoop();
    });
    on(audioPreviewEl, 'pause', () => {
      setPlayIconState(false);
      reflectPlayingState(false);
      stopPlayheadLoop();
    });
    on(audioPreviewEl, 'ended', () => {
      setPlayIconState(false);
      stopPlayheadLoop();
      renderWaveformCanvas(0);
      elapsed = songDuration;
      renderDuration();
    });
    // Metadata (termasuk durasi asli) baru pasti akurat begitu browser selesai membacanya —
    // di sinilah progress bar & label durasi Music Player disamakan ke durasi audio yang di-upload.
    on(audioPreviewEl, 'loadedmetadata', updateSongDuration);
    on(audioPreviewEl, 'durationchange', updateSongDuration);
    // Jaga-jaga: event 'timeupdate' bawaan browser, buat kasus playhead loop belum jalan
    // (misalnya seek terjadi tanpa play), progress bar tetap kesinkron.
    on(audioPreviewEl, 'timeupdate', () => {
      if (!tickingEnabled) return;
      elapsed = audioPreviewEl.currentTime;
      renderDuration();
    });
    // Klik di atas waveform buat seek langsung ke posisi itu
    on(audioWaveformCanvas, 'click', (e: Event) => {
      e.stopPropagation();
      if (!loadedAudioBuffer) return;
      const me = e as MouseEvent;
      const rect = audioWaveformCanvas.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (me.clientX - rect.left) / rect.width));
      const dur = audioPreviewEl.duration || loadedAudioBuffer.duration;
      audioPreviewEl.currentTime = ratio * dur;
      elapsed = ratio * dur;
      renderDuration();
      renderWaveformCanvas(ratio);
    });

    // ==== Progress bar Music Player: klik & drag kiri-kanan buat set posisi lagu ====
    function seekRatioFromPointer(e: PointerEvent) {
      const rect = progressTrack.getBoundingClientRect();
      if (rect.width === 0) return 0;
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    }
    function applyProgressSeek(ratio: number) {
      if (songDuration <= 0) return; // belum ada audio yang di-upload
      elapsed = ratio * songDuration;
      renderDuration();
      renderWaveformCanvas(ratio);
      if (audioPreviewEl.readyState > 0) {
        audioPreviewEl.currentTime = elapsed;
      }
    }
    let draggingProgress = false;
    on(progressHit, 'pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      if (songDuration <= 0) return;
      draggingProgress = true;
      progressHit.setPointerCapture(e.pointerId);
      applyProgressSeek(seekRatioFromPointer(e));
    });
    on(progressHit, 'pointermove', (e: PointerEvent) => {
      if (!draggingProgress) return;
      e.stopPropagation();
      applyProgressSeek(seekRatioFromPointer(e));
    });
    on(progressHit, 'pointerup', (e: PointerEvent) => {
      draggingProgress = false;
      e.stopPropagation();
    });
    on(progressHit, 'pointercancel', () => {
      draggingProgress = false;
    });
    on(progressHit, 'click', (e: Event) => e.stopPropagation());

    const handleAudioCanvasResize = () => {
      if (loadedAudioBuffer) drawWaveform(loadedAudioBuffer);
    };
    window.addEventListener('resize', handleAudioCanvasResize);
    cleanupFns.push(() => window.removeEventListener('resize', handleAudioCanvasResize));
    cleanupFns.push(() => {
      stopPlayheadLoop();
      if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    });

    // ==== Export Frame & Export Video: capture KANVAS 9:16 (.stage-frame) apa adanya ====
    // Patokan export sekarang .stage-frame (kanvas yang tampak di layar, sudah terkunci rasio 9:16 lewat CSS),
    // BUKAN lagi area layar HP di dalam SVG (yang rasionya ~402:874, beda dari kanvas). Jadi apa yang kelihatan
    // di kanvas — termasuk ruang kosong letterbox kiri-kanan kalau ada — itulah yang ikut ke-export, 1:1.
    const exportFrameBtn = $<HTMLButtonElement>('exportFrameBtn');
    const exportVideoBtn = $<HTMLButtonElement>('exportVideoBtn');
    const exportVideoProgressWrap = $('exportVideoProgressWrap');
    const exportVideoProgressFill = $('exportVideoProgressFill');
    const exportVideoProgressLabel = $('exportVideoProgressLabel');
    const EXPORT_H = 1920; // tinggi target hasil export
    const EXPORT_W = 1080; // lebar target hasil export — dikunci 9:16, sama seperti .stage-frame
    const stageFrame = stage.parentElement as HTMLElement; // .stage-frame — elemen kanvas yang jadi acuan crop export
    const wallpaperVideoEl = root.querySelector<HTMLVideoElement>('.wallpaper-video');

    // Capture SATU frame kanvas (state DOM saat fungsi ini dipanggil) → canvas EXPORT_W x EXPORT_H.
    // Dipakai baik oleh Export Frame (sekali panggil) maupun Export Video (dipanggil berulang per frame,
    // dengan state — elapsed, posisi video wallpaper, dll — sudah di-advance manual sebelum tiap panggilan).
    async function captureStageCanvas(): Promise<HTMLCanvasElement> {
      let cloneWrap: HTMLDivElement | null = null;
      try {
        const rect = stageFrame.getBoundingClientRect();
        // Render pada skala yang membuat tinggi kanvas pas 1920px; karena .stage-frame terkunci rasio 9:16
        // di CSS, lebarnya otomatis ikut pas ~1080px — hasil export jadi identik dengan kanvas di layar.
        const scale = EXPORT_H / rect.height;

        // ==== 1. Bekukan frame video wallpaper saat ini + siapkan lapisan blur pengganti backdrop-filter ====
        const videoEl = wallpaperVideoEl;
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

        // ==== 2. Clone seluruh .stage-frame (kanvas 9:16 utuh, biar modifikasi di bawah ini tidak mengganggu
        // tampilan asli & video yang lagi jalan). stageClone tetap merujuk ke elemen .stage di dalamnya,
        // supaya semua posisi persen (video, backdrop, dll — relatif ke viewBox 450x920) tetap benar. ====
        cloneWrap = document.createElement('div');
        cloneWrap.className = 'export-frame-clone';
        cloneWrap.style.cssText =
          'position:fixed;left:-99999px;top:0;width:' + rect.width + 'px;height:' + rect.height + 'px;pointer-events:none;';

        const frameClone = stageFrame.cloneNode(true) as HTMLElement;
        const stageClone = (frameClone.querySelector<HTMLElement>('#stage') ?? frameClone) as HTMLElement;
        stageClone.removeAttribute('id'); // hindari id "stage" duplikat selagi clone ini nempel sementara di DOM
        // Matikan blur bawaan CSS punya clone ini: backdrop-filter tidak pernah kebawa html2canvas,
        // tapi warna hitam datarnya (rgba tanpa blur) tetap bisa ke-render & bikin dobel gelap
        // di atas lapisan pengganti yang kita suntikkan manual di bawah.
        const styleOverride = document.createElement('style');
        styleOverride.textContent =
          '.export-frame-clone .stage::after { display: none !important; }' +
          '.export-frame-clone .stage-frame { border-radius: 0 !important; }';
        cloneWrap.appendChild(styleOverride);
        cloneWrap.appendChild(frameClone);
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

        // ==== 3. Screenshot clone KANVAS PENUH (frameClone, 9:16) yang sudah "dibekukan"
        // (video jadi gambar, blur sudah di-bake manual). Border-radius + overflow:hidden milik
        // .stage-frame ikut ter-capture apa adanya, jadi sudut yang membulat otomatis transparan. ====
        const captured = await html2canvas(frameClone, {
          backgroundColor: null,
          useCORS: true,
          scale,
        });

        // ==== 4. Output dikunci persis 1080x1920 (9:16) — SAMA PERSIS dengan apa yang tampak di kanvas,
        // tanpa crop tambahan ke area layar HP lagi. Kanvas-lah yang jadi patokan, bukan konten di dalamnya. ====
        const out = document.createElement('canvas');
        out.width = EXPORT_W;
        out.height = EXPORT_H;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('Canvas context tidak tersedia');
        ctx.drawImage(captured, 0, 0, captured.width, captured.height, 0, 0, EXPORT_W, EXPORT_H);
        return out;
      } finally {
        if (cloneWrap && cloneWrap.parentNode) cloneWrap.parentNode.removeChild(cloneWrap);
      }
    }

    on(exportFrameBtn, 'click', async (e: Event) => {
      e.stopPropagation();
      const originalLabel = exportFrameBtn.textContent || 'Export Frame (PNG 1080x1920)';
      exportFrameBtn.disabled = true;
      exportFrameBtn.textContent = 'Membuat gambar...';
      try {
        const out = await captureStageCanvas();
        const blob: Blob | null = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Gagal membuat PNG');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `control-center-frame-${EXPORT_W}x${EXPORT_H}.png`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Export frame gagal:', err);
        alert('Gagal export gambar. Coba lagi.');
      } finally {
        exportFrameBtn.disabled = false;
        exportFrameBtn.textContent = originalLabel;
      }
    });

    // ==== Export Video: render N frame secara DETERMINISTIK (state di-advance manual per frame,
    // bukan capture real-time), lalu encode tiap frame pakai WebCodecs VideoEncoder + mux jadi .mp4
    // pakai mp4-muxer. Semua di browser, tanpa server/Playwright — hasilnya tetap akurat & konsisten
    // walau device lemot, karena kita yang mengontrol "waktu" tiap frame, bukan menunggu jam asli. ====
    const VIDEO_FPS = 30;
    const MAX_EXPORT_DURATION_SEC = 60; // batas atas — nanti UI pemilihan durasi tinggal clamp ke sini
    const DEFAULT_EXPORT_DURATION_SEC = 10; // sementara fixed; pemilihan durasi oleh user menyusul

    on(exportVideoBtn, 'click', async (e: Event) => {
      e.stopPropagation();
      void exportVideo(DEFAULT_EXPORT_DURATION_SEC);
    });

    async function exportVideo(requestedDurationSec: number) {
      if (typeof VideoEncoder === 'undefined') {
        alert('Browser ini belum mendukung WebCodecs (VideoEncoder). Coba pakai Chrome/Edge versi terbaru.');
        return;
      }

      const durationSec = Math.max(1, Math.min(requestedDurationSec, MAX_EXPORT_DURATION_SEC));
      const totalFrames = Math.round(durationSec * VIDEO_FPS);
      const frameDurationUs = Math.round(1_000_000 / VIDEO_FPS);

      const originalLabel = exportVideoBtn.textContent || 'Export Video (MP4)';
      exportVideoBtn.disabled = true;
      exportFrameBtn.disabled = true;
      exportVideoBtn.textContent = 'Merender...';
      exportVideoProgressWrap.style.display = 'block';
      exportVideoProgressFill.style.width = '0%';
      exportVideoProgressLabel.textContent = `Merender frame 0/${totalFrames}...`;

      // Simpan state elapsed/play asli supaya bisa dikembalikan setelah render selesai
      const originalElapsed = elapsed;
      const wasPlaying = !audioPreviewEl.paused;
      stopTick();

      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: 'avc', width: EXPORT_W, height: EXPORT_H },
        fastStart: 'in-memory',
      });

      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (err) => console.error('VideoEncoder error:', err),
      });
      encoder.configure({
        codec: 'avc1.640028',
        width: EXPORT_W,
        height: EXPORT_H,
        bitrate: 8_000_000,
        framerate: VIDEO_FPS,
        hardwareAcceleration: 'prefer-hardware',
      });

      try {
        for (let i = 0; i < totalFrames; i++) {
          // ==== 1. Advance state manual (deterministik) — elapsed timer & posisi video wallpaper ====
          elapsed = originalElapsed + i / VIDEO_FPS;
          if (songDuration > 0 && elapsed > songDuration) elapsed -= songDuration;
          renderDuration();

          if (wallpaperVideoEl && wallpaperVideoEl.duration) {
            const t = (i / VIDEO_FPS) % wallpaperVideoEl.duration;
            await seekVideoTo(wallpaperVideoEl, t);
          }

          // ==== 2. Capture frame kanvas (reuse pipeline yang sama dengan Export Frame) ====
          const canvas = await captureStageCanvas();

          // ==== 3. Encode frame ====
          const frame = new VideoFrame(canvas, {
            timestamp: i * frameDurationUs,
            duration: frameDurationUs,
          });
          encoder.encode(frame, { keyFrame: i % (VIDEO_FPS * 2) === 0 });
          frame.close();

          const pct = Math.round(((i + 1) / totalFrames) * 100);
          exportVideoProgressFill.style.width = pct + '%';
          exportVideoProgressLabel.textContent = `Merender frame ${i + 1}/${totalFrames}...`;
        }

        await encoder.flush();
        muxer.finalize();

        const blob = new Blob([target.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `control-center-video-${EXPORT_W}x${EXPORT_H}.mp4`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Export video gagal:', err);
        alert('Gagal export video. Coba lagi.');
      } finally {
        encoder.close();
        elapsed = originalElapsed;
        renderDuration();
        if (wasPlaying) startTick();
        exportVideoBtn.disabled = false;
        exportFrameBtn.disabled = false;
        exportVideoBtn.textContent = originalLabel;
        exportVideoProgressWrap.style.display = 'none';
      }
    }

    renderDuration();
    applyCardStyle();
    applyAlbumArtStyle();
    applyCcOpacity();
    applyStageTransform();
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
      <div className="stage-col">
        <div className="stage-frame">
          <div className="stage" id="stage" dangerouslySetInnerHTML={{ __html: STAGE_MARKUP }} />
        </div>
        <div className="audio-canvas-wrap" id="audioCanvasWrap">
          <audio id="audioPreviewEl" preload="none" style={{ display: 'none' }} />
          <canvas id="audioWaveformCanvas" className="audio-waveform-canvas" style={{ display: 'none' }} />
          <div className="audio-canvas-empty" id="audioCanvasEmpty">
            <input type="file" accept="audio/*" id="audioUploadInput" style={{ display: 'none' }} />
            <button type="button" className="audio-upload-btn" id="audioUploadBtn">Upload Audio</button>
          </div>
          <div className="audio-canvas-info" id="audioCanvasInfo" style={{ display: 'none' }}>
            <button type="button" className="audio-play-pause-btn" id="audioPlayPauseBtn" aria-label="Play/Pause">
              <svg id="audioPlayIcon" width="12" height="12" viewBox="0 0 14 14" fill="none">
                <path d="M3 1.5L12 7L3 12.5V1.5Z" fill="currentColor" />
              </svg>
              <svg id="audioPauseIcon" width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ display: 'none' }}>
                <rect x="2" y="1.5" width="3.5" height="11" rx="1" fill="currentColor" />
                <rect x="8.5" y="1.5" width="3.5" height="11" rx="1" fill="currentColor" />
              </svg>
            </button>
            <span id="audioFileName"></span>
            <span id="audioFileDuration"></span>
            <button type="button" className="audio-replace-btn" id="audioReplaceBtn">Ganti</button>
          </div>
        </div>
      </div>
      <div className="customize-wrap">
        <div className="album-art-upload-wrap" id="albumArtUploadWrap">
          <span className="album-art-label">Cover / Album Art</span>
          <div className="album-art-btns">
            <input type="file" accept="image/*" id="ctrlAlbumArt" style={{ display: 'none' }} />
            <button type="button" className="album-art-btn" id="uploadArtBtn">Upload Gambar</button>
            <button type="button" className="album-art-btn album-art-btn-danger" id="removeArtBtn" style={{ display: 'none' }}>Hapus Gambar</button>
          </div>
        </div>
        <div className="toolbar-row">
          <button type="button" className="customize-toggle" id="customizeToggle">
            <span>Customize</span>
            <span className="chevron" id="customizeChevron">⌄</span>
          </button>
          <button type="button" className="export-video-btn" id="exportVideoBtn">Export Video</button>
        </div>
        <div className="export-video-progress-wrap" id="exportVideoProgressWrap" style={{ display: 'none' }}>
          <div className="export-video-progress-track">
            <div className="export-video-progress-fill" id="exportVideoProgressFill" style={{ width: '0%' }} />
          </div>
          <div className="export-video-progress-label" id="exportVideoProgressLabel">Merender frame 0/0...</div>
        </div>
        <div className="panel-stack collapsed" id="panelStack" dangerouslySetInnerHTML={{ __html: PANELS_MARKUP }} />
      </div>
    </div>
  );
}
