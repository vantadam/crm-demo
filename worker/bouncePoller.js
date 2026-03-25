// worker/bouncePoller.js
const { ImapFlow } = require('imapflow');
const pool = require('../db');

const POLL_INTERVAL = 30 * 60 * 1000; // 30 minutes
const CHUNK_SIZE    = 10;              // fetch this many envelopes at a time

const BOUNCE_SENDERS = [
  'mailer-daemon', 'postmaster', 'mail delivery',
  'delivery failure', 'delivery status', 'undeliverable', 'returned mail'
];

function extractEmails(text) {
  const matches = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
  return matches ? [...new Set(matches.map(e => e.toLowerCase()))] : [];
}

function isBounce(from, subject) {
  const combined = `${from} ${subject}`.toLowerCase();
  return BOUNCE_SENDERS.some(p => combined.includes(p));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function makeClient() {
  const client = new ImapFlow({
    host:   process.env.SMTP_HOST,
    port:   993,
    secure: true,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false,
    tls:    { rejectUnauthorized: false },
    socketTimeout:   20000,
    greetingTimeout: 15000
  });
  client.on('error', err => {
    console.error('[bounce] IMAP error (handled):', err.message);
  });
  return client;
}

async function pollBounces() {
  console.log('[bounce] Polling inbox for bounces...');

  // --- Pass 1: get list of unread UIDs ---
  let uids = [];
  {
    const client = makeClient();
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      uids = await client.search({ seen: false });
      await client.logout();
    } catch (err) {
      console.error('[bounce] Failed to fetch UID list:', err.message);
      try { await client.logout(); } catch (_) {}
      return;
    }
  }

  if (!uids.length) { console.log('[bounce] No unread messages.'); return; }
  console.log(`[bounce] Found ${uids.length} unread message(s). Processing in chunks of ${CHUNK_SIZE}...`);

  const bounceUids = [];

  // --- Pass 2: fetch envelopes in chunks, mark all read ---
  for (const chunk of chunkArray(uids, CHUNK_SIZE)) {
    const client = makeClient();
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');

      for await (const msg of client.fetch(chunk, { envelope: true }, { uid: true })) {
        const from    = msg.envelope?.from?.[0]?.address || '';
        const subject = msg.envelope?.subject || '';
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
        if (isBounce(from, subject)) bounceUids.push(msg.uid);
      }

      await client.logout();
    } catch (err) {
      console.error('[bounce] Chunk fetch error:', err.message);
      try { await client.logout(); } catch (_) {}
      // continue to next chunk
    }
  }

  console.log(`[bounce] ${bounceUids.length} bounce candidate(s) found.`);
  if (!bounceUids.length) return;

  // --- Pass 3: fetch full source for bounce candidates only ---
  let bounceCount = 0;
  for (const chunk of chunkArray(bounceUids, CHUNK_SIZE)) {
    const client = makeClient();
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');

      for await (const msg of client.fetch(chunk, { source: true }, { uid: true })) {
        const raw      = msg.source?.toString() || '';
        const emails   = extractEmails(raw);
        const sender   = (process.env.SMTP_USER || '').toLowerCase();
        const candidates = emails.filter(e =>
          e !== sender && !e.includes('mailer-daemon') && !e.includes('postmaster')
        );

        for (const bouncedEmail of candidates) {
          const result = await pool.query(
            `UPDATE campaign_queue cq
             SET status = 'bounced', bounced_at = NOW()
             FROM clients c
             WHERE cq.client_id = c.id
               AND LOWER(c.email) = $1
               AND cq.status IN ('sent', 'pending')
             RETURNING cq.campaign_id`,
            [bouncedEmail]
          );
          if (result.rows.length) {
            const campaignIds = [...new Set(result.rows.map(r => r.campaign_id))];
            for (const cid of campaignIds) {
              await pool.query(
                `UPDATE campaigns SET failed = failed + $1 WHERE id = $2`,
                [result.rows.filter(r => r.campaign_id === cid).length, cid]
              );
            }
            console.log(`[bounce] Marked bounced: ${bouncedEmail}`);
            bounceCount++;
          }
        }
      }

      await client.logout();
    } catch (err) {
      console.error('[bounce] Source fetch error:', err.message);
      try { await client.logout(); } catch (_) {}
    }
  }

  console.log(`[bounce] Poll complete — ${bounceCount} bounce(s) recorded.`);
}

function startBouncePoller() {
  console.log('[bounce] Bounce poller started — polling every 30 minutes');
  pollBounces();
  setInterval(pollBounces, POLL_INTERVAL);
}

module.exports = { startBouncePoller };