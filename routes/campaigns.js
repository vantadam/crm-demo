// routes/campaigns.js
const router = require('express').Router();
const pool   = require('../db');
const auth   = require('../middleware/auth');

// ------------------------------------------------------------------
// GET /api/campaigns — list all with progress
// ------------------------------------------------------------------
router.get('/', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM campaigns ORDER BY created_at DESC`
  );
  res.json(r.rows);
});

// ------------------------------------------------------------------
// GET /api/campaigns/:id — single campaign detail + queue stats
// ------------------------------------------------------------------
router.get('/:id', auth, async (req, res) => {
  const camp = await pool.query(
    `SELECT * FROM campaigns WHERE id=$1`, [req.params.id]
  );
  if (!camp.rows.length) return res.status(404).json({ error: 'Not found' });

  // Recent failures for the log panel
  const failures = await pool.query(
    `SELECT cq.error, c.email, c.first_name, c.last_name
     FROM campaign_queue cq
     JOIN clients c ON cq.client_id = c.id
     WHERE cq.campaign_id=$1 AND cq.status='failed'
     ORDER BY cq.id DESC LIMIT 50`,
    [req.params.id]
  );

  res.json({ campaign: camp.rows[0], failures: failures.rows });
});

// ------------------------------------------------------------------
// POST /api/campaigns — create + populate queue
// Body: { title, subject, sender_name, html_body, priority,
//         recipient_mode: 'all' | 'tag',
//         tag: 'VIP'  (if mode=tag) }
// ------------------------------------------------------------------
router.post('/', auth, async (req, res) => {
  const {
    title, subject, sender_name, html_body,
    priority = false,
    recipient_mode = 'all',
    tag
  } = req.body;

  if (!title || !subject || !html_body)
    return res.status(400).json({ error: 'title, subject and html_body are required' });

  // Build recipient list
  let clientQuery;
  if (recipient_mode === 'tag' && tag) {
    clientQuery = await pool.query(
      `SELECT DISTINCT c.id, c.email FROM clients c
       JOIN client_categories cc ON c.id = cc.client_id
       JOIN categories cat ON cc.category_id = cat.id
       WHERE cat.name = $1 AND c.email IS NOT NULL AND c.email <> ''`,
      [tag]
    );
  } else {
    clientQuery = await pool.query(
      `SELECT id, email FROM clients WHERE email IS NOT NULL AND email <> ''`
    );
  }

  const clients = clientQuery.rows;
  if (!clients.length)
    return res.status(400).json({ error: 'No clients with email found for this selection' });

  // Create campaign
  const camp = await pool.query(
    `INSERT INTO campaigns (title, subject, sender_name, html_body, priority, total)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      title,
      subject,
      sender_name || 'fmevenement.ca',
      html_body,
      priority,
      clients.length
    ]
  );
  const campaignId = camp.rows[0].id;

  // Populate queue
  for (const c of clients) {
    await pool.query(
      `INSERT INTO campaign_queue (campaign_id, client_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [campaignId, c.id]
    );
  }

  res.json(camp.rows[0]);
});

// ------------------------------------------------------------------
// PATCH /api/campaigns/:id/start
// ------------------------------------------------------------------
router.patch('/:id/start', auth, async (req, res) => {
  const r = await pool.query(
    `UPDATE campaigns
     SET status='running', started_at=COALESCE(started_at, NOW())
     WHERE id=$1 AND status IN ('draft','paused')
     RETURNING *`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(400).json({ error: 'Cannot start — check status' });
  res.json(r.rows[0]);
});

// ------------------------------------------------------------------
// PATCH /api/campaigns/:id/pause
// ------------------------------------------------------------------
router.patch('/:id/pause', auth, async (req, res) => {
  const r = await pool.query(
    `UPDATE campaigns SET status='paused' WHERE id=$1 AND status='running' RETURNING *`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(400).json({ error: 'Campaign is not running' });
  res.json(r.rows[0]);
});

// ------------------------------------------------------------------
// DELETE /api/campaigns/:id — only if draft or done
// ------------------------------------------------------------------
router.delete('/:id', auth, async (req, res) => {
  await pool.query(
    `DELETE FROM campaigns WHERE id=$1 AND status IN ('draft','done','paused')`,
    [req.params.id]
  );
  res.json({ success: true });
});

module.exports = router;