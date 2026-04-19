-- v41: Add indexes for faster search on snap_name, snap_mobile, and job ID
-- These indexes dramatically speed up LIKE queries used in the search API

CREATE INDEX IF NOT EXISTS idx_jobs_snap_name   ON jobs(snap_name);
CREATE INDEX IF NOT EXISTS idx_jobs_snap_mobile ON jobs(snap_mobile);
CREATE INDEX IF NOT EXISTS idx_jobs_id_text     ON jobs(id);
