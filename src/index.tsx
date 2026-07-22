import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'

// ── Types ─────────────────────────────────────────────────────────────────────
type Bindings = {
  DB: D1Database
  PRODUCT_IMAGES: R2Bucket
  JWT_SECRET: string
}
type Variables = {
  userId: number
  userRole: string
  userEmail: string
  userName: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'] }))

// v39: Health check endpoint for offline detection (no auth required)
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

// ── v52.6: Server-side image download endpoint ─────────────────────────────
// Android Chrome blocks programmatic <a download>.click() after the first use
// in a page lifecycle. This endpoint accepts the image binary via POST and
// serves it back with Content-Disposition: attachment — which is a genuine
// server-initiated download that Android NEVER blocks.
// No auth required — the image data is sent by the client, not stored.
app.post('/api/download-image', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || 'image/jpeg'
    const fileName = c.req.header('X-Filename') || 'job-card.jpg'
    const body = await c.req.arrayBuffer()
    if (!body || body.byteLength < 100) {
      return c.json({ error: 'No image data' }, 400)
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType.startsWith('image/') ? contentType : 'image/jpeg',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': body.byteLength.toString(),
        'Cache-Control': 'no-store, no-cache',
      }
    })
  } catch (e: any) {
    return c.json({ error: e.message || 'Download failed' }, 500)
  }
})

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function signToken(payload: Record<string, unknown>, secret: string) {
  const key = new TextEncoder().encode(secret)
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key)
}
async function verifyToken(token: string, secret: string) {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, key)
  return payload
}

// Runtime seed — fires on login if admin row missing
async function seedAdmin(db: D1Database) {
  const exists = await db.prepare('SELECT id FROM users WHERE email=?')
    .bind('bilalkhan1108@gmail.com').first()
  if (!exists) {
    const hash = await bcrypt.hash('0010', 10)
    await db.prepare(
      'INSERT OR IGNORE INTO users(name,email,password_hash,role,active) VALUES(?,?,?,?,1)'
    ).bind('Bilal Khan', 'bilalkhan1108@gmail.com', hash, 'admin').run()
  }
  // Ensure app_settings table exists (idempotent)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run()
  await db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('job_prefix','C')").run()
  await db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('job_seq_digits','3')").run()
}

// ── Middleware ────────────────────────────────────────────────────────────────
const authMiddleware = async (c: any, next: any) => {
  const header = c.req.header('Authorization') || ''
  const token  = header.replace('Bearer ', '').trim()
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET || 'aes-default-secret')
    c.set('userId',   payload.sub  as number)
    c.set('userRole', payload.role as string)
    c.set('userEmail',payload.email as string)
    c.set('userName', payload.name  as string)
    c.set('userRights', payload.rights as string || '[]')
    // Ensure app_settings table exists (runs once per Worker instance)
    await ensureDbSchema(c.env.DB)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
}
// ── Role Hierarchy: admin > director > manager > staff ───────────────────────
// Admin: full rights (owner)
// Director: all except staff-menu access
// Manager: all except staff, dashboard, settings
// Staff: assignable rights only
const ROLE_LEVELS: Record<string, number> = { admin: 4, director: 3, manager: 2, staff: 1 }
function roleLevel(role: string): number { return ROLE_LEVELS[role] || 0 }

const adminOnly = async (c: any, next: any) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}
// Staff menu = admin only (directors, managers, staff cannot access)
const staffMenuAccess = async (c: any, next: any) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}
// Check specific right for staff role; admin/director/manager always have all rights
function hasRight(c: any, right: string): boolean {
  const role = c.get('userRole')
  if (role === 'admin' || role === 'director' || role === 'manager') return true
  if (role === 'staff') {
    try {
      const rights = JSON.parse(c.get('userRights') || '[]')
      return rights.includes(right)
    } catch { return false }
  }
  return false
}
// Admin or Director or Manager (roles that can see dashboard, manage jobs, etc.)
const adminOrSupervisor = async (c: any, next: any) => {
  const role = c.get('userRole')
  const lvl = roleLevel(role)
  if (lvl < 2) return c.json({ error: 'Forbidden' }, 403) // staff cannot
  await next()
}
// Directors and above (dashboard access)
const dashboardAccess = async (c: any, next: any) => {
  const role = c.get('userRole')
  if (role !== 'admin' && role !== 'director') return c.json({ error: 'Forbidden' }, 403)
  await next()
}
// Settings access: admin only
const settingsAccess = async (c: any, next: any) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}

// ── Lazy DB init: ensure app_settings table on first request ─────────────────
// v50.2: PARALLEL schema migration — runs all independent ALTERs/INDEXes concurrently
// Was running 40+ sequential queries on cold start (~2-4s). Now runs in ~200-400ms.
let _dbInited = false
async function ensureDbSchema(db: D1Database) {
  if (_dbInited) return
  try {
    // Phase 1: Core tables (must be sequential — tables depend on each other)
    await db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run()
    await Promise.all([
      db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('job_prefix','C')").run(),
      db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('job_seq_digits','3')").run(),
      db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('customer_categories','Salon,Consumer,Retailer,N/A')").run().catch(() => {}),
    ])
    // Phase 2: All ALTER TABLE statements in parallel (each is idempotent, fails silently if exists)
    await Promise.all([
      db.prepare(`ALTER TABLE machines ADD COLUMN work_done TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN return_reason TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE users ADD COLUMN supervisor_rights TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN discount REAL NOT NULL DEFAULT 0`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'`).run().catch(() => {}),
      db.prepare(`ALTER TABLE customers ADD COLUMN category TEXT NOT NULL DEFAULT 'Salon'`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN snap_category TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN warranty_type TEXT NOT NULL DEFAULT 'out_warranty'`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN warranty_brand TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN dispatch_method TEXT NOT NULL DEFAULT 'in_person'`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN dispatch_courier_name TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN delivery_method TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN delivery_receiver_name TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN delivery_courier_name TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN delivered_at TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE job_history ADD COLUMN user_id INTEGER`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN purchased_from TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN purchase_invoice_no TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN purchase_date TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN invoice_image_key TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE machines ADD COLUMN invoice_image_url TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE customers ADD COLUMN note TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE customers ADD COLUMN dispatch_method TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN extra_charges REAL NOT NULL DEFAULT 0`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN extra_charges_note TEXT`).run().catch(() => {}),
      db.prepare(`ALTER TABLE jobs ADD COLUMN delivery_rating INTEGER`).run().catch(() => {}),
      db.prepare(`UPDATE users SET role='director' WHERE role='supervisor'`).run().catch(() => {}),
    ])
    // Phase 3: CREATE TABLE + all CREATE INDEX in parallel
    await Promise.all([
      db.prepare(`CREATE TABLE IF NOT EXISTS job_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT, user_name TEXT, user_role TEXT, created_at TEXT DEFAULT (datetime('now'))
      )`).run().catch(() => {}),
      db.prepare(`CREATE TABLE IF NOT EXISTS ai_learning (
        id INTEGER PRIMARY KEY AUTOINCREMENT, image_hash TEXT, product_name TEXT,
        product_complaint TEXT, charges REAL, brand TEXT, model TEXT, category TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jh_job ON job_history(job_id)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jh_created ON job_history(created_at)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_mobile ON jobs(snap_mobile)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(snap_name)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_status_date ON jobs(status, created_at)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_cust_name ON customers(name)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_job ON machines(job_id)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_staff ON machines(assigned_staff_id)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_dispatch ON jobs(dispatch_method)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_mobile2 ON jobs(snap_mobile2)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_cust_mobile ON customers(mobile)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_warranty ON machines(warranty_type, warranty_brand)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_snap_name ON jobs(snap_name)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_ai_brand ON ai_learning(brand)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_delivered_at ON jobs(delivered_at)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_delivery_method ON jobs(delivery_method)`).run().catch(() => {}),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_payment ON jobs(payment_method)`).run().catch(() => {}),
    ])
    _dbInited = true
  } catch (_) {}
}

// ── Job history helper — fire-and-forget, never blocks ───────────────────────
// v32: Separate job_history DB table with precise timestamps for:
//   - Job creation (auto-logged on POST /api/jobs)
//   - Machine/product addition (auto-logged on POST /api/jobs/:id/machines)
//   - Status changes (auto-logged on PUT /api/machines/:id and PUT /api/jobs/:id)
//   - Payment updates, customer edits, notes, delivery, etc.
// Each entry stores: job_id, action, detail, user_name, user_role, created_at (UTC)
// v44: logHistory — fast non-blocking insert (table guaranteed by migrations)
let _historyTableReady = false
async function logHistory(db: D1Database, jobId: string, action: string, detail: string, userName: string, userRole: string) {
  try {
    if (!_historyTableReady) {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS job_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT,
          user_name TEXT,
          user_role TEXT,
          user_id INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `).run()
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_jh_job ON job_history(job_id)`).run().catch(() => {})
      _historyTableReady = true
    }
    await db.prepare(
      `INSERT INTO job_history (job_id, action, detail, user_name, user_role) VALUES (?,?,?,?,?)`
    ).bind(jobId, action, detail, userName, userRole).run()
  } catch (_) {}
}
// v44: Fire-and-forget history logging (don't await — saves ~30ms per call)
function logHistoryAsync(db: D1Database, jobId: string, action: string, detail: string, userName: string, userRole: string) {
  logHistory(db, jobId, action, detail, userName, userRole).catch(() => {})
}

