'use strict';

// Vercel serverless function: GET /api/health
module.exports = (req, res) => {
  res.status(200).json({ ok: true, apiKeyConfigured: Boolean(process.env.YOUCAM_API_KEY) });
};
