'use strict';

// Vercel serverless function: POST /api/render
const { handleRenderBody } = require('../lib/render');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Request body must be JSON.' });
      return;
    }
  }
  const { status, payload } = await handleRenderBody(body || {});
  res.status(status).json(payload);
};
