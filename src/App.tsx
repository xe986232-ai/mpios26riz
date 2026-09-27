import { useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { STAGE_MARKUP, PANELS_MARKUP } from './markup';

// ==== Helper untuk Export Frame ====
// Rasterisasi TIDAK LAGI pakai html2canvas (reimplementasi CSS/layout sendiri pakai JS —
// nggak akurat, nggak dukung backdrop-filter, nggak bisa render <video>, lambat karena
// re-walk & recompute style tiap node tiap frame). Video & backdrop-filter tetap harus
// "dibekukan" jadi gambar statis dulu (sama seperti sebelumnya) karena keduanya memang
// nggak bisa dituangkan ke dokumen SVG statis apa adanya — tapi rasterisasi FINAL-nya
// sekarang lewat renderer SVG asli browser (lihat rasterizeNode di bawah), bukan lewat
// interpreter CSS buatan pihak ketiga.

// (captureVideoFrame & blurAndDim — dulu dipakai buat bekukan wallpaper video + backdrop-blur
// jadi gambar statis sebelum di-rasterisasi — sudah dihapus, karena elemen wallpaper-video &
// backdrop-filter-nya sendiri sudah dihapus total dari markup di komit sebelumnya, jadi kedua
// fungsi ini sudah jadi dead code.)

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

// ==== Rasterisasi native: ganti html2canvas dengan renderer SVG asli browser ====
// Ide: apa pun yang mau di-capture (baik elemen <svg> asli, maupun elemen HTML biasa yang
// isinya sudah "dibekukan"/statis) dibungkus jadi SATU dokumen SVG mandiri (kalau perlu
// lewat <foreignObject>), CSS halaman ini disuntikkan sebagai <style> di dalamnya, lalu
// dokumen itu di-serialize ke teks XML dan dirender lewat <img> — yang menggambar jadinya
// ENGINE SVG BAWAAN BROWSER sendiri, sama persis dengan yang dipakai buat nampilin di layar,
// bukan reimplementasi CSS/layout pihak ketiga kayak html2canvas.

let cachedInlineCss: string | null = null;

// Ambil semua CSS text dari stylesheet yang sudah ke-load di halaman ini (App.css, dst).
// Di-cache karena isinya nggak berubah selama satu sesi render/export berlangsung — dipanggil
// bisa ratusan/ribuan kali (sekali per frame video) tanpa perlu baca ulang document.styleSheets.
function getInlineCss(): string {
  if (cachedInlineCss !== null) return cachedInlineCss;
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) chunks.push(rule.cssText);
    } catch {
      // Stylesheet cross-origin yang nggak bisa dibaca isinya — dilewati saja. Nggak relevan
      // di project ini karena semua CSS-nya berasal dari bundle Vite sendiri (same-origin).
    }
  }
  cachedInlineCss = chunks.join('\n');
  return cachedInlineCss;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gagal memuat hasil render SVG sebagai gambar'));
    img.src = src;
  });
}

