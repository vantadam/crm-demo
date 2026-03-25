-- patch2.sql
-- Safe, additive only — no existing data is touched
-- Run: psql -U postgres -d crm_demo -f db/patch2.sql

-- Add scheduling + pacing fields to campaigns
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS batch_size   INT       NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS interval_ms  INT       NOT NULL DEFAULT 480000,
  ADD COLUMN IF NOT EXISTS start_at     TIMESTAMP NOT NULL DEFAULT NOW();

-- Backfill existing campaigns: start_at = created_at so they are
-- considered "already due" and nothing changes for them
UPDATE campaigns SET start_at = created_at WHERE start_at > created_at;

-- Add bounce tracking to queue
ALTER TABLE campaign_queue
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMP;

-- Index to speed up IMAP poller lookups by email
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);