// ── Job status auto-update (with history logging) ──────────────────────────────
async function updateJobStatus(db: D1Database, jobId: string, userName?: string, userRole?: string) {
  const { results: machines } = await db.prepare(
    'SELECT status FROM machines WHERE job_id=?'
  ).bind(jobId).all<any>()
  if (!machines.length) return
  const job = await db.prepare('SELECT status FROM jobs WHERE id=?').bind(jobId).first<any>()
  if (job?.status === 'delivered') return // whole-job delivery overrides
  const allReturned    = machines.every((m: any) => m.status === 'returned')
  const anyUnderRepair = machines.some((m: any)  => m.status === 'under_repair')
  const anyReturned    = machines.some((m: any)  => m.status === 'returned')
  const anyRepaired    = machines.some((m: any)  => m.status === 'repaired')
  const anyDelivered   = machines.some((m: any)  => m.status === 'delivered')
  const allDelivered   = machines.every((m: any) => m.status === 'delivered' || m.status === 'returned')
  // partial_delivered: some machines delivered but others still under_repair/repaired
  let newStatus: string
  if (allDelivered && machines.some((m: any) => m.status === 'delivered')) {
    newStatus = 'delivered'
  } else if (anyDelivered) {
    newStatus = 'partial_delivered'
  } else if (anyUnderRepair) {
    newStatus = 'under_repair'
  } else if (allReturned) {
    newStatus = 'returned'
  } else if (anyReturned && anyRepaired) {
    newStatus = 'partial_delivered'
  } else {
    newStatus = 'repaired'
  }
  const oldStatus = job?.status
  // v34: If all machines are now delivered, also set delivered_at on the job
  if (newStatus === 'delivered' && oldStatus !== 'delivered') {
    await db.prepare(`UPDATE jobs SET status=?,delivered_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .bind(newStatus, jobId).run()
  } else {
    await db.prepare(`UPDATE jobs SET status=?,updated_at=datetime('now') WHERE id=?`)
      .bind(newStatus, jobId).run()
  }
  // Log auto status transition
  if (oldStatus !== newStatus && userName) {
    logHistory(db, jobId, `Auto Status: ${newStatus}`, `Job status auto-changed from ${oldStatus} to ${newStatus}`, userName, userRole || 'system')
  }
}

// ── API: Auth ─────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (c) => {
  try { await seedAdmin(c.env.DB) } catch (_) {}
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { email, password } = body
  if (!email || !password) return c.json({ error: 'Email and password required' }, 400)
  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE email=? AND active=1'
  ).bind(email).first<any>()
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401)
  const token = await signToken(
    { sub: user.id, role: user.role, email: user.email, name: user.name, rights: user.supervisor_rights || '[]' },
    c.env.JWT_SECRET || 'aes-default-secret'
  )
  return c.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, supervisor_rights: user.supervisor_rights || '[]' } })
})

// ── API: Auth — refresh token (after role changes) ─────────────────────────
app.get('/api/auth/refresh', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id,name,email,role,active,supervisor_rights FROM users WHERE id=?'
  ).bind(c.get('userId')).first<any>()
  if (!user || !user.active) return c.json({ error: 'Account disabled' }, 403)
  const token = await signToken(
    { sub: user.id, role: user.role, email: user.email, name: user.name, rights: user.supervisor_rights || '[]' },
    c.env.JWT_SECRET || 'aes-default-secret'
  )
  return c.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, supervisor_rights: user.supervisor_rights || '[]' } })
})

app.get('/api/auth/me', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id,name,email,role,active,supervisor_rights FROM users WHERE id=?'
  ).bind(c.get('userId')).first<any>()
  return c.json(user)
})

// ── API: Customers ────────────────────────────────────────────────────────────
// v50.1: Return all customer fields including dispatch_method preference
app.get('/api/customers/by-mobile', authMiddleware, async (c) => {
  const mobile = c.req.query('mobile') || ''
  const cust = await c.env.DB.prepare(
    'SELECT * FROM customers WHERE mobile=?'
  ).bind(mobile).first<any>()
  return c.json(cust || null)
})

// v49.4: Manual customer creation from Settings
app.post('/api/customers', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const mobile = (body.mobile || '').replace(/\D/g, '').trim()
  const name = (body.name || '').trim()
  if (!mobile || mobile.length < 10) return c.json({ error: 'Valid mobile number required (min 10 digits)' }, 400)
  if (!name) return c.json({ error: 'Customer name required' }, 400)
  const mobile2 = (body.mobile2 || '').replace(/\D/g, '').trim() || null
  const address = (body.address || '').trim() || null
  const category = (body.category || 'Salon').trim()
  const note = (body.note || '').trim() || null
  try {
    await c.env.DB.prepare(
      `INSERT INTO customers(name, mobile, mobile2, address, category, note) VALUES(?,?,?,?,?,?)
       ON CONFLICT(mobile) DO UPDATE SET
         name=excluded.name, mobile2=excluded.mobile2,
         address=excluded.address, category=excluded.category, note=excluded.note, updated_at=datetime('now')`
    ).bind(name, mobile, mobile2, address, category, note).run()
    const cust = await c.env.DB.prepare('SELECT * FROM customers WHERE mobile=?').bind(mobile).first<any>()
    return c.json(cust, 201)
  } catch (e: any) {
    return c.json({ error: e.message || 'Failed to create customer' }, 500)
  }
})

// ── API: Dashboard Analytics ──────────────────────────────────────────────────
app.get('/api/analytics', authMiddleware, async (c) => {
  const role = c.get('userRole')
  const isAdmin = roleLevel(role) >= 2
  const userId  = c.get('userId')

  // Staff see all jobs in analytics (no filter needed)
  const staffJoin = ''

  const today = new Date().toISOString().split('T')[0]
  const monthStart = today.substring(0, 8) + '01'

  const [total, pending, completed, todayCount, monthCount, byStatus, byStaff,
         urCount, repCount, retCount, partialCount, courierPendingCount, urgentCount] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin}`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status IN ('under_repair','repaired','returned')`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status='delivered'`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE DATE(j.created_at)=?`).bind(today).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.created_at>=?`).bind(monthStart).first<any>(),
    isAdmin ? c.env.DB.prepare(`
      SELECT j.status, COUNT(j.id) AS cnt FROM jobs j GROUP BY j.status ORDER BY cnt DESC
    `).all<any>() : { results: [] },
    isAdmin ? c.env.DB.prepare(`
      SELECT u.name, COUNT(m.id) AS cnt, SUM(CASE WHEN m.status != 'returned' THEN m.charges * m.quantity ELSE 0 END) AS total_charges
      FROM machines m JOIN users u ON m.assigned_staff_id=u.id
      GROUP BY u.id, u.name ORDER BY cnt DESC LIMIT 10
    `).all<any>() : { results: [] },
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status='under_repair'`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status='repaired'`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status='returned'`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status='partial_delivered'`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.dispatch_method='courier' AND j.status != 'delivered'`).first<any>(),
    // v41: Urgent jobs — active jobs older than 25 days (needs immediate attention)
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${staffJoin} WHERE j.status IN ('under_repair','repaired') AND j.created_at <= datetime('now','-25 days')`).first<any>(),
  ])

  // Revenue data for admin dashboard
  let revenueData: any = { todayRevenue: 0, monthRevenue: 0, totalRevenue: 0, pendingDues: 0, onlineTotal: 0, cashTotal: 0 }
  let monthlyRevenue: any[] = []
  // v52.2: Delivery analytics — supports date, month, OR date range
  const delDate = c.req.query('del_date') || ''
  const delMonth = c.req.query('del_month') || ''
  const delFrom = c.req.query('del_from') || ''
  const delTo = c.req.query('del_to') || ''
  // Build delivery date filter: range > specific date > month > today
  let delDateCond = 'DATE(delivered_at)=?'
  let delDateParams: string[] = [today]
  let delLabel = 'today'
  if (delFrom && delTo && /^\d{4}-\d{2}-\d{2}$/.test(delFrom) && /^\d{4}-\d{2}-\d{2}$/.test(delTo)) {
    delDateCond = 'DATE(delivered_at) BETWEEN ? AND ?'
    delDateParams = [delFrom, delTo]
    delLabel = `${delFrom}~${delTo}`
  } else if (delDate && /^\d{4}-\d{2}-\d{2}$/.test(delDate)) {
    delDateParams = [delDate]; delLabel = delDate
  } else if (delMonth && /^\d{4}-\d{2}$/.test(delMonth)) {
    delDateCond = "strftime('%Y-%m',delivered_at)=?"
    delDateParams = [delMonth]; delLabel = delMonth
  }
  let deliveryAnalytics: any = { courierDel: 0, inPersonDel: 0, deliveredDel: 0, cashDel: 0, onlineDel: 0, delLabel }
  if (isAdmin) {
    const [todayRev, monthRev, totalRev, pendDues, onlineRev, cashRev, monthlyRev,
           courierDelQ, inPersonDelQ, deliveredDelQ, cashDelQ, onlineDelQ] = await Promise.all([
      c.env.DB.prepare(`SELECT COALESCE(SUM(j.received_amount),0) AS amt FROM jobs j WHERE DATE(j.created_at)=?`).bind(today).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(j.received_amount),0) AS amt FROM jobs j WHERE j.created_at>=?`).bind(monthStart).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(j.received_amount),0) AS amt FROM jobs j`).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN m.status != 'returned' THEN m.charges * m.quantity ELSE 0 END),0) - COALESCE(SUM(DISTINCT j.received_amount),0) AS amt FROM jobs j LEFT JOIN machines m ON m.job_id=j.id WHERE j.status != 'delivered'`).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(j.received_amount),0) AS amt FROM jobs j WHERE j.payment_method='online'`).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(j.received_amount),0) AS amt FROM jobs j WHERE j.payment_method='cash' OR j.payment_method IS NULL`).first<any>(),
      c.env.DB.prepare(`
        SELECT strftime('%Y-%m', j.created_at) AS month,
               COUNT(DISTINCT j.id) AS jobs,
               COALESCE(SUM(CASE WHEN m.status != 'returned' THEN m.charges * m.quantity ELSE 0 END),0) AS charges,
               COALESCE(SUM(DISTINCT j.received_amount),0) AS received
        FROM jobs j LEFT JOIN machines m ON m.job_id=j.id
        WHERE j.created_at >= datetime('now','-6 months')
        GROUP BY strftime('%Y-%m', j.created_at)
        ORDER BY month DESC LIMIT 6
      `).all<any>(),
      // v52.2: Delivery analytics — date/month/range-aware
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs WHERE status='delivered' AND ${delDateCond} AND delivery_method='courier'`).bind(...delDateParams).first<any>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs WHERE status='delivered' AND ${delDateCond} AND (delivery_method='in_person' OR delivery_method IS NULL)`).bind(...delDateParams).first<any>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs WHERE status='delivered' AND ${delDateCond}`).bind(...delDateParams).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(received_amount),0) AS amt FROM jobs WHERE status='delivered' AND ${delDateCond} AND (payment_method='cash' OR payment_method IS NULL)`).bind(...delDateParams).first<any>(),
      c.env.DB.prepare(`SELECT COALESCE(SUM(received_amount),0) AS amt FROM jobs WHERE status='delivered' AND ${delDateCond} AND payment_method='online'`).bind(...delDateParams).first<any>(),
    ])
    revenueData = {
      todayRevenue: todayRev?.amt || 0,
      monthRevenue: monthRev?.amt || 0,
      totalRevenue: totalRev?.amt || 0,
      pendingDues: Math.max(0, pendDues?.amt || 0),
      onlineTotal: onlineRev?.amt || 0,
      cashTotal: cashRev?.amt || 0,
    }
    monthlyRevenue = monthlyRev.results || []
    deliveryAnalytics = {
      courierDel: courierDelQ?.cnt || 0,
      inPersonDel: inPersonDelQ?.cnt || 0,
      deliveredDel: deliveredDelQ?.cnt || 0,
      cashDel: cashDelQ?.amt || 0,
      onlineDel: onlineDelQ?.amt || 0,
      delLabel,
    }
  }

  return c.json({
    total: total?.cnt || 0,
    pending: pending?.cnt || 0,
    completed: completed?.cnt || 0,
    today: todayCount?.cnt || 0,
    thisMonth: monthCount?.cnt || 0,
    underRepair: urCount?.cnt || 0,
    repaired: repCount?.cnt || 0,
    returned: retCount?.cnt || 0,
    partial: partialCount?.cnt || 0,
    courierPending: courierPendingCount?.cnt || 0,
    urgent: urgentCount?.cnt || 0,
    byStatus: isAdmin ? byStatus.results : [],
    byStaff: isAdmin ? byStaff.results : [],
    ...revenueData,
    ...deliveryAnalytics,
    monthlyRevenue,
  })
})

// ── API: Jobs — list ──────────────────────────────────────────────────────────
app.get('/api/jobs', authMiddleware, async (c) => {
  const status   = c.req.query('status') || ''
  const search   = c.req.query('q')      || ''
  const searchJob  = c.req.query('q_job')  || ''
  const searchName = c.req.query('q_name') || ''
  const staffId  = c.req.query('staff_id') || ''
  const from     = c.req.query('from')   || ''
  const to       = c.req.query('to')     || ''
  const brand    = c.req.query('brand')  || ''  // v50.7: server-side brand filter
  // v52.1: Delivery tile click filters — filter by delivery method / date / payment
  const delMethod  = c.req.query('del_method')  || ''  // 'courier' | 'in_person'
  const delDate    = c.req.query('del_date')    || ''  // YYYY-MM-DD
  const delMonth   = c.req.query('del_month')   || ''  // YYYY-MM
  const delFrom    = c.req.query('del_from')    || ''  // v52.2: YYYY-MM-DD date range start
  const delTo      = c.req.query('del_to')      || ''  // v52.2: YYYY-MM-DD date range end
  const payFilter  = c.req.query('pay_filter')  || ''  // 'cash' | 'online'
  const limit    = Math.min(parseInt(c.req.query('limit') || '100'), 500)
  const offset   = parseInt(c.req.query('offset') || '0') || 0
  const role     = c.get('userRole')
  const isAdmin  = roleLevel(role) >= 2
  const userId   = c.get('userId')
  const conds: string[] = []
  const params: any[] = []

  // active_only: hide jobs where ALL machines are repaired or returned
  if (status === 'active_only') {
    conds.push(`EXISTS (SELECT 1 FROM machines mx WHERE mx.job_id=j.id AND mx.status='under_repair')`)
    conds.push("j.status != 'delivered'")
  } else if (status === 'courier_pending') {
    // Show jobs dispatched via courier that are NOT yet delivered
    conds.push("j.dispatch_method='courier'")
    conds.push("j.status != 'delivered'")
  } else if (status === 'urgent') {
    // v49.7: Active jobs older than 25 days — server-side filter
    conds.push("j.status IN ('under_repair','repaired')")
    conds.push("j.created_at <= datetime('now','-25 days')")
  } else if (status) {
    conds.push('j.status=?'); params.push(status)
  }
  // Staff: hide delivered jobs only (supervisors and admin can see all)
  if (!isAdmin) {
    conds.push("j.status != 'delivered'")
  }
  // staff_id filter: admin can filter by any staff; staff can only filter by self
  if (staffId) {
    const filterStaff = isAdmin ? staffId : String(userId)
    conds.push(`EXISTS (SELECT 1 FROM machines ms2 WHERE ms2.job_id=j.id AND ms2.assigned_staff_id=?)`)
    params.push(filterStaff)
  }
  // Split search: q_job searches only job ID, q_name searches name/mobile
  if (searchJob) {
    conds.push('j.id LIKE ?')
    params.push(`%${searchJob}%`)
  }
  if (searchName) {
    // v52.2: Normalize phone search — strip +91, spaces, hyphens for tolerant matching
    const snDigits = searchName.replace(/[^0-9]/g, '')
    const snPhone = snDigits.length >= 12 && snDigits.startsWith('91') ? snDigits.slice(2) : snDigits
    // If search looks like a phone number (3+ digits), search both raw and normalized
    if (snPhone.length >= 3 && /\d/.test(searchName)) {
      conds.push('(j.snap_name LIKE ? OR j.snap_mobile LIKE ? OR j.snap_mobile2 LIKE ? OR j.snap_address LIKE ? OR REPLACE(REPLACE(REPLACE(j.snap_mobile," ",""),"+",""),"-","") LIKE ? OR REPLACE(REPLACE(REPLACE(j.snap_mobile2," ",""),"+",""),"-","") LIKE ?)')
      params.push(`%${searchName}%`, `%${searchName}%`, `%${searchName}%`, `%${searchName}%`, `%${snPhone}%`, `%${snPhone}%`)
    } else {
      conds.push('(j.snap_name LIKE ? OR j.snap_mobile LIKE ? OR j.snap_mobile2 LIKE ? OR j.snap_address LIKE ?)')
      params.push(`%${searchName}%`, `%${searchName}%`, `%${searchName}%`, `%${searchName}%`)
    }
  }
  // Legacy combined search (fallback)
  if (search && !searchJob && !searchName) {
    conds.push('(j.snap_name LIKE ? OR j.snap_mobile LIKE ? OR j.id LIKE ? OR j.snap_address LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
  }
  if (from) { conds.push('DATE(j.created_at)>=?'); params.push(from) }
  if (to)   { conds.push('DATE(j.created_at)<=?'); params.push(to) }
  // v50.7: Brand filter — uses indexed warranty_brand column for fast lookups
  if (brand) {
    conds.push(`EXISTS (SELECT 1 FROM machines mb WHERE mb.job_id=j.id AND mb.warranty_type='warranty' AND mb.warranty_brand=?)`)
    params.push(brand)
  }
  // v52.1: Delivery tile click filters — filter delivered jobs by method/date/payment
  if (delMethod === 'courier') {
    conds.push("j.delivery_method='courier'")
  } else if (delMethod === 'in_person') {
    conds.push("(j.delivery_method='in_person' OR j.delivery_method IS NULL)")
  }
  // v52.2: Support date range (del_from/del_to), single date, or month for delivery tile filters
  if (delFrom && delTo && /^\d{4}-\d{2}-\d{2}$/.test(delFrom) && /^\d{4}-\d{2}-\d{2}$/.test(delTo)) {
    conds.push('DATE(j.delivered_at) BETWEEN ? AND ?'); params.push(delFrom, delTo)
  } else if (delDate && /^\d{4}-\d{2}-\d{2}$/.test(delDate)) {
    conds.push('DATE(j.delivered_at)=?'); params.push(delDate)
  } else if (delMonth && /^\d{4}-\d{2}$/.test(delMonth)) {
    conds.push("strftime('%Y-%m',j.delivered_at)=?"); params.push(delMonth)
  }
  // v52.2 fix: Cash filter — only match explicit 'cash' or NULL when job IS delivered
  // (NULL payment_method on delivered jobs likely means cash/in-person)
  if (payFilter === 'cash') {
    conds.push("(j.payment_method='cash' OR (j.payment_method IS NULL AND j.status='delivered'))")
  } else if (payFilter === 'online') {
    conds.push("j.payment_method='online'")
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  // v35: Optimized query — uses indexed subqueries, avoids costly JOIN for thumb
  const { results } = await c.env.DB.prepare(`
    SELECT j.id, j.snap_name, j.snap_mobile, j.snap_category, j.status, j.dispatch_method, j.dispatch_courier_name,
           j.received_amount, j.discount, j.payment_method, j.extra_charges, j.extra_charges_note, j.delivery_rating, j.created_at, j.updated_at,
           COALESCE((SELECT SUM(quantity) FROM machines WHERE job_id=j.id), 0) AS machine_count,
           COALESCE((SELECT SUM(charges * quantity) FROM machines WHERE job_id=j.id AND status != 'returned'), 0) + COALESCE(j.extra_charges, 0) AS total_charges,
           (SELECT mi.url FROM machine_images mi WHERE mi.machine_id IN
             (SELECT id FROM machines WHERE job_id=j.id LIMIT 1) LIMIT 1) AS thumb
    FROM jobs j ${where}
    ORDER BY j.created_at DESC LIMIT ${limit} OFFSET ${offset}
  `).bind(...params).all<any>()

  return c.json(results.map((r: any) => ({
    ...r,
    balance_due: Math.max(0, (r.total_charges || 0) - (r.discount || 0) - (r.received_amount || 0))
  })))
})

// ── API: Jobs — pending payment filter
// v50.1: Include ALL jobs (including delivered) with unpaid balance
app.get('/api/jobs/pending-payment', authMiddleware, async (c) => {
  const role = c.get('userRole')
  const isAdminRole = roleLevel(role) >= 2
  if (!isAdminRole) return c.json({ error: 'Forbidden' }, 403)
  const search = c.req.query('q') || ''
  const conds: string[] = []
  const params: any[] = []
  if (search) {
    conds.push('(j.snap_name LIKE ? OR j.snap_mobile LIKE ? OR j.id LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  const where = `WHERE ${conds.join(' AND ')}`
  const { results } = await c.env.DB.prepare(`
    SELECT * FROM (
      SELECT j.id, j.snap_name, j.snap_mobile, j.status,
             j.received_amount, j.discount, j.extra_charges, j.extra_charges_note, j.created_at, j.updated_at,
             (SELECT COALESCE(SUM(quantity),0) FROM machines WHERE job_id=j.id) AS machine_count,
             COALESCE((SELECT SUM(charges * quantity) FROM machines WHERE job_id=j.id AND status != 'returned'),0) + COALESCE(j.extra_charges, 0) AS total_charges,
             (SELECT url FROM machine_images mi
              JOIN machines m2 ON mi.machine_id=m2.id
              WHERE m2.job_id=j.id ORDER BY mi.id LIMIT 1) AS thumb
      FROM jobs j ${where}
    ) sub WHERE sub.total_charges > 0 AND (sub.total_charges - COALESCE(sub.discount,0) - COALESCE(sub.received_amount,0)) > 0
    ORDER BY sub.created_at DESC LIMIT 500
  `).bind(...params).all<any>()
  return c.json(results.map((r: any) => ({
    ...r,
    balance_due: Math.max(0, (r.total_charges || 0) - (r.discount || 0) - (r.received_amount || 0))
  })))
})

// ── API: Jobs — create ────────────────────────────────────────────────────────
app.post('/api/jobs', authMiddleware, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { customer_name, customer_mobile } = body
  if (!customer_name || !customer_mobile)
    return c.json({ error: 'customer_name and customer_mobile are required' }, 400)

  // v52: ATOMIC counter — single UPDATE...RETURNING prevents race conditions when
  // two admins create jobs simultaneously. No separate read needed.
  const category = body.customer_category || 'Salon'
  const [counterResult, , prefixSetting, digitsSetting] = await Promise.all([
    c.env.DB.prepare('UPDATE job_counter SET last_seq=last_seq+1 WHERE id=1 RETURNING last_seq').first<any>(),
    c.env.DB.prepare(
      `INSERT INTO customers(name,mobile,mobile2,address,category,dispatch_method) VALUES(?,?,?,?,?,?)
       ON CONFLICT(mobile) DO UPDATE SET
         name=excluded.name, mobile2=excluded.mobile2,
         address=excluded.address, category=excluded.category,
         dispatch_method=excluded.dispatch_method, updated_at=datetime('now')`
    ).bind(customer_name, customer_mobile,
           body.customer_mobile2 || null, body.customer_address || null, category,
           body.dispatch_method === 'courier' ? 'courier' : 'in_person').run(),
    c.env.DB.prepare("SELECT value FROM app_settings WHERE key='job_prefix'").first<any>(),
    c.env.DB.prepare("SELECT value FROM app_settings WHERE key='job_seq_digits'").first<any>(),
  ])
  // Customer ID lookup (depends on upsert above)
  const cust = await c.env.DB.prepare('SELECT id FROM customers WHERE mobile=?').bind(customer_mobile).first<any>()
  const prefix = prefixSetting?.value || 'C'
  const digits = parseInt(digitsSetting?.value || '3')
  const seqNum = counterResult?.last_seq || 1
  const jobId = `${prefix}-${String(seqNum).padStart(digits, '0')}`

  const isAdminCreate = roleLevel(c.get('userRole')) >= 2
  const dispatchMethod = body.dispatch_method === 'courier' ? 'courier' : 'in_person'
  const dispatchCourierName = dispatchMethod === 'courier' ? (body.dispatch_courier_name || null) : null
  // Step 3: Insert job (single query)
  await c.env.DB.prepare(
    `INSERT INTO jobs(id,customer_id,snap_name,snap_mobile,snap_mobile2,
                      snap_address,snap_category,note,received_amount,dispatch_method,dispatch_courier_name)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(jobId, cust.id, customer_name, customer_mobile,
         body.customer_mobile2 || null, body.customer_address || null,
         category, body.note || null,
         isAdminCreate ? (body.received_amount || 0) : 0,
         dispatchMethod, dispatchCourierName).run()

  // v45: Return immediately — construct job object in-memory (skip SELECT)
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
  const job = {
    id: jobId, customer_id: cust.id, snap_name: customer_name,
    snap_mobile: customer_mobile, snap_mobile2: body.customer_mobile2 || null,
    snap_address: body.customer_address || null, snap_category: category,
    note: body.note || null, status: 'under_repair',
    received_amount: isAdminCreate ? (body.received_amount || 0) : 0,
    discount: 0, payment_method: null,
    dispatch_method: dispatchMethod, dispatch_courier_name: dispatchCourierName,
    created_at: now, updated_at: now, delivered_at: null
  }
  // Fire-and-forget history logging
  logHistoryAsync(c.env.DB, jobId, 'Job Created',
    `Customer: ${customer_name} (${customer_mobile})${body.note ? ' | Note: ' + body.note : ''}${dispatchMethod === 'courier' ? ' | Dispatch: Courier' + (dispatchCourierName ? ' (' + dispatchCourierName + ')' : '') : ''}`,
    c.get('userName') || 'System', c.get('userRole') || 'admin')
  return c.json(job, 201)
})
// ── API: Delivered jobs with filters (date range, delivery type) ─────────────
// MUST be registered BEFORE /api/jobs/:id to avoid route conflict
app.get('/api/jobs/delivered', authMiddleware, async (c) => {
  const role = c.get('userRole')
  const isAdminRole = roleLevel(role) >= 2
  if (!isAdminRole) return c.json({ error: 'Forbidden' }, 403)
  const from     = c.req.query('from') || ''
  const to       = c.req.query('to')   || ''
  const method   = c.req.query('method') || ''
  const search   = c.req.query('q') || ''
  const conds: string[] = ["j.status='delivered'"]
  const params: any[] = []
  if (from) { conds.push('DATE(j.delivered_at)>=?'); params.push(from) }
  if (to)   { conds.push('DATE(j.delivered_at)<=?'); params.push(to) }
  if (method && (method === 'in_person' || method === 'courier')) {
    conds.push('j.delivery_method=?'); params.push(method)
  }
  if (search) {
    conds.push('(j.snap_name LIKE ? OR j.snap_mobile LIKE ? OR j.id LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  const where = `WHERE ${conds.join(' AND ')}`
  const { results } = await c.env.DB.prepare(`
    SELECT j.id, j.snap_name, j.snap_mobile, j.status,
           j.received_amount, j.delivered_at, j.delivery_method,
           j.delivery_receiver_name, j.delivery_courier_name, j.extra_charges, j.extra_charges_note,
           (SELECT COALESCE(SUM(quantity),0) FROM machines WHERE job_id=j.id) AS machine_count,
           (SELECT SUM(charges * quantity) FROM machines WHERE job_id=j.id AND status != 'returned') + COALESCE(j.extra_charges, 0) AS total_charges
    FROM jobs j ${where}
    ORDER BY j.delivered_at DESC LIMIT 500
  `).bind(...params).all<any>()
  return c.json(results.map((r: any) => ({
    ...r,
    balance_due: Math.max(0, (r.total_charges || 0) - (r.discount || 0) - (r.received_amount || 0))
  })))
})

app.get('/api/jobs/:id', authMiddleware, async (c) => {
  const id  = c.req.param('id')

  // v43: PARALLEL queries — job + machines fetched simultaneously (saves ~50% latency)
  const [job, { results: machines }] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<any>(),
    c.env.DB.prepare(`
      SELECT m.*,
             u.name AS staff_name,
             (SELECT json_group_array(
               json_object('id',mi.id,'url',mi.url,'r2_object_key',mi.r2_object_key)
             ) FROM machine_images mi WHERE mi.machine_id=m.id) AS images_json
      FROM machines m
      LEFT JOIN users u ON m.assigned_staff_id=u.id
      WHERE m.job_id=?
      ORDER BY m.id
    `).bind(id).all<any>()
  ])

  if (!job) return c.json({ error: 'Not found' }, 404)

  const role2 = c.get('userRole')
  const isAdmin = roleLevel(role2) >= 2

  // v52.11: Staff CAN view delivered jobs if they have assigned machines
  // (Previously blocked all delivered job views for staff, causing "Failed to load job"
  //  when staff clicked repaired machines from Daily Repair Report)
  if (!isAdmin && job.status === 'delivered') {
    const userId = c.get('userId')
    const hasAssigned = machines.some((m: any) => String(m.assigned_staff_id) === String(userId))
    if (!hasAssigned) return c.json({ error: 'Forbidden' }, 403)
  }

  const enriched = machines.map((m: any) => ({
    ...m,
    images: (() => { try { return JSON.parse(m.images_json || '[]') } catch { return [] } })()
  }))
  const machineCharges = enriched.reduce((s: number, m: any) => {
    if (m.status === 'returned') return s;
    return s + ((parseFloat(m.charges) || 0) * (parseInt(m.quantity) || 1));
  }, 0)
  const extraCharges = parseFloat(job.extra_charges) || 0
  const totalCharges = machineCharges + extraCharges

  return c.json({
    ...job,
    machines: enriched,
    total_charges: totalCharges,
    balance_due: Math.max(0, totalCharges - (job.discount || 0) - (job.received_amount || 0))
  })
})

