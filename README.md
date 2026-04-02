# ADITION ELECTRIC SOLUTION — PWA v26

**Mobile-first PWA** for electric appliance repair shop management.  
Admin, Supervisor & Staff roles · Job tracking · R2 image storage · D1 SQLite DB

---

## URLs
| Environment | URL |
|---|---|
| **Sandbox (Dev)** | https://3000-itsteu7gob2nb2g5pp83m-dfc00ec5.sandbox.novita.ai |
| **GitHub** | https://github.com/bilalkhan1108-lgtm/Genspark-webapp |

---

## Completed Features (v26)

### Authentication & Role-Based Access Control
- Email/password login with JWT (30-day expiry)
- **Admin** (bilalkhan1108@gmail.com / `0010`) — full CRUD, financials, delivery, reports, staff management
- **Supervisor** — replaces old "Manager" role; admin assigns granular rights from dashboard
  - Available rights: `view_jobs`, `edit_jobs`, `create_jobs`, `view_financials`, `deliver`, `download`, `share`, `manage_machines`, `view_reports`
- **Staff** — no prices/financials visible, assignment requests only

### Dashboard (6 Summary Tiles)
- Tiles below menu bar: **No. of Jobs**, **Under Repair**, **Repaired**, **Returned**, **Partial**, **Delivered**
- Each tile is tappable to filter jobs by that status
- Virtual list rendering — handles 500+ jobs lag-free
- 300ms debounce search, persistent URL filter

### Filter Panel
- Status filters: All, Under Repair, Repaired, Returned, Partial Delivered, Delivered
- **Pending Payment** filter — shows jobs with outstanding balance
- Date range filter (From/To)
- Quick filters: Today, This Month, Pending
- Delivery type filter (In Person / Courier) for delivered jobs

### Financial Management
- **Discount/Deduction field** — editable above Received Amount on job detail
- **Payment Method dropdown** — Online / Cash (default: Cash) beside Received Amount
- Balance calculation: `Total - Discount - Received = Balance Due`
- Itemized product charges with per-line breakdown
- Revenue cards: Today, This Month, Total Earnings, Pending Dues

### Job Card (Print/Share)
- **1.5× font sizes** for customer details (name: 30px, mobile: 27px, address: 21px)
- **1.5× font sizes** for product details (name: 26px, complaint: 20px, price: 26px)
- **Payment section layout**: QR code → Payment Details → Notice Text → Tracking QR+Link
- **Two notices** on every job card:
  1. Damaged/replacement parts will NOT be returned to the customer
  2. Any damage or loss during repair is the customer's responsibility
- **Centered footer**: "Subjected to Ahmedabad Jurisdiction only" in readable format
- Discount and payment method shown in financial summary

### Print Address Label
- Generates JPG at **101×152mm** resolution (2× quality canvas rendering)
- **To section** (14pt): Variable-size customer Name, Address, Mobile, Alt Mobile
- **From section** (10pt name / 8pt address): Fixed ADITION ELECTRIC WORKS details
- Opens **Web Share API dialog** on mobile (for admin app selection)
- Falls back to direct download on desktop

### Auto-Download Delivered Job Card
- When a job status becomes **Delivered** (after Repair/Return), auto-generates and downloads `Job [Job No.] Delivered.jpg`
- Uses `sessionStorage` to prevent duplicate downloads within the same session
- Non-blocking: runs 800ms after delivery confirmation

### Job Management
- Auto-generated job IDs (configurable prefix + digit format)
- Customer auto-fill from history + returning customer insights
- Per-machine repair amounts, itemized total
- Work done notes, return reasons
- Product photo + voice note per machine
- Smart suggestion tiles (products, complaints, amounts)

### Staff Management
- Add/edit/delete staff with role selection: Staff, Supervisor, Admin
- Supervisor rights configuration via checkboxes
- Active/Inactive toggle
- Assignment request system: staff request, admin approve/deny

### Reports & Exports
- Full backup export/import (.xlsx)
- Staff work report with date range filter
- Job summary with revenue data
- Customer data export
- Customer ledger (summary or detailed with machines)
- Staff: own jobs export

### WhatsApp Integration
- Job creation confirmation with product list, amounts, tracking link
- Repair completion notification with payment details
- Delivery confirmation
- Customer reminder with 25-day notice
- WhatsApp community link in all messages

### Public Customer Tracking
- `/track?job=ID&mobile=NUMBER` — public page, no auth required
- Shows job status, machine list, work done details
- QR code on job card links directly to tracking page

### PWA Features
- Installable on Android/iOS home screen
- Push notification permission on login
- Service worker for offline shell caching
- Compressed image upload (1080px, WebP preferred)

---

## API Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | — | Login |
| GET | `/api/auth/me` | Auth | Current user info (includes supervisor_rights) |
| GET | `/api/analytics` | Auth | Dashboard stats (includes partial count) |
| GET | `/api/jobs` | Auth | List jobs (status, search, date, staff_id filters) |
| GET | `/api/jobs/pending-payment` | Admin | Jobs with outstanding balance |
| GET | `/api/jobs/delivered` | Admin | Delivered jobs with filters |
| POST | `/api/jobs` | Auth | Create job |
| GET | `/api/jobs/:id` | Auth | Job details with machines, images |
| PUT | `/api/jobs/:id` | Admin | Update (includes discount, payment_method) |
| DELETE | `/api/jobs/:id` | Admin | Delete job |
| POST | `/api/jobs/:id/machines` | Auth | Add machine |
| PUT | `/api/machines/:id` | Auth | Update machine status |
| DELETE | `/api/machines/:id` | Admin | Delete machine |
| POST | `/api/machines/:id/images` | Auth | Upload image |
| POST | `/api/machines/:id/audio` | Auth | Upload voice note |
| GET | `/api/staff` | Admin | List staff (includes supervisor_rights) |
| POST | `/api/staff` | Admin | Create staff (supports supervisor_rights) |
| PUT | `/api/staff/:id` | Admin | Update staff (supports supervisor_rights) |
| DELETE | `/api/staff/:id` | Admin | Delete staff |
| GET | `/api/requests` | Admin | Assignment requests |
| POST | `/api/requests` | Staff | Request assignment |
| PUT | `/api/requests/:id` | Admin | Approve/deny request |
| GET | `/api/settings` | Admin | App settings |
| PUT | `/api/settings` | Admin | Update settings |
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
- **New columns (v26)**:
  - `users.supervisor_rights` — JSON array of granted rights
  - `jobs.discount` — Discount/deduction amount
  - `jobs.payment_method` — 'cash' (default) or 'online'

## Tech Stack
- **Backend**: Hono + TypeScript + Cloudflare Workers
- **Frontend**: Vanilla JS + Tailwind CSS (CDN)
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **Auth**: JWT (jose) + bcryptjs
- **Export**: SheetJS (xlsx)
- **Capture**: html2canvas

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: Active
- **Last Updated**: 2026-04-02
