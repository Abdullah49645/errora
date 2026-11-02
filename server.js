'use strict';

/**
 * Errora server: serves the web app and proxies the YouCam API so the
 * API key never reaches the browser. Node 18+ only, no dependencies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { uploadImage, renderEarring, YouCamError } = require('./lib/youcam');

loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_SIZES_PER_REQUEST = 4;

// Built-in samples so anyone can try the app without their own photos.
const SAMPLES = {
  selfies: {
    model: { file: 'samples/model.jpg', url: process.env.SAMPLE_MODEL_URL || null },
  },
  earrings: {
    'pearl-drop': {
      file: 'samples/pearl-drop.jpg',
      url: 'https://bcw-media.s3.ap-northeast-1.amazonaws.com/strapi/assets/earring_product_07_5476e0a156_a69e8e6549.jpg',
    },
    'diamond-stud': {
      file: 'samples/diamond-stud.jpg',
      url: 'https://bcw-media.s3.ap-northeast-1.amazonaws.com/strapi/assets/earring_product_01_41c943f9fc_037ffb1241.jpg',
    },
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST' && url.pathname === '/api/render') return await handleRender(req, res);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, apiKeyConfigured: Boolean(process.env.YOUCAM_API_KEY) });
    }
    if (req.method === 'GET') return serveStatic(url.pathname, res);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Unexpected server error.' });
  }
});

server.listen(PORT, () => console.log(`Errora running at http://localhost:${PORT}`));

/**
 * POST /api/render
 * {
 *   selfie:  { sample: "model" } | { dataUrl: "data:image/jpeg;base64,..." },
 *   earring: { sample: "pearl-drop" } | { dataUrl: "data:image/png;base64,..." },
 *   sizesCm: [2.4, 3.2, 4.0],
 *   ear: "right" | "left"
 * }
 * -> { results: [{ cm, image: "data:image/jpeg;base64,..." }] }
 */
async function handleRender(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Request body must be JSON under 12 MB.' });
  }

  const sizes = Array.isArray(body.sizesCm) ? body.sizesCm.map(Number) : [];
  if (!sizes.length || sizes.length > MAX_SIZES_PER_REQUEST || sizes.some((s) => !(s > 0.2 && s < 15))) {
    return sendJson(res, 400, { error: 'Provide 1–4 sizes between 0.2 and 15 cm.' });
  }

  try {
    const [selfie, earring] = await Promise.all([
      resolveImage(body.selfie, SAMPLES.selfies, 'selfie'),
      resolveImage(body.earring, SAMPLES.earrings, 'earring'),
    ]);
    const rightEar = body.ear !== 'left';
    const urls = await Promise.all(sizes.map((cm) => renderEarring(selfie, earring, cm, rightEar)));
    // Fetch results server-side so the browser can measure pixels without CORS issues.
    const images = await Promise.all(urls.map(toDataUrl));
    sendJson(res, 200, { results: sizes.map((cm, i) => ({ cm, image: images[i] })) });
  } catch (err) {
    const status = err instanceof YouCamError ? (err.code === 'missing_api_key' ? 500 : 422) : 500;
    console.error('render failed:', err.message);
    sendJson(res, status, { error: err.message || 'Rendering failed.' });
  }
}

/** Turn a client image reference into { fileId } or { url } for the YouCam API. */
async function resolveImage(ref, samples, label) {
  if (!ref) throw new YouCamError(`Missing ${label} image.`, 'bad_request');
  if (ref.sample) {
    const sample = samples[ref.sample];
    if (!sample) throw new YouCamError(`Unknown sample ${label}.`, 'bad_request');
    if (sample.url) return { url: sample.url };
    const buffer = fs.readFileSync(path.join(PUBLIC_DIR, sample.file));
    return { fileId: await uploadImage(buffer, 'image/jpeg', path.basename(sample.file)) };
  }
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(ref.dataUrl || '');
  if (!match) throw new YouCamError(`The ${label} must be a JPG or PNG image.`, 'bad_request');
  const buffer = Buffer.from(match[2], 'base64');
  const ext = match[1] === 'image/png' ? 'png' : 'jpg';
  return { fileId: await uploadImage(buffer, match[1], `${label}.${ext}`) };
}

async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new YouCamError('Could not download the rendered image.', 'download_failed');
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${buffer.toString('base64')}`;
}

function serveStatic(pathname, res) {
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) filePath = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