// ── API: Jobs — update ────────────────────────────────────────────────────────
app.put('/api/jobs/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const role = c.get('userRole')
  const isAdmin = roleLevel(role) >= 2
  if (!isAdmin) return c.json({ error: 'Forbidden' }, 403)

  const fields: string[] = []
  const vals: any[] = []
  const allowed = [
    'note', 'status',
    'delivery_method', 'delivery_receiver_name', 'delivery_receiver_mobile',
    'delivery_courier_name', 'delivery_tracking', 'delivery_address',
    'dispatch_method', 'dispatch_courier_name',
    'snap_name', 'snap_mobile', 'snap_mobile2', 'snap_address', 'snap_category',
    'received_amount', 'discount', 'payment_method',
    'extra_charges', 'extra_charges_note', 'delivery_rating'
  ]
  // Also update customer table when snap fields change
  if (body.snap_name || body.snap_mobile || body.snap_address) {
    const currentJob = await c.env.DB.prepare('SELECT customer_id,snap_mobile FROM jobs WHERE id=?').bind(id).first<any>()
    if (currentJob?.customer_id) {
      const custFields: string[] = []
      const custVals: any[] = []
      if (body.snap_name) { custFields.push('name=?'); custVals.push(body.snap_name) }
      if (body.snap_mobile) { custFields.push('mobile=?'); custVals.push(body.snap_mobile) }
      if (body.snap_mobile2 !== undefined) { custFields.push('mobile2=?'); custVals.push(body.snap_mobile2 || null) }
      if (body.snap_address !== undefined) { custFields.push('address=?'); custVals.push(body.snap_address || null) }
      if (custFields.length) {
        custFields.push(`updated_at=datetime('now')`)
        custVals.push(currentJob.customer_id)
        await c.env.DB.prepare(`UPDATE customers SET ${custFields.join(',')} WHERE id=?`).bind(...custVals).run().catch(() => {})
      }
    }
  }
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); vals.push(body[k]) }
  }
  // v49.9: Support custom delivery date — use provided date or default to now
  if (body.status === 'delivered' || body.status === 'partial_delivered') {
    if (body.delivered_at) {
      fields.push(`delivered_at=?`); vals.push(body.delivered_at)
    } else {
      fields.push(`delivered_at=datetime('now')`)
    }
  }
  if (!fields.length) return c.json({ error: 'No fields to update' }, 400)
  fields.push(`updated_at=datetime('now')`)
  vals.push(id)
  // v52: Optimistic concurrency — if client sends _updated_at, verify it matches
  // before writing. Prevents two admins overwriting each other silently.
  if (body._updated_at) {
    vals.push(body._updated_at)
    const result = await c.env.DB.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id=? AND updated_at=?`).bind(...vals).run()
    if (result.meta?.changes === 0) {
      // Row may have been updated by another admin — re-read
      const current = await c.env.DB.prepare('SELECT updated_at FROM jobs WHERE id=?').bind(id).first<any>()
      if (current) return c.json({ error: 'Conflict — job was updated by another user. Please refresh and try again.', code: 'CONFLICT' }, 409)
      return c.json({ error: 'Job not found' }, 404)
    }
  } else {
    await c.env.DB.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  }
  // Log history for ALL update types
  const uName = c.get('userName') || 'Admin'
  const uRole = c.get('userRole') || 'admin'
  if (body.status) {
    const detail = body.status === 'delivered'
      ? `Delivered to: ${body.delivery_receiver_name || 'Customer'} via ${body.delivery_method || 'in_person'}${body.delivery_courier_name ? ' (' + body.delivery_courier_name + ')' : ''}${body.delivery_tracking ? ' Tracking: ' + body.delivery_tracking : ''}`
      : `Status changed to ${body.status}`
    logHistory(c.env.DB, id, `Status: ${body.status}`, detail, uName, uRole)
  }
  if ('received_amount' in body) {
    logHistory(c.env.DB, id, 'Payment Updated', `Received amount: ₹${body.received_amount}${body.payment_method ? ' ('+body.payment_method+')' : ''}`, uName, uRole)
  }
  if ('discount' in body) {
    logHistory(c.env.DB, id, 'Discount Updated', `Discount: ₹${body.discount}`, uName, uRole)
  }
  if ('extra_charges' in body) {
    logHistory(c.env.DB, id, 'Extra Charges Updated', `Extra charges: ₹${body.extra_charges}${body.extra_charges_note ? ' (' + body.extra_charges_note + ')' : ''}`, uName, uRole)
  }
  if (body.snap_name || body.snap_mobile || body.snap_address) {
    logHistory(c.env.DB, id, 'Customer Info Updated', `Name: ${body.snap_name || '—'}, Mobile: ${body.snap_mobile || '—'}`, uName, uRole)
  }
  if (body.note !== undefined) {
    logHistory(c.env.DB, id, 'Note Updated', body.note || '(cleared)', uName, uRole)
  }
  return c.json({ ok: true })
})

// ── API: Jobs — delete (admin only) — NEVER deletes customer data ────────────
app.delete('/api/jobs/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  const { results: imgs } = await c.env.DB.prepare(
    `SELECT mi.r2_object_key FROM machine_images mi
     JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=?`
  ).bind(id).all<any>()
  for (const img of imgs) {
    if (img.r2_object_key) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
  }
  const { results: audioMachines } = await c.env.DB.prepare(
    'SELECT audio_note_key FROM machines WHERE job_id=? AND audio_note_key IS NOT NULL'
  ).bind(id).all<any>()
  for (const m of audioMachines) {
    try { await c.env.PRODUCT_IMAGES.delete(m.audio_note_key) } catch (_) {}
  }
  await c.env.DB.prepare('DELETE FROM job_history WHERE job_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM assignment_requests WHERE job_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machine_images WHERE machine_id IN (SELECT id FROM machines WHERE job_id=?)').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machines WHERE job_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()
  // NOTE: Customer data is NEVER deleted — only job+machine data
  return c.json({ ok: true })
})

// ── API: Machines — create ────────────────────────────────────────────────────
app.post('/api/jobs/:id/machines', authMiddleware, async (c) => {
  const jobId = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  if (!body.product_name) return c.json({ error: 'product_name required' }, 400)
  const isAdminOrMgr = roleLevel(c.get('userRole')) >= 2
  const charges = isAdminOrMgr ? (parseFloat(body.charges) || 0) : 0
  const qty = parseInt(body.quantity) || 1
  const warrantyType = body.warranty_type || 'out_warranty'
  const warrantyBrand = warrantyType === 'warranty' ? (body.warranty_brand || null) : null
  // v48: warranty purchase fields
  const purchasedFrom = warrantyType === 'warranty' ? (body.purchased_from || null) : null
  const purchaseInvoiceNo = warrantyType === 'warranty' ? (body.purchase_invoice_no || null) : null
  const purchaseDate = warrantyType === 'warranty' ? (body.purchase_date || null) : null
  // v45: INSERT is the only blocking query — return machineId ASAP
  const result = await c.env.DB.prepare(
    `INSERT INTO machines(job_id,product_name,product_complaint,charges,quantity,assigned_staff_id,status,warranty_type,warranty_brand,purchased_from,purchase_invoice_no,purchase_date)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    jobId, body.product_name, body.product_complaint || null,
    charges, qty,
    body.assigned_staff_id || null,
    'under_repair',
    warrantyType, warrantyBrand,
    purchasedFrom, purchaseInvoiceNo, purchaseDate
  ).run()
  const machineId = result.meta.last_row_id
  // v45: Return IMMEDIATELY — defer status update + history to background
  const uName = c.get('userName') || 'System'
  const uRole = c.get('userRole') || 'admin'
  const lineTotal = charges * qty
  const warrantyInfo = warrantyType === 'warranty' && warrantyBrand ? ` | Warranty: ${warrantyBrand}` : ''
  // Use waitUntil so the response is sent before these complete
  c.executionCtx.waitUntil(Promise.all([
    updateJobStatus(c.env.DB, jobId, uName, uRole),
    logHistory(c.env.DB, jobId, 'Machine Added', `${body.product_name}${qty > 1 ? ' ×' + qty : ''}${body.product_complaint ? ' — ' + body.product_complaint : ''}${charges > 0 ? ' | ₹' + lineTotal : ''}${warrantyInfo}${body.assigned_staff_id ? ' | Assigned staff ID: ' + body.assigned_staff_id : ''}`, uName, uRole)
  ]).catch(() => {}))
  return c.json({ id: machineId }, 201)
})

// ── API: Batch Machine Status Update ─────────────────────────────────────────
// IMPORTANT: Must be registered BEFORE /api/machines/:id to avoid route conflict
// Allows updating multiple machines at once (e.g. mark 9 machines as repaired)
app.put('/api/machines/batch-status', authMiddleware, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { machine_ids, status, work_done, return_reason, delivery_method, delivery_receiver_name, delivery_courier_name } = body
  if (!machine_ids || !Array.isArray(machine_ids) || !machine_ids.length)
    return c.json({ error: 'machine_ids array required' }, 400)
  if (!status || !['under_repair','repaired','returned','delivered'].includes(status))
    return c.json({ error: 'Invalid status' }, 400)
  if (machine_ids.length > 50) return c.json({ error: 'Max 50 machines at once' }, 400)

  const role = c.get('userRole')
  const isAdm = roleLevel(role) >= 2
  const userId = c.get('userId')
  const userName = c.get('userName') || (isAdm ? 'Admin' : 'Staff')
  const userRole = c.get('userRole') || 'staff'

  // Fetch all machines to validate
  const placeholders = machine_ids.map(() => '?').join(',')
  const { results: machines } = await c.env.DB.prepare(
    `SELECT id, job_id, product_name, status, assigned_staff_id FROM machines WHERE id IN (${placeholders})`
  ).bind(...machine_ids).all<any>()
  if (!machines.length) return c.json({ error: 'No machines found' }, 404)

  // Check permissions for non-admin: must be assigned or have update_machine_status right
  if (!isAdm) {
    const canUpdate = hasRight(c, 'update_machine_status')
    for (const m of machines) {
      if (m.assigned_staff_id !== userId && !canUpdate)
        return c.json({ error: `Not assigned to machine ${m.product_name} (ID ${m.id})` }, 403)
    }
  }

  // Build batch update
  const jobIds = new Set<string>()
  for (const m of machines) {
    const extraFields: string[] = []
    const extraVals: any[] = []
    if (status === 'repaired' && work_done) { extraFields.push('work_done=?'); extraVals.push(work_done) }
    if (status === 'returned' && return_reason) { extraFields.push('return_reason=?'); extraVals.push(return_reason) }
    if (status === 'delivered') {
      extraFields.push('delivery_method=?');        extraVals.push(delivery_method || 'in_person')
      extraFields.push('delivery_receiver_name=?'); extraVals.push(delivery_receiver_name || null)
      extraFields.push('delivery_courier_name=?');  extraVals.push(delivery_courier_name || null)
      extraFields.push("delivered_at=datetime('now')")
    }
    const setClause = ['status=?', ...extraFields, `updated_at=datetime('now')`].join(',')
    await c.env.DB.prepare(`UPDATE machines SET ${setClause} WHERE id=?`)
      .bind(status, ...extraVals, m.id).run()
    jobIds.add(m.job_id)

    // Log history per machine
    const detail = status === 'repaired' && work_done
      ? `${m.product_name} → Repaired. Work: ${work_done}`
      : status === 'returned' && return_reason
      ? `${m.product_name} → Returned. Reason: ${return_reason}`
      : status === 'delivered'
      ? `${m.product_name} → Delivered (${delivery_method === 'courier' ? 'Courier' : 'In Person'}${delivery_receiver_name ? ' to ' + delivery_receiver_name : ''})`
      : `${m.product_name} → ${status}`
    logHistory(c.env.DB, m.job_id, `Machine: ${status}`, detail, userName, userRole)
  }

  // Update job statuses for all affected jobs
  for (const jobId of jobIds) {
    await updateJobStatus(c.env.DB, jobId, userName, userRole)
  }

  // Log batch action
  const names = machines.map((m: any) => m.product_name).join(', ')
  for (const jobId of jobIds) {
    logHistory(c.env.DB, jobId, `Batch: ${status}`, `Batch updated ${machines.length} machines to ${status}: ${names}`, userName, userRole)
  }

  return c.json({ ok: true, updated: machines.length })
})

