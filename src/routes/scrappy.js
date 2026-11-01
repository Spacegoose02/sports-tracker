// Chat with Scrappy (src/scrappy.js). Public like the rest of the site, but
// rate limited per IP since every message costs an API call.
//
//   GET  /api/scrappy        -> { enabled }   (the bubble hides when false)
//   POST /api/scrappy/chat   { messages: [{ role, content }] } -> { reply }

const express = require('express');
const { rateLimit } = require('../security');
const { createScrappy, cleanHistory } = require('../scrappy');

function createScrappyRouter({ env = process.env, client, logger = console, fetch: fetchImpl } = {}) {
  const router = express.Router();
  const scrappy = createScrappy({ env, client, logger, fetchImpl });
  const perMinute = Number(env.SCRAPPY_RATE_PER_MINUTE) || 8;
  const perDay = Number(env.SCRAPPY_RATE_PER_DAY) || 100;
  const minuteLimit = rateLimit({ windowMs: 60 * 1000, max: perMinute });
  const dayLimit = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: perDay });

  router.get('/scrappy', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ enabled: scrappy.enabled });
  });

  router.post('/scrappy/chat', (req, res, next) => {
    if (!scrappy.enabled) return res.status(503).json({ error: 'Scrappy is off. Set ANTHROPIC_API_KEY or OLLAMA_URL to turn him on.' });
    return next();
  }, minuteLimit, dayLimit, async (req, res) => {
    const history = cleanHistory(req.body && req.body.messages);
    if (!history) return res.status(400).json({ error: 'Send messages ending with a question.' });
    try {
      const reply = await scrappy.chat(history);
      res.set('Cache-Control', 'no-store').json({ reply });
    } catch (err) {
      logger.warn(`[scrappy] ${err.status || ''} ${err.message}`);
      res.status(502).json({ error: 'Scrappy tripped over a trash can. Try again in a minute.' });
    }
  });

  return router;
}

module.exports = { createScrappyRouter };
