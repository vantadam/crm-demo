const router = require('express').Router();
const axios = require('axios');
const nodemailer = require('nodemailer');
const pool = require('../db');
const auth = require('../middleware/auth');

// Yeastar API token helper
async function getYeastarToken() {
  const { data } = await axios.post(`http://${process.env.YEASTAR_HOST}:${process.env.YEASTAR_PORT}/api/v2.0.0/user/login`, {
    username: process.env.YEASTAR_USER,
    password: process.env.YEASTAR_PASS
  });
  return data.token;
}

// Send SMS via Yeastar TG200
router.post('/send', auth, async (req, res) => {
  const { clientIds, message } = req.body;
  const results = [];

  try {
    const token = await getYeastarToken();
    
    for (const clientId of clientIds) {
      const client = await pool.query('SELECT * FROM clients WHERE id=$1', [clientId]);
      const phone = client.rows[0]?.phone;
      if (!phone) continue;

      try {
        await axios.post(`http://${process.env.YEASTAR_HOST}:${process.env.YEASTAR_PORT}/api/v2.0.0/sms/send`, {
          token,
          trunk: 1,      // TG200 port 1
          to: phone,
          message
        });

        await pool.query(
          'INSERT INTO sms_logs (client_id, message, status) VALUES ($1,$2,$3)',
          [clientId, message, 'sent']
        );
        results.push({ clientId, status: 'sent' });
      } catch (e) {
        await pool.query(
          'INSERT INTO sms_logs (client_id, message, status) VALUES ($1,$2,$3)',
          [clientId, message, 'failed']
        );
        results.push({ clientId, status: 'failed', error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: 'Yeastar connection failed: ' + e.message });
  }
});

// Send Email
router.post('/email', auth, async (req, res) => {
  const { clientIds, subject, body } = req.body;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const results = [];
  for (const clientId of clientIds) {
    const client = await pool.query('SELECT * FROM clients WHERE id=$1', [clientId]);
    const email = client.rows[0]?.email;
    if (!email) continue;
    try {
      await transporter.sendMail({ from: process.env.SMTP_USER, to: email, subject, text: body });
      results.push({ clientId, status: 'sent' });
    } catch (e) {
      results.push({ clientId, status: 'failed', error: e.message });
    }
  }
  res.json({ results });
});

// SMS Logs
router.get('/logs', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT l.*, c.name as client_name, c.phone 
    FROM sms_logs l JOIN clients c ON l.client_id = c.id 
    ORDER BY l.sent_at DESC LIMIT 100
  `);
  res.json(r.rows);
});

module.exports = router;