// ── API: Machines — update ────────────────────────────────────────────────────
app.put('/api/machines/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const role    = c.get('userRole')
  const isAdmin = roleLevel(role) >= 2
  const userId  = c.get('userId')
  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(id).first<any>()
  if (!machine) return c.json({ error: 'Not found' }, 404)

  // Staff can only update status if they are the assigned_staff OR have update_machine_status right
  if (!isAdmin) {
    const canUpdateStatus = hasRight(c, 'update_machine_status')
    if (machine.assigned_staff_id !== userId && !canUpdateStatus)
      return c.json({ error: 'Not assigned to this machine' }, 403)
    if ('status' in body) {
      const extraFields: string[] = []
      const extraVals: any[] = []
      if ('work_done' in body)    { extraFields.push('work_done=?');    extraVals.push(body.work_done) }
      if ('return_reason' in body){ extraFields.push('return_reason=?'); extraVals.push(body.return_reason) }
      // v34: machine-level delivery fields
      if (body.status === 'delivered') {
        extraFields.push('delivery_method=?');        extraVals.push(body.delivery_method || 'in_person')
        extraFields.push('delivery_receiver_name=?'); extraVals.push(body.delivery_receiver_name || null)
        extraFields.push('delivery_courier_name=?');  extraVals.push(body.delivery_courier_name || null)
        extraFields.push("delivered_at=datetime('now')")
      }
      const setClause = ['status=?', ...extraFields, `updated_at=datetime('now')`].join(',')
      await c.env.DB.prepare(`UPDATE machines SET ${setClause} WHERE id=?`)
        .bind(body.status, ...extraVals, id).run()
      const staffName = c.get('userName') || 'Staff'
      const staffRole = c.get('userRole') || 'staff'
      await updateJobStatus(c.env.DB, machine.job_id, staffName, staffRole)
      // Log history: machine status change
      const detail = body.status === 'repaired' && body.work_done
        ? `${machine.product_name} \u2192 Repaired. Work: ${body.work_done}`
        : body.status === 'returned' && body.return_reason
        ? `${machine.product_name} \u2192 Returned. Reason: ${body.return_reason}`
        : body.status === 'delivered'
        ? `${machine.product_name} \u2192 Delivered (${body.delivery_method === 'courier' ? 'Courier' : 'In Person'}${body.delivery_receiver_name ? ' to ' + body.delivery_receiver_name : ''})`
        : `${machine.product_name} \u2192 ${body.status}`
      logHistory(c.env.DB, machine.job_id, `Machine: ${body.status}`, detail, staffName, staffRole)
      return c.json({ ok: true })
    }
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const fields: string[] = []
  const vals: any[] = []
  const allowed = ['product_name','product_complaint','quantity','assigned_staff_id','status','charges','work_done','return_reason','warranty_type','warranty_brand','purchased_from','purchase_invoice_no','purchase_date','delivery_method','delivery_receiver_name','delivery_courier_name']
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); vals.push(body[k]) }
  }
  // v49: Clear purchase fields when switching to out_warranty
  if (body.warranty_type === 'out_warranty') {
    if (!fields.some(f => f.startsWith('purchased_from'))) { fields.push('purchased_from=?'); vals.push(null) }
    if (!fields.some(f => f.startsWith('purchase_invoice_no'))) { fields.push('purchase_invoice_no=?'); vals.push(null) }
    if (!fields.some(f => f.startsWith('purchase_date'))) { fields.push('purchase_date=?'); vals.push(null) }
  }
  if (!fields.length) return c.json({ error: 'Nothing to update' }, 400)
  // v34: set delivered_at timestamp for machine-level delivery
  if (body.status === 'delivered') fields.push(`delivered_at=datetime('now')`)
  fields.push(`updated_at=datetime('now')`)
  vals.push(id)
  await c.env.DB.prepare(`UPDATE machines SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  const adminName = c.get('userName') || 'Admin'
  const adminRole = c.get('userRole') || 'admin'
  await updateJobStatus(c.env.DB, machine.job_id, adminName, adminRole)
  // Log history for ALL admin machine changes
  const changes: string[] = []
  if (body.status) changes.push(`Status → ${body.status}`)
  if (body.product_name && body.product_name !== machine.product_name) changes.push(`Name: ${body.product_name}`)
  if (body.charges !== undefined) changes.push(`Charges: ₹${body.charges}`)
  if (body.assigned_staff_id !== undefined) changes.push(`Staff assigned: ID ${body.assigned_staff_id}`)
  if (body.work_done) changes.push(`Work: ${body.work_done}`)
  if (body.return_reason) changes.push(`Return reason: ${body.return_reason}`)
  if (body.warranty_type) changes.push(`Warranty: ${body.warranty_type}${body.warranty_brand ? ' ('+body.warranty_brand+')' : ''}`)
  const editDetail = changes.length ? `${machine.product_name}: ${changes.join(', ')}` : `${machine.product_name} edited`
  logHistory(c.env.DB, machine.job_id, body.status ? `Machine: ${body.status}` : 'Machine Edited', editDetail, adminName, adminRole)
  return c.json({ ok: true })
})

app.delete('/api/machines/:id', authMiddleware, adminOnly, async (c) => {
  const id      = c.req.param('id')
  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(id).first<any>()
  if (!machine) return c.json({ error: 'Not found' }, 404)
  const { results: imgs } = await c.env.DB.prepare(
    'SELECT r2_object_key FROM machine_images WHERE machine_id=?'
  ).bind(id).all<any>()
  for (const img of imgs) {
    if (img.r2_object_key) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
  }
  if (machine.audio_note_key) try { await c.env.PRODUCT_IMAGES.delete(machine.audio_note_key) } catch (_) {}
  await c.env.DB.prepare('DELETE FROM assignment_requests WHERE machine_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machines WHERE id=?').bind(id).run()
  if (machine) await updateJobStatus(c.env.DB, machine.job_id)
  return c.json({ ok: true })
})

// ── API: Images ───────────────────────────────────────────────────────────────
// Upload image — any authenticated user
app.post('/api/machines/:id/images', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const machine   = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)

  // Staff can only upload to their assigned machines
  const role = c.get('userRole')
  const isAdmin = roleLevel(role) >= 2
  if (!isAdmin && machine.assigned_staff_id !== c.get('userId'))
    return c.json({ error: 'Not assigned to this machine' }, 403)

  const formData = await c.req.formData()
  const file     = formData.get('image') as File | null
  if (!file) return c.json({ error: 'No image field' }, 400)
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `machines/${machineId}/${Date.now()}-${safeFilename}`
  await c.env.PRODUCT_IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' }
  })
  const url = `/api/images/${key}`
  await c.env.DB.prepare(
    'INSERT INTO machine_images(machine_id,r2_object_key,url) VALUES(?,?,?)'
  ).bind(machineId, key, url).run()
  return c.json({ url, key }, 201)
})

// v48: Upload warranty invoice image — stored in R2 under brand-named folders
app.post('/api/machines/:id/invoice-image', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)
  const role = c.get('userRole')
  const isAdm = roleLevel(role) >= 2
  if (!isAdm && machine.assigned_staff_id !== c.get('userId'))
    return c.json({ error: 'Not assigned to this machine' }, 403)
  const formData = await c.req.formData()
  const file = formData.get('invoice') as File | null
  if (!file) return c.json({ error: 'No invoice field' }, 400)
  // Delete old invoice if exists
  if (machine.invoice_image_key) {
    try { await c.env.PRODUCT_IMAGES.delete(machine.invoice_image_key) } catch (_) {}
  }
  // Store under brand-named folder: invoices/{brand_lowercase}/{machineId}/{timestamp}-{filename}
  const brand = (machine.warranty_brand || 'other').toLowerCase().replace(/[^a-z0-9]/g, '_')
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `invoices/${brand}/${machineId}/${Date.now()}-${safeFilename}`
  await c.env.PRODUCT_IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' }
  })
  const url = `/api/images/${key}`
  await c.env.DB.prepare(
    `UPDATE machines SET invoice_image_key=?, invoice_image_url=?, updated_at=datetime('now') WHERE id=?`
  ).bind(key, url, machineId).run()
  return c.json({ url, key }, 201)
})

// v49.3: Delete warranty invoice image
app.delete('/api/machines/:id/invoice-image', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)
  const role = c.get('userRole')
  const isAdm = roleLevel(role) >= 2
  if (!isAdm && machine.assigned_staff_id !== c.get('userId'))
    return c.json({ error: 'Not assigned to this machine' }, 403)
  if (machine.invoice_image_key) {
    try { await c.env.PRODUCT_IMAGES.delete(machine.invoice_image_key) } catch (_) {}
  }
  await c.env.DB.prepare(
    `UPDATE machines SET invoice_image_key=NULL, invoice_image_url=NULL, updated_at=datetime('now') WHERE id=?`
  ).bind(machineId).run()
  return c.json({ ok: true })
})

// Serve image from R2 — authenticated, CORS headers for html2canvas
app.get('/api/images/*', authMiddleware, async (c) => {
  const key = c.req.path.slice('/api/images/'.length)
  const obj = await c.env.PRODUCT_IMAGES.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }
  })
})

// Delete image — admin only
app.delete('/api/images/:imageId', authMiddleware, adminOnly, async (c) => {
  const imageId = c.req.param('imageId')
  const img     = await c.env.DB.prepare('SELECT * FROM machine_images WHERE id=?').bind(imageId).first<any>()
  if (!img) return c.json({ error: 'Not found' }, 404)
  if (img.r2_object_key) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
  await c.env.DB.prepare('DELETE FROM machine_images WHERE id=?').bind(imageId).run()
  return c.json({ ok: true })
})

// ── API: Audio Notes ──────────────────────────────────────────────────────────
// Upload audio — admin & staff
app.post('/api/machines/:id/audio', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const machine   = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)

  const role = c.get('userRole')
  const isAdmin = roleLevel(role) >= 2
  if (!isAdmin && machine.assigned_staff_id !== c.get('userId'))
    return c.json({ error: 'Not assigned to this machine' }, 403)

  const formData = await c.req.formData()
  const file     = formData.get('audio') as File | null
  if (!file) return c.json({ error: 'No audio field' }, 400)

  // Delete old audio if exists
  if (machine.audio_note_key) {
    try { await c.env.PRODUCT_IMAGES.delete(machine.audio_note_key) } catch (_) {}
  }

  const ext = file.type.includes('ogg') ? '.ogg' : file.type.includes('mp4') ? '.m4a' : '.webm'
  const key = `audio/${machineId}/${Date.now()}${ext}`
  await c.env.PRODUCT_IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'audio/webm' }
  })
  const url = `/api/audio/${key}`
  await c.env.DB.prepare(
    `UPDATE machines SET audio_note_key=?,audio_note_url=?,updated_at=datetime('now') WHERE id=?`
  ).bind(key, url, machineId).run()
  return c.json({ url, key }, 201)
})

// Serve audio from R2
app.get('/api/audio/*', authMiddleware, async (c) => {
  const key = c.req.path.slice('/api/audio/'.length)
  const obj = await c.env.PRODUCT_IMAGES.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'audio/webm',
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    }
  })
})

// Delete audio — admin only
app.delete('/api/machines/:id/audio', authMiddleware, adminOnly, async (c) => {
  const machineId = c.req.param('id')
  const machine   = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Not found' }, 404)
  if (machine.audio_note_key)
    try { await c.env.PRODUCT_IMAGES.delete(machine.audio_note_key) } catch (_) {}
  await c.env.DB.prepare(
    `UPDATE machines SET audio_note_key=NULL,audio_note_url=NULL WHERE id=?`
  ).bind(machineId).run()
  return c.json({ ok: true })
})

// ── API: Assignment Requests ──────────────────────────────────────────────────
app.post('/api/requests', authMiddleware, async (c) => {
  if (c.get('userRole') === 'admin') return c.json({ error: 'Admins do not need to request' }, 400)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { machine_id, note } = body
  if (!machine_id) return c.json({ error: 'machine_id required' }, 400)

  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machine_id).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)

  const existing = await c.env.DB.prepare(
    `SELECT id FROM assignment_requests WHERE machine_id=? AND staff_id=? AND status='pending'`
  ).bind(machine_id, c.get('userId')).first<any>()
  if (existing) return c.json({ error: 'Request already pending' }, 409)

  const result = await c.env.DB.prepare(
    `INSERT INTO assignment_requests(machine_id,job_id,staff_id,note) VALUES(?,?,?,?)`
  ).bind(machine_id, machine.job_id, c.get('userId'), note || null).run()

  return c.json({ id: result.meta.last_row_id, status: 'pending' }, 201)
})

app.get('/api/requests', authMiddleware, adminOnly, async (c) => {
  const status = c.req.query('status') || 'pending'
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, u.name AS staff_name, u.email AS staff_email,
           m.product_name, m.product_complaint, m.job_id
    FROM assignment_requests r
    JOIN users u    ON r.staff_id   = u.id
    JOIN machines m ON r.machine_id = m.id
    WHERE r.status=?
    ORDER BY r.created_at DESC
    LIMIT 100
  `).bind(status).all<any>()
  return c.json(results)
})

// Admin: count pending requests (for badge)
app.get('/api/requests/count', authMiddleware, adminOnly, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM assignment_requests WHERE status='pending'`
  ).first<any>()
  return c.json({ count: row?.cnt || 0 })
})

app.put('/api/requests/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { action } = body
  if (!['approve','deny'].includes(action)) return c.json({ error: 'action must be approve or deny' }, 400)

  const req = await c.env.DB.prepare('SELECT * FROM assignment_requests WHERE id=?').bind(id).first<any>()
  if (!req) return c.json({ error: 'Not found' }, 404)
  if (req.status !== 'pending') return c.json({ error: 'Already resolved' }, 409)

  const newStatus = action === 'approve' ? 'approved' : 'denied'
  await c.env.DB.prepare(
    `UPDATE assignment_requests SET status=?,resolved_at=datetime('now') WHERE id=?`
  ).bind(newStatus, id).run()

  if (action === 'approve') {
    await c.env.DB.prepare(
      `UPDATE machines SET assigned_staff_id=?,updated_at=datetime('now') WHERE id=?`
    ).bind(req.staff_id, req.machine_id).run()
    await c.env.DB.prepare(
      `UPDATE assignment_requests SET status='denied',resolved_at=datetime('now')
       WHERE machine_id=? AND status='pending' AND id!=?`
    ).bind(req.machine_id, id).run()
  }

  return c.json({ ok: true, status: newStatus })
})

app.get('/api/my-requests', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, m.product_name, m.job_id
    FROM assignment_requests r
    JOIN machines m ON r.machine_id = m.id
    WHERE r.staff_id=?
    ORDER BY r.created_at DESC
    LIMIT 50
  `).bind(c.get('userId')).all<any>()
  return c.json(results)
})

// Staff: get recent assignment notifications (approved/denied in last 7 days)
app.get('/api/my-notifications', authMiddleware, async (c) => {
  try {
    // v52.7: Ensure staff_read_at column exists (lazy migration)
    await c.env.DB.prepare(
      `ALTER TABLE assignment_requests ADD COLUMN staff_read_at TEXT`
    ).run().catch(() => {}) // Ignore if column already exists

    // v52.7: Only return UNREAD notifications (staff_read_at IS NULL)
    const { results } = await c.env.DB.prepare(`
      SELECT r.id, r.status, r.created_at, r.resolved_at, r.job_id,
             m.product_name
      FROM assignment_requests r
      JOIN machines m ON r.machine_id = m.id
      WHERE r.staff_id=? AND r.status IN ('approved','denied')
        AND r.resolved_at >= datetime('now','-7 days')
        AND r.staff_read_at IS NULL
      ORDER BY r.resolved_at DESC
      LIMIT 10
    `).bind(c.get('userId')).all<any>()
    return c.json(results || [])
  } catch (_) {
    return c.json([])
  }
})

