# ADITION ELECTRIC SOLUTION — PWA v50.6

**Mobile-first PWA** for electric appliance repair shop management.  
Admin, Supervisor & Staff roles · Job tracking · R2 image storage · D1 SQLite DB · IndexedDB offline memory

---

## URLs
| Environment | URL |
|---|---|
| **Production** | https://adition-crm.pages.dev |
| **Sandbox (Dev)** | https://3000-itsteu7gob2nb2g5pp83m-dfc00ec5.sandbox.novita.ai |
| **GitHub** | https://github.com/bilalkhan1108-lgtm/Genspark-webapp |

---

## What's New in v35

### IndexedDB Offline Memory (Instant App Load)
- **All jobs cached in IndexedDB** — opens instantly with cached data on app launch
- **Job details cached** — detail pages render immediately from offline memory
- **Analytics cached** — dashboard tiles appear instantly
- **Staff list cached** — no wait for staff dropdown on detail pages
- **Background refresh** — silently fetches fresh data from API and updates if changed
- **No spinner on repeat visits** — data shows immediately, updates seamlessly
- Cache cleared on logout, manual refresh button also available

### Machine-Level Delivered Status
- **New machine status: "Delivered"** — added alongside Under Repair / Repaired / Returned
- When staff selects "Delivered" on a machine, a delivery modal asks:
  - **In Person** or **Courier** (same architecture as job-level delivery)
  - Receiver name, courier name, tracking ID (for courier)
- Each machine stores its own delivery_method, delivery_receiver_name, delivery_courier_name, delivered_at

### Auto Partial Delivered
- When some machines in a job are **delivered** but others are still under_repair/repaired, job status automatically becomes **partial_delivered**
- When **all** machines are delivered, job status becomes **delivered** with timestamp
- Dashboard "Partial" tile counts partial_delivered jobs

### Performance Optimizations
- **Virtual scroll row caching** — pre-builds all row HTML strings once, reuses on scroll
- **RAF-throttled scroll handler** — max 1 repaint per animation frame, eliminates jank
- **Backend SQL optimized** — faster thumb subquery, indexed queries
- **Event delegation** — no per-row click handlers, single delegated listener
- **Analytics 30s cache + IDB persistence** — avoids redundant API calls
- **Jobs list API: ~6ms**, **Job detail API: ~9ms**, **Analytics: ~51ms**

---

## Completed Features

### Authentication & Role-Based Access Control
- Email/password login with JWT (30-day expiry)
- **Admin** (bilalkhan1108@gmail.com / `0010`) — full CRUD, financials, delivery, reports, staff management
- **Supervisor** — replaces old "Manager" role; admin assigns granular rights from dashboard
  - Available rights: `view_jobs`, `edit_jobs`, `create_jobs`, `view_financials`, `deliver`, `download`, `share`, `manage_machines`, `view_reports`
- **Staff** — no prices/financials visible, assignment requests only

### Dashboard (7 Summary Tiles)
- Tiles: **No. of Jobs**, **Under Repair**, **Repaired**, **Returned**, **Partial**, **Delivered**, **Courier Pending**
- Each tile tappable to filter jobs by that status
- **Filter icon + Refresh button at the very top** of the dashboard
- Virtual list rendering — handles 500+ jobs lag-free
- 80ms debounce search for job ID, 100ms for name/mobile

### Filter Panel
- Status filters: All, Under Repair, Repaired, Returned, Partial Delivered, Delivered, Active Only, Courier Pending
- **Pending Payment** filter — shows jobs with outstanding balance
- Date range filter (From/To)
- Quick filters: Today, This Month, Active Only, Courier Pending, Pending
- Delivery type filter (In Person / Courier) for delivered jobs

### Financial Management
- **Discount/Deduction field** — editable above Received Amount on job detail
- **Payment Method dropdown** — Online / Cash (default: Cash) beside Received Amount
- Balance calculation: `Total - Discount - Received = Balance Due`
- Itemized product charges with per-line breakdown
- Revenue cards: Today, This Month, Total Earnings, Pending Dues

### Job Card (Print/Share)
- 1.5x font sizes for customer and product details
- Payment section: QR code, Payment Details, Notice Text, Tracking QR+Link
- Two notices on every job card
- Centered footer: "Subjected to Ahmedabad Jurisdiction only"

### Print Address Label
- Generates JPG at **101x152mm** resolution (2x quality canvas rendering)
- **To section**: Variable-size customer Name, Address, Mobile, Alt Mobile
- **From section** (+10pt font): ADITION ELECTRIC WORKS details with larger font
- Web Share API dialog on mobile, direct download on desktop

