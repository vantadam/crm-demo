-- ============================================================
-- MIGRATION: Expand clients + add campaigns system
-- Run once against your crm_demo database:
--   psql -U postgres -d crm_demo -f migration.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Expand clients table
-- ------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS first_name    VARCHAR(150),
  ADD COLUMN IF NOT EXISTS last_name     VARCHAR(150),
  ADD COLUMN IF NOT EXISTS customer_id   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS date_last_active TIMESTAMP,
  ADD COLUMN IF NOT EXISTS city          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS state         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS country       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS postcode      VARCHAR(20);

-- Migrate existing `name` into first_name (keep name col for now, drop later if desired)
UPDATE clients SET first_name = name WHERE first_name IS NULL;

-- ------------------------------------------------------------
-- 2. Campaigns table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(255) NOT NULL,
  subject       VARCHAR(500) NOT NULL,
  sender_name   VARCHAR(255) NOT NULL DEFAULT 'fmevenement.ca',
  html_body     TEXT NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'draft',
    -- draft | running | paused | done
  priority      BOOLEAN      NOT NULL DEFAULT FALSE,
    -- TRUE = order queue by date_last_active DESC
  total         INT          NOT NULL DEFAULT 0,
  sent          INT          NOT NULL DEFAULT 0,
  failed        INT          NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    DEFAULT NOW(),
  started_at    TIMESTAMP,
  finished_at   TIMESTAMP
);

-- ------------------------------------------------------------
-- 3. Campaign queue table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_queue (
  id          SERIAL PRIMARY KEY,
  campaign_id INT REFERENCES campaigns(id) ON DELETE CASCADE,
  client_id   INT REFERENCES clients(id)   ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | sent | failed | skipped
  error       TEXT,
  sent_at     TIMESTAMP,
  UNIQUE (campaign_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_cq_campaign_status
  ON campaign_queue(campaign_id, status);

-- ------------------------------------------------------------
-- 4. Extend sms_logs to also track email sends (optional clarity)
-- ------------------------------------------------------------
ALTER TABLE sms_logs
  ADD COLUMN IF NOT EXISTS type VARCHAR(10) DEFAULT 'sms';
  -- 'sms' | 'email'