// v52.7: Dismiss/mark staff notifications as read — prevents re-appearing on refresh
app.post('/api/my-notifications/dismiss', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId')
    const body = await c.req.json<{ ids?: number[] }>()

    // Ensure column exists
    await c.env.DB.prepare(
      `ALTER TABLE assignment_requests ADD COLUMN staff_read_at TEXT`
    ).run().catch(() => {})

    if (body.ids && body.ids.length > 0) {
      // Dismiss specific notifications by ID
      const placeholders = body.ids.map(() => '?').join(',')
      await c.env.DB.prepare(
        `UPDATE assignment_requests SET staff_read_at=datetime('now')
         WHERE id IN (${placeholders}) AND staff_id=?`
      ).bind(...body.ids, userId).run()
    } else {
      // Dismiss ALL unread notifications for this staff
      await c.env.DB.prepare(
        `UPDATE assignment_requests SET staff_read_at=datetime('now')
         WHERE staff_id=? AND status IN ('approved','denied')
           AND staff_read_at IS NULL`
      ).bind(userId).run()
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Job history endpoint — returns audit log for a job
// v50.1: If no explicit history rows, synthesize timeline from job + machines data
app.get('/api/jobs/:id/history', authMiddleware, async (c) => {
  const jobId = c.req.param('id')
  try {
    // Ensure job_history table exists (lazy create — critical for deployed model)
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS job_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        user_name TEXT,
        user_role TEXT,
        user_id INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run()
    await c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_jh_job ON job_history(job_id)`).run().catch(() => {})
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM job_history WHERE job_id=? ORDER BY created_at DESC LIMIT 200
    `).bind(jobId).all<any>()

    // v50.1: If we have real history entries, return them
    if (results && results.length > 0) return c.json(results)

    // Synthesize history from job + machines data for older jobs without history
    const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>()
    if (!job) return c.json([])
    const { results: machines } = await c.env.DB.prepare(
      'SELECT * FROM machines WHERE job_id=? ORDER BY id'
    ).bind(jobId).all<any>()
    const synthetic: any[] = []
    // 1. Job creation event
    synthetic.push({
      id: -1, job_id: jobId, action: 'Job Created',
      detail: `Customer: ${job.snap_name || 'N/A'} (${job.snap_mobile || ''})${job.dispatch_method === 'courier' ? ' | Dispatch: Courier' : ''}`,
      user_name: 'System', user_role: 'system', created_at: job.created_at
    })
    // 2. Machine additions
    ;(machines || []).forEach((m: any, i: number) => {
      synthetic.push({
        id: -(i + 10), job_id: jobId, action: 'Machine Added',
        detail: `${m.product_name || 'Product'} — ${m.complaint || 'N/A'}${m.charges ? ' | ₹' + m.charges : ''}`,
        user_name: 'System', user_role: 'system', created_at: m.created_at || job.created_at
      })
    })
    // 3. Payment events (if any received)
    if (job.received_amount > 0) {
      synthetic.push({
        id: -100, job_id: jobId, action: 'Payment Updated',
        detail: `Received: ₹${job.received_amount}${job.payment_method ? ' via ' + job.payment_method : ''}`,
        user_name: 'System', user_role: 'system', created_at: job.updated_at || job.created_at
      })
    }
    // 4. Discount (if any)
    if (job.discount > 0) {
      synthetic.push({
        id: -101, job_id: jobId, action: 'Discount Updated',
        detail: `Discount: ₹${job.discount}`,
        user_name: 'System', user_role: 'system', created_at: job.updated_at || job.created_at
      })
    }
    // 5. Machine status changes (repaired/delivered/returned)
    ;(machines || []).forEach((m: any, i: number) => {
      if (m.status === 'repaired' || m.status === 'delivered' || m.status === 'returned') {
        synthetic.push({
          id: -(200 + i), job_id: jobId,
          action: m.status === 'repaired' ? 'Machine: repaired' : m.status === 'returned' ? 'Machine: returned' : 'Delivered',
          detail: `${m.product_name || 'Product'}${m.work_done ? ' | Work: ' + m.work_done : ''}${m.return_reason ? ' | Reason: ' + m.return_reason : ''}`,
          user_name: 'System', user_role: 'system',
          created_at: m.delivered_at || m.updated_at || job.updated_at
        })
      }
    })
    // 6. Job delivery event
    if (job.status === 'delivered' && job.delivered_at) {
      synthetic.push({
        id: -300, job_id: jobId, action: 'Status: delivered',
        detail: 'All machines delivered',
        user_name: 'System', user_role: 'system', created_at: job.delivered_at
      })
    }
    // Sort newest first
    synthetic.sort((a: any, b: any) => (b.created_at || '').localeCompare(a.created_at || ''))
    return c.json(synthetic)
  } catch (e: any) {
    console.error('Job history fetch error:', e?.message || e)
    return c.json([])
  }
})

// Record a job history entry (internal helper — called after key actions)
// POST /api/jobs/:id/history  body: { action, detail }
app.post('/api/jobs/:id/history', authMiddleware, async (c) => {
  const jobId = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { action, detail } = body
  if (!action) return c.json({ error: 'action required' }, 400)
  try {
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS job_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        user_name TEXT,
        user_role TEXT,
        user_id INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run()
    await c.env.DB.prepare(
      `INSERT INTO job_history (job_id, action, detail, user_name, user_role, user_id) VALUES (?,?,?,?,?,?)`
    ).bind(jobId, action, detail || null, c.get('userName') || 'System', c.get('userRole') || 'staff', c.get('userId') || null).run()
    return c.json({ ok: true })
  } catch (e: any) {
    console.error('Job history post error:', e?.message || e)
    return c.json({ ok: false })
  }
})

// ── API: Staff management ─────────────────────────────────────────────────────
app.get('/api/staff', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id,name,email,role,active,supervisor_rights,created_at FROM users ORDER BY name'
  ).all<any>()
  return c.json(results)
})

app.post('/api/staff', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { name, email, password, role, active, supervisor_rights } = body
  if (!name || !email || !password) return c.json({ error: 'name, email, password required' }, 400)
  const validRoles = ['admin', 'director', 'manager', 'staff']
  const userRole = validRoles.includes(role) ? role : 'staff'
  const hash = await bcrypt.hash(password, 10)
  // Staff role uses assignable rights; admin/director/manager have all rights inherently
  const rights = userRole === 'staff' && supervisor_rights ? JSON.stringify(supervisor_rights) : null
  try {
    await c.env.DB.prepare(
      'INSERT INTO users(name,email,password_hash,role,active,supervisor_rights) VALUES(?,?,?,?,?,?)'
    ).bind(name, email, hash, userRole, active !== undefined ? active : 1, rights).run()
    return c.json({ ok: true }, 201)
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Email already exists' }, 409)
    return c.json({ error: 'Failed to create staff' }, 500)
  }
})

app.put('/api/staff/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const fields: string[] = []
  const vals: any[] = []
  if (body.name)     { fields.push('name=?');  vals.push(body.name) }
  if (body.email)    { fields.push('email=?'); vals.push(body.email) }
  if (body.password) {
    const hash = await bcrypt.hash(body.password, 10)
    fields.push('password_hash=?'); vals.push(hash)
  }
  if (body.role && ['admin','director','manager','staff'].includes(body.role)) { fields.push('role=?');   vals.push(body.role) }
  if (body.active !== undefined) { fields.push('active=?'); vals.push(body.active) }
  if (body.supervisor_rights !== undefined) { fields.push('supervisor_rights=?'); vals.push(body.supervisor_rights ? JSON.stringify(body.supervisor_rights) : null) }
  if (!fields.length) return c.json({ error: 'Nothing to update' }, 400)
  vals.push(id)
  await c.env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  return c.json({ ok: true })
})

app.delete('/api/staff/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  // Prevent deleting self
  if (parseInt(id) === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)
  // Null out staff references in machines (preserve job data)
  await c.env.DB.prepare(`UPDATE machines SET assigned_staff_id=NULL WHERE assigned_staff_id=?`).bind(id).run()
  // Remove pending assignment requests for this staff
  await c.env.DB.prepare(`DELETE FROM assignment_requests WHERE staff_id=?`).bind(id).run()
  // Hard-delete the user account
  await c.env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// ── API: Excel Backup / Restore ───────────────────────────────────────────────
app.get('/api/backup/export', authMiddleware, adminOnly, async (c) => {
  const [users, customers, jobs, machines, images] = await Promise.all([
    c.env.DB.prepare('SELECT id,name,email,role,active,created_at FROM users').all<any>(),
    c.env.DB.prepare('SELECT * FROM customers').all<any>(),
    c.env.DB.prepare('SELECT * FROM jobs').all<any>(),
    c.env.DB.prepare('SELECT * FROM machines').all<any>(),
    c.env.DB.prepare('SELECT * FROM machine_images').all<any>(),
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users.results),    'users')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(customers.results),'customers')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(jobs.results),     'jobs')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(machines.results), 'machines')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(images.results),   'machine_images')
  const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_backup_${date}.xlsx"`
    }
  })
})

app.post('/api/backup/import', authMiddleware, adminOnly, async (c) => {
  const fd   = await c.req.formData()
  const file = fd.get('file') as File | null
  if (!file) return c.json({ error: 'No file' }, 400)
  const wb        = XLSX.read(await file.arrayBuffer(), { type: 'buffer' })
  const customers = XLSX.utils.sheet_to_json(wb.Sheets['customers']      || XLSX.utils.aoa_to_sheet([])) as any[]
  const jobs      = XLSX.utils.sheet_to_json(wb.Sheets['jobs']           || XLSX.utils.aoa_to_sheet([])) as any[]
  const machines  = XLSX.utils.sheet_to_json(wb.Sheets['machines']       || XLSX.utils.aoa_to_sheet([])) as any[]
  const images    = XLSX.utils.sheet_to_json(wb.Sheets['machine_images'] || XLSX.utils.aoa_to_sheet([])) as any[]

  for (const r of customers) {
    await c.env.DB.prepare(
      `INSERT INTO customers(id,name,mobile,mobile2,address,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,mobile=excluded.mobile,
         mobile2=excluded.mobile2,address=excluded.address`
    ).bind(r.id,r.name,r.mobile,r.mobile2||null,r.address||null,r.created_at||'',r.updated_at||'').run()
  }
  for (const r of jobs) {
    await c.env.DB.prepare(
      `INSERT INTO jobs(id,customer_id,snap_name,snap_mobile,snap_mobile2,snap_address,
                        note,received_amount,status,delivery_method,delivery_receiver_name,
                        delivery_receiver_mobile,delivery_courier_name,delivery_tracking,
                        delivery_address,delivered_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,note=excluded.note,
         received_amount=excluded.received_amount`
    ).bind(r.id,r.customer_id,r.snap_name,r.snap_mobile,r.snap_mobile2||null,r.snap_address||null,
           r.note||null,r.received_amount||0,r.status,r.delivery_method||null,
           r.delivery_receiver_name||null,r.delivery_receiver_mobile||null,
           r.delivery_courier_name||null,r.delivery_tracking||null,r.delivery_address||null,
           r.delivered_at||null,r.created_at||'',r.updated_at||'').run()
  }
  for (const r of machines) {
    await c.env.DB.prepare(
      `INSERT INTO machines(id,job_id,product_name,product_complaint,charges,quantity,
                            assigned_staff_id,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,charges=excluded.charges`
    ).bind(r.id,r.job_id,r.product_name,r.product_complaint||null,r.charges||0,r.quantity||1,
           r.assigned_staff_id||null,r.status||'under_repair',r.created_at||'',r.updated_at||'').run()
  }
  for (const r of images) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO machine_images(id,machine_id,r2_object_key,url,created_at)
       VALUES(?,?,?,?,?)`
    ).bind(r.id,r.machine_id,r.r2_object_key||null,r.url||'',r.created_at||'').run()
  }
  const maxJob = await c.env.DB.prepare(
    `SELECT MAX(CAST(SUBSTR(id,3) AS INTEGER)) AS m FROM jobs`
  ).first<any>()
  await c.env.DB.prepare('UPDATE job_counter SET last_seq=? WHERE id=1')
    .bind(maxJob?.m || 0).run()
  return c.json({ ok: true, restored: { customers: customers.length, jobs: jobs.length, machines: machines.length } })
})

// ── API: Reports ──────────────────────────────────────────────────────────────
// Admin staff report
app.get('/api/reports/staff', authMiddleware, adminOnly, async (c) => {
  const from    = c.req.query('from')     || ''
  const to      = c.req.query('to')       || ''
  const staffId = c.req.query('staff_id') || ''
  const mStatus = c.req.query('status')   || '' // v52.1: machine status filter
  let q = `
    SELECT u.name AS staff_name, m.product_name, m.product_complaint AS problem_description,
           m.status AS machine_status, m.charges, m.quantity,
           j.id AS job_id, j.snap_name AS customer_name, j.snap_mobile AS phone,
           m.created_at AS created_date, m.work_done
    FROM machines m
    JOIN jobs j ON m.job_id=j.id
    LEFT JOIN users u ON m.assigned_staff_id=u.id
    WHERE 1=1`
  const ps: any[] = []
  if (from)    { q += ' AND DATE(m.created_at)>=?'; ps.push(from) }
  if (to)      { q += ' AND DATE(m.created_at)<=?'; ps.push(to) }
  if (staffId) { q += ' AND m.assigned_staff_id=?'; ps.push(staffId) }
  // v52.1: Filter by machine status (under_repair, repaired, delivered, returned)
  if (mStatus && ['under_repair','repaired','delivered','returned'].includes(mStatus)) {
    q += ' AND m.status=?'; ps.push(mStatus)
  }
  q += ' ORDER BY u.name, m.created_at DESC'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'Staff Report')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_staff_report.xlsx"`
    }
  })
})

// Staff: export their own jobs
app.get('/api/reports/my-jobs', authMiddleware, async (c) => {
  const from   = c.req.query('from') || ''
  const to     = c.req.query('to')   || ''
  const userId = c.get('userId')
  // v52.7: Staff report does NOT include charges — financial data is admin-only
  // v52.12: Staff report does NOT include phone — customer contact is admin-only
  let q = `
    SELECT j.id AS job_id, j.snap_name AS customer_name,
           m.product_name AS machine_type, m.product_complaint AS problem_description,
           m.status AS job_status, u.name AS assigned_staff,
           DATE(j.created_at) AS created_date
    FROM machines m
    JOIN jobs j ON m.job_id=j.id
    LEFT JOIN users u ON m.assigned_staff_id=u.id
    WHERE m.assigned_staff_id=?`
  const ps: any[] = [userId]
  if (from) { q += ' AND DATE(j.created_at)>=?'; ps.push(from) }
  if (to)   { q += ' AND DATE(j.created_at)<=?'; ps.push(to) }
  q += ' ORDER BY j.created_at DESC'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'My Jobs')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_my_jobs_${date}.xlsx"`
    }
  })
})

// v52.10: Daily Repair Report — view machines repaired on a specific date
// Staff: sees only their own repairs. Admin: can filter by staff or see all.
app.get('/api/reports/daily-repairs', authMiddleware, async (c) => {
  const date    = c.req.query('date') || new Date().toISOString().slice(0, 10)
  const staffId = c.req.query('staff_id') || ''
  const userId  = c.get('userId')
  const role    = c.get('userRole')
  const isAdm   = role === 'admin' || role === 'director' || role === 'manager'

  let q = `
    SELECT m.id AS machine_id, m.product_name, m.product_complaint,
           m.status, m.charges, m.quantity, m.work_done,
           j.id AS job_id, j.snap_name AS customer_name, j.snap_mobile AS phone,
           u.name AS staff_name, m.updated_at
    FROM machines m
    JOIN jobs j ON m.job_id = j.id
    LEFT JOIN users u ON m.assigned_staff_id = u.id
    WHERE m.status = 'repaired'
      AND DATE(m.updated_at) = ?`
  const ps: any[] = [date]

  if (!isAdm) {
    // Staff: force filter to own machines only
    q += ' AND m.assigned_staff_id = ?'
    ps.push(userId)
  } else if (staffId) {
    // Admin with staff filter
    q += ' AND m.assigned_staff_id = ?'
    ps.push(staffId)
  }

  q += ' ORDER BY m.updated_at DESC'

  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()

  // v52.12: Staff cannot see customer phone numbers or financial data
  const data = isAdm ? results : results.map((r: any) => ({
    ...r,
    phone: undefined,
    charges: undefined
  }))

  return c.json({ ok: true, date, count: results.length, data })
})

app.get('/api/reports/jobs', authMiddleware, adminOnly, async (c) => {
  const from = c.req.query('from') || ''
  const to   = c.req.query('to')   || ''
  let q = `
    SELECT j.id, j.snap_name AS customer, j.snap_mobile AS mobile, j.status,
           j.received_amount,
           COALESCE(SUM(m.quantity),0) AS machines,
           SUM(CASE WHEN m.status != 'returned' THEN m.charges * m.quantity ELSE 0 END) AS total_charges,
           MAX(0, SUM(CASE WHEN m.status != 'returned' THEN m.charges * m.quantity ELSE 0 END) - j.received_amount) AS balance_due,
           j.created_at
    FROM jobs j LEFT JOIN machines m ON j.id=m.job_id
    WHERE 1=1`
  const ps: any[] = []
  if (from) { q += ' AND DATE(j.created_at)>=?'; ps.push(from) }
  if (to)   { q += ' AND DATE(j.created_at)<=?'; ps.push(to) }
  q += ' GROUP BY j.id ORDER BY j.created_at DESC'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'Job Summary')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_job_summary.xlsx"`
    }
  })
})

// ── API: App Settings ─────────────────────────────────────────────────────────
// Get all settings
app.get('/api/settings', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value FROM app_settings').all<any>()
  const obj: Record<string, string> = {}
  for (const r of results) obj[r.key] = r.value
  return c.json(obj)
})

// Update a setting
app.put('/api/settings', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const allowed = ['job_prefix', 'job_seq_digits', 'customer_categories', 'gemini_api_key', 'gemini_api_keys', 'whatsapp_bot_url']
  for (const k of allowed) {
    if (k in body) {
      await c.env.DB.prepare(
        'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      ).bind(k, String(body[k])).run()
    }
  }
  return c.json({ ok: true })
})

// ── API: AI — Gemini-powered product and invoice analysis ────────────────────
// v50.4: Complete model chain — LATEST to OLDEST (user request)
//        Gemini 3.x: thinkingLevel param, temperature must be 1.0
//        Gemini 2.5: thinkingBudget param
//        User has Gemini Pro subscription — all models accessible
// v50.7: Added 3.5-flash and 3.1-flash-lite (newest models)
const GEMINI_MODELS = [
  'gemini-3.5-flash-preview',    // 1st: Latest Flash model, May 2026
  'gemini-3.1-flash-lite-preview', // 2nd: Fast, lightweight, latest lite
  'gemini-3.1-pro-preview',      // 3rd: Most advanced reasoning
  'gemini-3-flash-preview',      // 4th: Pro-level intelligence at Flash speed
  'gemini-2.5-pro',              // 5th: Stable, advanced reasoning, June 2025
  'gemini-2.5-flash',            // 6th: Stable, best price-performance, June 2025
  'gemini-2.0-flash',            // 7th: Deprecated June 2026 — emergency fallback
  'gemini-1.5-flash',            // 8th: Legacy last resort
]

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j])
  }
  return btoa(binary)
}

// v50.3: Model selection — cached per-worker for 1 hour
let _cachedModel: string | null = null
let _cachedModelExpiry = 0
async function pickModel(apiKey: string): Promise<string> {
  if (_cachedModel && Date.now() < _cachedModelExpiry) return _cachedModel
  _cachedModel = GEMINI_MODELS[0]  // latest model
  _cachedModelExpiry = Date.now() + 3600000
  return _cachedModel
}

// v50.7: Multi-API Key rotation system
// Stores the current key index and last-rate-limited timestamps per key
// On 429: marks key as rate-limited, moves to next key automatically
let _keyRotationIndex = 0
let _keyRateLimitedUntil: Map<string, number> = new Map()  // key -> timestamp when usable again

