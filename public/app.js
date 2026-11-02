'use strict';

const $ = (id) => document.getElementById(id);
const MAX_SIDE = 1600;
const CM_PER_UNIT = { mm: 0.1, cm: 1, in: 2.54 };

const state = {
  selfie: null,     // { sample } | { dataUrl }
  selfieSrc: null,  // image source used for pixel comparison
  earring: null,    // { sample } | { image: HTMLImageElement }
  crop: null,       // { x, y, w, h } in source-image pixels
};

/* ---------- Step 1: selfie ---------- */

$('selfie-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataUrl = await fileToJpegDataUrl(file);
  setSelfie({ dataUrl }, dataUrl);
});

$('use-sample-model').addEventListener('click', () => {
  setSelfie({ sample: 'model' }, 'samples/model.jpg');
  $('use-sample-model').classList.add('active');
});

function setSelfie(ref, src) {
  state.selfie = ref;
  state.selfieSrc = src;
  const img = $('selfie-preview');
  img.src = src;
  img.hidden = false;
  $('selfie-label').hidden = true;
  if (!ref.sample) $('use-sample-model').classList.remove('active');
  updateButton();
}

/* ---------- Step 2: earring + crop ---------- */

const canvas = $('crop-canvas');
const ctx = canvas.getContext('2d');
let view = null; // how the source image is fitted into the canvas
let dragStart = null;

$('earring-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = await loadImage(await fileToJpegDataUrl(file, 'image/png'));
  state.earring = { image: img };
  state.crop = null;
  document.querySelectorAll('[data-sample]').forEach((b) => b.classList.remove('active'));
  showInCanvas(img);
  setStatus('Drag a box around a single earring.');
  updateButton();
});

document.querySelectorAll('[data-sample]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-sample]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const img = await loadImage(`samples/${btn.dataset.sample}.jpg`);
    state.earring = { sample: btn.dataset.sample, image: img };
    state.crop = null;
    showInCanvas(img);
    $('size-value').value = btn.dataset.size;
    $('size-unit').value = 'cm';
    setStatus('');
    updateButton();
  });
});

function showInCanvas(img) {
  $('crop-empty').hidden = true;
  const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
  view = { img, scale, ox: (canvas.width - img.width * scale) / 2, oy: (canvas.height - img.height * scale) / 2 };
  drawCanvas();
}

function drawCanvas(selection) {
  ctx.fillStyle = '#f3ede6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!view) return;
  const { img, scale, ox, oy } = view;
  ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale);
  const box = selection || (state.crop && toCanvasBox(state.crop));
  if (box) {
    ctx.fillStyle = 'rgba(31,26,23,0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, (box.x - ox) / scale, (box.y - oy) / scale, box.w / scale, box.h / scale, box.x, box.y, box.w, box.h);
    ctx.strokeStyle = '#b0703c';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }
}

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}
function toCanvasBox(c) {
  return { x: view.ox + c.x * view.scale, y: view.oy + c.y * view.scale, w: c.w * view.scale, h: c.h * view.scale };
}
function normBox(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!view || state.earring?.sample) return;
  dragStart = canvasPoint(e);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (dragStart) drawCanvas(normBox(dragStart, canvasPoint(e)));
});
canvas.addEventListener('pointerup', (e) => {
  if (!dragStart) return;
  const box = normBox(dragStart, canvasPoint(e));
  dragStart = null;
  if (box.w < 8 || box.h < 8) { state.crop = null; drawCanvas(); return; }
  const { img, scale, ox, oy } = view;
  const x = Math.max(0, (box.x - ox) / scale);
  const y = Math.max(0, (box.y - oy) / scale);
  state.crop = { x, y, w: Math.min(img.width - x, box.w / scale), h: Math.min(img.height - y, box.h / scale) };
  drawCanvas();
  setStatus('Cropped. Enter the listed size and render.');
});

function croppedEarringDataUrl() {
  const { image } = state.earring;
  const c = state.crop || { x: 0, y: 0, w: image.width, h: image.height };
  const pad = 0.06;
  const out = document.createElement('canvas');
  out.width = Math.round(c.w * (1 + 2 * pad));
  out.height = Math.round(c.h * (1 + 2 * pad));
  const o = out.getContext('2d');
  o.fillStyle = '#ffffff';
  o.fillRect(0, 0, out.width, out.height);
  o.drawImage(image, c.x, c.y, c.w, c.h, c.w * pad, c.h * pad, c.w, c.h);
  return out.toDataURL('image/png');
}

/* ---------- Render ---------- */

['size-value', 'size-unit'].forEach((id) => $(id).addEventListener('input', updateButton));

function listedCm() {
  const v = parseFloat($('size-value').value);
  return v > 0 ? v * CM_PER_UNIT[$('size-unit').value] : null;
}

function updateButton() {
  $('render').disabled = !(state.selfie && state.earring && listedCm());
}

