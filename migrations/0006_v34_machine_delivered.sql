-- ================================================================
-- ADITION ELECTRIC SOLUTION — v34 Migration  
-- 1. Add 'delivered' to machines status CHECK
-- 2. Add 'partial_delivered' to jobs status CHECK
-- Only references columns from migrations 0001-0005
-- ================================================================

-- ── MACHINES: Recreate with 'delivered' in CHECK ──
CREATE TABLE IF NOT EXISTS machines_v34 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  product_complaint TEXT,
  charges REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  assigned_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'under_repair'
    CHECK(status IN ('under_repair','repaired','returned','delivered')),
  audio_note_key TEXT,
  audio_note_url TEXT,
  _dummy_v26 TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO machines_v34 (id, job_id, product_name, product_complaint, charges, quantity,
  assigned_staff_id, status, audio_note_key, audio_note_url, _dummy_v26, created_at, updated_at)
SELECT id, job_id, product_name, product_complaint, charges, quantity,
  assigned_staff_id, status, audio_note_key, audio_note_url, _dummy_v26, created_at, updated_at
FROM machines;

DROP TABLE machines;
ALTER TABLE machines_v34 RENAME TO machines;
CREATE INDEX IF NOT EXISTS idx_machines_job ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_machines_staff ON machines(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);

-- ── JOBS: Recreate with 'partial_delivered' in CHECK ──
-- Only columns from 0001_schema.sql (runtime adds more later)
CREATE TABLE IF NOT EXISTS jobs_v34 (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  snap_name TEXT NOT NULL,
  snap_mobile TEXT NOT NULL,
  snap_mobile2 TEXT,
  snap_address TEXT,
  note TEXT,
  received_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'under_repair'
    CHECK(status IN ('under_repair','repaired','returned','delivered','partial_delivered')),
  delivery_method TEXT CHECK(delivery_method IN ('in_person','courier')),
  delivery_receiver_name TEXT,
  delivery_receiver_mobile TEXT,
  delivery_courier_name TEXT,
  delivery_tracking TEXT,
  delivery_address TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO jobs_v34 (id, customer_id, snap_name, snap_mobile, snap_mobile2, snap_address,
  note, received_amount, status, delivery_method, delivery_receiver_name,
  delivery_receiver_mobile, delivery_courier_name, delivery_tracking,
  delivery_address, delivered_at, created_at, updated_at)
SELECT id, customer_id, snap_name, snap_mobile, snap_mobile2, snap_address,
  note, received_amount, status, delivery_method, delivery_receiver_name,
  delivery_receiver_mobile, delivery_courier_name, delivery_tracking,
  delivery_address, delivered_at, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v34 RENAME TO jobs;
CREATE INDEX IF NOT EXISTS idx_jobs_status_date ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_mobile ON jobs(snap_mobile);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(snap_name);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