// Get all available API keys (from gemini_api_keys JSON array + legacy gemini_api_key)
async function getApiKeys(db: any): Promise<string[]> {
  const keys: string[] = []
  // First: get the multi-key array
  const multiRow = await db.prepare("SELECT value FROM app_settings WHERE key='gemini_api_keys'").first<any>()
  if (multiRow?.value) {
    try {
      const arr = JSON.parse(multiRow.value)
      if (Array.isArray(arr)) {
        for (const k of arr) {
          const trimmed = (typeof k === 'string' ? k : k?.key || '').trim()
          if (trimmed && trimmed.startsWith('AIza')) keys.push(trimmed)
        }
      }
    } catch {}
  }
  // Fallback: legacy single key (if multi-keys is empty)
  if (keys.length === 0) {
    const singleRow = await db.prepare("SELECT value FROM app_settings WHERE key='gemini_api_key'").first<any>()
    if (singleRow?.value?.trim()) keys.push(singleRow.value.trim())
  }
  return keys
}

// Get the best available key (not rate-limited), rotating as needed
function pickBestKey(keys: string[]): string | null {
  if (!keys.length) return null
  const now = Date.now()
  // Try from current rotation index forward
  for (let i = 0; i < keys.length; i++) {
    const idx = (_keyRotationIndex + i) % keys.length
    const key = keys[idx]
    const limitUntil = _keyRateLimitedUntil.get(key) || 0
    if (now >= limitUntil) {
      _keyRotationIndex = idx
      return key
    }
  }
  // All keys are rate limited — pick the one expiring soonest
  let bestKey = keys[0]
  let soonest = Infinity
  for (const key of keys) {
    const until = _keyRateLimitedUntil.get(key) || 0
    if (until < soonest) { soonest = until; bestKey = key }
  }
  return bestKey
}

// Mark a key as rate-limited (cooldown: 60s)
function markKeyRateLimited(key: string) {
  _keyRateLimitedUntil.set(key, Date.now() + 60000) // 60s cooldown
  // Auto-rotate to next index
  _keyRotationIndex = (_keyRotationIndex + 1)
  console.log(`[AI-KEYS] Key ${key.slice(0,8)}… rate limited — rotated to next key`)
}

// v50.3: callGemini — tries EVERY model in the chain before giving up
// v50.7: Multi-key support — on 429, rotates to next API key before trying next model
async function callGemini(apiKey: string, model: string, contents: any[], genConfig?: any, allKeys?: string[]): Promise<{ok: boolean, data?: any, error?: string}> {
  let lastError = ''
  let startIdx = GEMINI_MODELS.indexOf(model)
  if (startIdx < 0) startIdx = 0
  let rateLimitCount = 0
  const MAX_RATE_RETRIES = 2
  const availableKeys = allKeys || [apiKey]
  let currentKey = apiKey

  for (let modelIdx = startIdx; modelIdx < GEMINI_MODELS.length; modelIdx++) {
    const currentModel = GEMINI_MODELS[modelIdx]
    try {
      console.log(`[AI] Trying model: ${currentModel} (idx ${modelIdx}) with key ${currentKey.slice(0,8)}…`)
      // v50.4: Build request body — minimize thinking for speed
      const reqBody: any = {
        contents,
        generationConfig: genConfig || { temperature: 0.4, maxOutputTokens: 2048 }
      }
      // Gemini 3.x: use thinkingLevel, temp must be 1.0
      if (currentModel.includes('3.5-flash') || currentModel.includes('3.1-pro') || currentModel.includes('3-flash') || currentModel.includes('3.1-flash-lite')) {
        reqBody.generationConfig.thinkingConfig = { thinkingLevel: 'minimal' }
        reqBody.generationConfig.temperature = 1.0
      } else if (currentModel.includes('2.5-flash')) {
        reqBody.generationConfig.thinkingConfig = { thinkingBudget: 0 }
      } else if (currentModel.includes('2.5-pro')) {
        reqBody.generationConfig.thinkingConfig = { thinkingBudget: 128 }
      }
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${currentKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      })

      if (resp.ok) {
        const data = await resp.json() as any
        // Handle thinking model responses — skip thought parts
        const parts = data?.candidates?.[0]?.content?.parts || []
        let text = ''
        for (const p of parts) {
          if (p.thought) continue
          if (p.text) { text = p.text; break }
        }
        if (!text) text = parts[0]?.text || ''
        if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
          return { ok: false, error: 'Content blocked by safety filters' }
        }
        if (!text) {
          console.log(`[AI] ${currentModel}: empty response, parts:`, JSON.stringify(parts).slice(0, 200))
          lastError = `${currentModel}: empty response`
          continue
        }
        // Success — cache model
        console.log(`[AI] ${currentModel}: SUCCESS (key ${currentKey.slice(0,8)}…), response length ${text.length}`)
        _cachedModel = currentModel
        _cachedModelExpiry = Date.now() + 3600000
        data._extractedText = text
        return { ok: true, data }
      }

      // Error responses
      const errBody = await resp.text().catch(() => '')
      console.log(`[AI] ${currentModel}: HTTP ${resp.status} — ${errBody.slice(0, 150)}`)

      if (resp.status === 404 || resp.status === 400) {
        lastError = `${currentModel} not available (${resp.status})`
        if (_cachedModel === currentModel) { _cachedModel = null; _cachedModelExpiry = 0 }
        continue
      }

      if (resp.status === 429) {
        lastError = 'RATE_LIMITED'
        // v50.7: Try next API key first before trying next model
        markKeyRateLimited(currentKey)
        const nextKey = pickBestKey(availableKeys)
        if (nextKey && nextKey !== currentKey) {
          console.log(`[AI] Rotating to next API key: ${nextKey.slice(0,8)}…`)
          currentKey = nextKey
          modelIdx--  // Retry same model with different key
          continue
        }
        // All keys exhausted for this model — try next model
        if (modelIdx < GEMINI_MODELS.length - 1) {
          console.log(`[AI] ${currentModel}: rate limited on all keys, trying next model`)
          // Reset to best key for next model
          currentKey = pickBestKey(availableKeys) || apiKey
          continue
        }
        // Last model also rate limited — wait and retry
        if (rateLimitCount < MAX_RATE_RETRIES) {
          rateLimitCount++
          const delay = rateLimitCount * 3000
          console.log(`[AI] All models rate limited, waiting ${delay}ms then retrying (attempt ${rateLimitCount})`)
          await new Promise(r => setTimeout(r, delay))
          currentKey = pickBestKey(availableKeys) || apiKey
          modelIdx = startIdx - 1
          continue
        }
        return { ok: false, error: 'RATE_LIMITED' }
      }

      if (resp.status === 403) {
        if (errBody.includes('API_KEY') || errBody.includes('api key') || errBody.includes('API key')) {
          // Try next key if available
          const nextKey = availableKeys.find(k => k !== currentKey)
          if (nextKey) { currentKey = nextKey; modelIdx--; continue }
          return { ok: false, error: 'Invalid API key. Check Settings → Gemini API Key.' }
        }
        lastError = `${currentModel}: access denied`
        continue
      }

      lastError = `${currentModel}: HTTP ${resp.status}`
      continue

    } catch (e: any) {
      lastError = `${currentModel}: network error — ${e.message}`
      console.log(`[AI] ${currentModel}: EXCEPTION — ${e.message}`)
      continue
    }
  }
  return { ok: false, error: lastError || 'AI analysis failed — all models unavailable' }
}

// v50.3: Test API key — try actual generateContent with latest model, no listModels waste
app.post('/api/ai/test-key', authMiddleware, adminOnly, async (c) => {
  const allKeys = await getApiKeys(c.env.DB)
  const geminiKey = allKeys.length ? allKeys[0] : null
  if (!geminiKey) return c.json({ error: 'No API key configured' }, 400)
  const keyCount = allKeys.length
  try {
    // Try each model until one works — this validates key AND finds best model
    for (const testModel of GEMINI_MODELS) {
      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${geminiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }], generationConfig: { maxOutputTokens: 10 } })
        })
        if (resp.ok) {
          _cachedModel = testModel
          _cachedModelExpiry = Date.now() + 3600000
          return c.json({ ok: true, model: testModel, keyCount, message: `API key works! Model: ${testModel}. ${keyCount} key(s) configured.` })
        }
        if (resp.status === 429) {
          // Rate limited means key IS valid — this model works
          _cachedModel = testModel
          _cachedModelExpiry = Date.now() + 3600000
          return c.json({ ok: true, model: testModel, message: `API key valid! Model: ${testModel} (rate limited now, will work shortly).` })
        }
        if (resp.status === 403) {
          const errBody = await resp.text().catch(() => '')
          if (errBody.includes('API_KEY') || errBody.includes('api key')) {
            return c.json({ error: 'Invalid API key — please check and re-enter' }, 400)
          }
          // Model access denied — try next
          continue
        }
        if (resp.status === 404) continue  // model not available, try next
        // Other error — try next model
      } catch (_) { continue }
    }
    return c.json({ error: 'Could not verify key — all models returned errors. Check your API key.' }, 400)
  } catch (e: any) {
    return c.json({ error: `Connection error: ${e.message}` }, 500)
  }
})

// v50: Analyze product image — Gemini with retry + strong DB fallback that auto-fills
app.post('/api/ai/analyze-product', authMiddleware, async (c) => {
  const allKeys = await getApiKeys(c.env.DB)
  const geminiKey = pickBestKey(allKeys)
  if (!geminiKey) return c.json({ error: 'Gemini API key not configured. Set it in Settings.' }, 400)
  const formData = await c.req.formData()
  const file = formData.get('image') as File | null
  if (!file) return c.json({ error: 'No image provided' }, 400)
  try {
    const buf = await file.arrayBuffer()
    const base64 = arrayBufferToBase64(buf)
    const mimeType = file.type || 'image/jpeg'
    // Fetch past learnings for context — include complaint & charges for richer fallback
    const { results: learnings } = await c.env.DB.prepare(
      'SELECT product_name, product_complaint, charges, brand, model, category FROM ai_learning ORDER BY id DESC LIMIT 50'
    ).all<any>()
    let learningCtx = ''
    if (learnings.length) {
      learningCtx = '\n\nPrevious products from this repair shop (use as reference to match):\n' +
        learnings.slice(0, 30).map((l: any) => `- ${l.product_name || ''}${l.brand ? ' | Brand:'+l.brand : ''}${l.model ? ' | Model:'+l.model : ''}${l.category ? ' | Cat:'+l.category : ''}${l.product_complaint ? ' | Complaint:'+l.product_complaint : ''}${l.charges ? ' | Charges:₹'+l.charges : ''}`).join('\n')
    }
    const model = await pickModel(geminiKey)
    const result = await callGemini(geminiKey, model, [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: `You are an expert at identifying electrical products used in salons and barbershops. Look at this product image carefully.

Identify:
1. Brand Name (common brands: Ikonic, Wahl, HNK, Chaoba, Nova, Philips, MARC, AYTY Pro, Kemei, VGR, Babyliss)
2. Model Number/Name
3. Category (Hair Dryer, Clipper, Trimmer, Straightener, Curler, Crimper, Steamer, Massager, or other)

IMPORTANT: Even if the image is blurry or partial, try your best to identify at least the Category.
If you can see ANY text or logo on the product, extract it.
If the product looks similar to any in the reference list below, match it.
${learningCtx}

Return ONLY a JSON object: {"brand":"...","model":"...","category":"...","product_name":"Brand Model Category","confidence":0.0-1.0}
- product_name = combine what you found: "Brand Model Category" or just "Category" if brand unknown
- confidence: your certainty (0.0-1.0). Set to at least 0.6 if you can identify the category.
- Empty string for fields you truly cannot identify.
Return ONLY valid JSON, no markdown, no code fences.` }
      ]
    }], undefined, allKeys)
    // v50.3: Parse Gemini response — use _extractedText (handles thinking model parts)
    if (result.ok) {
      const text = result.data?._extractedText || result.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      console.log('[AI] Gemini raw response:', text.slice(0, 300))
      // Handle JSON wrapped in code fences: ```json {...} ```
      const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed.product_name || parsed.brand || parsed.category) {
            return c.json({
              product_name: parsed.product_name || [parsed.brand, parsed.model, parsed.category].filter(Boolean).join(' ') || '',
              brand: parsed.brand || '', model: parsed.model || '', category: parsed.category || '',
              confidence: Math.max(parsed.confidence || 0, (parsed.product_name || parsed.brand) ? 0.6 : 0),
              source: 'gemini'
            })
          }
        } catch (parseErr) {
          console.error('[AI] JSON parse error:', parseErr, 'raw:', jsonMatch[0].slice(0, 200))
        }
      }
      // Gemini returned text but we couldn't parse JSON — return as-is with low confidence
      if (text.trim().length > 3) {
        return c.json({
          product_name: text.trim().slice(0, 100), brand: '', model: '', category: '',
          confidence: 0.3, source: 'gemini',
          ai_error: 'AI returned text but not structured data'
        })
      }
    }
    // v50.2: DB fallback — ONLY return suggestions, NEVER auto-fill
    // This ensures user clearly knows AI didn't work and data is from previous jobs
    const errMsg = result.error || 'AI could not analyze the image'
    if (learnings.length) {
      const freq: Record<string, {count: number, complaint: string, charges: number, brand: string, category: string, model: string}> = {}
      for (const l of learnings) {
        const key = l.product_name || ''
        if (!key) continue
        if (!freq[key]) freq[key] = { count: 0, complaint: l.product_complaint || '', charges: l.charges || 0, brand: l.brand || '', category: l.category || '', model: l.model || '' }
        freq[key].count++
        if (l.product_complaint) freq[key].complaint = l.product_complaint
        if (l.charges) freq[key].charges = l.charges
      }
      const sorted = Object.entries(freq).sort((a, b) => b[1].count - a[1].count)
      if (sorted.length) {
        return c.json({
          product_name: '', brand: '', model: '', category: '', confidence: 0,
          suggestions: sorted.slice(0, 8).map(([name, d]) => ({ name, brand: d.brand, category: d.category, complaint: d.complaint, charges: d.charges, count: d.count })),
          source: 'suggestions_only', ai_error: errMsg
        })
      }
    }
    return c.json({ product_name: '', brand: '', model: '', category: '', confidence: 0, source: 'none', ai_error: errMsg })
  } catch (e: any) { return c.json({ error: e.message || 'AI analysis failed' }, 500) }
})

// v50: Analyze invoice image — Gemini with retry + strong DB fallback with auto-fill
app.post('/api/ai/analyze-invoice', authMiddleware, async (c) => {
  const allKeys = await getApiKeys(c.env.DB)
  const geminiKey = pickBestKey(allKeys)
  if (!geminiKey) return c.json({ error: 'Gemini API key not configured' }, 400)
  const formData = await c.req.formData()
  const file = formData.get('image') as File | null
  if (!file) return c.json({ error: 'No image provided' }, 400)
  try {
    const buf = await file.arrayBuffer()
    const base64 = arrayBufferToBase64(buf)
    const mimeType = file.type || 'image/jpeg'
    // Fetch recent invoice data from machines AND ai_learning for comprehensive context
    const { results: invoiceHistory } = await c.env.DB.prepare(
      `SELECT purchased_from, purchase_invoice_no, purchase_date FROM machines 
       WHERE warranty_type='warranty' AND (purchased_from IS NOT NULL OR purchase_invoice_no IS NOT NULL)
       ORDER BY ROWID DESC LIMIT 30`
    ).all<any>()
    let invoiceCtx = ''
    const sellers = [...new Set(invoiceHistory.map((i: any) => i.purchased_from).filter(Boolean))]
    const invoiceNos = [...new Set(invoiceHistory.map((i: any) => i.purchase_invoice_no).filter(Boolean))]
    if (sellers.length || invoiceNos.length) {
      invoiceCtx = `\n\nKnown data from this shop's records:`
      if (sellers.length) invoiceCtx += `\nSellers/dealers: ${sellers.join(', ')}`
      if (invoiceNos.length) invoiceCtx += `\nRecent invoice numbers: ${invoiceNos.slice(0,10).join(', ')}`
    }
    const model = await pickModel(geminiKey)
    // v52.11: Improved invoice AI prompt — prioritize reading the ACTUAL image
    // Previously the DB context biased Gemini to return known sellers instead of reading the image
    const result = await callGemini(geminiKey, model, [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: `You are analyzing a purchase invoice/bill photo. Extract ONLY what you can see in THIS image.

TASK: Read the text visible in this invoice image and extract:
1. purchased_from: The seller/shop/dealer name visible on THIS invoice (company name, letterhead, stamp, logo)
2. invoice_no: The bill/invoice/receipt number visible on THIS invoice
3. purchase_date: The purchase date visible on THIS invoice (convert to YYYY-MM-DD format)

CRITICAL RULES:
- Extract data ONLY from text visible in THIS specific image. Do NOT guess or use any other source.
- Read ALL text carefully: headers, footers, stamps, handwritten text, margins, watermarks.
- If a field is not clearly visible in the image, return an empty string for that field.
- Do NOT copy data from the reference list below — only use it for SPELLING CORRECTION if the image text closely matches a known name.
${invoiceCtx ? '\nReference for spelling correction only (DO NOT use these unless the image text matches):' + invoiceCtx : ''}

Return ONLY a JSON object: {"purchased_from":"...","invoice_no":"...","purchase_date":"...","confidence":0.0-1.0}
- Empty string for fields you cannot clearly read in the image.
- Date must be YYYY-MM-DD format.
- confidence: How confident you are that the data comes from THIS image (0.0-1.0).
Return ONLY valid JSON, no markdown, no code fences.` }
      ]
    }], undefined, allKeys)
    // v50.3: Parse Gemini invoice response — use _extractedText (handles thinking model parts)
    if (result.ok) {
      const text = result.data?._extractedText || result.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      console.log('[AI] Invoice Gemini raw:', text.slice(0, 300))
      const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed.purchased_from || parsed.invoice_no || parsed.purchase_date) {
            // v50.5: Warranty period validation — check if purchase date is within 1 year
            let warranty_valid = true
            let warranty_message = ''
            if (parsed.purchase_date) {
              const purchaseMs = new Date(parsed.purchase_date).getTime()
              const nowMs = Date.now()
              const oneYearMs = 365 * 24 * 60 * 60 * 1000
              if (!isNaN(purchaseMs)) {
                const ageMs = nowMs - purchaseMs
                if (ageMs > oneYearMs) {
                  warranty_valid = false
                  const months = Math.round(ageMs / (30 * 24 * 60 * 60 * 1000))
                  warranty_message = `Purchase date is ${months} months ago — exceeds 1 year warranty period`
                } else if (ageMs < 0) {
                  warranty_message = 'Purchase date is in the future — please verify'
                } else {
                  const daysLeft = Math.round((oneYearMs - ageMs) / (24 * 60 * 60 * 1000))
                  warranty_message = `Warranty valid — ${daysLeft} days remaining`
                }
              }
            }
            return c.json({
              purchased_from: parsed.purchased_from || '', invoice_no: parsed.invoice_no || '',
              purchase_date: parsed.purchase_date || '',
              confidence: Math.max(parsed.confidence || 0, 0.6),
              warranty_valid, warranty_message,
              source: 'gemini'
            })
          }
        } catch (parseErr) {
          console.error('[AI] Invoice JSON parse error:', parseErr)
        }
      }
      // Gemini returned text but couldn't parse — still better than nothing
      if (text.trim().length > 3) {
        return c.json({
          purchased_from: text.trim().slice(0, 80), invoice_no: '', purchase_date: '',
          confidence: 0.2, source: 'gemini',
          ai_error: 'AI returned text but not structured data'
        })
      }
    }
    // v50.2: DB fallback — ONLY provide seller suggestions, NEVER auto-fill
    const invoiceErr = result.error || 'AI could not read this invoice'
    if (invoiceHistory.length) {
      return c.json({
        purchased_from: '', invoice_no: '', purchase_date: '',
        confidence: 0,
        seller_suggestions: sellers.slice(0, 8),
        source: 'suggestions_only',
        ai_error: invoiceErr
      })
    }
    return c.json({ purchased_from: '', invoice_no: '', purchase_date: '', confidence: 0, source: 'none', ai_error: invoiceErr })
  } catch (e: any) { return c.json({ error: e.message || 'AI analysis failed' }, 500) }
})

