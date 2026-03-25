// routes/campaigns.js
const router = require('express').Router();
const pool   = require('../db');
const auth   = require('../middleware/auth');

// GET /api/campaigns
router.get('/', auth, async (req, res) => {
  const r = await pool.query(`SELECT * FROM campaigns ORDER BY created_at DESC`);
  res.json(r.rows);
});

// GET /api/campaigns/:id — detail + queue rows paginated
router.get('/:id', auth, async (req, res) => {
  const camp = await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [req.params.id]);
  if (!camp.rows.length) return res.status(404).json({ error: 'Not found' });

  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '50');
  const statusFilter = req.query.status || '';
  const search       = req.query.search || '';
  const offset = (page - 1) * limit;

  let where = `cq.campaign_id=$1`;
  const params = [req.params.id];
  let idx = 2;

  if (statusFilter) { where += ` AND cq.status=$${idx++}`; params.push(statusFilter); }
  if (search) {
    where += ` AND (LOWER(c.first_name||' '||COALESCE(c.last_name,'')) LIKE $${idx} OR LOWER(c.email) LIKE $${idx})`;
    params.push(`%${search.toLowerCase()}%`); idx++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM campaign_queue cq JOIN clients c ON cq.client_id=c.id WHERE ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count);

  const rows = await pool.query(
    `SELECT cq.id, cq.status, cq.sent_at, cq.bounced_at, cq.error,
            c.first_name, c.last_name, c.email
     FROM campaign_queue cq
     JOIN clients c ON cq.client_id = c.id
     WHERE ${where}
     ORDER BY cq.id ASC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  res.json({
    campaign: camp.rows[0],
    queue: rows.rows,
    total,
    page,
    pages: Math.ceil(total / limit)
  });
});

// POST /api/campaigns — create
router.post('/', auth, async (req, res) => {
  const {
    title, subject, sender_name, html_body,
    priority     = false,
    recipient_mode = 'all',
    tag,
    batch_size   = parseInt(process.env.BATCH_SIZE        || '40'),
    interval_ms  = parseInt(process.env.BATCH_INTERVAL_MS || '480000'),
    start_at     // ISO string or null = now
  } = req.body;

  if (!title || !subject || !html_body)
    return res.status(400).json({ error: 'title, subject and html_body are required' });

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

  const startDate = start_at ? new Date(start_at) : new Date();

  const camp = await pool.query(
    `INSERT INTO campaigns
       (title, subject, sender_name, html_body, priority, total,
        batch_size, interval_ms, start_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      title, subject,
      sender_name || 'fmevenement.ca',
      html_body, priority,
      clients.length,
      batch_size, interval_ms,
      startDate
    ]
  );
  const campaignId = camp.rows[0].id;

  for (const c of clients) {
    await pool.query(
      `INSERT INTO campaign_queue (campaign_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [campaignId, c.id]
    );
  }

  res.json(camp.rows[0]);
});

// PATCH /:id/start
router.patch('/:id/start', auth, async (req, res) => {
  const r = await pool.query(
    `UPDATE campaigns
     SET status='running', started_at=COALESCE(started_at, NOW())
     WHERE id=$1 AND status IN ('draft','paused') RETURNING *`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(400).json({ error: 'Cannot start — check status' });
  res.json(r.rows[0]);
});

// PATCH /:id/pause
router.patch('/:id/pause', auth, async (req, res) => {
  const r = await pool.query(
    `UPDATE campaigns SET status='paused' WHERE id=$1 AND status='running' RETURNING *`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(400).json({ error: 'Campaign is not running' });
  res.json(r.rows[0]);
});

// DELETE /:id
router.delete('/:id', auth, async (req, res) => {
  await pool.query(
    `DELETE FROM campaigns WHERE id=$1 AND status IN ('draft','done','paused')`,
    [req.params.id]
  );
  res.json({ success: true });
});

// GET /:id/export — CSV export of full queue
router.get('/:id/export', auth, async (req, res) => {
  const camp = await pool.query(`SELECT title FROM campaigns WHERE id=$1`, [req.params.id]);
  if (!camp.rows.length) return res.status(404).end();

  const rows = await pool.query(
    `SELECT c.first_name, c.last_name, c.email,
            cq.status, cq.sent_at, cq.bounced_at, cq.error
     FROM campaign_queue cq
     JOIN clients c ON cq.client_id = c.id
     WHERE cq.campaign_id = $1
     ORDER BY cq.id ASC`,
    [req.params.id]
  );

  const headers = ['first_name','last_name','email','status','sent_at','bounced_at','error'];
  const csv = [
    headers.join(','),
    ...rows.rows.map(r =>
      headers.map(h => `"${(r[h] || '').toString().replace(/"/g, '""')}"`).join(',')
    )
  ].join('\n');

  const filename = `campaign-${req.params.id}-${camp.rows[0].title.replace(/\s+/g,'-')}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = router;