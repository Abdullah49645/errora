'use strict';

/**
 * Minimal YouCam API client for the 2D earring virtual try-on.
 *
 * Flow (YouCam API v2):
 *   1. POST /s2s/v2.0/file/2d-vto/earring      -> pre-signed upload URL + file_id
 *   2. PUT  <pre-signed URL>                     -> upload image bytes
 *   3. POST /s2s/v2.0/task/2d-vto/earring        -> task_id
 *   4. GET  /s2s/v2.0/task/2d-vto/earring/<id>   -> poll until success | error
 *
 * Public image URLs can be passed instead of uploading (src_file_url / ref_file_urls).
 */

const API_BASE = 'https://yce-api-01.makeupar.com';
const FEATURE = '2d-vto/earring';
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120000;

class YouCamError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'youcam_error';
  }
}

function apiKey() {
  const key = process.env.YOUCAM_API_KEY;
  if (!key) throw new YouCamError('YOUCAM_API_KEY is not configured on the server.', 'missing_api_key');
  return key;
}

async function call(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new YouCamError(`YouCam API returned HTTP ${res.status} with a non-JSON body.`);
  }
  if (!res.ok || (json.status && json.status >= 400)) {
    throw new YouCamError(json.error || `YouCam API returned HTTP ${res.status}.`, json.error_code);
  }
  return json;
}

/** Upload a JPEG/PNG buffer through the File API and return its file_id. */
async function uploadImage(buffer, contentType = 'image/jpeg', fileName = 'image.jpg') {
  const init = await call('POST', `/s2s/v2.0/file/${FEATURE}`, {
    files: [{ content_type: contentType, file_name: fileName, file_size: buffer.length }],
  });
  const file = init.data.files[0];
  const request = file.requests[0];
  // fetch computes Content-Length itself, so drop it from the pre-signed headers.
  const headers = Object.fromEntries(
    Object.entries(request.headers || { 'Content-Type': contentType }).filter(([k]) => k.toLowerCase() !== 'content-length'),
  );
  const put = await fetch(request.url, { method: request.method || 'PUT', headers, body: buffer });
  if (!put.ok) throw new YouCamError(`Image upload failed with HTTP ${put.status}.`, 'upload_failed');
  return file.file_id;
}

/**
 * Render one earring on one selfie at a physical size.
 * @param {{fileId?: string, url?: string}} selfie
 * @param {{fileId?: string, url?: string}} earring  a single earring, front view
 * @param {number} scaleCm  physical size in centimetres (earring_scale)
 * @param {boolean} rightEar
 * @returns {Promise<string>} URL of the rendered image (valid for ~2 hours)
 */
async function renderEarring(selfie, earring, scaleCm, rightEar) {
  const body = {
    source_info: { name: 'selfie.jpg' },
    object_infos: [
      {
        name: 'earring.jpg',
        parameter: {
          earring_scale: scaleCm,
          earring_is_right_ear: rightEar,
          earring_need_remove_background: true,
        },
      },
    ],
  };
  if (selfie.fileId) body.src_file_id = selfie.fileId;
  else body.src_file_url = selfie.url;
  if (earring.fileId) body.ref_file_ids = [earring.fileId];
  else body.ref_file_urls = [earring.url];

  const created = await call('POST', `/s2s/v2.0/task/${FEATURE}`, body);
  const taskId = created.data.task_id;
  const started = Date.now();

  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const polled = await call('GET', `/s2s/v2.0/task/${FEATURE}/${encodeURIComponent(taskId)}`);
    const data = polled.data || {};
    if (data.task_status === 'success') return data.results.url;
    if (data.task_status === 'error') {
      throw new YouCamError(describeTaskError(data.error, data.error_message), data.error);
    }
  }
  throw new YouCamError('The try-on task timed out.', 'timeout');
}

function describeTaskError(code, message) {
  const known = {
    PHOTO_DETECTION_FAIL: 'We could not find an ear in your photo. Use a three-quarter view with the ear clearly visible.',
    PHOTO_CHECK_INVALID: 'Your photo angle or framing is not supported. Turn your head about 30° so the ear faces the camera.',
    OBJECT_DETECTION_FAIL: 'We could not detect an earring in the product image. Crop tightly around a single earring.',
    INPUT_ERROR: 'One of the images is in an unsupported format. Use JPG or PNG.',
    INPUT_MAIN_IMAGE_EMPTY: 'Your photo is missing.',
    RUNTIME_ERROR: 'The try-on engine hit an unexpected error. Please try again.',
  };
  if (known[code]) return known[code];
  if (code === '1') return 'The try-on engine could not process this photo. Use a clear three-quarter view with the ear visible.';
  return message || `The try-on task failed (${code || 'unknown error'}).`;
}

async function credit() {
  const res = await call('GET', '/s2s/v1.0/client/credit');
  return res.results && res.results[0] ? res.results[0].amount : null;
}

module.exports = { uploadImage, renderEarring, credit, YouCamError };