// v49.5: AI learning — store user corrections to improve future predictions
app.post('/api/ai/learn', authMiddleware, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { product_name, product_complaint, charges, brand, model, category, image_hash } = body
  if (!product_name) return c.json({ error: 'product_name required' }, 400)
  try {
    await c.env.DB.prepare(
      `INSERT INTO ai_learning(image_hash, product_name, product_complaint, charges, brand, model, category) VALUES(?,?,?,?,?,?,?)`
    ).bind(image_hash || null, product_name, product_complaint || null, charges || null, brand || null, model || null, category || null).run()
    return c.json({ ok: true })
  } catch (e: any) { return c.json({ error: e.message }, 500) }
})

// v49.8: Download ALL customers as vCard (.vcf) — Google Contacts compatible with groups
app.get('/api/customers/vcf', authMiddleware, adminOnly, async (c) => {
  const account = c.req.query('account') || 'aditionelectricworks@gmail.com'
  const { results } = await c.env.DB.prepare(
    `SELECT c.name, c.mobile, c.mobile2, c.address, c.category, c.note FROM customers c ORDER BY c.category, c.name`
  ).all<any>()
  let vcf = ''
  for (const r of results) {
    const name = (r.name || 'Unknown').trim()
    const parts = name.split(/\s+/)
    const firstName = parts[0] || name
    const lastName = parts.slice(1).join(' ') || ''
    const category = r.category || 'Customer'
    // Clean phone numbers: strip non-digits, remove leading 91 country code if present
    const cleanPhone = (p: string) => {
      if (!p) return ''
      let d = p.replace(/\D/g, '')
      if (d.length > 10 && d.startsWith('91')) d = d.slice(2)
      return d.length >= 10 ? `+91${d}` : ''
    }
    const phone1 = cleanPhone(r.mobile)
    const phone2 = cleanPhone(r.mobile2)
    vcf += 'BEGIN:VCARD\r\nVERSION:3.0\r\n'
    vcf += `FN:${name}\r\n`
    vcf += `N:${lastName};${firstName};;;\r\n`
    if (phone1) vcf += `TEL;TYPE=CELL:${phone1}\r\n`
    if (phone2) vcf += `TEL;TYPE=CELL;TYPE=HOME:${phone2}\r\n`
    if (r.address) vcf += `ADR;TYPE=HOME:;;${r.address.replace(/[\r\n]+/g, ', ')};;;;\r\n`
    // Google Contacts uses CATEGORIES for group labels (auto-creates groups on import)
    vcf += `CATEGORIES:${category}\r\n`
    vcf += `ORG:AES - ${category}\r\n`
    const noteText = [`Category: ${category}`, r.note ? r.note.replace(/[\r\n]+/g, ' ') : ''].filter(Boolean).join(' | ')
    vcf += `NOTE:${noteText}\r\n`
    vcf += 'END:VCARD\r\n'
  }
  const filename = `AES_Contacts_${new Date().toISOString().slice(0,10)}.vcf`
  return new Response(vcf, {
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    }
  })
})

// ── API: Customer Data Export ─────────────────────────────────────────────────
app.get('/api/reports/customers', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.name AS customer_name, c.mobile AS phone_number,
           c.mobile2 AS alt_phone, c.address, c.category,
           COUNT(DISTINCT j.id) AS total_jobs,
           MIN(j.created_at) AS first_job, MAX(j.created_at) AS last_job
    FROM customers c
    LEFT JOIN jobs j ON j.customer_id = c.id
    GROUP BY c.id, c.name, c.mobile
    ORDER BY c.name
  `).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'Customer Data')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_customers_${date}.xlsx"`
    }
  })
})

// ── API: Customer insights (total jobs, spending, last visit) ────────────────
app.get('/api/customers/insights', authMiddleware, async (c) => {
  const mobile = c.req.query('mobile') || ''
  if (!mobile) return c.json({ error: 'mobile required' }, 400)
  try {
    const row = await c.env.DB.prepare(`
      SELECT COUNT(DISTINCT j.id) AS total_jobs,
             SUM(CASE WHEN m.status != 'returned' THEN m.charges * m.quantity ELSE 0 END) AS total_spending,
             MAX(j.created_at) AS last_visit,
             MIN(j.created_at) AS first_visit
      FROM jobs j
      LEFT JOIN machines m ON m.job_id = j.id
      WHERE j.snap_mobile = ? OR j.snap_mobile2 = ?
    `).bind(mobile, mobile).first<any>()
    return c.json({
      total_jobs: row?.total_jobs || 0,
      total_spending: row?.total_spending || 0,
      last_visit: row?.last_visit || null,
      first_visit: row?.first_visit || null,
    })
  } catch (_) {
    return c.json({ total_jobs: 0, total_spending: 0, last_visit: null, first_visit: null })
  }
})

// ── API: Customer search by name/mobile ──────────────────────────────────────
// v50.1: Return category + dispatch_method for auto-fill on name suggestion click
app.get('/api/customers/search', authMiddleware, async (c) => {
  const q = (c.req.query('q') || '').trim()
  if (q.length < 2) return c.json([])
  const term = `%${q}%`
  const { results } = await c.env.DB.prepare(`
    SELECT DISTINCT c.name, c.mobile, c.mobile2, c.address, c.category, c.dispatch_method
    FROM customers c
    WHERE c.name LIKE ? OR c.mobile LIKE ? OR c.mobile2 LIKE ?
    ORDER BY c.name LIMIT 8
  `).bind(term, term, term).all<any>()
  return c.json(results)
})

// ── API: Customer update (edit name, mobile, address) ────────────────────────
app.put('/api/customers/:id', authMiddleware, async (c) => {
  const role = c.get('userRole')
  const isAdminRole = roleLevel(role) >= 2
  if (!isAdminRole) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const fields: string[] = []
  const vals: any[] = []
  if (body.name)    { fields.push('name=?');    vals.push(body.name) }
  if (body.mobile)  { fields.push('mobile=?');  vals.push(body.mobile) }
  if (body.mobile2 !== undefined) { fields.push('mobile2=?'); vals.push(body.mobile2 || null) }
  if (body.address !== undefined) { fields.push('address=?'); vals.push(body.address || null) }
  if (body.category) { fields.push('category=?'); vals.push(body.category) }
  if (!fields.length) return c.json({ error: 'Nothing to update' }, 400)
  fields.push(`updated_at=datetime('now')`)
  vals.push(id)
  try {
    await c.env.DB.prepare(`UPDATE customers SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
    // Also update snap fields in all linked jobs
    if (body.name || body.mobile || body.address) {
      const cust = await c.env.DB.prepare('SELECT * FROM customers WHERE id=?').bind(id).first<any>()
      if (cust) {
        const jobFields: string[] = []
        const jobVals: any[] = []
        if (body.name)    { jobFields.push('snap_name=?');    jobVals.push(body.name) }
        if (body.mobile)  { jobFields.push('snap_mobile=?');  jobVals.push(body.mobile) }
        if (body.mobile2 !== undefined) { jobFields.push('snap_mobile2=?'); jobVals.push(body.mobile2 || null) }
        if (body.address !== undefined) { jobFields.push('snap_address=?'); jobVals.push(body.address || null) }
        if (jobFields.length) {
          jobVals.push(id)
          await c.env.DB.prepare(`UPDATE jobs SET ${jobFields.join(',')},updated_at=datetime('now') WHERE customer_id=?`).bind(...jobVals).run()
        }
      }
    }
    return c.json({ ok: true })
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Mobile already in use' }, 409)
    return c.json({ error: 'Update failed' }, 500)
  }
})

// ── API: Customer list (all customers with stats) ─────────────────────────────
app.get('/api/customers', authMiddleware, async (c) => {
  const role = c.get('userRole')
  const isAdminRole = roleLevel(role) >= 2
  if (!isAdminRole) return c.json({ error: 'Forbidden' }, 403)
  const { results } = await c.env.DB.prepare(`
    SELECT c.id, c.name, c.mobile, c.mobile2, c.address, c.category,
           COUNT(DISTINCT j.id) AS total_jobs,
           SUM(CASE WHEN j.status='delivered' THEN 1 ELSE 0 END) AS delivered_jobs,
           MAX(j.created_at) AS last_job_date
    FROM customers c
    LEFT JOIN jobs j ON j.customer_id = c.id
    GROUP BY c.id ORDER BY c.name
    LIMIT 500
  `).all<any>()
  return c.json(results)
})

// ── API: Customer History (all jobs by phone OR name) ─────────────────────────
// v48: supports search by name or mobile — ledger search enhancement
app.get('/api/customers/history', authMiddleware, async (c) => {
  const mobile = c.req.query('mobile') || ''
  const name   = c.req.query('name')   || ''
  if (!mobile && !name) return c.json({ error: 'mobile or name required' }, 400)
  let q = `
    SELECT j.id, j.snap_name, j.snap_mobile, j.status, j.created_at,
           j.received_amount,
           (SELECT SUM(CASE WHEN status != 'returned' THEN charges * quantity ELSE 0 END) FROM machines WHERE job_id=j.id) AS total_charges,
           (SELECT COALESCE(SUM(quantity),0) FROM machines WHERE job_id=j.id) AS machine_count,
           (SELECT GROUP_CONCAT(product_name,', ') FROM machines WHERE job_id=j.id) AS products
    FROM jobs j WHERE `
  const params: any[] = []
  if (mobile) {
    q += `(j.snap_mobile=? OR j.snap_mobile2=?)`
    params.push(mobile, mobile)
  } else {
    q += `j.snap_name LIKE ?`
    params.push(`%${name}%`)
  }
  const from = c.req.query('from') || ''
  const to   = c.req.query('to')   || ''
  if (from) { q += ` AND DATE(j.created_at)>=?`; params.push(from) }
  if (to)   { q += ` AND DATE(j.created_at)<=?`; params.push(to) }
  q += ` ORDER BY j.created_at DESC LIMIT 200`
  const { results } = await c.env.DB.prepare(q).bind(...params).all<any>()
  return c.json(results)
})

// ── API: Customer Ledger Export ───────────────────────────────────────────────
app.get('/api/reports/ledger', authMiddleware, adminOnly, async (c) => {
  const mobile = c.req.query('mobile') || ''
  const name   = c.req.query('name')   || ''
  const from   = c.req.query('from')   || ''
  const to     = c.req.query('to')     || ''
  const mode   = c.req.query('mode')   || 'A'  // A=summary, B=with machines
  if (!mobile && !name) return c.json({ error: 'mobile or name required' }, 400)

  let jConds = ''
  const jParams: any[] = []
  if (mobile) {
    jConds = `WHERE (j.snap_mobile=? OR j.snap_mobile2=?)`
    jParams.push(mobile, mobile)
  } else {
    jConds = `WHERE j.snap_name LIKE ?`
    jParams.push(`%${name}%`)
  }
  if (from) { jConds += ` AND DATE(j.created_at)>=?`; jParams.push(from) }
  if (to)   { jConds += ` AND DATE(j.created_at)<=?`; jParams.push(to) }

  const { results: jobs } = await c.env.DB.prepare(`
    SELECT j.id AS job_number, j.snap_name AS customer, j.snap_mobile AS phone,
           j.status, j.received_amount AS received,
           (SELECT SUM(CASE WHEN status != 'returned' THEN charges * quantity ELSE 0 END) FROM machines WHERE job_id=j.id) AS amount,
           j.created_at AS date
    FROM jobs j ${jConds} ORDER BY j.created_at DESC
  `).bind(...jParams).all<any>()

  const wb = XLSX.utils.book_new()

  if (mode === 'B') {
    // Mode B: with machine details
    const rows: any[] = []
    for (const job of jobs) {
      const { results: machines } = await c.env.DB.prepare(
        `SELECT product_name, product_complaint, charges FROM machines WHERE job_id=?`
      ).bind(job.job_number).all<any>()
      if (machines.length) {
        machines.forEach((m: any, i: number) => {
          rows.push({
            'Job Number':   i === 0 ? job.job_number : '',
            'Date':         i === 0 ? job.date : '',
            'Customer':     i === 0 ? job.customer : '',
            'Machine':      m.product_name,
            'Complaint':    m.product_complaint || '',
            'Charges':      m.charges || 0,
            'Job Total':    i === 0 ? job.amount : '',
            'Received':     i === 0 ? job.received : '',
            'Due':          i === 0 ? job.due : '',
            'Status':       i === 0 ? job.status : '',
          })
        })
      } else {
        rows.push({ 'Job Number': job.job_number, 'Date': job.date, 'Customer': job.customer,
                    'Machine': '', 'Complaint': '', 'Charges': 0,
                    'Job Total': job.amount, 'Received': job.received, 'Due': job.due, 'Status': job.status })
      }
    }
    // Totals row
    const totalAmt = jobs.reduce((s: number, r: any) => s + (r.amount||0), 0)
    const totalRec = jobs.reduce((s: number, r: any) => s + (r.received||0), 0)
    rows.push({ 'Job Number': 'TOTAL', 'Job Total': totalAmt, 'Received': totalRec, 'Due': totalAmt - totalRec })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ledger With Machines')
  } else {
    // Mode A: summary
    const rows = jobs.map((r: any) => ({
      'Job Number': r.job_number, 'Date': r.date, 'Status': r.status,
      'Amount': r.amount || 0, 'Received': r.received || 0, 'Due': (r.amount||0) - (r.received||0),
    }))
    const totalAmt = jobs.reduce((s: number, r: any) => s + (r.amount||0), 0)
    const totalRec = jobs.reduce((s: number, r: any) => s + (r.received||0), 0)
    rows.push({ 'Job Number': 'TOTAL', 'Amount': totalAmt, 'Received': totalRec, 'Due': totalAmt - totalRec })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ledger Summary')
  }

  const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const fname = `AES_ledger_${mobile || name}_${new Date().toISOString().slice(0,10)}.xlsx`
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fname}"`
    }
  })
})