### Job Management
- Auto-generated job IDs (configurable prefix + digit format)
- Customer auto-fill from history + returning customer insights
- Per-machine repair amounts, itemized total
- Work done notes, return reasons
- Product photo + voice note per machine
- Smart suggestion tiles (products, complaints, amounts)
- **Dispatch through option**: In Person (default) or Courier with courier name

### Staff Management
- Add/edit/delete staff with role selection
- Supervisor rights configuration
- Active/Inactive toggle
- Assignment request system

### Reports & Exports
- Full backup export/import (.xlsx)
- Staff work report, job summary, customer data export
- Customer ledger, staff own jobs export

### WhatsApp Integration
- Job creation, repair completion, delivery confirmation
- Customer reminder with 25-day notice
- **v50.6: WhatsApp Bot Integration** — separate Node.js bot server for automated job card sharing
  - New **"Bot Send"** button (purple) next to existing WhatsApp button
  - Sends job card image + text message via bot automatically
  - Bot URL configurable in Settings > WhatsApp Bot section
  - Bot handles inbound auto-replies: business info, status checks in EN/HI/GU

### Public Customer Tracking
- `/track?job=ID&mobile=NUMBER` — public page, no auth required
- **v50.6: `/api/check-status?job=ID`** — public, returns job status JSON (used by WhatsApp bot)

### PWA Features
- Installable on Android/iOS home screen
- Push notification permission on login
- Service worker v35 for offline shell caching
- IndexedDB offline memory for instant data loading
- Compressed image upload (1080px, WebP preferred)

---

## API Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | — | Login |
| GET | `/api/auth/me` | Auth | Current user info |
| GET | `/api/analytics` | Auth | Dashboard stats |
| GET | `/api/jobs` | Auth | List jobs (status, search, date, staff_id filters) |
| GET | `/api/jobs/pending-payment` | Admin | Jobs with outstanding balance |
| GET | `/api/jobs/delivered` | Admin | Delivered jobs with filters |
| POST | `/api/jobs` | Auth | Create job |
| GET | `/api/jobs/:id` | Auth | Job details with machines, images |
| PUT | `/api/jobs/:id` | Admin | Update job |
| DELETE | `/api/jobs/:id` | Admin | Delete job |
| POST | `/api/jobs/:id/machines` | Auth | Add machine |
| PUT | `/api/machines/:id` | Auth | Update machine status (incl. delivered + delivery details) |
| DELETE | `/api/machines/:id` | Admin | Delete machine |
| POST | `/api/machines/:id/images` | Auth | Upload image |
| POST | `/api/machines/:id/audio` | Auth | Upload voice note |
| GET | `/api/staff` | Admin | List staff |
| POST | `/api/staff` | Admin | Create staff |
| PUT | `/api/staff/:id` | Admin | Update staff |
| DELETE | `/api/staff/:id` | Admin | Delete staff |
| GET | `/api/requests` | Admin | Assignment requests |
| POST | `/api/requests` | Staff | Request assignment |
| PUT | `/api/requests/:id` | Admin | Approve/deny request |
| GET | `/api/settings` | Admin | App settings |
| PUT | `/api/settings` | Admin | Update settings |
| GET | `/api/check-status` | Public | Bot status check (job status JSON) |
| GET | `/api/track` | Public | Customer job tracking |
| GET | `/api/customers/search` | Auth | Customer autocomplete |
| GET | `/api/customers/history` | Auth | Customer job history |
| GET | `/api/reports/*` | Admin | Various Excel exports |
| GET | `/api/backup/export` | Admin | Full data backup |
| POST | `/api/backup/import` | Admin | Restore data backup |

---

## Data Architecture
- **D1 Database**: users, customers, jobs, machines, machine_images, job_counter, app_settings, job_history, assignment_requests
- **R2 Storage**: Product images and voice notes
- **IndexedDB (Client)**: Offline cache for jobs, job details, analytics, staff
- **Key columns (v35)**:
  - `machines.delivery_method` — 'in_person' or 'courier'
  - `machines.delivery_receiver_name`, `delivery_courier_name`, `delivered_at`
  - `jobs.status` CHECK: under_repair, repaired, returned, partial_delivered, delivered
  - `machines.status` CHECK: under_repair, repaired, returned, delivered

## Tech Stack
- **Backend**: Hono + TypeScript + Cloudflare Workers
- **Frontend**: Vanilla JS + Tailwind CSS (CDN) + IndexedDB
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **Auth**: JWT (jose) + bcryptjs
- **Export**: SheetJS (xlsx)
- **Capture**: html2canvas

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: Active
- **Last Updated**: 2026-05-22
- **WhatsApp Bot**: Separate Node.js project — see `/home/user/whatsapp-bot/README.md`
