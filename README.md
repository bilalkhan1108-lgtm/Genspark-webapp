# ADITION ELECTRIC SOLUTION — PWA v52.1

**Mobile-first PWA** for electric appliance repair shop management.  
Admin, Supervisor & Staff roles · Job tracking · R2 image storage · D1 SQLite DB · IndexedDB offline memory

---

## URLs
| Environment | URL |
|---|---|
| **Production** | https://adition-crm.pages.dev |
| **GitHub** | https://github.com/bilalkhan1108-lgtm/Genspark-webapp |

---

## What's New in v52.1

### Date-Aware Delivery Analytics
- **View delivery data for any day or month** — not just today
- Date selector row: **Today / This Month / Last Month / Custom Date Picker**
- All 5 delivery tiles update dynamically: Delivered, In-Person, By Courier, Cash, Online

### Clickable Delivery Tiles
- **Tap any delivery tile** to filter job list by that category
- Active tile inverts color (white text on colored background) with shadow
- Filter banner shows above job list with clear button
- Toggle: tap same tile again to deselect

### Staff Work Report — Status Filter
- New **Machine Status** dropdown: All / Under Repair / Repaired / Delivered / Returned
- Combined with existing staff selector and date range for precise productivity analysis

### Performance & Stability Fixes
- **App hang fix**: AbortController on mobile lookup + name suggest prevents freeze on paste/rapid input
- **Broken thumbnails fix**: onerror handler replaces failed images with tool icon
- **Request deduplication**: Prevents overlapping API calls from concurrent input events

---

## What's New in v52

### Delivery Analytics Dashboard (Admin)
- 5 tiles: **Delivered Today**, **In-Person**, **By Courier**, **Cash Today**, **Online Today**
- Now supports date/month selection (v52.1)

### Staff Work Report
- Staff selector dropdown to filter by specific staff member
- Status filter for Under Repair / Repaired / Delivered / Returned (v52.1)
- Excel export with SheetJS

### Staff Login — Job Tabs
- When staff taps "My Assigned Jobs", shows tabs: **Under Repair / Repaired / All**
- Default: Under Repair (shows active work)

### Concurrency & Performance (v52)
- **Atomic job counter**: `UPDATE...RETURNING` prevents duplicate job IDs
- **Optimistic locking**: `_updated_at` field check on PUT, 409 conflict with auto-refresh
- **Throttled render**: requestAnimationFrame prevents UI jank
- **Double-click protection**: Submit buttons disable on click with spinner

---

## What's New in v51.1

### 5-Star Delivery Rating
- Star rating UI in "Mark as Delivered" modal
- Click to rate 1-5, click same star to clear
- **Conditional Google Review link**: Only included in WhatsApp message if rating ≥ 4 stars

---

## Completed Features

### Authentication & Role-Based Access Control
- Email/password login with JWT (30-day expiry)
- **Admin** — full CRUD, financials, delivery, reports, staff management
- **Supervisor** — granular rights assigned by admin (view_jobs, edit_jobs, create_jobs, view_financials, deliver, download, share, manage_machines, view_reports, update_machine_status)
- **Staff** — no prices/financials visible, assignment requests only

### Dashboard (7 Summary Tiles + 5 Delivery Tiles)
- Status tiles: **No. of Jobs**, **Under Repair**, **Repaired**, **Partial**, **Delivered**, **Courier Pending**, **Urgent>25d**
- Delivery tiles: **Delivered**, **In Person**, **By Courier**, **Cash**, **Online** (clickable filters)
- Each tile tappable to filter jobs by that status
- Brand filter row: IKONIC, HNK, MARC, AYTY Pro
- Virtual list rendering — handles 500+ jobs lag-free

### Filter Panel
- Status filters: All, Under Repair, Repaired, Returned, Partial Delivered, Delivered, Active Only, Courier Pending
- **Pending Payment** filter — shows jobs with outstanding balance
- Date range filter (From/To)
- Quick filters: Today, This Month, Active Only, Courier Pending, Pending
- Delivery type filter (In Person / Courier) for delivered jobs

### Financial Management
- Discount/Deduction field, Payment Method (Online/Cash)
- Balance: `Total - Discount - Received = Balance Due`
- Revenue cards: Today, This Month, Total Earnings, Pending Dues

### Job Management
- Auto-generated job IDs (configurable prefix + digit format)
- Customer auto-fill + returning customer insights
- Per-machine repair amounts, work done notes, return reasons
- Product photo + voice note per machine
- Smart suggestion tiles (products, complaints, amounts)
- Dispatch method: In Person / Courier
- Extra charges with notes

### Staff Management
- Add/edit/delete staff with role selection
- Supervisor rights configuration
- Active/Inactive toggle, assignment request system

### Reports & Exports
- Staff work report (with staff & status filters)
- Full backup export/import (.xlsx)
- Job summary, customer data export, customer ledger

### WhatsApp Integration
- Job creation, repair completion, delivery confirmation messages
- Conditional Google Review link (rating ≥ 4)
- Customer reminder with 25-day notice
- WhatsApp Bot Integration for automated job card sharing

### PWA Features
- Installable on Android/iOS, push notifications
- Service worker offline caching, IndexedDB offline memory
- Compressed image upload (1080px, WebP preferred)

---

## API Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | — | Login |
| GET | `/api/auth/me` | Auth | Current user info |
| GET | `/api/analytics` | Auth | Dashboard stats (supports `del_date`, `del_month` params) |
| GET | `/api/jobs` | Auth | List jobs (status, search, date, staff_id, brand, del_method, del_date, del_month, pay_filter) |
| GET | `/api/jobs/pending-payment` | Admin | Jobs with outstanding balance |
| GET | `/api/jobs/delivered` | Admin | Delivered jobs with method/date filters |
| POST | `/api/jobs` | Auth | Create job (atomic counter) |
| GET | `/api/jobs/:id` | Auth | Job details with machines, images |
| PUT | `/api/jobs/:id` | Admin | Update job (optimistic locking with _updated_at) |
| DELETE | `/api/jobs/:id` | Admin | Delete job |
| POST | `/api/jobs/:id/machines` | Auth | Add machine |
| PUT | `/api/machines/:id` | Auth | Update machine status |
| POST | `/api/machines/:id/images` | Auth | Upload image |
| POST | `/api/machines/:id/audio` | Auth | Upload voice note |
| GET | `/api/staff` | Admin | List staff |
| POST | `/api/staff` | Admin | Create staff |
| PUT | `/api/staff/:id` | Admin | Update staff |
| DELETE | `/api/staff/:id` | Admin | Delete staff |
| GET | `/api/reports/staff` | Admin | Staff work report (supports staff_id, status params) |
| GET | `/api/settings` | Admin | App settings |
| PUT | `/api/settings` | Admin | Update settings |
| GET | `/api/check-status` | Public | Job status JSON |
| GET | `/api/track` | Public | Customer job tracking page |
| GET | `/api/customers/search` | Auth | Customer autocomplete |
| GET | `/api/backup/export` | Admin | Full data backup |
| POST | `/api/backup/import` | Admin | Restore data backup |

---

## Data Architecture
- **D1 Database**: users, customers, jobs, machines, machine_images, job_counter, app_settings, job_history, assignment_requests
- **R2 Storage**: Product images and voice notes
- **IndexedDB (Client)**: Offline cache for jobs, job details, analytics, staff
- **Key columns**: delivery_rating (INTEGER 0-5), delivery_method, payment_method, delivered_at, _updated_at (optimistic locking)

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
- **Project Name**: adition-crm
- **Status**: ✅ Active
- **Last Updated**: 2026-06-19
