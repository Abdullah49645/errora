'use strict';

/**
 * Shared render logic used by the local server (server.js) and the
 * Vercel serverless function (api/render.js).
 */

const fs = require('fs');
const path = require('path');
const { uploadImage, renderEarring, YouCamError } = require('./youcam');

const SAMPLES_DIR = path.join(__dirname, '..', 'public', 'samples');
const MAX_SIZES_PER_REQUEST = 4;

// Built-in samples so anyone can try the app without their own photos.
const SAMPLES = {
  selfies: {
    model: { file: 'model.jpg', url: process.env.SAMPLE_MODEL_URL || null },
  },
  earrings: {
    'pearl-drop': {
      file: 'pearl-drop.jpg',
      url: 'https://bcw-media.s3.ap-northeast-1.amazonaws.com/strapi/assets/earring_product_07_5476e0a156_a69e8e6549.jpg',
    },
    'diamond-stud': {
      file: 'diamond-stud.jpg',
      url: 'https://bcw-media.s3.ap-northeast-1.amazonaws.com/strapi/assets/earring_product_01_41c943f9fc_037ffb1241.jpg',
    },
  },
};

/**
 * @param {object} body  { selfie, earring, sizesCm, ear }
 * @returns {Promise<{status: number, payload: object}>}
 */
async function handleRenderBody(body) {
  const sizes = Array.isArray(body && body.sizesCm) ? body.sizesCm.map(Number) : [];
  if (!sizes.length || sizes.length > MAX_SIZES_PER_REQUEST || sizes.some((s) => !(s > 0.2 && s < 15))) {
    return { status: 400, payload: { error: 'Provide 1–4 sizes between 0.2 and 15 cm.' } };
  }
  try {
    const [selfie, earring] = await Promise.all([
      resolveImage(body.selfie, SAMPLES.selfies, 'selfie'),
      resolveImage(body.earring, SAMPLES.earrings, 'earring'),
    ]);
    const rightEar = body.ear !== 'left';
    const urls = await Promise.all(sizes.map((cm) => renderEarring(selfie, earring, cm, rightEar)));
    // Images are served through /api/image (same origin) so the browser can measure pixels.
    return {
      status: 200,
      payload: { results: sizes.map((cm, i) => ({ cm, image: `/api/image?u=${encodeURIComponent(urls[i])}` })) },
    };
  } catch (err) {
    const status = err instanceof YouCamError ? (err.code === 'missing_api_key' ? 500 : 422) : 500;
    console.error('render failed:', err.message);
    return { status, payload: { error: err.message || 'Rendering failed.' } };
  }
}

/** Turn a client image reference into { fileId } or { url } for the YouCam API. */
async function resolveImage(ref, samples, label) {
  if (!ref) throw new YouCamError(`Missing ${label} image.`, 'bad_request');
  if (ref.sample) {
    const sample = samples[ref.sample];
    if (!sample) throw new YouCamError(`Unknown sample ${label}.`, 'bad_request');
    if (sample.url) return { url: sample.url };
    const buffer = fs.readFileSync(path.join(SAMPLES_DIR, sample.file));
    return { fileId: await uploadImage(buffer, 'image/jpeg', sample.file) };
  }
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(ref.dataUrl || '');
  if (!match) throw new YouCamError(`The ${label} must be a JPG or PNG image.`, 'bad_request');
  const buffer = Buffer.from(match[2], 'base64');
  const ext = match[1] === 'image/png' ? 'png' : 'jpg';
  return { fileId: await uploadImage(buffer, match[1], `${label}.${ext}`) };
}

/**
 * Download a rendered image from YouCam's result storage. Only YouCam result
 * hosts are allowed, so the proxy cannot be used to fetch arbitrary URLs.
 * @returns {Promise<{status: number, type?: string, buffer?: Buffer, error?: string}>}
 */
async function fetchResultImage(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 400, error: 'Invalid image URL.' };
  }
  if (url.protocol !== 'https:' || !/^yce-[a-z0-9-]+\.s3[a-z0-9.-]*\.amazonaws\.com$/.test(url.hostname)) {
    return { status: 400, error: 'Only YouCam result images can be loaded.' };
  }
  const res = await fetch(url);
  if (!res.ok) return { status: 502, error: 'Could not download the rendered image.' };
  const buffer = Buffer.from(await res.arrayBuffer());
  // Result storage labels files as binary; detect the real image type.
  const type = buffer[0] === 0x89 && buffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return { status: 200, type, buffer };
}

module.exports = { handleRenderBody, fetchResultImage };