// ── API: Warranty Brand Report ────────────────────────────────────────────────
// v47: Download all machines repaired under warranty for a particular brand + date range
app.get('/api/reports/warranty-brand', authMiddleware, adminOnly, async (c) => {
  const brand = c.req.query('brand') || ''
  const from  = c.req.query('from')  || ''
  const to    = c.req.query('to')    || ''
  const status = c.req.query('status') || ''

  let q = `
    SELECT j.id AS job_id, j.snap_name AS customer_name, j.snap_mobile AS phone,
           j.snap_address AS address, j.status AS job_status,
           m.product_name, m.product_complaint, m.work_done,
           m.status AS machine_status, m.charges, m.quantity,
           m.warranty_brand AS brand,
           m.purchased_from, m.purchase_invoice_no, m.purchase_date,
           m.invoice_image_url,
           u.name AS assigned_staff,
           DATE(m.created_at) AS date_added,
           DATE(j.created_at) AS job_date
    FROM machines m
    JOIN jobs j ON m.job_id = j.id
    LEFT JOIN users u ON m.assigned_staff_id = u.id
    WHERE m.warranty_type = 'warranty'`
  const ps: any[] = []
  if (brand) { q += ' AND m.warranty_brand = ?'; ps.push(brand) }
  if (from)  { q += ' AND DATE(m.created_at) >= ?'; ps.push(from) }
  if (to)    { q += ' AND DATE(m.created_at) <= ?'; ps.push(to) }
  if (status) { q += ' AND m.status = ?'; ps.push(status) }
  q += ' ORDER BY m.created_at DESC'

  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()

  // Build summary row
  const totalMachines = results.length
  const totalCharges = results.reduce((s: number, r: any) => s + ((parseFloat(r.charges) || 0) * (parseInt(r.quantity) || 1)), 0)

  const wb = XLSX.utils.book_new()
  const rows = results.map((r: any) => ({
    'Job ID': r.job_id,
    'Job Date': r.job_date,
    'Customer': r.customer_name,
    'Phone': r.phone,
    'Address': r.address || '',
    'Product': r.product_name,
    'Complaint': r.product_complaint || '',
    'Work Done': r.work_done || '',
    'Brand': r.brand || '',
    'Purchased From': r.purchased_from || '',
    'Invoice No.': r.purchase_invoice_no || '',
    'Purchase Date': r.purchase_date || '',
    'Invoice Image': r.invoice_image_url ? `${c.req.url.split('/api/')[0]}${r.invoice_image_url}` : '',
    'Machine Status': r.machine_status,
    'Charges': r.charges || 0,
    'Qty': r.quantity || 1,
    'Line Total': (parseFloat(r.charges) || 0) * (parseInt(r.quantity) || 1),
    'Staff': r.assigned_staff || '',
    'Date Added': r.date_added,
  }))
  // Add totals row
  rows.push({ 'Job ID': 'TOTAL', 'Product': `${totalMachines} machines`, 'Line Total': totalCharges })
  const brandLabel = brand || 'All Brands'
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), `Warranty - ${brandLabel}`.slice(0, 31))
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_warranty_${brandLabel.replace(/\s+/g,'_')}_${date}.xlsx"`
    }
  })
})

// v50.9: Formatted brand warranty report — matches exact Ikonic/brand Excel template
// Columns: Sr.No, Date of complaint, Customer Name, Mobile, Product Model, Purchased From,
//          Customer Invoice No, Purchase Date, Warranty Status (fixed "In warranty"),
//          Product Problem, Spare Used (work_done), Date of Delivery, Repair Charge (fixed 150),
//          Invoice Image (URL link)
// No courier details table. Each row = 1 machine with warranty_type='warranty'
app.get('/api/reports/brand-warranty-formatted', authMiddleware, adminOnly, async (c) => {
  const brand = c.req.query('brand') || ''
  const from  = c.req.query('from')  || ''
  const to    = c.req.query('to')    || ''

  if (!brand) return c.json({ error: 'Brand parameter is required' }, 400)

  let q = `
    SELECT j.id AS job_id, j.snap_name AS customer_name, j.snap_mobile AS phone,
           j.created_at AS job_created,
           m.product_name, m.product_complaint, m.work_done,
           m.status AS machine_status,
           m.purchased_from, m.purchase_invoice_no, m.purchase_date,
           m.invoice_image_url,
           m.delivered_at AS machine_delivered_at,
           j.delivered_at AS job_delivered_at,
           m.quantity
    FROM machines m
    JOIN jobs j ON m.job_id = j.id
    WHERE m.warranty_type = 'warranty' AND m.warranty_brand = ?`
  const ps: any[] = [brand]

  // Date filter on job creation date (= "date of customer complaint")
  if (from) { q += ' AND DATE(j.created_at) >= ?'; ps.push(from) }
  if (to)   { q += ' AND DATE(j.created_at) <= ?'; ps.push(to) }

  q += ' ORDER BY j.created_at ASC'

  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()

  // Build base URL for invoice image links
  const reqUrl = c.req.url
  const baseUrl = reqUrl.includes('/api/') ? reqUrl.split('/api/')[0] : ''

  // Format date helper: "2025-10-01 00:00:00" → Date object for Excel
  const parseDate = (d: string | null) => {
    if (!d) return ''
    const dt = new Date(d)
    return isNaN(dt.getTime()) ? '' : dt
  }

  const wb = XLSX.utils.book_new()

  // Build header row manually for exact column control
  const headers = [
    'Sr. No.',
    'Date of customer complaint',
    'Customer Name',
    'Mobile no.',
    'Product Model Name',
    'Purchased From',
    'Customer Invoice No',
    'Purchase Date',
    'Warranty Status',
    'Product Problem',
    'Spare Used',
    'Date of Delivery',
    'Repair charge claimed to SSIZ',
    'Invoice Image'
  ]

  const rows: any[][] = [headers]

  // v50.9b: Expand each machine by its quantity — qty=3 becomes 3 separate rows
  let srNo = 0
  results.forEach((r: any) => {
    const qty = parseInt(r.quantity) || 1
    // Delivery date: prefer machine-level, then job-level
    const deliveryDate = r.machine_delivered_at || r.job_delivered_at || ''
    // Invoice image: full URL link
    const invoiceImgUrl = r.invoice_image_url ? `${baseUrl}${r.invoice_image_url}` : ''

    for (let q = 0; q < qty; q++) {
      srNo++
      rows.push([
        srNo,                                           // A: Sr. No.
        parseDate(r.job_created),                       // B: Date of customer complaint
        r.customer_name || '',                          // C: Customer Name
        r.phone || '',                                  // D: Mobile no.
        r.product_name || '',                           // E: Product Model Name
        r.purchased_from || '',                         // F: Purchased From
        r.purchase_invoice_no || '',                    // G: Customer Invoice No
        parseDate(r.purchase_date),                     // H: Purchase Date
        'In warranty',                                  // I: Warranty Status (fixed)
        r.product_complaint || '',                      // J: Product Problem
        r.work_done || '',                              // K: Spare Used
        parseDate(deliveryDate),                        // L: Date of Delivery
        150,                                            // M: Repair charge (fixed 150)
        invoiceImgUrl                                   // N: Invoice Image URL
      ])
    }
  })

  // Add totals row at end — sum of column M (total rows * 150)
  const totalDataRows = srNo
  if (totalDataRows > 0) {
    const totalRow: any[] = new Array(14).fill('')
    totalRow[12] = totalDataRows * 150  // Sum of repair charges (one 150 per expanded row)
    rows.push(totalRow)
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Set column widths to match Ikonic format
  ws['!cols'] = [
    { wch: 6 },    // A: Sr. No.
    { wch: 14 },   // B: Date of complaint
    { wch: 28 },   // C: Customer Name
    { wch: 14 },   // D: Mobile
    { wch: 22 },   // E: Product Model
    { wch: 22 },   // F: Purchased From
    { wch: 14 },   // G: Invoice No
    { wch: 14 },   // H: Purchase Date
    { wch: 14 },   // I: Warranty Status
    { wch: 22 },   // J: Product Problem
    { wch: 18 },   // K: Spare Used
    { wch: 14 },   // L: Delivery Date
    { wch: 16 },   // M: Repair Charge
    { wch: 40 },   // N: Invoice Image
  ]

  // Format date columns (B, H, L) as date
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    // Column B (index 1) — Date of complaint
    const bCell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: 1 })]
    if (bCell && bCell.v instanceof Date) { bCell.t = 'd'; bCell.z = 'yyyy-mm-dd' }
    // Column H (index 7) — Purchase Date
    const hCell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: 7 })]
    if (hCell && hCell.v instanceof Date) { hCell.t = 'd'; hCell.z = 'yyyy-mm-dd' }
    // Column L (index 11) — Delivery Date
    const lCell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: 11 })]
    if (lCell && lCell.v instanceof Date) { lCell.t = 'd'; lCell.z = 'yyyy-mm-dd' }
  }

  const sheetName = `${brand} Warranty Report`.slice(0, 31)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const dateStr = new Date().toISOString().slice(0, 10)
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  // Build filename like "October-'25 Job Details.xlsx" if date range available
  let fileName = `${brand}_warranty_${dateStr}.xlsx`
  if (from) {
    const fd = new Date(from)
    if (!isNaN(fd.getTime())) {
      const monthName = monthNames[fd.getMonth()]
      const yearShort = "'" + String(fd.getFullYear()).slice(2)
      fileName = `${monthName}-${yearShort} ${brand} Job Details.xlsx`
    }
  }

  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`
    }
  })
})

// v47: Warranty brand summary (JSON) for in-page preview
app.get('/api/reports/warranty-brand-summary', authMiddleware, adminOnly, async (c) => {
  const brand = c.req.query('brand') || ''
  const from  = c.req.query('from')  || ''
  const to    = c.req.query('to')    || ''

  let q = `
    SELECT m.warranty_brand AS brand, m.status,
           COUNT(*) AS cnt,
           SUM(m.charges * m.quantity) AS total_charges
    FROM machines m
    JOIN jobs j ON m.job_id = j.id
    WHERE m.warranty_type = 'warranty'`
  const ps: any[] = []
  if (brand) { q += ' AND m.warranty_brand = ?'; ps.push(brand) }
  if (from)  { q += ' AND DATE(m.created_at) >= ?'; ps.push(from) }
  if (to)    { q += ' AND DATE(m.created_at) <= ?'; ps.push(to) }
  q += ' GROUP BY m.warranty_brand, m.status ORDER BY m.warranty_brand, m.status'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  return c.json(results)
})

// v47: Bulk sync — return ALL jobs (lightweight) for offline cache
app.get('/api/jobs/sync', authMiddleware, async (c) => {
  const since = c.req.query('since') || '' // ISO date: only jobs updated after this
  const role  = c.get('userRole')
  const isAdmin = roleLevel(role) >= 2
  const userId  = c.get('userId')

  let q = `
    SELECT j.id, j.snap_name, j.snap_mobile, j.snap_mobile2, j.snap_address, j.snap_category, j.status, j.dispatch_method,
           j.received_amount, j.discount, j.payment_method, j.extra_charges, j.delivery_rating, j.created_at, j.updated_at,
           COALESCE((SELECT SUM(quantity) FROM machines WHERE job_id=j.id), 0) AS machine_count,
           COALESCE((SELECT SUM(charges * quantity) FROM machines WHERE job_id=j.id AND status != 'returned'), 0) + COALESCE(j.extra_charges, 0) AS total_charges,
           (SELECT mi.url FROM machine_images mi WHERE mi.machine_id IN
             (SELECT id FROM machines WHERE job_id=j.id LIMIT 1) LIMIT 1) AS thumb
    FROM jobs j`
  const conds: string[] = []
  const ps: any[] = []
  if (!isAdmin) {
    conds.push("j.status != 'delivered'")
  }
  if (since) {
    conds.push('j.updated_at > ?')
    ps.push(since)
  }
  if (conds.length) q += ` WHERE ${conds.join(' AND ')}`
  q += ' ORDER BY j.created_at DESC LIMIT 5000'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  return c.json(results.map((r: any) => ({
    ...r,
    balance_due: Math.max(0, (r.total_charges || 0) - (r.discount || 0) - (r.received_amount || 0))
  })))
})

// v47: Send login password to staff (admin only)
app.post('/api/staff/:id/send-password', authMiddleware, adminOnly, async (c) => {
  const staffId = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { password } = body
  if (!password || password.length < 4) return c.json({ error: 'Password must be at least 4 characters' }, 400)

  const hash = await bcrypt.hash(password, 10)
  await c.env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(hash, staffId).run()
  const staff = await c.env.DB.prepare('SELECT name, email FROM users WHERE id=?').bind(staffId).first<any>()
  if (!staff) return c.json({ error: 'Staff not found' }, 404)

  return c.json({ ok: true, message: `Password updated for ${staff.name}`, email: staff.email })
})

// ── API: Cleanup ──────────────────────────────────────────────────────────────
app.delete('/api/cleanup', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { from, to, full_reset } = body

  if (full_reset) {
    await c.env.DB.prepare('DELETE FROM job_history').run()
    await c.env.DB.prepare('DELETE FROM assignment_requests').run()
    await c.env.DB.prepare('DELETE FROM machine_images').run()
    await c.env.DB.prepare('DELETE FROM machines').run()
    await c.env.DB.prepare('DELETE FROM jobs').run()
    // NOTE: Customer data is NEVER deleted in cleanup — only job+machine data
    // await c.env.DB.prepare('DELETE FROM customers').run() — REMOVED
    await c.env.DB.prepare('UPDATE job_counter SET last_seq=0 WHERE id=1').run()
    return c.json({ ok: true, message: 'Full reset done — counter reset, customer data preserved' })
  }

  if (from && to) {
    const { results: jobIds } = await c.env.DB.prepare(
      `SELECT id FROM jobs WHERE DATE(created_at)>=? AND DATE(created_at)<=? AND status!='delivered'`
    ).bind(from, to).all<any>()

    let deleted = 0
    for (const { id } of jobIds) {
      const { results: imgs } = await c.env.DB.prepare(
        `SELECT mi.r2_object_key FROM machine_images mi
         JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=?`
      ).bind(id).all<any>()
      for (const img of imgs) {
        if (img.r2_object_key) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
      }
      await c.env.DB.prepare('DELETE FROM assignment_requests WHERE job_id=?').bind(id).run()
      await c.env.DB.prepare('DELETE FROM machines WHERE job_id=?').bind(id).run()
      await c.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()
      deleted++
    }
    return c.json({ ok: true, deleted })
  }
  return c.json({ error: 'Provide from/to dates or full_reset:true' }, 400)
})

// ── API: Bot Status Check (PUBLIC — read-only, used by WhatsApp bot) ────────
// v50.6: Returns job status JSON for a given job ID. Used by the external
// WhatsApp bot to answer customer status inquiries automatically.
app.get('/api/check-status', async (c) => {
  const jobId = (c.req.query('job') || '').trim()
  if (!jobId) return c.json({ error: 'job parameter required' }, 400)

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>()
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // Fetch machines for device summary
  const { results: machines } = await c.env.DB.prepare(`
    SELECT product_name, status, quantity, work_done FROM machines WHERE job_id=? ORDER BY id
  `).bind(jobId).all<any>()

  const machineCount = machines.reduce((s: number, m: any) => s + (parseInt(m.quantity) || 1), 0)
  const deviceNames = machines.map((m: any) => m.product_name).filter(Boolean).join(', ')
  const machineStatuses = machines.map((m: any) => ({
    product_name: m.product_name || '',
    status: m.status || 'pending',
    quantity: parseInt(m.quantity) || 1,
    work_done: m.work_done || ''
  }))

  return c.json({
    ok: true,
    job_id: job.id,
    customer_name: job.snap_name || '',
    device_names: deviceNames,
    status: job.status || 'received',
    machine_count: machineCount,
    machines: machineStatuses,
    created_at: job.created_at || '',
    delivered_at: job.delivered_at || '',
  })
})

// ── API: Customer Self-Tracking (PUBLIC — no auth) ──────────────────────────
app.get('/api/track', async (c) => {
  const jobId  = c.req.query('job')    || ''
  const mobile = c.req.query('mobile') || ''
  if (!jobId || !mobile) return c.json({ error: 'job and mobile parameters required' }, 400)

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>()
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // Validate mobile matches the job's customer
  const jobMobile  = (job.snap_mobile  || '').replace(/\D/g, '')
  const jobMobile2 = (job.snap_mobile2 || '').replace(/\D/g, '')
  const queryMob   = mobile.replace(/\D/g, '')
  if (queryMob !== jobMobile && queryMob !== jobMobile2 && '91' + queryMob !== jobMobile && queryMob !== '91' + jobMobile) {
    return c.json({ error: 'Mobile number does not match this job' }, 403)
  }

  // Return limited public info (no financial data, no staff info)
  const { results: machines } = await c.env.DB.prepare(`
    SELECT m.product_name, m.product_complaint, m.status, m.quantity, m.work_done,
           (SELECT json_group_array(json_object('url',mi.url)) FROM machine_images mi WHERE mi.machine_id=m.id) AS images_json
    FROM machines m WHERE m.job_id=? ORDER BY m.id
  `).bind(jobId).all<any>()

  const enriched = machines.map((m: any) => ({
    product_name: m.product_name,
    product_complaint: m.product_complaint,
    status: m.status,
    quantity: m.quantity,
    work_done: m.work_done,
    images: (() => { try { return JSON.parse(m.images_json || '[]') } catch { return [] } })()
  }))

  return c.json({
    id: job.id,
    customer_name: job.snap_name,
    status: job.status,
    created_at: job.created_at,
    delivered_at: job.delivered_at,
    machine_count: enriched.reduce((s: number, m: any) => s + (parseInt(m.quantity) || 1), 0),
    machines: enriched,
  })
})

// ── Static + SPA ──────────────────────────────────────────────────────────────
app.use('/static/*',      serveStatic({ root: './' }))
app.use('/icons/*',       serveStatic({ root: './public' }))
app.use('/sw.js',         serveStatic({ root: './public' }))
app.use('/manifest.json', serveStatic({ root: './public' }))
app.get('*', (c) => c.html(HTML_PAGE))

// ── HTML Shell ────────────────────────────────────────────────────────────────
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>ADITION ELECTRIC SOLUTION v31</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/static/style.css">
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body>
<div id="app"></div>
<script src="/static/app.js"></script>
</body>
</html>`

export default app