$('render').addEventListener('click', async () => {
  const cm = round(listedCm(), 2);
  const sizes = $('ladder').checked ? [round(cm * 0.75, 2), cm, round(cm * 1.25, 2)] : [cm];
  const earring = state.earring.sample ? { sample: state.earring.sample } : { dataUrl: croppedEarringDataUrl() };

  $('render').disabled = true;
  setStatus(`<span class="spinner"></span>Rendering ${sizes.length} size${sizes.length > 1 ? 's' : ''} with the YouCam earring engine…`, false, true);
  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selfie: state.selfie, earring, sizesCm: sizes, ear: $('ear').value }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Rendering failed.');
    await showResults(json.results, cm);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    updateButton();
  }
});

async function showResults(results, listed) {
  const original = await loadImage(state.selfieSrc);
  const renders = await Promise.all(results.map((r) => loadImage(r.image)));

  // Locate each rendered earring by comparing against the original photo.
  const boxes = renders.map((img) => findChange(original, img));
  const union = boxes.filter(Boolean).reduce((u, b) => (u ? {
    x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1),
  } : { ...b }), null);

  const cards = $('cards');
  const fulls = $('fulls');
  cards.innerHTML = '';
  fulls.innerHTML = '';

  results.forEach((r, i) => {
    const img = renders[i];
    const box = boxes[i];
    const card = document.createElement('div');
    card.className = 'card' + (r.cm === listed ? ' listed' : '');
    const cv = document.createElement('canvas');
    drawZoom(cv, img, union, box, r.cm);
    const cap = document.createElement('div');
    cap.className = 'cap';
    const label = r.cm === listed ? 'Listed size' : r.cm < listed ? '25% smaller' : '25% larger';
    cap.innerHTML = `<strong>${formatSize(r.cm)}</strong><span>${label}</span>`;
    card.append(cv, cap);
    cards.append(card);

    const full = document.createElement('img');
    full.src = r.image;
    full.alt = `Full photo, ${formatSize(r.cm)}`;
    fulls.append(full);
  });

  $('results-hint').textContent = 'Every view uses the same crop and zoom, so you can compare sizes directly. The bar shows 1 cm at the scale of your ear.';
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Bounding box of pixels that differ between the original photo and a render. */
function findChange(original, render) {
  const w = render.width, h = render.height;
  const a = pixels(original, w, h), b = pixels(render, w, h);
  const xs = [], ys = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 70) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < 6) return null;
  xs.sort((m, n) => m - n);
  ys.sort((m, n) => m - n);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  return { x0: q(xs, 0.01), y0: q(ys, 0.01), x1: q(xs, 0.99), y1: q(ys, 0.99) };
}

function pixels(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

function drawZoom(cv, img, union, box, cm) {
  const size = 520;
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  let crop;
  if (union) {
    const cx = (union.x0 + union.x1) / 2;
    const cy = (union.y0 + union.y1) / 2;
    const side = Math.min(Math.max((union.y1 - union.y0) * 2.6, (union.x1 - union.x0) * 4, img.height * 0.3), img.width, img.height);
    crop = {
      x: clamp(cx - side / 2, 0, img.width - side),
      y: clamp(union.y0 - side * 0.38, 0, img.height - side),
      side,
    };
  } else {
    const side = Math.min(img.width, img.height);
    crop = { x: (img.width - side) / 2, y: (img.height - side) / 2, side };
  }
  const k = size / crop.side;
  g.drawImage(img, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size);

  if (box) {
    // 1 cm scale bar, derived from the rendered earring height and the size requested.
    const pxPerCm = ((box.y1 - box.y0) / cm) * k;
    const barX = (box.x1 - crop.x) * k + 26;
    const barY = (box.y0 - crop.y) * k;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 5;
    line(g, barX, barY, barX, barY + pxPerCm);
    g.strokeStyle = '#b0703c';
    g.lineWidth = 2.5;
    line(g, barX, barY, barX, barY + pxPerCm);
    line(g, barX - 6, barY, barX + 6, barY);
    line(g, barX - 6, barY + pxPerCm, barX + 6, barY + pxPerCm);
    g.font = '600 15px Inter, system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(barX + 10, barY + pxPerCm / 2 - 11, 42, 22);
    g.fillStyle = '#1f1a17';
    g.fillText('1 cm', barX + 14, barY + pxPerCm / 2 + 5);
  }
}

/* ---------- helpers ---------- */

function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }
function formatSize(cm) { return cm < 1 ? `${round(cm * 10, 1)} mm` : `${round(cm, 2)} cm`; }

function setStatus(msg, isError = false, html = false) {
  const el = $('status');
  el.classList.toggle('error', isError);
  if (html) el.innerHTML = msg; else el.textContent = msg;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = src;
  });
}

/** Read an uploaded file, downscale to MAX_SIDE, and return a data URL. */
async function fileToJpegDataUrl(file, type = 'image/jpeg') {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    const g = c.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}
