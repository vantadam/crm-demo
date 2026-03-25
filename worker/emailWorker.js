// worker/emailWorker.js
const nodemailer = require('nodemailer');
const pool       = require('../db');

const DEFAULT_BATCH    = parseInt(process.env.BATCH_SIZE        || '40');
const DEFAULT_INTERVAL = parseInt(process.env.BATCH_INTERVAL_MS || '480000');

// Track last batch time per campaign in memory
const lastBatchAt = {};

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
}

function interpolate(html, client) {
  return html
    .replace(/\{\{first_name\}\}/gi,  client.first_name  || '')
    .replace(/\{\{last_name\}\}/gi,   client.last_name   || '')
    .replace(/\{\{email\}\}/gi,       client.email       || '')
    .replace(/\{\{city\}\}/gi,        client.city        || '')
    .replace(/\{\{state\}\}/gi,       client.state       || '')
    .replace(/\{\{country\}\}/gi,     client.country     || '')
    .replace(/\{\{postcode\}\}/gi,    client.postcode    || '')
    .replace(/\{\{customer_id\}\}/gi, client.customer_id || '');
}

async function autoStartScheduled() {
  const r = await pool.query(
    `UPDATE campaigns
     SET status='running', started_at=COALESCE(started_at, NOW())
     WHERE status='draft' AND start_at <= NOW()
     RETURNING id, title`
  );
  r.rows.forEach(c => console.log(`[worker] Auto-started campaign #${c.id} "${c.title}"`));
}

async function processAllRunning() {
  const campResult = await pool.query(
    `SELECT * FROM campaigns
     WHERE status = 'running' AND start_at <= NOW()
     ORDER BY created_at ASC`
  );
  if (!campResult.rows.length) return;

  const now = Date.now();

  for (const campaign of campResult.rows) {
    const batchSize  = campaign.batch_size  || DEFAULT_BATCH;
    const intervalMs = campaign.interval_ms || DEFAULT_INTERVAL;
    const last       = lastBatchAt[campaign.id];

    if (last && (now - last.getTime()) < intervalMs) continue;

    await processCampaignBatch(campaign, batchSize);
    lastBatchAt[campaign.id] = new Date();
  }
}

async function processCampaignBatch(campaign, batchSize) {
  const orderBy = campaign.priority ? 'c.date_last_active DESC NULLS LAST' : 'cq.id ASC';

  const batchResult = await pool.query(
    `SELECT cq.id as queue_id, c.*
     FROM campaign_queue cq
     JOIN clients c ON cq.client_id = c.id
     WHERE cq.campaign_id = $1 AND cq.status = 'pending'
     ORDER BY ${orderBy}
     LIMIT $2`,
    [campaign.id, batchSize]
  );

  if (!batchResult.rows.length) {
    await pool.query(
      `UPDATE campaigns SET status='done', finished_at=NOW() WHERE id=$1`,
      [campaign.id]
    );
    console.log(`[worker] Campaign #${campaign.id} "${campaign.title}" finished.`);
    delete lastBatchAt[campaign.id];
    return;
  }

  const transporter = createTransporter();
  const from = `"${campaign.sender_name}" <${process.env.SMTP_USER}>`;

  console.log(`[worker] Campaign #${campaign.id} — sending batch of ${batchResult.rows.length}`);

  for (const row of batchResult.rows) {
    if (!row.email) {
      await pool.query(`UPDATE campaign_queue SET status='skipped', error='no email' WHERE id=$1`, [row.queue_id]);
      await pool.query(`UPDATE campaigns SET failed = failed + 1 WHERE id=$1`, [campaign.id]);
      continue;
    }
    try {
      const html = interpolate(campaign.html_body, row);
      await transporter.sendMail({
        from, to: row.email,
        subject: interpolate(campaign.subject, row),
        html, text: html.replace(/<[^>]+>/g, '')
      });
      await pool.query(`UPDATE campaign_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [row.queue_id]);
      await pool.query(`UPDATE campaigns SET sent = sent + 1 WHERE id=$1`, [campaign.id]);
    } catch (err) {
      console.error(`[worker] Failed ${row.email}:`, err.message);
      await pool.query(`UPDATE campaign_queue SET status='failed', error=$1 WHERE id=$2`, [err.message, row.queue_id]);
      await pool.query(`UPDATE campaigns SET failed = failed + 1 WHERE id=$1`, [campaign.id]);
    }
  }
  console.log(`[worker] Batch done for campaign #${campaign.id}.`);
}

function startWorker() {
  console.log('[worker] Email worker started — tick every 60s, per-campaign pacing');
  const tick = async () => {
    try { await autoStartScheduled(); await processAllRunning(); }
    catch (err) { console.error('[worker] Error:', err.message); }
  };
  tick();
  setInterval(tick, 60_000);
}

module.exports = { startWorker };