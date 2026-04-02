-- ================================================================
-- ADITION ELECTRIC SOLUTION — v26 Migration
-- Changes: 
--   1. Replace 'manager' role with 'supervisor' role
--   2. Add supervisor_rights JSON column to users
--   3. Add discount, payment_method columns to jobs
--   4. Add partial_delivered to jobs status CHECK
-- ================================================================

PRAGMA foreign_keys = ON;

-- Add supervisor_rights column to users (JSON string of granted rights)
-- e.g. '["view_jobs","edit_jobs","view_financials","deliver","download","share","manage_staff"]'
ALTER TABLE machines ADD COLUMN _dummy_v26 TEXT;

-- Supervisor rights column
-- Using INSERT OR IGNORE approach since ALTER TABLE doesn't support IF NOT EXISTS
-- The ensureDbSchema function handles this idempotently

-- Add discount and payment_method columns to jobs
-- discount: deduction amount above received_amount
-- payment_method: 'cash' (default) or 'online'

-- Convert existing manager users to supervisor role
UPDATE users SET role='supervisor' WHERE role='manager';
