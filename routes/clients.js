const router = require('express').Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const pool = require('../db');
const auth = require('../middleware/auth');

const upload = multer({ dest: 'uploads/' });

// Get all clients with their categories
router.get('/', auth, async (req, res) => {
  const result = await pool.query(`
    SELECT c.*, 
      COALESCE(json_agg(cat.name) FILTER (WHERE cat.id IS NOT NULL), '[]') AS categories
    FROM clients c
    LEFT JOIN client_categories cc ON c.id = cc.client_id
    LEFT JOIN categories cat ON cc.category_id = cat.id
    GROUP BY c.id ORDER BY c.created_at DESC
  `);
  res.json(result.rows);
});

// Add single client
router.post('/', auth, async (req, res) => {
  const { name, phone, email, categories } = req.body;
  const client = await pool.query(
    'INSERT INTO clients (name, phone, email) VALUES ($1,$2,$3) RETURNING *',
    [name, phone, email]
  );
  const clientId = client.rows[0].id;
  if (categories && categories.length) {
    for (const catName of categories) {
      let cat = await pool.query('SELECT id FROM categories WHERE name=$1', [catName]);
      if (!cat.rows.length) cat = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING *', [catName]);
      const catId = cat.rows[0].id;
      await pool.query('INSERT INTO client_categories VALUES ($1,$2) ON CONFLICT DO NOTHING', [clientId, catId]);
    }
  }
  res.json(client.rows[0]);
});

// CSV Import
router.post('/import', auth, upload.single('file'), async (req, res) => {
  const content = fs.readFileSync(req.file.path);
  const records = parse(content, { columns: true, skip_empty_lines: true });
  let count = 0;
  for (const row of records) {
    const r = await pool.query(
      'INSERT INTO clients (name, phone, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',
      [row.name, row.phone, row.email]
    );
    count++;
  }
  fs.unlinkSync(req.file.path);
  res.json({ imported: count });
});

// Delete client
router.delete('/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// Get all categories
router.get('/categories', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM categories ORDER BY name');
  res.json(r.rows);
});

// Add category
router.post('/categories', auth, async (req, res) => {
  const { name } = req.body;
  const r = await pool.query('INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [name]);
  res.json(r.rows[0] || { name });
});

// Assign categories to client
router.put('/:id/categories', auth, async (req, res) => {
  const { categories } = req.body;
  await pool.query('DELETE FROM client_categories WHERE client_id=$1', [req.params.id]);
  for (const catName of categories) {
    let cat = await pool.query('SELECT id FROM categories WHERE name=$1', [catName]);
    if (!cat.rows.length) cat = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING *', [catName]);
    await pool.query('INSERT INTO client_categories VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, cat.rows[0].id]);
  }
  res.json({ success: true });
});

module.exports = router;