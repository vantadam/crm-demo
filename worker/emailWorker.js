// worker/emailWorker.js
// -----------------------------------------------------------
// Background worker — runs inside the Node process.
// Call startWorker() once from server.js.
// Picks up the oldest running campaign, sends a batch,
// waits BATCH_INTERVAL_MS, then repeats.
// -----------------------------------------------------------

const nodemailer = require('nodemailer');
const pool       = require('../db');

const BATCH_SIZE     = parseInt(process.env.BATCH_SIZE     || '40');
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL_MS || '480000'); // 8 min default

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false }
  });
}

// Replace {{variable}} tokens in html with client row values
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

async function processBatch() {
  // Find one running campaign
  const campResult = await pool.query(
    `SELECT * FROM campaigns WHERE status = 'running' ORDER BY created_at ASC LIMIT 1`
  );
  if (!campResult.rows.length) return; // nothing to do

  const campaign = campResult.rows[0];

  // Pull a batch of pending items, ordered by priority if set
  const orderBy = campaign.priority
    ? 'c.date_last_active DESC NULLS LAST'
    : 'cq.id ASC';

  const batchResult = await pool.query(
    `SELECT cq.id as queue_id, c.*
     FROM campaign_queue cq
     JOIN clients c ON cq.client_id = c.id
     WHERE cq.campaign_id = $1 AND cq.status = 'pending'
     ORDER BY ${orderBy}
     LIMIT $2`,
    [campaign.id, BATCH_SIZE]
  );

  if (!batchResult.rows.length) {
    // No more pending — mark campaign done
    await pool.query(
      `UPDATE campaigns SET status='done', finished_at=NOW() WHERE id=$1`,
      [campaign.id]
    );
    console.log(`[worker] Campaign #${campaign.id} "${campaign.title}" finished.`);
    return;
  }

  const transporter = createTransporter();
  const from = `"${campaign.sender_name}" <${process.env.SMTP_USER}>`;

  console.log(`[worker] Campaign #${campaign.id} — sending batch of ${batchResult.rows.length}`);

  for (const row of batchResult.rows) {
    if (!row.email) {
      await pool.query(
        `UPDATE campaign_queue SET status='skipped', error='no email' WHERE id=$1`,
        [row.queue_id]
      );
      await pool.query(
        `UPDATE campaigns SET failed = failed + 1 WHERE id=$1`,
        [campaign.id]
      );
      continue;
    }

    try {
      const html = interpolate(campaign.html_body, row);
      const text = html.replace(/<[^>]+>/g, ''); // plain text fallback

      await transporter.sendMail({
        from,
        to:      row.email,
        subject: interpolate(campaign.subject, row),
        html,
        text
      });

      await pool.query(
        `UPDATE campaign_queue SET status='sent', sent_at=NOW() WHERE id=$1`,
        [row.queue_id]
      );
      await pool.query(
        `UPDATE campaigns SET sent = sent + 1 WHERE id=$1`,
        [campaign.id]
      );
    } catch (err) {
      console.error(`[worker] Failed to send to ${row.email}:`, err.message);
      await pool.query(
        `UPDATE campaign_queue SET status='failed', error=$1 WHERE id=$2`,
        [err.message, row.queue_id]
      );
      await pool.query(
        `UPDATE campaigns SET failed = failed + 1 WHERE id=$1`,
        [campaign.id]
      );
    }
  }

  console.log(`[worker] Batch done for campaign #${campaign.id}.`);
}

function startWorker() {
  console.log(`[worker] Email worker started — batch: ${BATCH_SIZE}, interval: ${BATCH_INTERVAL}ms`);
  // Run immediately once, then on interval
  processBatch().catch(err => console.error('[worker] Error:', err.message));
  setInterval(() => {
    processBatch().catch(err => console.error('[worker] Error:', err.message));
  }, BATCH_INTERVAL);
}

module.exports = { startWorker };