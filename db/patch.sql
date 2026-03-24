-- patch.sql
-- Run: psql -U postgres -d crm_demo -f db/patch.sql

-- 1. Make the old `name` column nullable (we now use first_name + last_name)
ALTER TABLE clients ALTER COLUMN name DROP NOT NULL;

-- 2. Make sms_logs FK cascade on delete so deleting a client doesn't error
ALTER TABLE sms_logs DROP CONSTRAINT IF EXISTS sms_logs_client_id_fkey;
ALTER TABLE sms_logs ADD CONSTRAINT sms_logs_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;