const router = require('express').Router();
const nodemailer = require('nodemailer');
const pool = require('../db');
const auth = require('../middleware/auth');

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
}

// Send SMS via email-to-SMS gateway
router.post('/send', auth, async (req, res) => {
  const { clientIds, message } = req.body;
  const results = [];
  const transporter = createTransporter();

  for (const clientId of clientIds) {
    const result = await pool.query('SELECT * FROM clients WHERE id=$1', [clientId]);
    const c = result.rows[0];

    if (!c?.phone) {
      results.push({ clientId, status: 'skipped', reason: 'no phone' });
      continue;
    }

    try {
      await transporter.sendMail({
        from: `"fmevenement.ca" <${process.env.SMTP_USER}>`,
        to: process.env.SMS_GATEWAY,
        subject: c.phone,
        text: message
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
});

// Send Email directly to clients
router.post('/email', auth, async (req, res) => {
  const { clientIds, subject, body } = req.body;
  const results = [];
  const transporter = createTransporter();

  for (const clientId of clientIds) {
    const result = await pool.query('SELECT * FROM clients WHERE id=$1', [clientId]);
    const c = result.rows[0];

    if (!c?.email) {
      results.push({ clientId, status: 'skipped', reason: 'no email' });
      continue;
    }

    try {
      await transporter.sendMail({
        from: `"fmevenement.ca" <${process.env.SMTP_USER}>`,
        to: c.email,
        subject,
        text: body,
        html: `<p>${body.replace(/\n/g, '<br>')}</p>`
      });
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