// Merender SATU node (elemen <svg> asli, ATAU elemen HTML biasa yang isinya sudah statis)
// jadi HTMLCanvasElement berukuran outputW x outputH (= nativeW/nativeH * scale), lewat
// renderer SVG bawaan browser — bukan html2canvas.
//
// - Kalau node-nya sendiri sudah berupa <svg> (mis. #cc, #player): dipakai langsung sebagai
//   dokumen, tinggal dikunci width/height/viewBox-nya & disuntik <style>.
// - Kalau node-nya elemen HTML biasa (mis. .stage-frame, yang di dalamnya ada <svg> lagi):
//   dibungkus lewat <svg><foreignObject> supaya bisa jadi satu dokumen SVG yang valid.
//
// PENTING: kalau node adalah elemen HTML, fungsi ini MEMINDAHKAN node tsb (appendChild) ke
// wrapper sementara. Ini aman untuk kasus reuseClone (Export Video) karena yang dipindah
// cuma referensi DOM-nya — konten & child element (video/backdrop img yang di-update tiap
// frame) tetap sama, cuma "rumahnya" (parent) yang berpindah tiap kali fungsi ini dipanggil.
async function rasterizeNode(
  node: Element,
  nativeW: number,
  nativeH: number,
  scale: number
): Promise<HTMLCanvasElement> {
  const css = getInlineCss();
  const outW = Math.max(1, Math.round(nativeW * scale));
  const outH = Math.max(1, Math.round(nativeH * scale));
  const svgNS = 'http://www.w3.org/2000/svg';
  const xhtmlNS = 'http://www.w3.org/1999/xhtml';

  let root: SVGSVGElement;
  if (node instanceof SVGSVGElement) {
    root = node;
    root.setAttribute('width', String(outW));
    root.setAttribute('height', String(outH));
    if (!root.getAttribute('viewBox')) {
      root.setAttribute('viewBox', `0 0 ${nativeW} ${nativeH}`);
    }
  } else {
    root = document.createElementNS(svgNS, 'svg');
    root.setAttribute('width', String(outW));
    root.setAttribute('height', String(outH));
    root.setAttribute('viewBox', `0 0 ${nativeW} ${nativeH}`);
    const foreignObject = document.createElementNS(svgNS, 'foreignObject');
    foreignObject.setAttribute('x', '0');
    foreignObject.setAttribute('y', '0');
    foreignObject.setAttribute('width', String(nativeW));
    foreignObject.setAttribute('height', String(nativeH));
    (node as HTMLElement).setAttribute('xmlns', xhtmlNS);
    foreignObject.appendChild(node);
    root.appendChild(foreignObject);
  }

  root.setAttribute('xmlns', svgNS);
  const styleEl = document.createElementNS(svgNS, 'style');
  styleEl.textContent = css;
  root.insertBefore(styleEl, root.firstChild);

  const xml = new XMLSerializer().serializeToString(root);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context tidak tersedia');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, outW, outH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ==== Helper untuk panel Layers (hide/show elemen sebelum Export Frame) ====
// Toggle di sini mengubah style.display LANGSUNG di elemen asli dalam #stage,
// jadi tidak perlu ubah apa pun di logika export: rasterizeNode/clone yang sudah
// ada otomatis ikut menghormati elemen yang disembunyikan.
const LAYER_SKIP_TAGS = new Set([
  'STYLE', 'DEFS', 'CLIPPATH', 'LINEARGRADIENT', 'RADIALGRADIENT', 'FILTER',
  'FECOLORMATRIX', 'FEBLEND', 'FEGAUSSIANBLUR', 'FEOFFSET', 'FEFLOOD', 'FECOMPOSITE',
  'FEMERGE', 'FEMERGENODE', 'MASK', 'PATTERN', 'METADATA', 'TITLE', 'DESC',
]);

const LAYER_EYE_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const LAYER_EYE_CLOSED =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.4 19.4 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a19.5 19.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

function escapeLayerLabel(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

let layerUidCounter = 0;
function renderLayerNode(el: Element, depth: number): string {
  if (LAYER_SKIP_TAGS.has(el.tagName.toUpperCase())) return '';
  layerUidCounter++;
  const uid = 'ly' + layerUidCounter;
  el.setAttribute('data-layer-uid', uid);
  const childEls = Array.from(el.children).filter((c) => !LAYER_SKIP_TAGS.has(c.tagName.toUpperCase()));
  const cls = (el.getAttribute('class') || '').split(' ')[0];
  const label = el.id || cls || el.tagName.toLowerCase();
  const tag = el.tagName.toLowerCase();
  // Semua level auto-expand supaya elemen dalam (judul, durasi, volume bar, dll)
  // langsung kelihatan sebagai layer tanpa perlu klik disclosure berkali-kali.
  const openClass = ' open';
  const childrenHtml = childEls.length
    ? '<div class="layer-children">' + childEls.map((c) => renderLayerNode(c, depth + 1)).join('') + '</div>'
    : '';
  return (
    '<div class="layer-node' + openClass + '" data-uid="' + uid + '">' +
    '<div class="layer-row" style="padding-left:' + (depth * 16 + 8) + 'px">' +
    (childEls.length
      ? '<button type="button" class="layer-disclosure" data-role="disclosure">\u25B8</button>'
      : '<span class="layer-disclosure-spacer"></span>') +
    '<button type="button" class="layer-eye" data-role="eye">' + LAYER_EYE_OPEN + '</button>' +
    '<span class="layer-label">' + escapeLayerLabel(label) + '</span>' +
    '<span class="layer-tag">' + tag + '</span>' +
    '</div>' + childrenHtml +
    '</div>'
  );
}

function buildLayersPanel(stageEl: HTMLElement, listEl: HTMLElement, countEl: HTMLElement) {
  layerUidCounter = 0;
  const roots = Array.from(stageEl.children).filter((c) => !LAYER_SKIP_TAGS.has(c.tagName.toUpperCase()));
  listEl.innerHTML = roots.map((r) => renderLayerNode(r, 0)).join('');
  countEl.textContent = layerUidCounter + ' elemen';
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

    // ==== Panel Layers: hide/show elemen di #stage sebelum Export Frame ====
    const layersToggle = $('layersToggle');
    const layersPanel = $('layersPanel');
    const layersList = $('layersList');
    const layersCount = $('layersCount');

    buildLayersPanel(stage, layersList, layersCount);

    on(layersToggle, 'click', (e: Event) => {
      e.stopPropagation();
      const nowCollapsed = layersPanel.classList.toggle('collapsed');
      layersToggle.classList.toggle('open', !nowCollapsed);
    });

    on(layersList, 'click', (e: Event) => {
      const target = e.target as HTMLElement;
      const disclosureBtn = target.closest<HTMLElement>('[data-role="disclosure"]');
      if (disclosureBtn) {
        disclosureBtn.closest('.layer-node')?.classList.toggle('open');
        return;
      }
      const eyeBtn = target.closest<HTMLElement>('[data-role="eye"]');
      if (eyeBtn) {
        const node = eyeBtn.closest<HTMLElement>('.layer-node');
        if (!node) return;
        const uid = node.getAttribute('data-uid');
        const targetEl = stage.querySelector<HTMLElement>(`[data-layer-uid="${uid}"]`);
        if (!targetEl) return;
        const nowHidden = targetEl.style.display !== 'none';
        targetEl.style.display = nowHidden ? 'none' : '';
        node.classList.toggle('hidden-layer', nowHidden);
        eyeBtn.classList.toggle('is-hidden', nowHidden);
        eyeBtn.innerHTML = nowHidden ? LAYER_EYE_CLOSED : LAYER_EYE_OPEN;
      }
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

    // ==== Efek "ketekan" di kartu Control Center ====
    // .cc-hit itu cuma layer transparan buat nangkep klik — scale doang di rect
    // transparan itu gak keliatan sama sekali. Jadi di sini kita cari elemen visual
    // (background, border, icon) yang posisinya (titik tengah bounding box-nya) ada
    // di dalam area tiap kartu, terus semuanya di-scale bareng dari titik tengah yang
    // SAMA (transform-box: view-box) pas ditekan — biar kartunya kerasa "masuk ke dalam"
    // beneran, bukan cuma highlight transparan yang nempel doang.
    const ccSvg = root.querySelector('.cc svg');
    if (ccSvg) {
      const allHits = Array.from(ccSvg.querySelectorAll<SVGRectElement>('.cc-hit'));
      // Kartu kecil di dalam kartu besar (class "in") diproses duluan biar dia yang
      // "ngeklaim" visualnya sendiri dulu — biar kartu besar di luar nggak ikut narik
      // ikon-ikon kecil di dalamnya pas kartu besar itu yang ditekan.
      const sortedHits = [...allHits].sort((a) => (a.classList.contains('in') ? -1 : 1));

      const candidateSelector = 'path, rect, circle, ellipse, polygon, polyline, image, use';
      const allCandidates = Array.from(ccSvg.querySelectorAll<SVGGraphicsElement>(candidateSelector)).filter(
        (el) => !el.classList.contains('cc-hit') && !el.closest('defs')
      );
      const claimed = new Set<SVGGraphicsElement>();

      sortedHits.forEach((hit) => {
        const hx = parseFloat(hit.getAttribute('x') || '0');
        const hy = parseFloat(hit.getAttribute('y') || '0');
        const hw = parseFloat(hit.getAttribute('width') || '0');
        const hh = parseFloat(hit.getAttribute('height') || '0');
        const cx = hx + hw / 2;
        const cy = hy + hh / 2;

        const members: SVGGraphicsElement[] = [];
        for (const el of allCandidates) {
          if (claimed.has(el)) continue;
          let bbox: DOMRect;
          try {
            bbox = el.getBBox();
          } catch {
            continue;
          }
          if (bbox.width === 0 && bbox.height === 0) continue;
          const ecx = bbox.x + bbox.width / 2;
          const ecy = bbox.y + bbox.height / 2;
          if (ecx >= hx && ecx <= hx + hw && ecy >= hy && ecy <= hy + hh) {
            members.push(el);
            claimed.add(el);
          }
        }
        if (members.length === 0) return;

        members.forEach((el) => {
          el.style.transformBox = 'view-box';
          el.style.transformOrigin = `${cx}px ${cy}px`;
          el.style.transition = 'transform .12s ease-out';
        });
        const press = () => members.forEach((el) => (el.style.transform = 'scale(0.94)'));
        const release = () => members.forEach((el) => (el.style.transform = ''));
        on(hit, 'pointerdown', press);
        on(hit, 'pointerup', release);
        on(hit, 'pointerleave', release);
        on(hit, 'pointercancel', release);
      });
    }

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
      stageOffsetY: -3,
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
      // Bulatkan sekali ke detik bulat (posSec), lalu turunkan sisa waktu dari angka
      // yang sama (durSec - posSec) — supaya elapsed & remaining ganti detik BARENGAN,
      // bukan dibulatkan sendiri-sendiri dari dua nilai pecahan yang beda titik pembulatannya.
      const durSec = Math.round(dur);
      const posSec = Math.min(durSec, Math.round(pos));
      timeElapsed.textContent = fmtTime(posSec);
      timeRemaining.textContent = '-' + fmtTime(durSec - posSec);
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
    //
    // ==== KENAPA SEBELUMNYA SELALU GAGAL ("Tainted canvases may not be exported") ====
    // Pendekatan lama membungkus .stage-frame (elemen <div> biasa) lewat <foreignObject> di dalam SVG
    // supaya bisa dirender jadi satu <img>, lalu di-drawImage ke canvas. Chrome SENGAJA menandai
    // ("taint") canvas apa pun yang sumbernya adalah SVG yang mengandung <foreignObject> — ini
    // restriksi keamanan browser (bukan bug di kode ini) dan berlaku SELALU, walau isinya cuma
    // data-URI same-origin. Begitu canvas ke-taint, canvas.toBlob()/toDataURL() PASTI dilempar
    // SecurityError — persis pesan yang muncul. Makanya Export Frame nggak pernah benar-benar
    // berhasil sejak awal, terlepas dari resolusi/kualitasnya.
    //
    // FIX: #cc dan #player masing-masing SUDAH berupa <svg> asli TANPA <foreignObject> di dalamnya
    // (video wallpaper & backdrop-blur yang dulu pakai foreignObject sudah dihapus total dari markup).
    // Jadi sekarang keduanya di-rasterisasi TERPISAH lewat rasterizeNode (cabang SVGSVGElement,
    // tanpa dibungkus foreignObject sama sekali → tidak pernah ke-taint), lalu digabung manual di
    // canvas 2D memakai geometri on-screen asli (getBoundingClientRect/getComputedStyle) supaya
    // posisi, ukuran, dan opacity-nya identik dengan yang tampak di layar — termasuk transform
    // scale(.78) & opacity saat Music Player "open" (getBoundingClientRect sudah otomatis
    // memperhitungkan transform CSS, jadi tidak perlu dihitung ulang manual).
    const exportFrameBtn = $<HTMLButtonElement>('exportFrameBtn');
    const exportVideoBtn = $<HTMLButtonElement>('exportVideoBtn');
    const exportVideoProgressWrap = $('exportVideoProgressWrap');
    const exportVideoProgressFill = $('exportVideoProgressFill');
    const exportVideoProgressLabel = $('exportVideoProgressLabel');
    // MP4/H.264 nggak punya alpha channel — bagian kartu yang transparan (rgba dengan alpha<1,
    // lihat catatan panjang di captureStageCanvas) bakal KEHILANGAN alpha-nya pas di-encode jadi
    // video, dan cuma nyisain RGB mentahnya (putih) → makanya sebelumnya kartu jadi putih solid
    // pas di-export video, padahal Export Frame (PNG, yang punya alpha channel) hasilnya normal.
    // Fix-nya: khusus buat Export Video, canvas di-flatten dulu ke warna solid ini (dipilih user)
    // SEBELUM alpha-nya kebuang — persis kaya nge-flatten PNG transparan di atas layer warna di
    // editor gambar manual. Export Frame & Export Assets tetap transparan apa adanya (tidak kena).
    const ctrlExportVideoBg = $<HTMLInputElement>('ctrlExportVideoBg');
    const valExportVideoBg = $('valExportVideoBg');
    on(ctrlExportVideoBg, 'input', () => {
      valExportVideoBg.textContent = ctrlExportVideoBg.value;
    });
    const EXPORT_H = 1920; // tinggi target hasil export
    const EXPORT_W = 1080; // lebar target hasil export — dikunci 9:16, sama seperti .stage-frame
    const stageFrame = stage.parentElement as HTMLElement; // .stage-frame — elemen kanvas yang jadi acuan crop export
    const wallpaperVideoEl = root.querySelector<HTMLVideoElement>('.wallpaper-video'); // sudah tidak ada di markup — dibiarkan null, dicek aman di bawah

    // Dipakai buat nunggu <img> yang src-nya baru di-set (freeze-frame wallpaper) selesai decode,
    // dipakai di jalur Export Assets (captureComponentCanvas) di bawah.
    function waitImgLoaded(img: HTMLImageElement | null): Promise<void> {
      if (!img || !img.src) return Promise.resolve();
      if (img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }

    // Bekukan status "dimming" tombol/kartu Control Center saat Music Player lagi kebuka, sesuai
    // aturan CSS asli (.stage.open .cc svg > g[clip-path] > *:nth-child(n+3), dan
    // .cc svg > rect:not(.phone-frame)) — di-bake jadi atribut opacity eksplisit di clone, karena
    // clone yang dirender lewat rasterizeNode nanti berdiri sendiri (nggak lagi punya ancestor
    // ".stage.open" buat dicocokkan selector CSS-nya).
    function bakeCcOpenDimming(ccSvgClone: SVGSVGElement, isOpen: boolean) {
      if (!isOpen) return; // default (closed) sudah opacity 1 apa adanya, tidak perlu diubah
      const clipGroup = ccSvgClone.querySelector('g[clip-path]');
      if (clipGroup) {
        Array.from(clipGroup.children).forEach((child, idx) => {
          if (idx >= 2) child.setAttribute('opacity', '0'); // nth-child(n+3), 0-based idx>=2
        });
      }
      ccSvgClone.querySelectorAll('rect').forEach((r) => {
        if (!r.classList.contains('phone-frame')) r.setAttribute('opacity', '0');
      });
    }

    // Capture SATU frame kanvas (state DOM saat fungsi ini dipanggil) → canvas EXPORT_W x EXPORT_H.
    // Dipakai baik oleh Export Frame maupun Export Video (dipanggil berulang per frame, dengan
    // state — elapsed, dll — sudah di-advance manual sebelum tiap panggilan).
    async function captureStageCanvas(backgroundColor?: string): Promise<HTMLCanvasElement> {
      const rect = stageFrame.getBoundingClientRect();
      // Guard: kalau .stage-frame lagi berukuran 0 (misal ke-trigger saat belum ke-render/tersembunyi),
      // scale bakal jadi Infinity/NaN dan bikin canvas.width = Infinity → browser throw IndexSizeError
      // tanpa pesan yang jelas. Ketangkep di sini dulu biar errornya informatif.
      if (!rect.width || !rect.height) {
        throw new Error(`Kanvas belum siap dirender (ukuran ${rect.width}x${rect.height}). Coba tunggu sebentar lalu klik lagi.`);
      }
      // Render pada skala yang membuat tinggi kanvas pas 1920px; karena .stage-frame terkunci rasio 9:16
      // di CSS, lebarnya otomatis ikut pas ~1080px — hasil export jadi identik dengan kanvas di layar.
      const scale = EXPORT_H / rect.height;
      const isOpen = stage.classList.contains('open');

      const ccWrapEl = $<HTMLElement>('cc');
      const playerWrapEl = $<HTMLElement>('player');
      const ccSvgEl = ccWrapEl.querySelector<SVGSVGElement>('svg');
      const playerSvgEl = playerWrapEl.querySelector<SVGSVGElement>('svg');
      if (!ccSvgEl || !playerSvgEl) throw new Error('Elemen #cc/#player tidak ditemukan di kanvas.');

      const ccRect = ccWrapEl.getBoundingClientRect();
      const playerRect = playerWrapEl.getBoundingClientRect();
      const playerOpacity = parseFloat(getComputedStyle(playerWrapEl).opacity || '1');

      const ccClone = ccSvgEl.cloneNode(true) as SVGSVGElement;
      bakeCcOpenDimming(ccClone, isOpen);
      ccClone.querySelectorAll('rect.phone-frame').forEach((r) => r.setAttribute('display', 'none'));

      const outCcW = Math.max(1, Math.round(ccRect.width * scale));
      const outCcH = Math.max(1, Math.round(ccRect.height * scale));
      const ccCanvas = await rasterizeNode(ccClone, 450, 920, outCcW / 450);

      let playerCanvas: HTMLCanvasElement | null = null;
      let outPlayerW = 0;
      let outPlayerH = 0;
      if (playerOpacity > 0.003) {
        const playerClone = playerSvgEl.cloneNode(true) as SVGSVGElement;
        outPlayerW = Math.max(1, Math.round(playerRect.width * scale));
        outPlayerH = Math.max(1, Math.round(playerRect.height * scale));
        playerCanvas = await rasterizeNode(playerClone, 336, 600, outPlayerW / 336);
      }

      const out = document.createElement('canvas');
      out.width = EXPORT_W;
      out.height = EXPORT_H;
      const outCtx = out.getContext('2d');
      if (!outCtx) throw new Error('Canvas context tidak tersedia');
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'high';

      // Kunci: .stage-frame punya overflow:hidden, jadi bagian #cc/#player yang meluber keluar
      // (misal karena efek "cover zoom" pada .stage) harus ikut kepotong di sini. Border-radius
      // SENGAJA tidak dibaked ke hasil export (sama seperti perilaku sebelumnya) — hasilnya persegi
      // penuh 1080x1920, biar gampang dipakai ulang/di-crop manual.
      outCtx.save();
      outCtx.beginPath();
      outCtx.rect(0, 0, EXPORT_W, EXPORT_H);
      outCtx.clip();

      // Cuma dipanggil kalau backgroundColor di-set (khusus Export Video, lihat catatan di atas
      // deklarasi ctrlExportVideoBg) — Export Frame/Assets memanggil captureStageCanvas() tanpa
      // argumen sehingga canvas-nya tetap transparan apa adanya, alpha-nya kebawa ke PNG.
      if (backgroundColor) {
        outCtx.fillStyle = backgroundColor;
        outCtx.fillRect(0, 0, EXPORT_W, EXPORT_H);
      }

      const ccX = Math.round((ccRect.left - rect.left) * scale);
      const ccY = Math.round((ccRect.top - rect.top) * scale);
      outCtx.drawImage(ccCanvas, ccX, ccY, outCcW, outCcH);

      if (playerCanvas) {
        const playerX = Math.round((playerRect.left - rect.left) * scale);
        const playerY = Math.round((playerRect.top - rect.top) * scale);
        outCtx.globalAlpha = playerOpacity;
        outCtx.drawImage(playerCanvas, playerX, playerY, outPlayerW, outPlayerH);
        outCtx.globalAlpha = 1;
      }

      outCtx.restore();
      return out;
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
        const msg = err instanceof Error ? err.message : String(err);
        alert(`Gagal export gambar: ${msg}\n\nCoba lagi. Kalau masih gagal, buka console browser (F12) buat lihat detail errornya.`);
      } finally {
        exportFrameBtn.disabled = false;
        exportFrameBtn.textContent = originalLabel;
      }
    });


    // ==== Export Assets: rasterisasi SETIAP komponen SVG (Control Center & Music Player) secara MANDIRI
    // dari ukuran aslinya masing-masing (bukan dari .stage yang sudah discale responsif ke layar), dalam
    // resolusi sangat tinggi (jauh di atas 4K), lalu dibungkus jadi satu file .zip. Beda dengan Export Frame
    // yang cuma men-capture KANVAS 9:16 gabungan apa adanya (satu tampilan aktif saja), di sini KEDUA
    // komponen selalu ikut ter-export sekaligus, terlepas dari mana yang sedang kelihatan di layar.
    const exportAssetsBtn = $<HTMLButtonElement>('exportAssetsBtn');
    const ASSET_SCALE = 8; // ~8x resolusi asli tiap komponen — jauh melebihi 4K (cc: 3600x7360px, player: 2688x4800px)

    // CATATAN: dulu fungsi ini membungkus DIV pembungkus (.cc/.player) lewat <foreignObject> —
    // itu juga kena masalah taint yang sama seperti captureStageCanvas (lihat catatan panjang di
    // atas). #cc & #player sendiri sudah <svg> murni tanpa foreignObject di dalamnya, jadi sekarang
    // svg-nya di-clone & di-rasterisasi LANGSUNG (cabang SVGSVGElement di rasterizeNode, tanpa
    // wrapping apa pun) — sekalian membuang logika bake wallpaper-video/backdrop-blur yang sudah
    // jadi dead code total sejak elemen wallpaper-nya dihapus dari markup.
    async function captureComponentCanvas(
      wrapEl: HTMLElement, // div pembungkus (#cc atau #player), dipakai buat cari <svg> di dalamnya
      nativeW: number,
      nativeH: number,
      scale: number
    ): Promise<HTMLCanvasElement> {
      const svgEl = wrapEl.querySelector<SVGSVGElement>('svg');
      if (!svgEl) throw new Error('Elemen <svg> tidak ditemukan di komponen ini.');
      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      return await rasterizeNode(clone, nativeW, nativeH, scale);
    }

    function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Gagal membuat PNG'));
        }, 'image/png');
      });
    }

    on(exportAssetsBtn, 'click', async (e: Event) => {
      e.stopPropagation();
      const originalLabel = exportAssetsBtn.textContent || 'Export Assets (ZIP PNG 4K)';
      exportAssetsBtn.disabled = true;
      try {
        // Komponen 1: Control Center (450x920 asli) — nama file mengikuti nama komponennya
        exportAssetsBtn.textContent = 'Merender Control Center...';
        const ccEl = $('cc');
        const ccCanvas = await captureComponentCanvas(ccEl, 450, 920, ASSET_SCALE);
        const ccBlob = await canvasToPngBlob(ccCanvas);

        // Komponen 2: Music Player (336x600 asli)
        exportAssetsBtn.textContent = 'Merender Music Player...';
        const playerEl = $('player');
        const playerCanvas = await captureComponentCanvas(playerEl, 336, 600, ASSET_SCALE);
        const playerBlob = await canvasToPngBlob(playerCanvas);

        exportAssetsBtn.textContent = 'Membungkus ZIP...';
        const zip = new JSZip();
        zip.file(`control-center-${ccCanvas.width}x${ccCanvas.height}.png`, ccBlob);
        zip.file(`music-player-${playerCanvas.width}x${playerCanvas.height}.png`, playerBlob);
        const zipBlob = await zip.generateAsync({ type: 'blob' });

        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'assets-export.zip';
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Export assets gagal:', err);
        alert('Gagal export assets. Coba lagi.');
      } finally {
        exportAssetsBtn.disabled = false;
        exportAssetsBtn.textContent = originalLabel;
      }
    });

    // ==== Export Video: render N frame secara DETERMINISTIK (state di-advance manual per frame,
    // bukan capture real-time), lalu encode tiap frame pakai WebCodecs VideoEncoder + mux jadi .mp4
    // pakai mp4-muxer. Semua di browser, tanpa server/Playwright — hasilnya tetap akurat & konsisten
    // walau device lemot, karena kita yang mengontrol "waktu" tiap frame, bukan menunggu jam asli. ====
    const VIDEO_FPS = 20; // diturunkan dari 30 → langsung motong ~33% jumlah frame yang harus di-render (masih halus untuk konten sosial media)
    const MAX_EXPORT_DURATION_SEC = 600; // batas atas keamanan (10 menit), bukan lagi patokan utama durasi
    const FALLBACK_EXPORT_DURATION_SEC = 10; // dipakai HANYA kalau belum ada lagu yang di-upload sama sekali

    // Cari config VideoEncoder yang didukung device/browser ini, nyoba beberapa kandidat H.264
    // berurutan dari yang paling bagus ke yang paling kompatibel (bukan cuma pasang satu codec
    // fixed) — pola ini dicontek dari referensi kamu (ios-music-player/lib/webcodecs-export.ts),
    // yang terbukti export-nya aman di berbagai device. Banyak Chrome Android/WebView TIDAK
    // mendukung hardware encoder High Profile (avc1.640028), makanya perlu fallback ke Main
    // lalu Baseline Profile biar tetap bisa export walau kualitasnya sedikit turun.
    async function findSupportedVideoConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
      // Bitrate ikut resolusi & fps (bukan angka fix), di-cap 6-40 Mbps.
      const bitrate = Math.min(40_000_000, Math.max(6_000_000, Math.round(width * height * fps * 0.35)));
      const candidates: VideoEncoderConfig[] = [
        // avc1.640028 = High Profile Level 4.0 — paling tajam, tapi tidak semua device dukung.
        { codec: 'avc1.640028', width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality' },
        // avc1.4d0028 = Main Profile Level 4.0 — fallback kedua.
        { codec: 'avc1.4d0028', width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality' },
        // avc1.42001f = Baseline Profile Level 3.1 — fallback paling kompatibel, hampir semua device dukung.
        { codec: 'avc1.42001f', width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality' },
      ];
      for (const config of candidates) {
        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported) return support.config ?? config;
        } catch {
          // lanjut coba kandidat berikutnya
        }
      }
      throw new Error('Tidak ada konfigurasi VideoEncoder (H.264) yang didukung browser ini.');
    }

    on(exportVideoBtn, 'click', async (e: Event) => {
      e.stopPropagation();
      // Durasi export sekarang ikut durasi lagu yang di-upload (songDuration), bukan hardcode lagi.
      // Kalau belum ada lagu yang di-upload (songDuration <= 0), fallback ke FALLBACK_EXPORT_DURATION_SEC.
      const durationSec = songDuration > 0 ? songDuration : FALLBACK_EXPORT_DURATION_SEC;
      void exportVideo(durationSec);
    });

    async function exportVideo(requestedDurationSec: number) {
      if (typeof VideoEncoder === 'undefined') {
        alert('Browser ini belum mendukung WebCodecs (VideoEncoder). Coba pakai Chrome/Edge versi terbaru.');
        return;
      }

      const durationSec = Math.max(1, Math.min(requestedDurationSec, MAX_EXPORT_DURATION_SEC));
      const totalFrames = Math.round(durationSec * VIDEO_FPS);
      const frameDurationUs = Math.round(1_000_000 / VIDEO_FPS);

      // Cek dukungan config encoder DULU sebelum mulai render apa pun, nyoba beberapa kandidat
      // codec (bukan cuma satu), supaya kalau device ini tidak dukung High Profile, otomatis
      // jatuh ke Main/Baseline Profile alih-alih langsung gagal total.
      let desiredConfig: VideoEncoderConfig;
      try {
        desiredConfig = await findSupportedVideoConfig(EXPORT_W, EXPORT_H, VIDEO_FPS);
      } catch (err) {
        console.error('Gagal cek dukungan VideoEncoder:', err);
        const detail = err instanceof Error ? err.message : String(err);
        alert(
          `Browser/device ini tidak mendukung konfigurasi video ${EXPORT_W}x${EXPORT_H} dengan codec apa pun yang dicoba.\n\nDetail: ${detail}\n\nCoba pakai Chrome/Edge terbaru.`
        );
        return;
      }

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

      // Warna solid buat nimpa bagian transparan kartu (lihat catatan di deklarasi ctrlExportVideoBg
      // di atas) — dibaca sekali di awal, bukan tiap frame, karena nggak ada alasan buat berubah
      // di tengah proses render satu video.
      const videoBackgroundColor = ctrlExportVideoBg.value || '#000000';

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
      encoder.configure(desiredConfig);

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

          // ==== 2. Capture frame kanvas (reuse pipeline yang sama dengan Export Frame, tapi kali ini
          // di-flatten dulu ke videoBackgroundColor karena MP4 nggak punya alpha channel) ====
          const canvas = await captureStageCanvas(videoBackgroundColor);

          // ==== 3. Encode frame ====
          // PENTING: sengaja TIDAK kasih elemen <canvas> langsung ke `new VideoFrame(canvas, ...)`.
          // Itu jalur yang sebelumnya dipakai, dan di beberapa Chrome/WebView Android jalur ini
          // kebukti bikin VideoFrame berisi data kosong/putih walau `canvas`-nya sendiri render-nya
          // BENAR (kebukti dari Export Frame/PNG yang hasilnya normal, lewat toBlob() — jalur beda
          // dari yang dipakai VideoFrame). Fix: ambil pixel data-nya eksplisit lewat getImageData(),
          // terus kasih raw buffer RGBA itu ke VideoFrame — jalur ini nggak bergantung ke cara
          // browser "nge-bridge" elemen <canvas>, jadi lebih konsisten across device.
          const frameCtx = canvas.getContext('2d', { willReadFrequently: true });
          if (!frameCtx) throw new Error('Canvas context tidak tersedia saat ambil pixel data frame.');
          const imageData = frameCtx.getImageData(0, 0, canvas.width, canvas.height);
          const frame = new VideoFrame(imageData.data, {
            format: 'RGBA',
            codedWidth: canvas.width,
            codedHeight: canvas.height,
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
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        alert(`Gagal export video. Coba lagi.\n\nDetail: ${detail}`);
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
          <button type="button" className="customize-toggle" id="layersToggle">
            <span>Layers</span>
            <span className="chevron" id="layersChevron">⌄</span>
          </button>
          <button type="button" className="export-video-btn" id="exportVideoBtn">Export Video</button>
        </div>
        <div className="layers-panel collapsed" id="layersPanel">
          <div className="layers-panel-header">
            <span>Layers</span>
            <span className="layers-count" id="layersCount"></span>
          </div>
          <div className="layers-list" id="layersList"></div>
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
