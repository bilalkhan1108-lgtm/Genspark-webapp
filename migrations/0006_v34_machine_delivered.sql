-- ================================================================
-- ADITION ELECTRIC SOLUTION — v34 Migration  (SAFE VERSION)
-- 1. Add 'delivered' to machines status CHECK
-- 2. Add 'partial_delivered' to jobs status CHECK
-- 3. Add delivery columns to machines
-- Uses PRAGMA foreign_keys = OFF to prevent CASCADE deletes
-- NOTE: Some columns (work_done, return_reason, warranty_type, etc.)
--       are added at runtime by ensureDbSchema, so we only copy columns
--       guaranteed by migrations 0001-0005.
-- ================================================================

PRAGMA foreign_keys = OFF;

-- ── MACHINES: Recreate with 'delivered' in CHECK + delivery columns ──
CREATE TABLE IF NOT EXISTS machines_v34 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  product_name TEXT NOT NULL,
  product_complaint TEXT,
  charges REAL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  assigned_staff_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'under_repair'
    CHECK(status IN ('under_repair','repaired','returned','delivered')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  audio_note_key TEXT,
  audio_note_url TEXT,
  work_done TEXT,
  return_reason TEXT,
  _dummy_v26 TEXT,
  warranty_type TEXT NOT NULL DEFAULT 'out_warranty',
  warranty_brand TEXT,
  delivery_method TEXT,
  delivery_receiver_name TEXT,
  delivery_courier_name TEXT,
  delivered_at TEXT
);

-- Copy only columns from 0001-0005 migrations (work_done, return_reason, 
-- warranty_type, warranty_brand are added by ensureDbSchema at runtime)
INSERT INTO machines_v34 (id, job_id, product_name, product_complaint, charges, quantity,
  assigned_staff_id, status, created_at, updated_at, audio_note_key, audio_note_url,
  _dummy_v26)
SELECT id, job_id, product_name, product_complaint, charges, quantity,
  assigned_staff_id, status, created_at, updated_at, audio_note_key, audio_note_url,
  _dummy_v26
FROM machines;

DROP TABLE machines;
ALTER TABLE machines_v34 RENAME TO machines;
CREATE INDEX IF NOT EXISTS idx_machines_job_id ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
CREATE INDEX IF NOT EXISTS idx_machines_assigned ON machines(assigned_staff_id);

-- ── JOBS: Recreate with 'partial_delivered' in CHECK ──
CREATE TABLE IF NOT EXISTS jobs_v34 (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  snap_name TEXT NOT NULL,
  snap_mobile TEXT NOT NULL,
  snap_mobile2 TEXT,
  snap_address TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'under_repair'
    CHECK(status IN ('under_repair','repaired','returned','delivered','partial_delivered')),
  delivery_method TEXT CHECK(delivery_method IN ('in_person','courier')),
  delivery_courier_name TEXT,
  delivery_tracking TEXT,
  delivery_address TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  received_amount REAL DEFAULT 0,
  delivery_receiver_name TEXT,
  delivery_receiver_mobile TEXT,
  discount REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  snap_category TEXT,
  dispatch_method TEXT NOT NULL DEFAULT 'in_person',
  dispatch_courier_name TEXT
);

-- Copy only columns from 0001-0005 migrations (discount, payment_method, 
-- snap_category, dispatch_method, dispatch_courier_name added by ensureDbSchema)
INSERT INTO jobs_v34 (id, customer_id, snap_name, snap_mobile, snap_mobile2, snap_address,
  note, status, delivery_method, delivery_courier_name, delivery_tracking,
  delivery_address, delivered_at, created_at, updated_at,
  received_amount, delivery_receiver_name, delivery_receiver_mobile)
SELECT id, customer_id, snap_name, snap_mobile, snap_mobile2, snap_address,
  note, status, delivery_method, delivery_courier_name, delivery_tracking,
  delivery_address, delivered_at, created_at, updated_at,
  COALESCE(received_amount, 0), delivery_receiver_name, delivery_receiver_mobile
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v34 RENAME TO jobs;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

PRAGMA foreign_keys = ON;
