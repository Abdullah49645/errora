'use strict';

// Vercel serverless function: GET /api/image?u=<YouCam result URL>
// Streams a rendered image from the same origin so the browser can read its pixels.
const { fetchResultImage } = require('../lib/render');

module.exports = async (req, res) => {
  const img = await fetchResultImage((req.query && req.query.u) || '');
  if (img.status !== 200) {
    res.status(img.status).json({ error: img.error });
    return;
  }
  res.setHeader('Content-Type', img.type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(200).send(img.buffer);
};
