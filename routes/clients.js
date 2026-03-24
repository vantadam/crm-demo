// routes/clients.js  (full replacement)
const router = require('express').Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs   = require('fs');
const pool = require('../db');
const auth = require('../middleware/auth');

const upload = multer({ dest: 'uploads/' });

// ------------------------------------------------------------------
// GET /api/clients
// ------------------------------------------------------------------
router.get('/', auth, async (req, res) => {
  const result = await pool.query(`
    SELECT c.*,
      COALESCE(json_agg(cat.name) FILTER (WHERE cat.id IS NOT NULL), '[]') AS categories
    FROM clients c
    LEFT JOIN client_categories cc ON c.id = cc.client_id
    LEFT JOIN categories cat       ON cc.category_id = cat.id
    GROUP BY c.id ORDER BY c.created_at DESC
  `);
  res.json(result.rows);
});

// ------------------------------------------------------------------
// POST /api/clients — add single client
// ------------------------------------------------------------------
router.post('/', auth, async (req, res) => {
  const { first_name, last_name, phone, email, categories,
          city, state, country, postcode, customer_id } = req.body;
  const fullName = [first_name, last_name].filter(Boolean).join(' ') || 'Unknown';

  const client = await pool.query(
    `INSERT INTO clients
       (name, first_name, last_name, phone, email, city, state, country, postcode, customer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [fullName, first_name, last_name, phone, email, city, state, country, postcode, customer_id]
  );
  const clientId = client.rows[0].id;

  const allTags = [...(categories || [])];
  if (city)    allTags.push(city);
  if (state)   allTags.push(state);
  if (country) allTags.push(country);

  await assignTags(clientId, allTags);
  res.json(client.rows[0]);
});

// ------------------------------------------------------------------
// POST /api/clients/import — CSV import
// ------------------------------------------------------------------
router.post('/import', auth, upload.single('file'), async (req, res) => {
  const content = fs.readFileSync(req.file.path);
  const records = parse(content, {
    columns: header => header.map(h => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true
  });
  fs.unlinkSync(req.file.path);

  const extraTag = (req.body.extraTag || '').trim();

  let imported = 0, skipped = 0;

  for (const row of records) {
    const email      = row.email || null;
    const first_name = row.first_name || row.firstname || null;
    const last_name  = row.last_name  || row.lastname  || null;
    const fullName   = [first_name, last_name].filter(Boolean).join(' ') || 'Unknown';

    let date_last_active = null;
    if (row.date_last_active) {
      const d = new Date(row.date_last_active);
      if (!isNaN(d.getTime())) date_last_active = d;
    }

    try {
      const r = await pool.query(
        `INSERT INTO clients
           (name, first_name, last_name, email, phone,
            date_last_active, city, state, country, postcode, customer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          fullName,
          first_name,
          last_name,
          email,
          row.phone || null,
          date_last_active,
          row.city     || null,
          row.state    || null,
          row.country  || null,
          row.postcode || null,
          row.customer_id || null
        ]
      );

      if (r.rows.length) {
        const clientId = r.rows[0].id;
        const tags = [];
        if (row.city)    tags.push(row.city);
        if (row.state)   tags.push(row.state);
        if (row.country) tags.push(row.country);
        if (extraTag)    tags.push(extraTag);
        await assignTags(clientId, tags);
        imported++;
      } else {
        skipped++;
      }
    } catch (e) {
      console.error('Import row error:', e.message, row);
      skipped++;
    }
  }

  res.json({ imported, skipped });
});

// ------------------------------------------------------------------
// DELETE /api/clients/:id
// ------------------------------------------------------------------
router.delete('/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ------------------------------------------------------------------
// GET /api/clients/categories
// ------------------------------------------------------------------
router.get('/categories', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM categories ORDER BY name');
  res.json(r.rows);
});

// ------------------------------------------------------------------
// POST /api/clients/categories
// ------------------------------------------------------------------
router.post('/categories', auth, async (req, res) => {
  const { name } = req.body;
  const r = await pool.query(
    `INSERT INTO categories (name) VALUES ($1)
     ON CONFLICT (name) DO NOTHING RETURNING *`,
    [name]
  );
  res.json(r.rows[0] || { name });
});

// ------------------------------------------------------------------
// PUT /api/clients/:id/categories
// ------------------------------------------------------------------
router.put('/:id/categories', auth, async (req, res) => {
  const { categories } = req.body;
  await pool.query('DELETE FROM client_categories WHERE client_id=$1', [req.params.id]);
  await assignTags(req.params.id, categories || []);
  res.json({ success: true });
});

// ------------------------------------------------------------------
// Helper: upsert tags and link to client
// ------------------------------------------------------------------
async function assignTags(clientId, tagNames) {
  for (const raw of tagNames) {
    const name = (raw || '').trim();
    if (!name) continue;
    let cat = await pool.query('SELECT id FROM categories WHERE name=$1', [name]);
    if (!cat.rows.length) {
      cat = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING *', [name]);
    }
    await pool.query(
      'INSERT INTO client_categories VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [clientId, cat.rows[0].id]
    );
  }
}

module.exports = router;