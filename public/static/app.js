// ╔══════════════════════════════════════════════════════════════════════╗
// ║  ADITION ELECTRIC SOLUTION — PWA Frontend v41                       ║
// ║  v41: Turbo search overhaul (instant client+server), job card      ║
// ║  image reliability fix, performance boost, repair-shop features    ║
// ╚══════════════════════════════════════════════════════════════════════╝
;(function () {
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  token  : localStorage.getItem('AES_TOKEN') || null,
  user   : (() => { try { return JSON.parse(localStorage.getItem('AES_USER') || 'null') } catch { return null } })(),
  view   : (() => {
    // If already logged in, go to dashboard; otherwise login
    const tok = localStorage.getItem('AES_TOKEN');
    const usr = (() => { try { return JSON.parse(localStorage.getItem('AES_USER') || 'null') } catch { return null } })();
    return (tok && usr) ? 'dashboard' : 'login';
  })(),
  jobId  : null,
  jobs   : [],
  job    : null,
  staff  : [],
  requests: [],
  filter : new URLSearchParams(window.location.search).get('status') || '',
  search : '',
  searchJob : '',
  searchName: '',
  fromDate: '',
  toDate  : '',
  myJobsOnly: false,
  audioStream  : null,
  audioRecorder: null,
  audioChunks  : [],
};

const CARD_H = 88;

// ─────────────────────────────────────────────────────────────────────────────
// v39: OFFLINE DETECTION & READ-ONLY MODE
// Monitors navigator.onLine + real connectivity. When offline, the entire UI
// becomes read-only: mutating buttons are hidden, a persistent banner shows.
// When back online, everything restores seamlessly.
// ─────────────────────────────────────────────────────────────────────────────
let _isOffline = !navigator.onLine;

function _showOfflineBanner() {
  let banner = document.getElementById('aes-offline-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'aes-offline-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:linear-gradient(135deg,#E53935,#C62828);color:#fff;text-align:center;padding:6px 16px;font-size:13px;font-weight:800;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 2px 12px rgba(0,0,0,.3);transition:transform .3s ease;animation:offlinePulse 2s infinite';
    banner.innerHTML = '<i class="fas fa-wifi-slash" style="font-size:14px"></i> Offline — View Only';
    // Add keyframe animation
    if (!document.getElementById('aes-offline-style')) {
      const style = document.createElement('style');
      style.id = 'aes-offline-style';
      style.textContent = `
        @keyframes offlinePulse { 0%,100%{opacity:1} 50%{opacity:.85} }
        .aes-offline-hidden { display:none !important; }
        .app-header { transition: margin-top .3s ease; }
        body.aes-offline .app-header { margin-top:33px; }
        body.aes-offline .bottom-nav { pointer-events:auto; }
      `;
      document.head.appendChild(style);
    }
    document.body.prepend(banner);
  }
  banner.style.display = '';
  document.body.classList.add('aes-offline');
  // Push header down so banner doesn't overlap
  _lockMutatingUI(true);
}

function _hideOfflineBanner() {
  const banner = document.getElementById('aes-offline-banner');
  if (banner) banner.style.display = 'none';
  document.body.classList.remove('aes-offline');
  _lockMutatingUI(false);
}

// Show brief "Back Online" toast when reconnecting
function _showOnlineToast() {
  let el = document.getElementById('aes-online-toast');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'aes-online-toast';
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10001;background:linear-gradient(135deg,#43A047,#2E7D32);color:#fff;text-align:center;padding:6px 16px;font-size:13px;font-weight:800;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 2px 12px rgba(0,0,0,.3);animation:toastIn .22s ease';
  el.innerHTML = '<i class="fas fa-wifi" style="font-size:14px"></i> Back Online';
  document.body.prepend(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 2500);
}

// v39: Hide/show mutating (write) UI elements based on offline state
// Instead of removing DOM elements, we use a CSS class to hide them
function _lockMutatingUI(lock) {
  // Selectors for ALL buttons/elements that perform write operations
  const mutatingSelectors = [
    '#btn-add-machine', '#btn-batch-select', '#btn-deliver', '#btn-share',
    '#btn-wa-reminder', '#btn-del-job', '#btn-edit-customer', '#btn-print-addr',
    '#recv-save', '#discount-input', '#recv-input', '#pay-method',
    '#btn-jobcard',  // download requires network for image fetch
    '.batch-action-btn', '#batch-bar',
    // New Job tab should be hidden entirely in bottom nav
    '[data-nav="newjob"]',
    // Settings mutating items
    '#set-reset', '#set-cleanup', '#btn-save-prefix',
    // Requests tab
    '[data-nav="requests"]',
    // Staff panel write actions
    '#btn-add-staff',
    // Dashboard refresh (can't fetch when offline)
    '#btn-refresh-jobs',
    // Machine card edit/delete buttons
    '.mc-edit-btn', '.mc-del-btn',
    // Image upload buttons
    '.cam-upload-btn', '.cam-btn',
    // Audio record buttons
    '.audio-record-btn',
    // Status dropdowns on machine cards
    '.mc-status-select',
  ];
  document.querySelectorAll(mutatingSelectors.join(',')).forEach(el => {
    if (lock) el.classList.add('aes-offline-hidden');
    else      el.classList.remove('aes-offline-hidden');
  });
}

// Check actual connectivity (navigator.onLine can lie on some networks)
async function _checkRealConnectivity() {
  if (!navigator.onLine) return false;
  try {
    const resp = await fetch('/api/health', { method: 'HEAD', cache: 'no-store' });
    return resp.ok;
  } catch { return false; }
}

function _handleOfflineChange(offline) {
  const wasOffline = _isOffline;
  _isOffline = offline;
  if (offline) {
    _showOfflineBanner();
    // If on dashboard, load from IndexedDB cache
    if (S.view === 'dashboard' && (!S.jobs || !S.jobs.length)) {
      IDB.loadAllJobs().then(jobs => {
        if (jobs.length) { S.jobs = jobs; renderVList(false); }
      });
    }
  } else {
    _hideOfflineBanner();
    if (wasOffline) {
      _showOnlineToast();
      // Silently refresh current view data in background
      if (S.view === 'dashboard') { loadJobs(); }
      else if (S.view === 'detail' && S.jobId) { loadDetail(); }
    }
  }
}

// Listen for browser online/offline events
window.addEventListener('online',  () => _handleOfflineChange(false));
window.addEventListener('offline', () => _handleOfflineChange(true));

// Initial check on boot — delay to let SW register first
setTimeout(() => { if (!navigator.onLine) _handleOfflineChange(true); }, 500);

// ─────────────────────────────────────────────────────────────────────────────
// SMART SUGGESTIONS CACHE (localStorage-backed)
// ─────────────────────────────────────────────────────────────────────────────
const _sugCache = {
  _key: 'AES_SMART_SUGGESTIONS_V2',
  _data: null,
  load() {
    if (this._data) return this._data;
    try { this._data = JSON.parse(localStorage.getItem(this._key) || '{}'); }
    catch { this._data = {}; }
    if (!this._data.products)   this._data.products   = [];
    if (!this._data.complaints) this._data.complaints = [];
    if (!this._data.amounts)    this._data.amounts    = [];
    if (!this._data.prodMap)    this._data.prodMap     = {}; // product→[complaints]
    if (!this._data.amtMap)     this._data.amtMap      = {}; // product→[amounts]
    return this._data;
  },
  save() { try { localStorage.setItem(this._key, JSON.stringify(this._data)); } catch {} },
  addProduct(name) {
    if (!name) return;
    const d = this.load();
    d.products = [name, ...d.products.filter(p => p !== name)].slice(0, 30);
    this.save();
  },
  addComplaint(comp, product) {
    if (!comp) return;
    const d = this.load();
    d.complaints = [comp, ...d.complaints.filter(c => c !== comp)].slice(0, 30);
    if (product) {
      if (!d.prodMap[product]) d.prodMap[product] = [];
      d.prodMap[product] = [comp, ...d.prodMap[product].filter(c => c !== comp)].slice(0, 10);
    }
    this.save();
  },
  addAmount(amt, product) {
    if (!amt || amt <= 0) return;
    const d = this.load();
    d.amounts = [amt, ...d.amounts.filter(a => a !== amt)].slice(0, 20);
    if (product) {
      if (!d.amtMap[product]) d.amtMap[product] = [];
      d.amtMap[product] = [amt, ...d.amtMap[product].filter(a => a !== amt)].slice(0, 8);
    }
    this.save();
  },
  getProducts(q) {
    const d = this.load();
    if (!q) return d.products.slice(0, 12);
    const lq = q.toLowerCase();
    return d.products.filter(p => p.toLowerCase().includes(lq)).slice(0, 12);
  },
  getComplaints(product) {
    const d = this.load();
    if (product && d.prodMap[product]?.length) return d.prodMap[product];
    return d.complaints.slice(0, 10);
  },
  getAmounts(product) {
    const d = this.load();
    if (product && d.amtMap[product]?.length) return d.amtMap[product];
    return d.amounts.slice(0, 10);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// INDEXEDDB OFFLINE MEMORY — instant app load
// Stores jobs list + job details persistently; renders cached data on app open
// before any network request, then silently refreshes in background.
// ─────────────────────────────────────────────────────────────────────────────
const IDB = {
  _db: null,
  _dbReady: null,
  DB_NAME: 'AES_OFFLINE_V2',
  DB_VER: 2,
  STORE_JOBS: 'jobs',
  STORE_DETAILS: 'details',
  STORE_META: 'meta',

  init() {
    if (this._dbReady) return this._dbReady;
    this._dbReady = new Promise((resolve, reject) => {
      if (!window.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(this.DB_NAME, this.DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE_JOBS)) {
          db.createObjectStore(this.STORE_JOBS, { keyPath: 'cacheKey' });
        }
        if (!db.objectStoreNames.contains(this.STORE_DETAILS)) {
          db.createObjectStore(this.STORE_DETAILS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(this.STORE_META)) {
          db.createObjectStore(this.STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => resolve(null);
    });
    return this._dbReady;
  },

  async _tx(store, mode) {
    const db = await this.init();
    if (!db) return null;
    try {
      return db.transaction(store, mode).objectStore(store);
    } catch { return null; }
  },

  // Save jobs list for a given filter key
  async saveJobs(filterKey, jobs) {
    const os = await this._tx(this.STORE_JOBS, 'readwrite');
    if (!os) return;
    try {
      os.put({ cacheKey: filterKey || '_all', ts: Date.now(), data: jobs.slice(0, 200) });
    } catch {}
  },

  // Load jobs list for a given filter key
  // v36: Always return cached data (no expiry) — WhatsApp-like instant load
  async loadJobs(filterKey) {
    const os = await this._tx(this.STORE_JOBS, 'readonly');
    if (!os) return null;
    return new Promise(resolve => {
      const req = os.get(filterKey || '_all');
      req.onsuccess = () => {
        const r = req.result;
        if (!r || !r.data) { resolve(null); return; }
        resolve(r.data); // Always return — stale or fresh, user sees data instantly
      };
      req.onerror = () => resolve(null);
    });
  },

  // Save full job detail
  async saveDetail(job) {
    if (!job || !job.id) return;
    const os = await this._tx(this.STORE_DETAILS, 'readwrite');
    if (!os) return;
    try {
      os.put({ ...job, _cachedAt: Date.now() });
    } catch {}
  },

  // Load cached job detail
  async loadDetail(jobId) {
    if (!jobId) return null;
    const os = await this._tx(this.STORE_DETAILS, 'readonly');
    if (!os) return null;
    return new Promise(resolve => {
      const req = os.get(jobId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },

  // Save analytics cache
  async saveMeta(key, value) {
    const os = await this._tx(this.STORE_META, 'readwrite');
    if (!os) return;
    try { os.put({ key, value, ts: Date.now() }); } catch {}
  },

  async loadMeta(key) {
    const os = await this._tx(this.STORE_META, 'readonly');
    if (!os) return null;
    return new Promise(resolve => {
      const req = os.get(key);
      req.onsuccess = () => resolve(req.result?.value || null);
      req.onerror = () => resolve(null);
    });
  },

  // Bulk save all job details from the jobs list (for instant detail view)
  async bulkSaveDetails(jobs) {
    const db = await this.init();
    if (!db || !jobs?.length) return;
    try {
      const tx = db.transaction(this.STORE_DETAILS, 'readwrite');
      const os = tx.objectStore(this.STORE_DETAILS);
      for (const j of jobs) {
        if (j && j.id) os.put({ ...j, _cachedAt: Date.now(), _listCache: true });
      }
    } catch {}
  },

  // v36: Load ALL cached job details for offline mode (WhatsApp-like)
  async loadAllDetails() {
    const db = await this.init();
    if (!db) return [];
    return new Promise(resolve => {
      try {
        const tx = db.transaction(this.STORE_DETAILS, 'readonly');
        const os = tx.objectStore(this.STORE_DETAILS);
        const req = os.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  },

  // v36: Load ALL cached job lists (all filter keys)
  async loadAllJobs() {
    const db = await this.init();
    if (!db) return [];
    return new Promise(resolve => {
      try {
        const tx = db.transaction(this.STORE_JOBS, 'readonly');
        const os = tx.objectStore(this.STORE_JOBS);
        const req = os.getAll();
        req.onsuccess = () => {
          const results = req.result || [];
          // Merge all cached job lists, deduplicate by id
          const jobMap = new Map();
          for (const r of results) {
            if (r.data && Array.isArray(r.data)) {
              for (const j of r.data) {
                if (j && j.id) jobMap.set(j.id, j);
              }
            }
          }
          resolve(Array.from(jobMap.values()));
        };
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  },

  // Save staff list for offline
  async saveStaff(staff) {
    await this.saveMeta('staff', staff);
  },
  async loadStaff() {
    return await this.loadMeta('staff');
  },

  // Clear all cached data
  async clear() {
    const db = await this.init();
    if (!db) return;
    try {
      db.transaction(this.STORE_JOBS, 'readwrite').objectStore(this.STORE_JOBS).clear();
      db.transaction(this.STORE_DETAILS, 'readwrite').objectStore(this.STORE_DETAILS).clear();
      db.transaction(this.STORE_META, 'readwrite').objectStore(this.STORE_META).clear();
    } catch {}
  }
};

// Initialize IndexedDB immediately on script load (non-blocking)
IDB.init();

// Build suggestion tile HTML — scrollable horizontal row, tappable
function suggestionTilesHTML(items, targetId, extraClass) {
  if (!items || !items.length) return '';
  return `<div class="sug-tiles ${extraClass||''}" data-target="${targetId}" style="display:flex;flex-wrap:nowrap;gap:6px;margin-top:6px;overflow-x:auto;overflow-y:hidden;padding:4px 0;-webkit-overflow-scrolling:touch;scroll-behavior:smooth;scrollbar-width:none">
    ${items.map(v => `<span class="sug-tile" data-val="${esc(String(v))}" style="background:#f0f4ff;color:#1a1a2e;border:1px solid #d0d8f0;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;user-select:none;transition:background .15s,transform .1s;flex-shrink:0;-webkit-tap-highlight-color:transparent">${esc(String(v))}</span>`).join('')}
  </div>`;
}

// Wire suggestion tiles — clicking sets value, animates, moves cursor to next field
function bindSuggestionTiles(container, onSelect) {
  (container || document).querySelectorAll('.sug-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const target = document.getElementById(tile.closest('.sug-tiles')?.dataset.target);
      if (target) {
        if (target.tagName === 'TEXTAREA') {
          const cur = target.value.trim();
          target.value = cur ? cur + ', ' + tile.dataset.val : tile.dataset.val;
        } else {
          target.value = tile.dataset.val;
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        // Visual feedback
        tile.style.background = '#E8F5E9'; tile.style.borderColor = '#43A047';
        tile.style.transform = 'scale(0.92)';
        setTimeout(() => { tile.style.background = '#f0f4ff'; tile.style.borderColor = '#d0d8f0'; tile.style.transform = ''; }, 350);
        // Auto-focus next field
        autoFocusNext(target);
      }
      if (onSelect) onSelect(tile.dataset.val, target);
    }, { passive: true });
  });
}

// Auto-focus next logical input field
function autoFocusNext(currentEl) {
  if (!currentEl) return;
  const form = currentEl.closest('.modal-sheet') || currentEl.closest('.card') || document;
  const fields = Array.from(form.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea,select'));
  const idx = fields.indexOf(currentEl);
  if (idx >= 0 && idx < fields.length - 1) {
    setTimeout(() => { fields[idx + 1]?.focus(); fields[idx + 1]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); }, 120);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────
const API = axios.create({ baseURL: '/' });
API.interceptors.request.use(cfg => {
  if (S.token) cfg.headers.Authorization = 'Bearer ' + S.token;
  return cfg;
});
API.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) logout();
  return Promise.reject(err);
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// Role hierarchy: admin(4) > director(3) > manager(2) > staff(1)
const ROLE_LEVELS = { admin: 4, director: 3, manager: 2, staff: 1 };
const roleLevel = (r) => ROLE_LEVELS[r] || 0;
const isAdmin   = () => roleLevel(S.user?.role) >= 2; // manager and above
const isAdminOnly = () => S.user?.role === 'admin'; // only admin
const isDirector = () => S.user?.role === 'admin' || S.user?.role === 'director';
const isStaff   = () => S.user?.role === 'staff';
function hasSuperRight(right) {
  if (roleLevel(S.user?.role) >= 2) return true; // admin/director/manager have all rights
  if (S.user?.role === 'staff') {
    try {
      const rights = typeof S.user.supervisor_rights === 'string' ? JSON.parse(S.user.supervisor_rights) : (S.user.supervisor_rights || []);
      return rights.includes(right);
    } catch { return false; }
  }
  return false;
}
// Role display labels
const ROLE_LABEL = { admin: 'Admin', director: 'Director', manager: 'Manager', staff: 'Staff' };
const roleLabel = (r) => ROLE_LABEL[r] || r;
const fmtRs   = n => '₹' + (parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '';
const esc     = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const STATUS_COLOR = { under_repair:'#E53935', repaired:'#43A047', returned:'#B8860B', partial_delivered:'#FF6F00', delivered:'#1E88E5', active_only:'#2E7D32', courier_pending:'#7B1FA2' };
const STATUS_BG    = { under_repair:'#FFEBEE', repaired:'#E8F5E9', returned:'#FFF8E1', partial_delivered:'#FFF3E0', delivered:'#E3F2FD', active_only:'#E8F5E9', courier_pending:'#F3E5F5' };
const STATUS_LABEL = { under_repair:'Under Repair', repaired:'Repaired', returned:'Returned', partial_delivered:'Partial Delivered', delivered:'Delivered', active_only:'Active Only', courier_pending:'Courier Pending' };
const sc = s => STATUS_COLOR[s] || '#888';
const sb = s => STATUS_BG[s]    || '#f5f5f5';
const sl = s => STATUS_LABEL[s] || s;

// v41: Smarter debounce — cancellable, returns promise
function debounce(fn, ms = 150) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// v41: REQUEST DEDUPLICATION — prevents duplicate concurrent API calls
// Also cancels stale requests when search terms change
const _pendingRequests = new Map();
let _lastSearchSeq = 0; // Monotonic counter to detect stale API responses
function dedupeGet(url, params) {
  const key = url + JSON.stringify(params || {});
  if (_pendingRequests.has(key)) return _pendingRequests.get(key);
  const promise = API.get(url, { params }).finally(() => _pendingRequests.delete(key));
  _pendingRequests.set(key, promise);
  return promise;
}

// v41: INSTANT CLIENT-SIDE SEARCH — filters already-loaded jobs before API call
// Searches job ID, customer name, AND mobile number
let _allLoadedJobs = []; // Master cache of all jobs seen in this session
let _allJobsFullyLoaded = false; // True when we've loaded ALL jobs (not just first page)

function _clientSideFilter(jobs, searchJob, searchName) {
  if (!searchJob && !searchName) return null; // No filter active
  const sjLower = searchJob ? searchJob.toLowerCase() : '';
  const snLower = searchName ? searchName.toLowerCase() : '';
  return jobs.filter(j => {
    if (sjLower && !(j.id || '').toLowerCase().includes(sjLower)) return false;
    if (snLower) {
      const name = (j.snap_name || '').toLowerCase();
      const mobile = (j.snap_mobile || '');
      if (!name.includes(snLower) && !mobile.includes(snLower)) return false;
    }
    return true;
  });
}

// v41: Pre-populate master cache from IndexedDB on startup for instant first-search
async function _warmupSearchCache() {
  try {
    const allCached = await IDB.loadAllJobs();
    if (allCached && allCached.length) {
      for (const j of allCached) {
        const idx = _allLoadedJobs.findIndex(x => x.id === j.id);
        if (idx >= 0) _allLoadedJobs[idx] = j;
        else _allLoadedJobs.push(j);
      }
    }
  } catch {}
}

// Toast
function toast(msg, type = 'info') {
  document.querySelectorAll('.aes-toast').forEach(t => t.remove());
  const el = Object.assign(document.createElement('div'), { className: 'aes-toast', textContent: msg });
  const bg = type === 'error' ? '#C62828' : type === 'success' ? '#2E7D32' : '#1565C0';
  el.style.cssText = `position:fixed;bottom:82px;left:50%;transform:translateX(-50%);
    background:${bg};color:#fff;padding:11px 22px;border-radius:12px;z-index:9999;
    font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.35);
    max-width:90vw;text-align:center;animation:toastIn .22s ease;pointer-events:none;
    will-change:transform,opacity;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Scroll lock
function lockScroll()   { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; }
function unlockScroll() { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; }

// Modal
function showModal(html) {
  closeModal();
  lockScroll();
  const ov = document.createElement('div');
  ov.id = 'aes-modal';
  ov.innerHTML = `<div class="modal-sheet" style="will-change:transform,opacity">${html}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  ov.querySelector('.modal-sheet')?.addEventListener('touchmove', e => e.stopPropagation(), { passive: false });
  // Animate in
  requestAnimationFrame(() => {
    const sheet = ov.querySelector('.modal-sheet');
    if (sheet) { sheet.style.transform = 'translateY(0)'; sheet.style.opacity = '1'; }
  });
}
function closeModal() {
  document.getElementById('aes-modal')?.remove();
  unlockScroll();
  stopAudioRecorder();
}
window.closeModal = closeModal;
window.showJobHistory = showJobHistory;
window.navigate = navigate;
window.S = S;
// Expose global helpers used in inline onclick attributes
window.setFilter  = setFilter;
window.filterAll       = function() { setFilter('');             S.fromDate = ''; S.toDate = ''; _analyticsCacheTs = 0; loadJobs(); };
window.filterActive    = function() { setFilter('under_repair'); S.fromDate = ''; S.toDate = ''; loadJobs(); };
window.filterDone      = function() { setFilter('delivered');    S.fromDate = ''; S.toDate = ''; loadJobs(); };
window.filterByStatus  = function(st) { setFilter(st); S.fromDate = ''; S.toDate = ''; loadJobs(); };
window.filterToday  = function() {
  const t = new Date().toISOString().split('T')[0];
  setFilter(''); S.fromDate = t; S.toDate = t; loadJobs();
};
window.filterMonth  = function() {
  const now = new Date();
  const ms  = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
  const me  = now.toISOString().split('T')[0];
  setFilter(''); S.fromDate = ms; S.toDate = me; loadJobs();
};
// Active Only: show only jobs where NOT all machines are repaired/returned
window.filterActiveOnly = function() {
  setFilter('active_only'); S.fromDate = ''; S.toDate = ''; loadJobs();
};
// Courier Pending: show jobs dispatched via courier, not yet delivered
window.filterCourierPending = function() {
  setFilter('courier_pending'); S.fromDate = ''; S.toDate = ''; loadJobs();
};
// v41: Urgent: show active jobs older than 25 days — filter client-side from master cache
window.filterUrgent = function() {
  const cutoff = Date.now() - 25 * 86400000;
  const urgentJobs = _allLoadedJobs.filter(j => {
    const isActive = j.status === 'under_repair' || j.status === 'repaired';
    const created = new Date(j.created_at).getTime();
    return isActive && created <= cutoff;
  });
  if (urgentJobs.length) {
    S.jobs = urgentJobs.sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    S.filter = ''; S.fromDate = ''; S.toDate = '';
    renderVList(false);
    toast(`🚨 ${urgentJobs.length} urgent job${urgentJobs.length>1?'s':''} (>25 days)`, 'error');
  } else {
    toast('No urgent jobs — all active jobs are under 25 days! 🎉', 'success');
  }
};

function setFilter(s) {
  S.filter = s;
  const u = new URL(window.location);
  s ? u.searchParams.set('status', s) : u.searchParams.delete('status');
  history.replaceState({}, '', u);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED IMAGE / AUDIO LOADER
// R2 endpoints require Bearer token; we fetch as blob then set src
// ─────────────────────────────────────────────────────────────────────────────
const _mediaCache = new Map();
const _mediaLoading = new Map(); // prevent duplicate fetches
async function loadAuthMedia(url, el, attr) {
  if (!url || !S.token) return;
  if (_mediaCache.has(url)) { el[attr] = _mediaCache.get(url); return; }
  // Deduplicate: if already loading this URL, wait for it
  if (_mediaLoading.has(url)) {
    try { await _mediaLoading.get(url); if (_mediaCache.has(url)) el[attr] = _mediaCache.get(url); } catch {}
    return;
  }
  const promise = (async () => {
    try {
      const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
      if (!resp.ok) return;
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      _mediaCache.set(url, blobUrl);
      el[attr] = blobUrl;
    } catch (_) {
      // Silent retry once after 1s\n
      try {
        await new Promise(r => setTimeout(r, 1000));
        const resp2 = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
        if (resp2.ok) { const b = await resp2.blob(); const bu = URL.createObjectURL(b); _mediaCache.set(url, bu); el[attr] = bu; }
      } catch {}
    } finally { _mediaLoading.delete(url); }
  })();
  _mediaLoading.set(url, promise);
  await promise;
}

function applyAuthImages(container) {
  (container || document).querySelectorAll('img[data-auth-src]').forEach(img => {
    if (!img.src || img.src === window.location.href || img.src.startsWith('data:image/gif')) loadAuthMedia(img.dataset.authSrc, img, 'src');
  });
  (container || document).querySelectorAll('audio[data-audio-src]').forEach(aud => {
    if (!aud.src || aud.src === window.location.href) loadAuthMedia(aud.dataset.audioSrc, aud, 'src');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE COMPRESSION (canvas, max 1080px, before R2 upload)
// ─────────────────────────────────────────────────────────────────────────────
function compressImage(file, maxW = 1080, quality = 0.82) {
  return new Promise((resolve, reject) => {
    try {
      // Use createImageBitmap for faster decoding when available
      const useBlob = typeof createImageBitmap === 'function';
      const processImg = (img, w, h) => {
        const ratio = Math.min(1, maxW / Math.max(w, h));
        const nw = Math.round(w * ratio);
        const nh = Math.round(h * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = nw; canvas.height = nh;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, nw, nh);
        // Try WebP first (smaller file, faster upload), fallback to JPEG
        const tryWebP = typeof canvas.toBlob === 'function';
        const mime = tryWebP && canvas.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
        const ext = mime === 'image/webp' ? '.webp' : '.jpg';
        canvas.toBlob(blob => {
          if (blob) resolve(new File([blob], file.name.replace(/\.[^.]+$/, ext), { type: mime }));
          else resolve(file); // Fallback to original
        }, mime, quality);
      };

      if (useBlob) {
        createImageBitmap(file).then(bmp => {
          processImg(bmp, bmp.width, bmp.height);
        }).catch(() => {
          // Fallback to FileReader
          const reader = new FileReader();
          reader.onload = e => { const img = new Image(); img.onload = () => processImg(img, img.width, img.height); img.onerror = () => resolve(file); img.src = e.target.result; };
          reader.readAsDataURL(file);
        });
      } else {
        const reader = new FileReader();
        reader.onload = e => { const img = new Image(); img.onload = () => processImg(img, img.width, img.height); img.onerror = () => resolve(file); img.src = e.target.result; };
        reader.onerror = () => resolve(file);
        reader.readAsDataURL(file);
      }
    } catch (_) { resolve(file); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RECORDER (hardware-accelerated Web Audio API)
// ─────────────────────────────────────────────────────────────────────────────
async function startAudioRecorder(onData) {
  try {
    // Check if mediaDevices API is available (requires HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Microphone not available. Use HTTPS.', 'error');
      return false;
    }
    // Request permission explicitly — this triggers the browser permission dialog
    S.audioStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    S.audioChunks = [];
    // Detect supported MIME types across browsers (Chrome, Safari, Firefox)
    let mimeType = 'audio/webm';
    if (typeof MediaRecorder !== 'undefined') {
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) mimeType = 'audio/ogg;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';
    }
    S.audioRecorder = new MediaRecorder(S.audioStream, { mimeType });
    S.audioRecorder.ondataavailable = e => { if (e.data.size > 0) S.audioChunks.push(e.data); };
    S.audioRecorder.onstop = () => {
      const blob = new Blob(S.audioChunks, { type: mimeType });
      if (onData) onData(blob, mimeType);
      S.audioStream?.getTracks().forEach(t => t.stop());
      S.audioStream = null;
    };
    S.audioRecorder.start(250);
    return true;
  } catch (err) {
    console.error('Microphone error:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      toast('Microphone permission denied. Please allow in browser settings.', 'error');
    } else if (err.name === 'NotFoundError') {
      toast('No microphone found on this device.', 'error');
    } else if (err.name === 'NotReadableError') {
      toast('Microphone is already in use by another app.', 'error');
    } else {
      toast('Microphone error: ' + (err.message || 'Unknown'), 'error');
    }
    return false;
  }
}

function stopAudioRecorder() {
  if (S.audioRecorder && S.audioRecorder.state !== 'inactive') S.audioRecorder.stop();
  S.audioStream?.getTracks().forEach(t => t.stop());
  S.audioStream = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VISUAL VIEWPORT — keeps inputs above Android keyboard
// ─────────────────────────────────────────────────────────────────────────────
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
        focused.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      // Adjust modal sheet height for keyboard
      const sheet = document.querySelector('.modal-sheet');
      if (sheet) {
        const vvh = window.visualViewport.height;
        sheet.style.maxHeight = (vvh * 0.92) + 'px';
      }
    });
  }, { passive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
async function login(email, password) {
  try {
    const r = await API.post('/api/auth/login', { email, password });
    S.token = r.data.token; S.user = r.data.user;
    localStorage.setItem('AES_TOKEN', S.token);
    localStorage.setItem('AES_USER', JSON.stringify(S.user));
    maybeAskPushPermission();
    navigate('dashboard');
    // v36: Pre-cache staff list for offline after login
    API.get('/api/staff').then(sr => { if (sr.data) { S.staff = sr.data; IDB.saveStaff(sr.data); }}).catch(() => {});
  } catch (e) {
    toast(e.response?.data?.error || 'Login failed', 'error');
  }
}
function logout() {
  S.token = null; S.user = null; S.jobs = []; S.job = null; S.staff = []; S.requests = [];
  localStorage.removeItem('AES_TOKEN'); localStorage.removeItem('AES_USER');
  IDB.clear(); // Clear offline memory on logout
  navigate('login');
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
function navigate(view, params = {}) {
  S.view = view;
  if (params.jobId) S.jobId = params.jobId;
  // Push history state so Android back button goes to jobs list, not app exit
  if (view === 'dashboard') {
    // Reset search fields when navigating to dashboard
    S.searchJob = ''; S.searchName = ''; S.search = '';
    history.pushState({ view: 'dashboard' }, '', '/?status=' + (S.filter || ''));
  } else if (view === 'detail') {
    history.pushState({ view: 'detail', jobId: S.jobId }, '', '/?job=' + S.jobId);
  } else if (view !== 'login') {
    history.pushState({ view }, '', '/' + (view !== 'dashboard' ? '?view=' + view : ''));
  }
  render();
}

// Back button: instead of exiting app, go to jobs list
// RESET search fields on back navigation so dashboard shows all jobs
window.addEventListener('popstate', e => {
  const state = e.state;
  if (!S.token || !S.user) { render(); return; }
  if (!state || state.view === 'dashboard') {
    S.view = 'dashboard';
    // Reset search on back to dashboard
    S.searchJob = ''; S.searchName = ''; S.search = '';
    render();
  } else if (state.view === 'detail' && state.jobId) {
    S.view = 'detail'; S.jobId = state.jobId; render();
  } else {
    S.view = state.view || 'dashboard'; render();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ROOT
// ─────────────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  // Public tracking page — no auth required
  if (S.view === 'track') {
    app.innerHTML = `<div class="app-shell"><div id="view-root">${trackHTML()}</div></div>`;
    bindTrack();
    return;
  }
  if (!S.token || !S.user) {
    // v39: If offline but previously logged in, allow read-only dashboard access
    // (token expired or cleared but we still have cached data)
    app.innerHTML = loginHTML();
    bindLogin();
    return;
  }
  // Ask push permission once after first render when logged in
  maybeAskPushPermission();
  app.innerHTML = `
    <div class="app-shell">
      ${headerHTML()}
      <div id="view-root">${viewHTML()}</div>
      ${bottomNavHTML()}
    </div>`;
  bindView();
  // v39: Re-apply offline state after re-render
  if (_isOffline) {
    _showOfflineBanner();
    setTimeout(() => _lockMutatingUI(true), 100);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
function loginHTML() {
  return `
  <div class="login-bg">
    <div class="login-card">
      <div class="login-logo">
        <div class="logo-icon"><i class="fas fa-bolt"></i></div>
        <h1 class="login-title">ADITION ELECTRIC</h1>
        <p class="login-sub">Service Management System</p>
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input id="l-email" type="email" class="form-input" placeholder="admin@example.com"
               autocomplete="username">
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input id="l-pass" type="password" class="form-input" placeholder="••••••••"
               autocomplete="current-password">
      </div>
      <button id="l-btn" class="btn-primary btn-full">
        <i class="fas fa-sign-in-alt"></i> Sign In
      </button>
    </div>
    <p class="login-footer">✨ adition™ since 1984 · Gheekanta, Ahmedabad</p>
  </div>`;
}
function bindLogin() {
  const go = () => login(
    document.getElementById('l-email').value.trim(),
    document.getElementById('l-pass').value
  );
  document.getElementById('l-btn')?.addEventListener('click', go);
  document.getElementById('l-pass')?.addEventListener('keypress', e => { if (e.key === 'Enter') go(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────────────────────────
function headerHTML() {
  const titles = {
    dashboard:'Jobs Dashboard', newjob:'New Job', admindash:'Dashboard',
    detail:'Job Details', staff:'Staff Panel',
    reports:'Reports', settings:'Settings', requests:'Requests'
  };
  const backBtn = S.view === 'detail'
    ? `<button class="hdr-back" id="hdr-back-btn"><i class="fas fa-arrow-left"></i></button>` : '';
  const subtitle = S.view === 'detail' && S.job
    ? `<div class="hdr-job-id">${S.job.id} · ${esc(S.job.snap_name)}</div>`
    : `<div class="hdr-sub">ADITION ELECTRIC SOLUTION</div>`;
  return `
  <header class="app-header" style="will-change:transform">
    <div class="hdr-left">
      ${backBtn}
      <div>
        <div class="hdr-title">${titles[S.view] || 'AES'}</div>
        ${subtitle}
      </div>
    </div>
    <div class="hdr-right">
      ${window._pwaInstallPrompt ? `<button class="icon-btn pwa-install-btn" id="hdr-install-btn" title="Install App" style="color:#43A047"><i class="fas fa-download"></i></button>` : ''}
      <span class="role-badge ${S.user?.role==='admin'?'role-admin':S.user?.role==='supervisor'?'role-manager':'role-staff'}">${esc((S.user?.name||'').split(' ')[0])}</span>
      <button class="icon-btn" id="hdr-logout-btn" title="Sign out"><i class="fas fa-sign-out-alt"></i></button>
    </div>
  </header>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM NAV
// ─────────────────────────────────────────────────────────────────────────────
function bottomNavHTML() {
  const role = S.user?.role;
  const lvl = roleLevel(role);
  const tabs = [
    { id:'dashboard', icon:'fa-list-ul',    label:'Jobs'    },
    ...(lvl >= 2 ? [{ id:'newjob', icon:'fa-plus-circle', label:'New Job' }]
       : hasSuperRight('create_jobs') ? [{ id:'newjob', icon:'fa-plus-circle', label:'New Job' }] : []),
    // Dashboard: admin + director only
    ...(lvl >= 3 ? [{ id:'admindash', icon:'fa-chart-line', label:'Dashboard' }] : []),
    // Requests: admin only
    ...(role === 'admin' ? [{ id:'requests', icon:'fa-bell', label:'Requests', badge: true }] : []),
    // Staff menu: admin only
    ...(role === 'admin' ? [{ id:'staff',    icon:'fa-users',     label:'Staff'   }] : []),
    { id:'reports',  icon:'fa-chart-bar', label:'Reports' },
    // Settings: admin only; others see "More" with limited options
    { id:'settings',  icon:'fa-cog',         label:'More'    },
  ];
  return `
  <nav class="bottom-nav">
    ${tabs.map(t => `
    <button class="nav-btn ${S.view===t.id?'nav-active':''}" data-nav="${t.id}">
      ${t.badge
        ? `<span class="nav-badge-wrap"><i class="fas ${t.icon} nav-icon"></i><span class="nav-dot" id="req-dot" style="display:none"></span></span>`
        : `<i class="fas ${t.icon} nav-icon"></i>`}
      <span class="nav-label">${t.label}</span>
    </button>`).join('')}
  </nav>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEW DISPATCH
// ─────────────────────────────────────────────────────────────────────────────
function viewHTML() {
  // v39: Block write-only views when offline — redirect to read-only dashboard
  if (_isOffline && ['newjob', 'requests'].includes(S.view)) {
    S.view = 'dashboard';
    toast('Offline — view only mode', 'info');
  }
  switch (S.view) {
    case 'dashboard': return dashboardHTML();
    case 'newjob':    return (isAdmin() || hasSuperRight('create_jobs')) ? newJobHTML() : deniedHTML();
    case 'admindash': return isDirector() ? adminDashHTML() : deniedHTML();
    case 'detail':    return `<div id="detail-root" class="view-pad"><div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div></div>`;
    case 'staff':     return (S.user?.role === 'admin') ? staffHTML() : deniedHTML();
    case 'reports':   return reportsHTML();
    case 'requests':  return isAdminOnly() ? requestsHTML() : deniedHTML();
    case 'settings':  return settingsHTML();
    case 'track':     return trackHTML();
    default:          return dashboardHTML();
  }
}
const deniedHTML = () => `<div class="empty-state"><i class="fas fa-lock fa-3x"></i><p>Access Denied</p></div>`;

function bindView() {
  document.getElementById('hdr-back-btn')?.addEventListener('click', () => navigate('dashboard'));
  document.getElementById('hdr-logout-btn')?.addEventListener('click', logout);
  document.getElementById('hdr-install-btn')?.addEventListener('click', async () => {
    if (!window._pwaInstallPrompt) return;
    try {
      window._pwaInstallPrompt.prompt();
      const { outcome } = await window._pwaInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        toast('App installed! \ud83c\udf89', 'success');
        window._pwaInstallPrompt = null;
        document.getElementById('hdr-install-btn')?.remove();
        document.getElementById('set-install-app')?.remove();
      }
    } catch (_) {}
  });
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav), { passive: true });
  });

  // Poll pending requests count for admin notification dot
  if (isAdminOnly()) {
    API.get('/api/requests/count').then(r => {
      const dot = document.getElementById('req-dot');
      if (dot) dot.style.display = r.data.count > 0 ? 'block' : 'none';
    }).catch(() => {});
  }

  // Staff: show notification bar for recent request updates (approved/denied)
  if (!isAdmin() && S.view === 'dashboard') {
    API.get('/api/my-notifications').then(r => {
      const notes = r.data || [];
      if (!notes.length) return;
      const bar = document.getElementById('staff-notif-bar');
      if (!bar) return;
      bar.innerHTML = notes.slice(0, 5).map((n, idx) => {
        const icon   = n.status === 'approved' ? '✅' : '❌';
        const color  = n.status === 'approved' ? '#E8F5E9' : '#FFEBEE';
        const border = n.status === 'approved' ? '#43A047' : '#E53935';
        const action = n.status === 'approved' ? 'Assignment Approved' : 'Assignment Denied';
        const ts     = n.resolved_at || n.created_at;
        const tsStr  = ts ? new Date(ts).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
        const msg    = `${icon} <b>${action}</b> — Job <b>#${esc(n.job_id)}</b> · <i>${esc(n.product_name)}</i>`;
        return `<div class="staff-notif-item" data-nidx="${idx}" style="position:relative;background:${color};border-left:4px solid ${border};border-radius:8px;padding:10px 32px 10px 14px;margin-bottom:6px;font-size:13px;line-height:1.5">
          ${msg}
          <div style="color:#999;font-size:11px;margin-top:3px">${tsStr}</div>
          <button class="notif-dismiss-btn" data-nidx="${idx}" style="position:absolute;top:6px;right:6px;background:none;border:none;cursor:pointer;font-size:14px;color:#999;padding:2px 5px;line-height:1;border-radius:4px" title="Dismiss">✕</button>
        </div>`;
      }).join('');
      bar.style.display = 'block';
      // Bind dismiss buttons — click small cross to hide individual notification
      bar.querySelectorAll('.notif-dismiss-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = btn.closest('.staff-notif-item');
          if (item) { item.style.transition = 'opacity .2s,height .2s,margin .2s,padding .2s'; item.style.opacity = '0'; item.style.height = '0'; item.style.marginBottom = '0'; item.style.paddingTop = '0'; item.style.paddingBottom = '0'; item.style.overflow = 'hidden'; setTimeout(() => item.remove(), 250); }
        });
      });
    }).catch(() => {});
  }

  switch (S.view) {
    case 'dashboard': loadJobs();                                               break;
    case 'newjob':    if (isAdmin() || hasSuperRight('create_jobs')) bindNewJob(); break;
    case 'admindash': if (isDirector()) loadAdminDash();                        break;
    case 'detail':    loadDetail();                                             break;
    case 'staff':     if (S.user?.role === 'admin') loadStaff();                break;
    case 'reports':   if (S.user?.role === 'admin') loadStaffForSelects(); bindReports(); break;
    case 'requests':  if (S.user?.role === 'admin') loadRequests();             break;
    case 'settings':  bindSettings();                                          break;
    case 'track':     bindTrack();                                             break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — virtual-scroll list
// ─────────────────────────────────────────────────────────────────────────────
function dashboardHTML() {
  const activeFilterLabel = S.filter === 'active_only' ? 'Active Only' : S.filter === 'courier_pending' ? 'Courier Pending' : S.filter ? sl(S.filter) : (S.fromDate || S.toDate ? 'Date Range' : 'All Jobs');
  const hasFilter = S.filter || S.fromDate || S.toDate;
  return `
  <div style="display:flex;flex-direction:column;height:100%">
    <!-- TOP BAR: Filter + Refresh icons at the very top -->
    <div style="display:flex;align-items:center;gap:4px;padding:6px 12px 2px;flex-shrink:0;border-bottom:1px solid #f0f0f0">
      <button id="btn-open-filter" style="display:inline-flex;align-items:center;gap:4px;background:${hasFilter?'#E3F2FD':'transparent'};border:${hasFilter?'1.5px solid #1E88E5':'1px solid #e0e0e0'};border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;color:${hasFilter?'#1565C0':'#666'};cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent;transition:all .15s;line-height:1;min-height:30px">
        <i class="fas fa-filter" style="font-size:11px"></i>${hasFilter ? ' '+activeFilterLabel : ' Filter'}
      </button>
      ${hasFilter ? `<button id="btn-clear-filter" style="display:inline-flex;align-items:center;background:#FFEBEE;border:1px solid #E53935;border-radius:6px;padding:3px 8px;font-size:11px;color:#E53935;font-weight:700;cursor:pointer;line-height:1;min-height:26px"><i class="fas fa-times" style="font-size:9px;margin-right:3px"></i>Clear</button>` : ''}
      <div style="flex:1"></div>
      <span id="cc-count" style="font-size:11px;color:#aaa;font-weight:600"></span>
      <button id="btn-refresh-jobs" style="display:inline-flex;align-items:center;justify-content:center;background:#f0f4ff;border:1.5px solid #1565C0;border-radius:8px;cursor:pointer;color:#1565C0;padding:5px 10px;font-size:14px;-webkit-tap-highlight-color:transparent;transition:transform .15s;min-height:30px;gap:4px" title="Refresh jobs"><i class="fas fa-sync-alt" style="font-size:12px"></i><span style="font-size:12px;font-weight:700">Refresh</span></button>
    </div>
    ${!isAdmin() ? `<div id="staff-notif-bar" style="display:none;padding:8px 12px 0"></div>` : ''}
    ${isAdmin() ? `<div id="owner-dash" style="padding:6px 10px 2px;display:flex;gap:5px;flex-wrap:wrap"></div>` : ''}
    <div id="filter-panel" style="display:none;padding:8px 12px;background:#f8f9fb;border-bottom:1px solid #e0e0e0;flex-shrink:0">
      <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Filter by Status</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button class="fp-chip ${S.filter===''?'fp-active':''}" data-fp-status="" style="--fp-color:#1a1a2e">All</button>
        <button class="fp-chip ${S.filter==='under_repair'?'fp-active':''}" data-fp-status="under_repair" style="--fp-color:${sc('under_repair')}">Under Repair</button>
        <button class="fp-chip ${S.filter==='repaired'?'fp-active':''}" data-fp-status="repaired" style="--fp-color:${sc('repaired')}">Repaired</button>
        <button class="fp-chip ${S.filter==='returned'?'fp-active':''}" data-fp-status="returned" style="--fp-color:${sc('returned')}">Returned</button>
        <button class="fp-chip ${S.filter==='partial_delivered'?'fp-active':''}" data-fp-status="partial_delivered" style="--fp-color:${sc('partial_delivered')}">Partial</button>
        <button class="fp-chip ${S.filter==='delivered'?'fp-active':''}" data-fp-status="delivered" style="--fp-color:${sc('delivered')}">Delivered</button>
        <button class="fp-chip ${S.filter==='active_only'?'fp-active':''}" data-fp-status="active_only" style="--fp-color:#2E7D32">Active Only</button>
        <button class="fp-chip ${S.filter==='courier_pending'?'fp-active':''}" data-fp-status="courier_pending" style="--fp-color:#7B1FA2">📮 Courier Pending</button>
        ${isAdmin() ? `<button class="fp-chip ${S.filter==='pending_payment'?'fp-active':''}" data-fp-status="pending_payment" style="--fp-color:#FB8C00">Pending Payment</button>` : ''}
      </div>
      <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Date Range</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <input id="fp-from" type="date" class="form-input" style="flex:1;min-height:36px;padding:4px 8px;font-size:13px;border-radius:8px" value="${esc(S.fromDate)}">
        <input id="fp-to" type="date" class="form-input" style="flex:1;min-height:36px;padding:4px 8px;font-size:13px;border-radius:8px" value="${esc(S.toDate)}">
      </div>
      <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Quick Filters</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button class="fp-quick" onclick="filterToday()">📅 Today</button>
        <button class="fp-quick" onclick="filterMonth()">📊 This Month</button>
        <button class="fp-quick" onclick="filterActiveOnly()">🟢 Active Only</button>
        <button class="fp-quick" onclick="filterCourierPending()">📮 Courier Pending</button>
        ${isAdmin() ? `<button class="fp-quick" onclick="filterByStatus('under_repair')">🔧 Pending</button>` : ''}
      </div>
      ${S.filter === 'delivered' && isAdmin() ? `
      <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Delivery Type</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <select id="del-type" class="form-input" style="min-height:36px;padding:4px 8px;font-size:13px;border-radius:8px;flex:1">
          <option value="">All Types</option>
          <option value="in_person">In Person</option>
          <option value="courier">Courier</option>
        </select>
      </div>` : ''}
      <div style="display:flex;gap:8px">
        <button id="fp-apply" style="flex:1;background:#1565C0;color:#fff;border:none;border-radius:8px;padding:10px;font-size:14px;font-weight:700;cursor:pointer"><i class="fas fa-check"></i> Apply</button>
        <button id="fp-reset" style="flex:1;background:#f0f2f5;color:#555;border:1px solid #ddd;border-radius:8px;padding:10px;font-size:14px;font-weight:700;cursor:pointer"><i class="fas fa-undo"></i> Reset</button>
      </div>
    </div>
    ${!isAdmin() ? `
    <div class="my-jobs-bar">
      <button id="btn-my-assigned" class="btn-my-assigned ${S.myJobsOnly ? 'btn-my-active' : ''}">
        <i class="fas fa-user-check"></i>
        ${S.myJobsOnly ? 'My Assigned Jobs ✓' : 'My Assigned Jobs'}
      </button>
      ${S.myJobsOnly ? `<button id="btn-clear-my" class="btn-my-clear"><i class="fas fa-times"></i> All Jobs</button>` : ''}
    </div>` : ''}
    <div style="display:flex;gap:6px;padding:4px 10px;flex-shrink:0">
      <div style="flex:1;position:relative;display:flex;align-items:center;background:#f0f2f5;border-radius:12px;border:1.5px solid #e0e0e0;overflow:hidden;transition:border-color .15s">
        <i class="fas fa-hashtag" style="position:absolute;left:12px;color:#1565C0;font-size:14px;pointer-events:none"></i>
        <input id="dash-search-job" type="search" class="search-input"
               placeholder="Job No." value="${esc(S.searchJob || '')}"
               autocomplete="off" autocorrect="off" spellcheck="false"
               style="padding-left:34px;border:none;background:transparent;width:100%;min-height:40px;font-size:14px;font-weight:600;outline:none">
      </div>
      <div style="flex:1.5;position:relative;display:flex;align-items:center;background:#f0f2f5;border-radius:12px;border:1.5px solid #e0e0e0;overflow:hidden;transition:border-color .15s">
        <i class="fas fa-search" style="position:absolute;left:12px;color:#888;font-size:14px;pointer-events:none"></i>
        <input id="dash-search-name" type="search" class="search-input"
               placeholder="Name or Mobile\u2026" value="${esc(S.searchName || '')}"
               autocomplete="off" autocorrect="off" spellcheck="false"
               style="padding-left:34px;border:none;background:transparent;width:100%;min-height:40px;font-size:14px;font-weight:600;outline:none">
      </div>
    </div>
    <div id="vlist-wrap" class="vlist-wrap" style="flex:1"></div>
  </div>`;
}

// Analytics 30-second cache — only used for chip counts (no separate stats bar)
let _analyticsCache = null;
let _analyticsCacheTs = 0;
async function loadAnalytics(force) {
  const now = Date.now();
  if (!force && _analyticsCache && (now - _analyticsCacheTs) < 30000) {
    _applyChipCounts(_analyticsCache);
    return;
  }
  // Instant: load from offline cache first
  if (!_analyticsCache) {
    const cached = await IDB.loadMeta('analytics');
    if (cached) { _analyticsCache = cached; _applyChipCounts(cached); }
  }
  // Background: fetch fresh
  API.get('/api/analytics').then(r => {
    _analyticsCache = r.data;
    _analyticsCacheTs = Date.now();
    _applyChipCounts(r.data);
    IDB.saveMeta('analytics', r.data); // Persist for instant load
  }).catch(() => {});
}
function _applyChipCounts(d) {
  // Update the job count label in header
  const ccCount = document.getElementById('cc-count');
  if (ccCount) ccCount.textContent = `${d.total || 0} total`;

  // Owner dashboard tiles (admin/manager only)
  const ownerDash = document.getElementById('owner-dash');
  if (ownerDash && isAdmin()) {
    const tiles = [
      { label: 'No. of Jobs', value: d.total || 0, icon: '📋', bg: '#F3E5F5', color: '#7B1FA2', click: 'filterAll()' },
      { label: 'Under Repair', value: d.underRepair || 0, icon: '🔧', bg: '#FFF3E0', color: '#E65100', click: "filterByStatus('under_repair')" },
      { label: 'Repaired', value: d.repaired || 0, icon: '✅', bg: '#E8F5E9', color: '#2E7D32', click: "filterByStatus('repaired')" },
      { label: 'Returned', value: d.returned || 0, icon: '↩️', bg: '#FFF8E1', color: '#B8860B', click: "filterByStatus('returned')" },
      { label: 'Partial', value: d.partial || 0, icon: '📦', bg: '#FFF3E0', color: '#FF6F00', click: "filterByStatus('partial_delivered')" },
      { label: 'Delivered', value: d.completed || 0, icon: '🚚', bg: '#E3F2FD', color: '#1565C0', click: 'filterDone()' },
      { label: 'Courier', value: d.courierPending || 0, icon: '📮', bg: '#F3E5F5', color: '#7B1FA2', click: 'filterCourierPending()' },
      { label: 'Urgent>25d', value: d.urgent || 0, icon: '🚨', bg: d.urgent > 0 ? '#FFCDD2' : '#F5F5F5', color: d.urgent > 0 ? '#C62828' : '#888', click: 'filterUrgent()' },
    ];
    ownerDash.innerHTML = tiles.map(t => `
      <div onclick="${t.click}" style="flex:1;min-width:44px;background:${t.bg};border-radius:8px;padding:4px 2px;cursor:pointer;text-align:center;transition:transform .15s;-webkit-tap-highlight-color:transparent" ontouchstart="this.style.transform='scale(0.95)'" ontouchend="this.style.transform=''">
        <div style="font-size:13px">${t.icon}</div>
        <div style="font-size:16px;font-weight:900;color:${t.color};line-height:1.1">${t.value}</div>
        <div style="font-size:8px;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:.2px">${t.label}</div>
      </div>`).join('');
  }
}

// Job loading state
let _jobsLoading = false;
let _jobsHasMore = true;
let _jobsOffset  = 0;
let _jobsLoadId  = 0; // v37: monotonic counter to discard stale API responses
const JOBS_PER_PAGE = 100; // Higher batch = fewer API calls = faster perceived load

// Build the IDB cache key for the current filter state
function _idbFilterKey() {
  if (S.search || S.searchJob || S.searchName || S.fromDate || S.toDate || S.myJobsOnly) return null;
  return 'f_' + (S.filter || '_all');
}

async function loadJobs(append = false) {
  const wrap = document.getElementById('vlist-wrap');
  const isSearching = !!(S.searchJob || S.searchName);
  if (!append) {
    _jobsOffset = 0;
    _jobsHasMore = true;
    _jobsLoading = false;
    _jobsLoadId++;
    const cacheKey = _idbFilterKey();

    // v41: INSTANT CLIENT-SIDE FILTER — show results in <1ms from master cache
    // Works on very first keystroke because _allLoadedJobs is pre-warmed from IDB
    if (isSearching && _allLoadedJobs.length) {
      const clientResults = _clientSideFilter(_allLoadedJobs, S.searchJob, S.searchName);
      if (clientResults !== null) {
        S.jobs = clientResults;
        renderVList(false);
        // If master cache has enough data, skip API call entirely for instant UX
        if (_allJobsFullyLoaded && clientResults.length > 0) {
          _jobsLoading = false;
          bindDashboardEvents();
          return;
        }
        // Otherwise still fire API in background for server-accurate results
      }
    }
    // IDB cache fallback for non-search loads (filter views)
    else if (cacheKey) {
      const cached = await IDB.loadJobs(cacheKey);
      if (cached && cached.length) {
        S.jobs = cached;
        renderVList(false);
      } else if (!S.jobs.length) {
        S.jobs = [];
        if (wrap) wrap.innerHTML = `<div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>`;
      }
    } else if (!S.jobs.length) {
      S.jobs = [];
      if (wrap) wrap.innerHTML = `<div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>`;
    }
  }
  if (_jobsLoading || !_jobsHasMore) return;
  _jobsLoading = true;
  const myLoadId = _jobsLoadId;
  const mySearchSeq = ++_lastSearchSeq;
  // v41: Only refresh analytics on fresh non-search load
  if (!append && !isSearching) loadAnalytics();
  try {
    const params = { limit: JOBS_PER_PAGE, offset: _jobsOffset };
    if (S.filter)     params.status   = S.filter;
    if (S.searchJob)  params.q_job    = S.searchJob;
    if (S.searchName) params.q_name   = S.searchName;
    if (S.search && !S.searchJob && !S.searchName) params.q = S.search;
    if (S.fromDate)   params.from     = S.fromDate;
    if (S.toDate)     params.to       = S.toDate;
    if (S.myJobsOnly && !isAdmin()) params.staff_id = S.user?.id;
    const r = await dedupeGet('/api/jobs', params);
    // v41: Discard if user has moved on (stale load ID or newer search)
    if (myLoadId !== _jobsLoadId || mySearchSeq !== _lastSearchSeq) { _jobsLoading = false; return; }
    const newJobs = r.data || [];
    if (newJobs.length < JOBS_PER_PAGE) _jobsHasMore = false;
    _jobsOffset += newJobs.length;
    if (append) {
      S.jobs = [...S.jobs, ...newJobs];
    } else {
      S.jobs = newJobs;
      const cacheKey = _idbFilterKey();
      if (cacheKey) {
        IDB.saveJobs(cacheKey, S.jobs);
        IDB.bulkSaveDetails(S.jobs);
      }
      // v41: Build master cache for instant client-side search
      if (!isSearching && !S.search) {
        const idSet = new Set(_allLoadedJobs.map(x => x.id));
        for (const j of newJobs) {
          if (idSet.has(j.id)) {
            const idx = _allLoadedJobs.findIndex(x => x.id === j.id);
            if (idx >= 0) _allLoadedJobs[idx] = j;
          } else {
            _allLoadedJobs.push(j);
            idSet.add(j.id);
          }
        }
        if (!_jobsHasMore) _allJobsFullyLoaded = true;
      }
      // v41: Only prefetch on initial non-search loads to save bandwidth
      if (!isSearching) _prefetchDetails(newJobs.slice(0, 15));
    }
    renderVList(append);
  } catch {
    if (myLoadId !== _jobsLoadId) { _jobsLoading = false; return; }
    if (!append && (!S.jobs.length)) {
      const allCached = await IDB.loadAllJobs();
      if (allCached.length) {
        // v41: Also populate master cache from IDB for offline search
        _allLoadedJobs = allCached;
        _allJobsFullyLoaded = true;
        if (isSearching) {
          const filtered = _clientSideFilter(allCached, S.searchJob, S.searchName);
          S.jobs = filtered || allCached;
        } else {
          S.jobs = allCached;
        }
        renderVList(false);
        if (_isOffline) toast('Showing cached data (offline)', 'info');
      } else if (wrap) {
        wrap.innerHTML = _isOffline
          ? `<div class="empty-state"><i class="fas fa-wifi-slash fa-2x" style="color:#E53935"></i><p style="font-weight:700">You're Offline</p><p style="font-size:13px;color:#888">No cached data available yet. Connect to the internet to load jobs.</p></div>`
          : `<div class="empty-state"><i class="fas fa-exclamation-circle fa-2x" style="color:#e53935"></i><p>Error loading jobs</p></div>`;
      }
    }
  }
  _jobsLoading = false;
  bindDashboardEvents();
  if (_isOffline) setTimeout(() => _lockMutatingUI(true), 50);
}

// v36: Pre-fetch full job details in background for WhatsApp-like offline access
let _prefetchRunning = false;
async function _prefetchDetails(jobs) {
  if (_prefetchRunning || !jobs?.length) return;
  _prefetchRunning = true;
  try {
    for (const j of jobs) {
      if (!j?.id) continue;
      // Skip if we already have fresh cached detail (less than 5 min old)
      const existing = await IDB.loadDetail(j.id);
      if (existing && existing._cachedAt && (Date.now() - existing._cachedAt) < 300000 && !existing._listCache) continue;
      // Fetch full detail silently — no UI impact
      try {
        const resp = await API.get(`/api/jobs/${j.id}`);
        if (resp.data) IDB.saveDetail(resp.data);
      } catch { /* Silent — offline or rate limit */ }
      // Small delay between requests to avoid API flood
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}
  _prefetchRunning = false;
}

// ── One-time dashboard event bindings (prevents accumulation on repeated loadJobs) ──
let _dashEvtBound = false;
function bindDashboardEvents() {
  if (_dashEvtBound) return;
  _dashEvtBound = true;

  // Use event delegation on the main container to avoid per-element binding
  document.addEventListener('click', e => {
    const t = e.target.closest('[id]');
    if (!t) return;
    switch (t.id) {
      case 'btn-my-assigned':
        S.myJobsOnly = !S.myJobsOnly;
        S.fromDate = ''; S.toDate = ''; setFilter('');
        render();
        break;
      case 'btn-clear-my':
        S.myJobsOnly = false; render();
        break;
      case 'btn-refresh-jobs': {
        const icon = t.querySelector('i');
        if (icon) { icon.style.transform = 'rotate(360deg)'; icon.style.transition = 'transform .4s'; setTimeout(() => { icon.style.transform = ''; }, 450); }
        _analyticsCacheTs = 0;
        IDB.saveJobs(_idbFilterKey(), []); // Clear offline cache to force fresh fetch
        S.jobs = [];
        loadJobs();
        toast('Refreshing…', 'info');
        break;
      }
      case 'btn-open-filter': {
        const panel = document.getElementById('filter-panel');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        break;
      }
      case 'btn-clear-filter':
        setFilter(''); S.fromDate = ''; S.toDate = ''; _analyticsCacheTs = 0;
        render();
        break;
      case 'fp-apply': {
        const activeChip = document.querySelector('.fp-chip.fp-active');
        const newStatus = activeChip?.dataset.fpStatus || '';
        setFilter(newStatus);
        S.fromDate = document.getElementById('fp-from')?.value || '';
        S.toDate = document.getElementById('fp-to')?.value || '';
        const panel = document.getElementById('filter-panel');
        if (panel) panel.style.display = 'none';

        if (newStatus === 'pending_payment') {
          _jobsOffset = 0; _jobsHasMore = true; S.jobs = [];
          setFilter('pending_payment');
          const wrap = document.getElementById('vlist-wrap');
          if (wrap) wrap.innerHTML = `<div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>`;
          API.get('/api/jobs/pending-payment', { params: { q: S.searchJob || S.searchName || S.search } })
            .then(r => { S.jobs = r.data || []; _jobsHasMore = false; renderVList(false); })
            .catch(() => { if (wrap) wrap.innerHTML = '<div class="empty-state"><p>Filter failed</p></div>'; });
          return;
        }

        const delType = document.getElementById('del-type')?.value || '';
        if (newStatus === 'delivered' && (S.fromDate || S.toDate || delType)) {
          _jobsOffset = 0; _jobsHasMore = true; S.jobs = [];
          const wrap = document.getElementById('vlist-wrap');
          if (wrap) wrap.innerHTML = `<div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>`;
          API.get('/api/jobs/delivered', { params: { from: S.fromDate, to: S.toDate, method: delType, q: S.searchJob || S.searchName || S.search } })
            .then(r => { S.jobs = r.data || []; _jobsHasMore = false; renderVList(false); })
            .catch(() => { if (wrap) wrap.innerHTML = '<div class="empty-state"><p>Filter failed</p></div>'; });
          return;
        }

        loadJobs();
        break;
      }
      case 'fp-reset':
        setFilter(''); S.fromDate = ''; S.toDate = '';
        { const panel = document.getElementById('filter-panel'); if (panel) panel.style.display = 'none'; }
        _analyticsCacheTs = 0;
        render();
        break;
    }

    // Filter panel status chips (event delegation)
    if (e.target.closest('.fp-chip')) {
      document.querySelectorAll('.fp-chip').forEach(b => b.classList.remove('fp-active'));
      e.target.closest('.fp-chip').classList.add('fp-active');
    }
  });

  // v41: TURBO SEARCH — instant client-side filter + delayed API refinement
  // Step 1: Every keystroke immediately filters _allLoadedJobs (0ms delay)
  // Step 2: After typing stops, fire API for server-accurate results (300ms debounce)
  // Step 3: If master cache is complete (_allJobsFullyLoaded), skip API entirely

  function _instantSearchFilter() {
    S.searchJob = document.getElementById('dash-search-job')?.value.trim() || '';
    S.searchName = document.getElementById('dash-search-name')?.value.trim() || '';
    S.search = S.searchJob || S.searchName || '';

    // Instant client-side filter: show results in <1ms
    if (_allLoadedJobs.length && (S.searchJob || S.searchName)) {
      const instant = _clientSideFilter(_allLoadedJobs, S.searchJob, S.searchName);
      if (instant !== null) { S.jobs = instant; renderVList(false); }
    }
    // When both fields cleared, show all jobs
    if (!S.searchJob && !S.searchName) {
      _jobsLoadId++; // Cancel any pending API search
      loadJobs();
    }
  }

  // Delayed API call for server-accurate results (only if client cache isn't complete)
  const _debouncedApiSearch = debounce(() => {
    if (_allJobsFullyLoaded && (S.searchJob || S.searchName)) return; // Cache is authoritative
    loadJobs();
  }, 350);

  document.addEventListener('input', e => {
    if (e.target.id === 'dash-search-job' || e.target.id === 'dash-search-name') {
      _instantSearchFilter(); // Instant client-side
      if (S.searchJob || S.searchName) _debouncedApiSearch(); // Delayed API
    }
  });
  // Handle the 'X' clear button on search inputs
  document.addEventListener('search', e => {
    if (e.target.id === 'dash-search-job' || e.target.id === 'dash-search-name') {
      _instantSearchFilter();
    }
  });
}

function renderVList(append = false) {
  const wrap = document.getElementById('vlist-wrap');
  if (!wrap) return;
  if (!S.jobs.length) {
    wrap.innerHTML = `<div class="empty-state"><i class="fas fa-inbox fa-3x"></i><p>No jobs found</p>${isAdmin() ? '<p class="empty-sub">Tap <b>New Job</b> to create one</p>' : ''}</div>`;
    return;
  }
  const total = S.jobs.length;
  const wrapH = wrap.clientHeight || (window.innerHeight - 200);

  // v35: Pre-build all row HTML strings once, reuse on scroll (eliminates repeated jobRowHTML calls)
  if (!wrap._rowCache || !append) wrap._rowCache = S.jobs.map(j => jobRowHTML(j));
  else if (append) {
    const existing = wrap._rowCache.length;
    for (let i = existing; i < S.jobs.length; i++) wrap._rowCache.push(jobRowHTML(S.jobs[i]));
  }

  // v35: Track visible range to skip identical re-paints (huge perf win on scroll)
  let _lastStart = -1, _lastEnd = -1;
  let _rafPending = false;

  function paint() {
    const scrollTop = wrap.scrollTop;
    const startIdx  = Math.max(0, Math.floor(scrollTop / CARD_H) - 3);
    const endIdx    = Math.min(total - 1, startIdx + Math.ceil(wrapH / CARD_H) + 6);
    if (startIdx === _lastStart && endIdx === _lastEnd) return; // skip no-op repaints
    _lastStart = startIdx; _lastEnd = endIdx;
    const topH      = startIdx * CARD_H;
    const botH      = Math.max(0, (total - endIdx - 1) * CARD_H);

    // Use cached row HTML strings for zero-cost rendering
    const html = wrap._rowCache.slice(startIdx, endIdx + 1).join('');
    wrap.innerHTML =
      `<div style="height:${topH}px;pointer-events:none"></div>` +
      html +
      `<div style="height:${botH}px;pointer-events:none"></div>` +
      (_jobsHasMore ? `<div id="infinite-loader" style="text-align:center;padding:16px;color:#888"><i class="fas fa-spinner fa-spin"></i> Loading more…</div>` : '');
  }

  paint();

  // v35: Event delegation for job row clicks (no per-row binding = faster)
  if (!wrap._clickDel) {
    wrap._clickDel = true;
    wrap.addEventListener('click', e => {
      const row = e.target.closest('.job-row');
      if (row?.dataset.id) navigate('detail', { jobId: row.dataset.id });
    }, { passive: true });
  }

  // v35: RAF-throttled scroll handler — max 1 paint per frame, prevents jank
  if (wrap._scrollHandler) wrap.removeEventListener('scroll', wrap._scrollHandler);
  const onScroll = () => {
    if (!_rafPending) {
      _rafPending = true;
      requestAnimationFrame(() => {
        paint();
        applyAuthImages(wrap);
        _rafPending = false;
        // Infinite scroll: load more when near bottom
        if (_jobsHasMore && !_jobsLoading) {
          const nearBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 200;
          if (nearBottom) loadJobs(true);
        }
      });
    }
  };
  wrap._scrollHandler = onScroll;
  wrap.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(() => applyAuthImages(wrap), 30);
}

// v41: Highlight search terms in text (wraps matches in <mark>)
function _hl(text, searchTerm) {
  if (!searchTerm || !text) return esc(text || '');
  const escaped = esc(text);
  const term = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp('(' + term + ')', 'gi'), '<mark style="background:#FFF176;padding:0 1px;border-radius:2px">$1</mark>');
}

function jobRowHTML(j) {
  const color   = sc(j.status);
  const bg      = sb(j.status);
  const balance = Math.max(0, (j.total_charges || 0) - (j.discount || 0) - (j.received_amount || 0));
  // v41: AGING ALERT — show how old the job is + color warning for stale jobs
  const daysSince = j.created_at ? Math.floor((Date.now() - new Date(j.created_at).getTime()) / 86400000) : 0;
  const isActive = j.status === 'under_repair' || j.status === 'repaired' || j.status === 'partial_delivered';
  const agingTag = isActive && daysSince >= 15
    ? `<span style="background:${daysSince>=25?'#FFCDD2':daysSince>=15?'#FFF3E0':'transparent'};color:${daysSince>=25?'#C62828':'#E65100'};font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;margin-left:4px">${daysSince}d</span>`
    : '';
  // v41: Search highlight — highlight matching job ID and name
  const jobIdDisplay = S.searchJob ? _hl(j.id, S.searchJob) : esc(j.id);
  const nameDisplay = S.searchName ? _hl(j.snap_name, S.searchName) : esc(j.snap_name);
  // v41: Show mobile in search results when searching by name/mobile
  const mobileDisplay = S.searchName && j.snap_mobile && j.snap_mobile.includes(S.searchName)
    ? ` <span style="color:#1565C0;font-size:11px;font-weight:600">${_hl(j.snap_mobile, S.searchName)}</span>` : '';
  return `
  <div class="job-row" data-id="${j.id}" style="border-left-color:${color};will-change:transform,opacity${isActive && daysSince>=25?';background:#FFF8F8':''}">
    <div class="job-row-thumb">
      ${j.thumb
        ? `<img data-auth-src="${j.thumb}" class="thumb-img" loading="lazy" alt="thumb">`
        : `<i class="fas fa-tools" style="color:#bbb;font-size:22px"></i>`}
    </div>
    <div class="job-row-body">
      <div class="job-row-top">
        <span class="job-id">${jobIdDisplay}${agingTag}</span>
        <span class="status-chip" style="background:${bg};color:${color};border-color:${color}">${sl(j.status)}</span>
      </div>
      <div class="job-name">${nameDisplay}${mobileDisplay}${j.dispatch_method === 'courier' ? ' <span style="background:#F3E5F5;color:#7B1FA2;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:4px">📮 Courier</span>' : ''}</div>
      <div class="job-row-foot">
        <span class="job-meta"><i class="fas fa-tools"></i> ${j.machine_count || 0}</span>
        <span class="job-meta" style="color:#888;font-size:10px">${fmtDate(j.created_at)}</span>
        ${hasSuperRight('view_financials')
          ? `<span class="job-balance" style="color:${balance>0?'#E53935':'#43A047'}">Bal: ${fmtRs(balance)}</span>`
          : ''}
      </div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW JOB FORM — includes product image upfront + per-machine charges
// ─────────────────────────────────────────────────────────────────────────────
function newJobHTML() {
  return `
  <div class="view-pad">
    <div class="card">
      <h2 class="section-title"><i class="fas fa-user-circle" style="color:#E53935"></i> Customer Details</h2>
      <div class="form-row-2">
        <div class="form-group">
          <label class="form-label">Mobile <span class="req">*</span></label>
          <input id="nj-mobile" type="tel" class="form-input" placeholder="9876543210" maxlength="15" inputmode="numeric">
        </div>
        <div class="form-group">
          <label class="form-label">Alt. Mobile</label>
          <input id="nj-mobile2" type="tel" class="form-input" placeholder="Optional" maxlength="15" inputmode="numeric">
        </div>
      </div>
      <div id="nj-cust-insights" style="display:none"></div>
      <div class="form-group">
        <label class="form-label">Customer Name <span class="req">*</span></label>
        <input id="nj-name" type="text" class="form-input" placeholder="Full name" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Customer Category</label>
        <select id="nj-category" class="form-input">
          <option value="Salon" selected>Salon</option>
          <option value="Consumer">Consumer</option>
          <option value="Retailer">Retailer</option>
          <option value="N/A">N/A</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <textarea id="nj-address" class="form-input" rows="2" placeholder="Street, area, city"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Internal Note</label>
        <textarea id="nj-note" class="form-input" rows="2" placeholder="Remarks for this job…"></textarea>
      </div>
      ${hasSuperRight('view_financials') ? `
      <div class="form-group">
        <label class="form-label">Received Amount (₹)</label>
        <input id="nj-received" type="number" class="form-input" placeholder="0" min="0" inputmode="decimal">
      </div>` : ''}

      <!-- Dispatch Method -->
      <div class="form-group">
        <label class="form-label"><i class="fas fa-truck" style="color:#7B1FA2"></i> Dispatch Through</label>
        <select id="nj-dispatch" class="form-input">
          <option value="in_person" selected>🤝 In Person</option>
          <option value="courier">📮 Courier</option>
        </select>
      </div>
      <div id="nj-dispatch-courier-wrap" class="form-group" style="display:none">
        <label class="form-label">Courier Name <span style="color:#999;font-size:12px">(optional)</span></label>
        <input id="nj-dispatch-courier" type="text" class="form-input" placeholder="e.g. DTDC, BlueDart">
      </div>
    </div>

    <div class="card">
      <h2 class="section-title"><i class="fas fa-tools" style="color:#E53935"></i> First Machine</h2>

      <!-- 1. Product Photo (Optional) -->
      <div class="form-group">
        <label class="form-label"><i class="fas fa-camera" style="color:#E53935"></i> Product Photo <span style="color:#999;font-size:12px">(optional)</span></label>
        <div style="display:flex;gap:10px;align-items:center">
          <label class="img-upload-label" style="flex:1">
            <i class="fas fa-camera"></i> Take / Pick Photo
            <input id="nj-img" type="file" accept="image/*" capture="environment" style="display:none">
          </label>
          <div id="nj-img-preview" style="display:none">
            <img id="nj-img-thumb" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:2px solid #e0e0e0">
            <button id="nj-img-clear" style="margin-left:4px;background:#E53935;color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px"><i class="fas fa-times"></i></button>
          </div>
        </div>
      </div>

      <!-- 2. Voice Note (Optional) -->
      <div class="form-group">
        <label class="form-label"><i class="fas fa-microphone" style="color:#E53935"></i> Voice Note <span style="color:#999;font-size:12px">(optional)</span></label>
        <div id="nj-audio-section">
          <button id="nj-audio-rec" class="btn-sm btn-orange" style="width:100%;padding:10px">
            <i class="fas fa-microphone"></i> Record Voice Note
          </button>
          <div id="nj-audio-preview" style="display:none;margin-top:6px;align-items:center;gap:8px">
            <audio id="nj-audio-play" controls style="flex:1;height:36px"></audio>
            <button id="nj-audio-clear" class="btn-sm btn-red" style="padding:6px 10px"><i class="fas fa-times"></i></button>
          </div>
        </div>
      </div>

      <!-- 3. Product Name with AI tiles -->
      <div class="form-group">
        <label class="form-label">Product Name <span class="req">*</span></label>
        <input id="nj-product" type="text" class="form-input" placeholder='e.g. Samsung TV 55"' autocomplete="off">
        <div id="nj-prod-sugs"></div>
      </div>

      <!-- 4. Complaint / Issue with quick-tags and AI tiles -->
      <div class="form-group">
        <label class="form-label">Complaint / Issue</label>
        <div class="complaint-tags" id="nj-ctags">
          <span class="ctag" data-t="Motor Issue">⚙️ Motor Issue</span>
          <span class="ctag" data-t="Power Issue">🔌 Power Issue</span>
          <span class="ctag" data-t="Blade Problem">🔪 Blade Problem</span>
          <span class="ctag" data-t="Heating Issue">🌡️ Heating Issue</span>
          <span class="ctag" data-t="Noise Issue">🔊 Noise Issue</span>
          <span class="ctag" data-t="Not Working">❌ Not Working</span>
          <span class="ctag" data-t="Charging Issue">🔋 Charging Issue</span>
          <span class="ctag" data-t="Speed Problem">💨 Speed Problem</span>
        </div>
        <textarea id="nj-complaint" class="form-input" rows="2" placeholder="Describe the problem…"></textarea>
        <div id="nj-comp-sugs"></div>
      </div>

      <!-- 5. Warranty Status -->
      <div class="form-group">
        <label class="form-label"><i class="fas fa-shield-alt" style="color:#1565C0"></i> Warranty Status</label>
        <select id="nj-warranty" class="form-input">
          <option value="out_warranty" selected>Out of Warranty</option>
          <option value="warranty">Under Warranty</option>
        </select>
      </div>
      <div id="nj-brand-wrap" class="form-group" style="display:none">
        <label class="form-label">Brand / Company</label>
        <select id="nj-brand" class="form-input">
          <option value="">— Select Brand —</option>
          <option value="IKONIC">IKONIC</option>
          <option value="HNK">HNK</option>
          <option value="MARC">MARC</option>
          <option value="AYTY Pro">AYTY Pro</option>
        </select>
      </div>

      <!-- 6. Repair Amount -->
      ${hasSuperRight('view_financials') ? `
      <div class="form-group">
        <label class="form-label">Repair Amount (₹)</label>
        <input id="nj-charges" type="number" class="form-input" placeholder="0" min="0" inputmode="decimal">
        <div id="nj-amt-sugs"></div>
      </div>` : ''}

      <!-- 7. Quantity (below Repair Amount, default 1, clear on focus) -->
      <div class="form-group">
        <label class="form-label">Quantity</label>
        <input id="nj-qty" type="number" class="form-input" placeholder="1" min="1" value="1" inputmode="numeric"
               onfocus="if(this.value==='1')this.value=''" onblur="if(!this.value)this.value='1'">
      </div>

      <!-- 7. Assign Staff -->
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Assign Staff</label>
        <select id="nj-staff" class="form-input">
          <option value="">— None —</option>
          ${S.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>` : ''}

      <button id="nj-submit" class="btn-primary btn-full" style="margin-top:8px">
        <i class="fas fa-save"></i> Create Job
      </button>
    </div>
  </div>`;
}

function bindNewJob() {
  // Pre-load staff for selector if admin
  if (isAdmin() && !S.staff.length) {
    API.get('/api/staff').then(r => {
      S.staff = r.data;
      const sel = document.getElementById('nj-staff');
      if (sel) sel.innerHTML = `<option value="">— None —</option>` +
        S.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    }).catch(() => {});
  }

  // Warranty dropdown toggle in New Job form
  document.getElementById('nj-warranty')?.addEventListener('change', e => {
    const wrap = document.getElementById('nj-brand-wrap');
    if (wrap) wrap.style.display = e.target.value === 'warranty' ? 'block' : 'none';
  });

  // Dispatch method toggle — show courier name field when courier selected
  document.getElementById('nj-dispatch')?.addEventListener('change', e => {
    const wrap = document.getElementById('nj-dispatch-courier-wrap');
    if (wrap) wrap.style.display = e.target.value === 'courier' ? 'block' : 'none';
  });

  const mobileIn = document.getElementById('nj-mobile');
  let _mobileLookupDone = '';
  async function lookupMobile() {
    const m = mobileIn?.value.trim();
    if (!m || m.length < 10 || m === _mobileLookupDone) return;
    _mobileLookupDone = m;
    try {
      const r = await API.get('/api/customers/by-mobile', { params: { mobile: m } });
      if (r.data) {
        document.getElementById('nj-name').value    = r.data.name    || '';
        document.getElementById('nj-mobile2').value = r.data.mobile2 || '';
        document.getElementById('nj-address').value = r.data.address || '';
        const catSel = document.getElementById('nj-category');
        if (catSel && r.data.category) catSel.value = r.data.category;
        toast('Customer found — auto-filled ✅', 'success');
        // Auto-focus product name after auto-fill
        setTimeout(() => document.getElementById('nj-product')?.focus(), 150);
      }
      // Fetch customer insights (total jobs, spending, last visit)
      API.get('/api/customers/insights', { params: { mobile: m } }).then(ir => {
        const ins = ir.data;
        const badge = document.getElementById('nj-cust-insights');
        if (badge && ins.total_jobs > 0) {
          badge.style.display = 'block';
          badge.innerHTML = `
            <div style="background:#E8F5E9;border:1px solid #43A047;border-radius:10px;padding:10px 14px;margin-top:8px">
              <div style="font-size:14px;font-weight:800;color:#2E7D32;margin-bottom:4px">
                🔄 Returning Customer (${ins.total_jobs} Jobs)
              </div>
              <div style="font-size:13px;color:#555;display:flex;gap:16px;flex-wrap:wrap">
                <span>💰 Total Spent: <b>${fmtRs(ins.total_spending || 0)}</b></span>
                ${ins.last_visit ? `<span>📅 Last Visit: <b>${fmtDate(ins.last_visit)}</b></span>` : ''}
              </div>
            </div>`;
        }
      }).catch(() => {});
    } catch (_) {}
  }
  mobileIn?.addEventListener('blur', lookupMobile);
  // Also trigger on input for instant lookup when 10+ digits typed
  mobileIn?.addEventListener('input', debounce(() => {
    if ((mobileIn?.value.trim() || '').length >= 10) lookupMobile();
  }, 400));

  // Smart name autofill — suggest existing customers as user types
  const nameIn = document.getElementById('nj-name');
  let _suggestTimeout = null;
  nameIn?.addEventListener('input', () => {
    clearTimeout(_suggestTimeout);
    const q = nameIn.value.trim();
    if (q.length < 2) { removeSuggestBox(); return; }
    _suggestTimeout = setTimeout(async () => {
      try {
        const r = await API.get('/api/customers/search', { params: { q } });
        const list = r.data || [];
        if (!list.length) { removeSuggestBox(); return; }
        let box = document.getElementById('nj-suggest-box');
        if (!box) {
          box = document.createElement('div');
          box.id = 'nj-suggest-box';
          box.style.cssText = 'position:absolute;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:1000;max-height:220px;overflow-y:auto;left:0;right:0;top:100%';
          nameIn.parentElement.style.position = 'relative';
          nameIn.parentElement.appendChild(box);
        }
        box.innerHTML = list.map(c => `
          <div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:14px"
               onmousedown="event.preventDefault()"
               onclick="(function(){
                 document.getElementById('nj-name').value='${esc(c.name)}';
                 document.getElementById('nj-mobile').value='${c.mobile||''}';
                 document.getElementById('nj-mobile2').value='${c.mobile2||''}';
                 document.getElementById('nj-address').value='${esc(c.address||'')}';
                 var _cs=document.getElementById('nj-category'); if(_cs) _cs.value='${esc(c.category||'Salon')}';
                 document.getElementById('nj-suggest-box')?.remove();
               })()">
            <b>${esc(c.name)}</b> <span style="color:#888;font-size:12px">${c.mobile||''}</span>
          </div>`).join('');
      } catch (_) {}
    }, 300);
  });
  nameIn?.addEventListener('blur', () => { setTimeout(removeSuggestBox, 200); });
  function removeSuggestBox() { document.getElementById('nj-suggest-box')?.remove(); }

  // Smart suggestion tiles for new job product/complaint/amount fields
  const njProdSugs = document.getElementById('nj-prod-sugs');
  const njCompSugs = document.getElementById('nj-comp-sugs');
  const njAmtSugs  = document.getElementById('nj-amt-sugs');

  function njUpdateProdSugs(q) {
    if (!njProdSugs) return;
    const sugs = _sugCache.getProducts(q);
    njProdSugs.innerHTML = suggestionTilesHTML(sugs, 'nj-product', 'prod-sugs');
    bindSuggestionTiles(njProdSugs, (v) => {
      njUpdateCompSugs(v);
      njUpdateAmtSugs(v);
      njUpdateCTags(v);
      setTimeout(() => document.getElementById('nj-complaint')?.focus(), 100);
    });
  }
  function njUpdateCompSugs(product) {
    if (!njCompSugs) return;
    const comps = _sugCache.getComplaints(product);
    njCompSugs.innerHTML = suggestionTilesHTML(comps, 'nj-complaint', 'comp-sugs');
    bindSuggestionTiles(njCompSugs, () => {
      setTimeout(() => document.getElementById('nj-charges')?.focus(), 100);
    });
  }
  function njUpdateAmtSugs(product) {
    if (!njAmtSugs) return;
    const amts = _sugCache.getAmounts(product);
    njAmtSugs.innerHTML = suggestionTilesHTML(amts.map(a => '₹' + a), 'nj-charges', 'amt-sugs');
    njAmtSugs.querySelectorAll('.sug-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const chg = document.getElementById('nj-charges');
        if (chg) { chg.value = tile.dataset.val.replace(/[₹,]/g, ''); chg.dispatchEvent(new Event('input')); }
        tile.style.background = '#E8F5E9';
        setTimeout(() => { tile.style.background = '#f0f4ff'; }, 400);
        setTimeout(() => document.getElementById('nj-qty')?.focus(), 100);
      }, { passive: true });
    });
  }

  // Complaint quick-tags (same as Add Machine modal)
  function njBindCTags() {
    document.querySelectorAll('#nj-ctags .ctag').forEach(tag => {
      tag.addEventListener('click', () => {
        const comp = document.getElementById('nj-complaint');
        if (!comp) return;
        const cur = comp.value.trim();
        comp.value = cur ? `${cur}, ${tag.dataset.t}` : tag.dataset.t;
        tag.style.background = '#FFEBEE';
        setTimeout(() => { tag.style.background = ''; }, 600);
      }, { passive: true });
    });
  }
  njBindCTags();

  function njUpdateCTags(productName) {
    const tagEl = document.getElementById('nj-ctags');
    if (!tagEl) return;
    const name = (productName || '').toLowerCase();
    const clipperTags  = ['⚙️ Motor Issue','🔪 Blade Problem','🔊 Noise Issue','💨 Speed Problem','❌ Not Working'];
    const dryerTags    = ['🌡️ Heating Issue','🔌 Power Issue','💨 Speed Problem','🔊 Noise Issue','❌ Not Working'];
    const trimmerTags  = ['⚙️ Motor Issue','🔋 Charging Issue','🔪 Blade Problem','🔌 Power Issue','❌ Not Working'];
    const acTags       = ['🌡️ Heating Issue','🔌 Power Issue','🔊 Noise Issue','💨 Speed Problem','❌ Not Working'];
    const genericTags  = ['⚙️ Motor Issue','🔌 Power Issue','🔪 Blade Problem','🌡️ Heating Issue','🔊 Noise Issue','❌ Not Working','🔋 Charging Issue','💨 Speed Problem'];
    let tags = genericTags;
    if (/clipper|cliper/.test(name))          tags = clipperTags;
    else if (/dryer|drier|blower/.test(name)) tags = dryerTags;
    else if (/trimmer|trim/.test(name))       tags = trimmerTags;
    else if (/ac|air/.test(name))             tags = acTags;
    tagEl.innerHTML = tags.map(t => { const raw = t.replace(/[^a-zA-Z ]/g,'').trim(); return `<span class="ctag" data-t="${raw}">${t}</span>`; }).join('');
    njBindCTags();
  }

  njUpdateProdSugs('');
  njUpdateCompSugs('');
  njUpdateAmtSugs('');

  document.getElementById('nj-product')?.addEventListener('input', debounce(e => {
    const val = e.target.value.trim();
    njUpdateProdSugs(val);
    njUpdateCompSugs(val);
    njUpdateAmtSugs(val);
    njUpdateCTags(val);
  }, 150));

  // Image preview (instant blob URL)
  const imgInput = document.getElementById('nj-img');
  imgInput?.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const blobUrl = URL.createObjectURL(file);
    document.getElementById('nj-img-thumb').src = blobUrl;
    document.getElementById('nj-img-preview').style.display = 'flex';
  });
  document.getElementById('nj-img-clear')?.addEventListener('click', () => {
    if (imgInput) imgInput.value = '';
    document.getElementById('nj-img-preview').style.display = 'none';
  });

  // Voice Note recorder for first machine
  let _njAudioBlob = null, _njAudioMime = 'audio/webm';
  document.getElementById('nj-audio-rec')?.addEventListener('click', async () => {
    const btn = document.getElementById('nj-audio-rec');
    if (S.audioRecorder && S.audioRecorder.state === 'recording') {
      stopAudioRecorder();
      btn.innerHTML = '<i class="fas fa-microphone"></i> Record Voice Note';
      btn.style.background = '';
      return;
    }
    const ok = await startAudioRecorder((blob, mime) => {
      _njAudioBlob = blob; _njAudioMime = mime;
      const url = URL.createObjectURL(blob);
      const aud = document.getElementById('nj-audio-play');
      if (aud) aud.src = url;
      const prev = document.getElementById('nj-audio-preview');
      if (prev) prev.style.display = 'flex';
      btn.innerHTML = '<i class="fas fa-microphone"></i> Record Voice Note';
      btn.style.background = '';
    });
    if (ok) {
      btn.innerHTML = '<i class="fas fa-stop" style="animation:pulse 1s infinite"></i> Stop Recording';
      btn.style.background = '#E53935';
    }
  });
  document.getElementById('nj-audio-clear')?.addEventListener('click', () => {
    _njAudioBlob = null;
    document.getElementById('nj-audio-preview').style.display = 'none';
    stopAudioRecorder();
  });

  document.getElementById('nj-submit')?.addEventListener('click', async () => {
    const name    = document.getElementById('nj-name')?.value.trim();
    const mobile  = document.getElementById('nj-mobile')?.value.trim();
    const product = document.getElementById('nj-product')?.value.trim();
    if (!name || !mobile || !product) { toast('Name, mobile & product are required', 'error'); return; }

    // Save to suggestion cache for future use
    _sugCache.addProduct(product);
    const _njComp = document.getElementById('nj-complaint')?.value.trim();
    if (_njComp) _sugCache.addComplaint(_njComp, product);
    const _njChg = hasSuperRight('view_financials') ? (parseFloat(document.getElementById('nj-charges')?.value) || 0) : 0;
    if (_njChg > 0) _sugCache.addAmount(_njChg, product);

    const btn = document.getElementById('nj-submit');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';

    // Capture form data before async ops
    const njDispatch = document.getElementById('nj-dispatch')?.value || 'in_person';
    const formData = {
      customer_name:    name,
      customer_mobile:  mobile,
      customer_mobile2: document.getElementById('nj-mobile2')?.value.trim() || null,
      customer_address: document.getElementById('nj-address')?.value.trim() || null,
      customer_category: document.getElementById('nj-category')?.value || 'Salon',
      note:             document.getElementById('nj-note')?.value.trim()    || null,
      received_amount:  hasSuperRight('view_financials') ? (parseFloat(document.getElementById('nj-received')?.value) || 0) : 0,
      dispatch_method:  njDispatch,
      dispatch_courier_name: njDispatch === 'courier' ? (document.getElementById('nj-dispatch-courier')?.value.trim() || null) : null,
    };
    const njWarrantyType = document.getElementById('nj-warranty')?.value || 'out_warranty';
    const njWarrantyBrand = njWarrantyType === 'warranty' ? (document.getElementById('nj-brand')?.value || null) : null;
    const machData = {
      product_name:      product,
      product_complaint: document.getElementById('nj-complaint')?.value.trim() || null,
      charges:           hasSuperRight('view_financials') ? (parseFloat(document.getElementById('nj-charges')?.value) || 0) : 0,
      quantity:          parseInt(document.getElementById('nj-qty')?.value) || 1,
      assigned_staff_id: hasSuperRight('manage_machines') ? (document.getElementById('nj-staff')?.value || null) : null,
      warranty_type:     njWarrantyType,
      warranty_brand:    njWarrantyBrand,
    };
    const imgFile = document.getElementById('nj-img')?.files[0];
    const audioBlob = _njAudioBlob;
    const audioMime = _njAudioMime;

    try {
      // ── OPTIMISTIC UI: Show success immediately, navigate FIRST ───────────
      const jobR = await API.post('/api/jobs', formData);
      const jid = jobR.data.id;

      // Show success toast and navigate to detail instantly
      toast(`Job ${jid} created!`, 'success');
      S.jobId = jid;
      navigate('detail');

      // ── Background: add machine + upload media (non-blocking) ─────────────
      (async () => {
        try {
          const machR = await API.post(`/api/jobs/${jid}/machines`, machData);
          const machId = machR.data.id;

          const uploads = [];
          if (imgFile && machId) {
            uploads.push((async () => {
              try {
                const compressed = await compressImage(imgFile, 1080, 0.82);
                const fd = new FormData(); fd.append('image', compressed);
                await API.post(`/api/machines/${machId}/images`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
              } catch (_) { toast('Image upload failed (job still created)', 'error'); }
            })());
          }
          if (audioBlob && machId) {
            uploads.push((async () => {
              try {
                const ext  = audioMime.includes('ogg') ? '.ogg' : '.webm';
                const file = new File([audioBlob], `voice_note${ext}`, { type: audioMime });
                const fd   = new FormData(); fd.append('audio', file);
                await API.post(`/api/machines/${machId}/audio`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
              } catch (_) { toast('Audio upload failed (job still created)', 'error'); }
            })());
          }
          if (uploads.length) await Promise.allSettled(uploads);
          // Silently refresh detail if still on this job
          if (S.jobId === jid && S.view === 'detail') loadDetail();
        } catch (_) {
          toast('Machine add failed — please add manually', 'error');
        }
      })();
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create job', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Create Job';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB DETAIL
// ─────────────────────────────────────────────────────────────────────────────
async function loadDetail() {
  if (!S.jobId) return;

  // 1) INSTANT: Show cached detail from IndexedDB immediately (0ms)
  const cached = await IDB.loadDetail(S.jobId);
  if (cached) {
    S.job = cached;
    // Load staff from offline cache too
    if (isAdmin() && !S.staff.length) {
      const cachedStaff = await IDB.loadStaff();
      if (cachedStaff) S.staff = cachedStaff;
    }
    renderDetail();
  }

  // 2) BACKGROUND: Fetch fresh data from API and update if changed
  try {
    const [jobResp, staffResp] = await Promise.all([
      API.get(`/api/jobs/${S.jobId}`),
      (isAdmin() && !S.staff.length) ? API.get('/api/staff').catch(() => null) : Promise.resolve(null)
    ]);
    const freshJob = jobResp.data;
    if (staffResp?.data) {
      S.staff = staffResp.data;
      IDB.saveStaff(S.staff); // Cache staff for offline
    }

    // Only re-render if data actually changed (avoid flicker)
    const changed = !cached || freshJob.updated_at !== cached.updated_at
                    || freshJob.status !== cached.status
                    || JSON.stringify(freshJob.machines) !== JSON.stringify(cached.machines);
    S.job = freshJob;
    IDB.saveDetail(freshJob); // Persist to offline memory
    if (changed || !cached) renderDetail();
  } catch {
    // v39: If offline with cached data, just show it (already rendered above)
    if (cached && _isOffline) {
      // Already rendered — just lock write buttons
      setTimeout(() => _lockMutatingUI(true), 50);
    } else if (!cached) {
      const root = document.getElementById('detail-root');
      if (root) root.innerHTML = _isOffline
        ? `<div class="empty-state"><i class="fas fa-wifi-slash fa-2x" style="color:#E53935"></i><p style="font-weight:700">Offline</p><p style="font-size:13px;color:#888">This job hasn't been cached yet. Go online to view it.</p></div>`
        : `<div class="empty-state" style="color:#e53935"><i class="fas fa-exclamation-triangle fa-2x"></i><p>Failed to load job</p></div>`;
    }
  }
  // v39: Lock write UI after detail render if offline
  if (_isOffline) setTimeout(() => _lockMutatingUI(true), 50);
}

function renderDetail() {
  const j    = S.job;
  if (!j) return;
  const root = document.getElementById('detail-root');
  if (!root) return;

  // Refresh sticky header
  const hdr = document.querySelector('.app-header');
  if (hdr) {
    hdr.outerHTML = headerHTML();
    document.getElementById('hdr-back-btn')?.addEventListener('click', () => navigate('dashboard'));
    document.getElementById('hdr-logout-btn')?.addEventListener('click', logout);
  }

  const color    = sc(j.status);
  const total    = j.total_charges   || 0;
  const discount = j.discount        || 0;
  const received = j.received_amount || 0;
  const balance  = Math.max(0, total - discount - received);
  const userId   = S.user?.id;

  root.innerHTML = `
    <!-- Status Banner -->
    <div class="detail-banner" style="background:${color};display:flex;align-items:center;justify-content:space-between;padding:14px 18px">
      <span class="detail-job-id" style="font-size:22px;font-weight:900;color:#fff;letter-spacing:1px">${j.id}</span>
      <span class="detail-status-label" style="background:rgba(255,255,255,.2);padding:6px 18px;border-radius:10px;font-weight:800;color:#fff;font-size:15px;letter-spacing:.5px;text-align:center;display:inline-flex;align-items:center;justify-content:center;min-width:120px;min-height:34px">${sl(j.status)}</span>
    </div>

    <!-- Customer Card -->
    <div class="card mt-3">
      <div class="section-header" style="margin-bottom:6px">
        <h3 class="section-title" style="margin:0"><i class="fas fa-user-circle" style="color:${color}"></i> Customer</h3>
        ${hasSuperRight('edit_jobs') ? `<button id="btn-edit-customer" class="btn-sm btn-orange" style="padding:4px 10px;font-size:12px"><i class="fas fa-edit"></i> Edit</button>` : ''}
      </div>
      <div class="info-row">
        <i class="fas fa-user info-icon" style="color:${color}"></i>
        <span class="info-val fw-bold">${esc(j.snap_name)}</span>
        ${j.snap_category ? `<span style="background:#E8EAF6;color:#3949AB;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:8px">${esc(j.snap_category)}</span>` : ''}
      </div>
      ${hasSuperRight('view_jobs') ? `
      <div class="info-row">
        <i class="fas fa-phone info-icon" style="color:${color}"></i>
        <a href="tel:${j.snap_mobile}" class="info-link">${j.snap_mobile}</a>
        ${j.snap_mobile2 ? `<a href="tel:${j.snap_mobile2}" class="info-link ml-8">${j.snap_mobile2}</a>` : ''}
      </div>` : ''}
      ${j.snap_address ? `
      <div class="info-row">
        <i class="fas fa-map-marker-alt info-icon" style="color:${color}"></i>
        <span class="info-val">${esc(j.snap_address)}</span>
      </div>` : ''}
      ${j.note ? `
      <div class="info-row">
        <i class="fas fa-sticky-note info-icon" style="color:${color}"></i>
        <span class="info-val text-muted">${esc(j.note)}</span>
      </div>` : ''}
      <div class="info-row">
        <i class="fas fa-calendar info-icon" style="color:${color}"></i>
        <span class="info-val text-muted">${fmtDate(j.created_at)}</span>
      </div>
      ${j.dispatch_method === 'courier' ? `
      <div class="info-row" style="background:#F3E5F5;border-radius:8px;padding:8px 12px;margin-top:4px">
        <i class="fas fa-truck info-icon" style="color:#7B1FA2"></i>
        <span class="info-val" style="color:#7B1FA2;font-weight:800">📮 Dispatch through Courier${j.dispatch_courier_name ? ' — ' + esc(j.dispatch_courier_name) : ''}</span>
      </div>` : ''}
      ${hasSuperRight('view_jobs') && j.snap_mobile ? `
      <div class="info-row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <button id="btn-cust-history" class="btn-sm" style="background:#7B1FA2;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer">
          <i class="fas fa-history"></i> Customer History
        </button>
        ${hasSuperRight('share') ? `<button id="btn-wa-reminder" class="btn-sm" style="background:#25D366;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer">
          <i class="fab fa-whatsapp"></i> Send Reminder
        </button>` : ''}
      </div>` : ''}
    </div>

    <!-- Financial Panel — RBAC: visible with view_financials right -->
    ${hasSuperRight('view_financials') ? `
    <div class="card mt-3 financial-panel">
      <div class="fin-title"><i class="fas fa-rupee-sign"></i> Financials</div>
        ${(j.machines||[]).filter(m => (parseFloat(m.charges)||0) > 0).map(m => {
          const lineAmt = (parseFloat(m.charges)||0) * (parseInt(m.quantity)||1);
          const isReturned = m.status === 'returned';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:13px;color:${isReturned?'#999':'#555'}${isReturned?';text-decoration:line-through':''}">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.product_name)}${m.quantity > 1 ? ' ×' + m.quantity : ''}${isReturned?' (Returned)':''}</span>
            <span style="font-weight:600;color:${isReturned?'#999':'#1a1a2e'};flex-shrink:0;margin-left:8px">${fmtRs(lineAmt)}</span>
          </div>`;
        }).join('')}
        <div class="fin-row" style="border-top:1px solid #e0e0e0;margin-top:4px;padding-top:6px">
          <span class="fin-label fw-bold">= Total Amount</span>
          <span class="fin-amount fw-bold">${fmtRs(total)}</span>
        </div>
        ${discount > 0 ? `<div class="fin-row">
          <span class="fin-label" style="color:#FB8C00">Discount/Deduction</span>
          <span class="fin-amount" style="color:#FB8C00">- ${fmtRs(discount)}</span>
        </div>` : ''}
        <div class="fin-row">
          <span class="fin-label">Received Amount${j.payment_method === 'online' ? ' (Online)' : ' (Cash)'}</span>
          <span class="fin-amount" style="color:#43A047">${fmtRs(received)}</span>
        </div>
      <div class="fin-row fin-balance">
        <span class="fin-label fw-bold">Balance Due</span>
        <span class="fin-amount fw-bold" style="color:${balance>0?'#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
      <div class="fin-edit-row">
        <label class="form-label" style="margin:0;font-weight:700">Discount/Deduction (₹)</label>
        <div style="display:flex;gap:8px;margin-top:4px;margin-bottom:8px">
          <input id="discount-input" type="number" class="form-input" style="flex:1"
                 value="${discount}" min="0" placeholder="0" inputmode="decimal">
        </div>
        <label class="form-label" style="margin:0;font-weight:700">Received Amount (₹)</label>
        <div style="display:flex;gap:8px;margin-top:4px">
          <input id="recv-input" type="number" class="form-input" style="flex:1"
                 value="${received}" min="0" placeholder="0" inputmode="decimal">
          <select id="pay-method" class="form-input" style="width:100px;flex-shrink:0">
            <option value="cash" ${(j.payment_method||'cash')==='cash'?'selected':''}>Cash</option>
            <option value="online" ${j.payment_method==='online'?'selected':''}>Online</option>
          </select>
          <button id="recv-save" class="btn-sm btn-green">Save</button>
        </div>
      </div>
    </div>` : ''}

    ${j.status === 'delivered' && j.delivery_receiver_name ? `
    <!-- Delivery Info Card -->
    <div class="card mt-3 delivery-card">
      <div class="delivery-title"><i class="fas fa-box-open"></i> Delivery Information</div>
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-user-check info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${esc(j.delivery_receiver_name)}</span>
      </div>
      ${j.delivery_receiver_mobile ? `
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-phone info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${j.delivery_receiver_mobile}</span>
      </div>` : ''}
      ${j.delivery_method ? `
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-truck info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${j.delivery_method === 'courier' ? 'Courier' : 'In Person'}
          ${j.delivery_courier_name ? ' — ' + esc(j.delivery_courier_name) : ''}
          ${j.delivery_tracking ? ' · #' + esc(j.delivery_tracking) : ''}
        </span>
      </div>` : ''}
      ${j.delivered_at ? `
      <div class="info-row" style="border:none;padding:3px 0">
        <i class="fas fa-calendar-check info-icon" style="color:#1E88E5"></i>
        <span class="info-val">${fmtDate(j.delivered_at)}</span>
      </div>` : ''}
    </div>` : ''}

    <!-- Action Buttons — RBAC: rights-based access per staff -->
    <div class="action-row mt-3">
      ${hasSuperRight('deliver') ? `
      <button id="btn-deliver" class="action-btn" style="background:#1E88E5">
        <i class="fas fa-check-double"></i><span>Deliver</span>
      </button>` : ''}
      ${hasSuperRight('download') ? `
      <button id="btn-jobcard" class="action-btn" style="background:#43A047">
        <i class="fas fa-file-image"></i><span>Download</span>
      </button>` : ''}
      ${hasSuperRight('share') ? `
      <button id="btn-share" class="action-btn" style="background:#25D366">
        <i class="fab fa-whatsapp"></i><span>Share</span>
      </button>
      <button id="btn-print-addr" class="action-btn" style="background:#FB8C00">
        <i class="fas fa-print"></i><span>Address</span>
      </button>` : ''}
      ${isAdminOnly() ? `
      <button id="btn-del-job" class="action-btn" style="background:#E53935">
        <i class="fas fa-trash"></i><span>Delete</span>
      </button>` : ''}
      <button id="btn-job-history" class="action-btn" style="background:#7B1FA2">
        <i class="fas fa-history"></i><span>History</span>
      </button>
    </div>

    <!-- Machines List -->
    <div class="card mt-3">
      <div class="section-header">
        <h3 class="section-title" style="margin:0">
          <i class="fas fa-tools" style="color:#E53935"></i> Machines
          <span id="machine-counter" style="background:#E53935;color:#fff;border-radius:12px;padding:2px 10px;font-size:13px;font-weight:800;margin-left:8px">Total: ${(j.machines||[]).reduce((s,m) => s + (parseInt(m.quantity)||1), 0)}</span>
        </h3>
        <div style="display:flex;gap:6px;align-items:center">
          ${hasSuperRight('update_machine_status') ? `<button id="btn-batch-select" class="btn-sm" style="background:#7B1FA2;color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer"><i class="fas fa-check-double"></i> Select</button>` : ''}
          ${hasSuperRight('manage_machines') ? `<button id="btn-add-machine" class="btn-sm btn-red">+ Add</button>` : ''}
        </div>
      </div>
      <!-- v36: Batch action bar — hidden until selection mode is active -->
      <div id="batch-bar" style="display:none;padding:8px 10px;background:linear-gradient(135deg,#EDE7F6,#E8EAF6);border-radius:10px;margin-bottom:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:6px">
            <button id="batch-select-all" class="btn-sm" style="background:#fff;color:#7B1FA2;border:1.5px solid #7B1FA2;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer">Select All</button>
            <span id="batch-count" style="font-size:12px;font-weight:700;color:#7B1FA2">0 selected</span>
          </div>
          <button id="batch-cancel" class="btn-sm" style="background:#fff;color:#E53935;border:1.5px solid #E53935;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer"><i class="fas fa-times"></i> Cancel</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="batch-action-btn" data-batch-status="repaired" style="flex:1;background:#43A047;color:#fff;border:none;border-radius:8px;padding:8px 6px;font-size:12px;font-weight:700;cursor:pointer;min-width:70px"><i class="fas fa-wrench"></i> Repaired</button>
          <button class="batch-action-btn" data-batch-status="returned" style="flex:1;background:#B8860B;color:#fff;border:none;border-radius:8px;padding:8px 6px;font-size:12px;font-weight:700;cursor:pointer;min-width:70px"><i class="fas fa-undo"></i> Returned</button>
          <button class="batch-action-btn" data-batch-status="delivered" style="flex:1;background:#1E88E5;color:#fff;border:none;border-radius:8px;padding:8px 6px;font-size:12px;font-weight:700;cursor:pointer;min-width:70px"><i class="fas fa-check-double"></i> Delivered</button>
          <button class="batch-action-btn" data-batch-status="under_repair" style="flex:1;background:#E53935;color:#fff;border:none;border-radius:8px;padding:8px 6px;font-size:12px;font-weight:700;cursor:pointer;min-width:70px"><i class="fas fa-tools"></i> Under Repair</button>
        </div>
      </div>
      <div id="machines-container">
        ${(j.machines||[]).length
          ? (j.machines||[]).map(m => machineCardHTML(m, userId)).join('')
          : '<p class="text-muted text-center" style="padding:20px">No machines yet — tap + Add</p>'}
      </div>
    </div>

    <!-- Hidden print element for html2canvas — dynamic height, no overflow -->
    <div id="job-card-print"
         style="position:fixed;left:-99999px;top:0;width:1080px;
                background:#fff;pointer-events:none;z-index:-1">
      ${jobCardPrintHTML(j)}
    </div>`;

  bindDetail(j);
  // Load authenticated images and audio after DOM is set
  requestAnimationFrame(() => applyAuthImages(document.getElementById('detail-root')));
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE VIEWER (click-to-enlarge lightbox)
// ─────────────────────────────────────────────────────────────────────────────
function openImageViewer(url) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:2000;display:flex;align-items:center;justify-content:center;';
  const img = document.createElement('img');
  img.style.cssText = 'max-width:95vw;max-height:90vh;object-fit:contain;border-radius:8px;';
  img.alt = 'Image';
  ov.appendChild(img);
  // close on tap
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
  loadAuthMedia(url, img, 'src');
}
// Expose for inline onclick handlers in modal HTML strings
window.openImageViewer = openImageViewer;

// ─────────────────────────────────────────────────────────────────────────────
// MACHINE CARD
// Staff: sees product name, complaint, status; can change status ONLY if assigned
// Status dropdown disabled for staff not assigned to this machine → shows Request button
// ─────────────────────────────────────────────────────────────────────────────
function machineCardHTML(m, currentUserId) {
  const color = sc(m.status);
  const canUpdateStatus = hasSuperRight('update_machine_status');
  const isAssigned = isAdmin() || (m.assigned_staff_id === currentUserId) || canUpdateStatus;
  const staffNotAssigned = !isAdmin() && m.assigned_staff_id !== currentUserId && !canUpdateStatus;
  // Normalize audio URL: old records stored /api/images/audio/..., new ones /api/audio/...
  const audioUrl = m.audio_note_url
    ? m.audio_note_url.replace('/api/images/audio/', '/api/audio/')
    : null;

  return `
  <div class="machine-card" data-machine-id="${m.id}" style="border-left-color:${color};will-change:transform,opacity">
    <div class="machine-top" style="display:flex;gap:10px;align-items:flex-start">
      <!-- v36: batch selection checkbox — hidden by default, shown in select mode -->
      <label class="batch-check-wrap" style="display:none;flex-shrink:0;align-items:flex-start;padding-top:2px;cursor:pointer">
        <input type="checkbox" class="batch-check" data-mid="${m.id}" style="width:22px;height:22px;accent-color:#7B1FA2;cursor:pointer;margin:0;flex-shrink:0">
      </label>
      <div style="flex:1;min-width:0;overflow:hidden">
        <div class="machine-name" style="font-size:15px;font-weight:800;color:#1a1a2e;line-height:1.3;word-break:break-word">${esc(m.product_name)}${m.quantity>1?` <span class="machine-qty" style="color:#888;font-size:13px;font-weight:600">×${m.quantity}</span>`:''}</div>
        ${m.product_complaint ? `<div class="machine-complaint" style="font-size:13px;color:#666;margin-top:3px;line-height:1.3;word-break:break-word">${esc(m.product_complaint)}</div>` : ''}
        ${m.work_done ? `<div style="font-size:12px;color:#2E7D32;margin-top:2px;line-height:1.3">✅ Work: ${esc(m.work_done)}</div>` : ''}
        ${m.return_reason ? `<div style="font-size:12px;color:#E65100;margin-top:2px;line-height:1.3">↩ ${esc(m.return_reason)}</div>` : ''}
        ${m.warranty_type === 'warranty' && m.warranty_brand ? `<div style="font-size:12px;color:#1565C0;margin-top:2px;line-height:1.3;font-weight:700"><i class="fas fa-shield-alt"></i> Warranty: ${esc(m.warranty_brand)}</div>` : ''}
        ${m.warranty_type === 'out_warranty' ? `<div style="font-size:11px;color:#999;margin-top:2px"><i class="fas fa-shield-alt" style="opacity:.5"></i> Out of Warranty</div>` : ''}
        ${m.staff_name ? `<div class="machine-staff" style="font-size:12px;color:#888;margin-top:2px"><i class="fas fa-user-cog"></i> ${esc(m.staff_name)}</div>` : ''}
        ${m.status === 'delivered' ? `<div style="font-size:12px;color:#1E88E5;margin-top:3px;font-weight:700"><i class="fas fa-check-double"></i> Delivered ${m.delivery_method === 'courier' ? '📮 Courier' : '🤝 In Person'}${m.delivery_receiver_name ? ' to ' + esc(m.delivery_receiver_name) : ''}${m.delivery_courier_name ? ' via ' + esc(m.delivery_courier_name) : ''}</div>` : ''}
      </div>
      <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:90px">
        ${isAssigned ? `
        <select data-mid="${m.id}" class="status-sel" data-prev="${m.status}" style="border:2px solid ${color};color:${color};border-radius:8px;padding:4px 6px;font-size:12px;font-weight:700;text-align:center;text-align-last:center;background:#fff;min-width:110px;cursor:pointer;min-height:36px">
          <option value="under_repair" ${m.status==='under_repair'?'selected':''}>Under Repair</option>
          <option value="repaired"     ${m.status==='repaired'    ?'selected':''}>Repaired</option>
          <option value="returned"     ${m.status==='returned'    ?'selected':''}>Returned</option>
          <option value="delivered"    ${m.status==='delivered'   ?'selected':''}>Delivered</option>
        </select>` : `
        <span class="status-chip" style="background:${sb(m.status)};color:${color};border:1.5px solid ${color};display:inline-flex;align-items:center;justify-content:center;padding:5px 14px;border-radius:8px;font-size:12px;font-weight:700;white-space:nowrap;text-align:center;min-width:90px;min-height:30px;box-sizing:border-box">${sl(m.status)}</span>`}
        ${hasSuperRight('view_financials') ? `<div style="font-size:14px;font-weight:800;color:${m.status==='returned'?'#999':'#1a1a2e'};text-align:center;white-space:nowrap${m.status==='returned'?';text-decoration:line-through':''}">
          ${m.warranty_type === 'warranty' && m.warranty_brand ? `<div style="font-size:10px;color:#1565C0;font-weight:700">[${esc(m.warranty_brand)}]</div>` : ''}
          ${fmtRs((parseFloat(m.charges)||0) * (parseInt(m.quantity)||1))}${m.quantity > 1 ? `<div style="font-size:10px;color:#888;font-weight:600">${fmtRs(m.charges)} × ${m.quantity}</div>` : ''}</div>` : ''}
      </div>
    </div>

    <!-- Images row with embedded camera upload -->
    <div class="images-row">
      ${(m.images||[]).map(img => `
      <div class="img-wrap" onclick="openImageViewer('${img.url}')" style="cursor:pointer">
        <img data-auth-src="${img.url}" class="img-thumb" loading="lazy" alt="">
        ${hasSuperRight('edit_jobs') ? `<button class="img-del-btn" data-iid="${img.id}" title="Remove" onclick="event.stopPropagation()">×</button>` : ''}
      </div>`).join('')}
      <!-- Camera button — part of machine details, available to all -->
      <label class="img-add-btn" title="Take / pick photo">
        <i class="fas fa-camera"></i>
        <input type="file" accept="image/*" capture="environment"
               data-mid="${m.id}" class="img-file-input" style="display:none">
      </label>
    </div>

    <!-- Audio Note Section (admin & staff — not public) -->
    <div class="audio-row">
      ${audioUrl ? `
      <div style="flex:1;display:flex;align-items:center;gap:6px;min-width:0">
        <audio controls data-audio-src="${audioUrl}" class="audio-player" preload="none" style="flex:1;min-width:0"></audio>
        ${hasSuperRight('edit_jobs') ? `<button data-mid="${m.id}" class="btn-sm btn-red btn-del-audio" title="Delete"><i class="fas fa-trash"></i></button>` : ''}
      </div>` : `
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-rec-audio">
        <i class="fas fa-microphone"></i> Voice Note
      </button>`}
    </div>

    ${hasSuperRight('edit_jobs') ? `
    <div class="machine-actions">
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-edit-m">
        <i class="fas fa-edit"></i> Edit
      </button>
      ${isAdminOnly() ? `<button data-mid="${m.id}" class="btn-sm btn-red btn-del-m">
        <i class="fas fa-trash"></i>
      </button>` : ''}
    </div>` : staffNotAssigned ? `
    <div class="machine-actions">
      <button data-mid="${m.id}" data-jid="${S.job?.id||''}" class="btn-sm btn-blue btn-request-assign">
        <i class="fas fa-hand-paper"></i> Request Assignment
      </button>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BIND DETAIL
// ─────────────────────────────────────────────────────────────────────────────
function bindDetail(j) {
  // Status selects — only for assigned staff / admin
  document.querySelectorAll('.status-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      const mid      = e.target.dataset.mid;
      const newStatus = e.target.value;
      const prevStatus = e.target.dataset.prev || 'under_repair';

      // v34: Machine-level "Delivered" — show delivery method modal
      if (newStatus === 'delivered') {
        showModal(`
          <h3 class="modal-title"><i class="fas fa-check-double" style="color:#1E88E5"></i> Deliver Machine</h3>
          <div class="form-group">
            <label class="form-label">Delivery Method <span class="req">*</span></label>
            <select id="md-method" class="form-input">
              <option value="in_person">🤝 In Person</option>
              <option value="courier">📮 Courier</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Receiver Name <span style="color:#999;font-size:12px">(optional)</span></label>
            <input id="md-rname" type="text" class="form-input" placeholder="Person who collected">
          </div>
          <div class="form-group" id="md-courier-wrap" style="display:none">
            <label class="form-label">Courier Name <span style="color:#999;font-size:12px">(optional)</span></label>
            <input id="md-courier" type="text" class="form-input" placeholder="e.g. DTDC, BlueDart">
          </div>
          <div class="modal-footer">
            <button onclick="closeModal()" class="btn-ghost">Cancel</button>
            <button id="md-confirm" class="btn-primary" style="background:#1E88E5"><i class="fas fa-check"></i> Confirm</button>
          </div>`);
        document.getElementById('md-method')?.addEventListener('change', ev => {
          document.getElementById('md-courier-wrap').style.display = ev.target.value === 'courier' ? '' : 'none';
        });
        document.getElementById('md-confirm')?.addEventListener('click', async () => {
          const deliveryData = {
            status: 'delivered',
            delivery_method: document.getElementById('md-method')?.value || 'in_person',
            delivery_receiver_name: document.getElementById('md-rname')?.value.trim() || null,
            delivery_courier_name: document.getElementById('md-courier')?.value.trim() || null,
          };
          closeModal();
          try {
            await API.put(`/api/machines/${mid}`, deliveryData);
            toast('Machine marked as delivered', 'success');
            await loadDetail();
          } catch (err) {
            toast(err.response?.data?.error || 'Update failed', 'error');
            e.target.value = prevStatus;
          }
        });
        document.querySelector('.modal-overlay')?.addEventListener('click', () => { e.target.value = prevStatus; }, { once: true });
        return;
      }

      // Show optional note modal for meaningful transitions
      const needsNote = (prevStatus === 'under_repair' && newStatus === 'repaired')
                     || (prevStatus === 'under_repair' && newStatus === 'returned')
                     || (newStatus === 'repaired')
                     || (newStatus === 'returned');

      if (needsNote) {
        const label    = newStatus === 'repaired' ? 'Work Done (optional)' : 'Return Reason (optional)';
        const pholder  = newStatus === 'repaired' ? 'e.g. Replaced motor, cleaned blade…' : 'e.g. Customer collected unrepaired…';
        const noteKey  = newStatus === 'repaired' ? 'work_done' : 'return_reason';
        showModal(`
          <h3 class="modal-title"><i class="fas fa-clipboard-check" style="color:#43A047"></i> ${newStatus === 'repaired' ? 'Mark as Repaired' : 'Mark as Returned'}</h3>
          <div class="form-group">
            <label class="form-label">${label}</label>
            <textarea id="status-note-input" class="form-input" rows="3" placeholder="${pholder}" style="resize:vertical"></textarea>
          </div>
          <div class="modal-footer">
            <button onclick="closeModal()" class="btn-ghost">Cancel</button>
            <button id="status-note-save" class="btn-primary">Confirm</button>
          </div>`);
        document.getElementById('status-note-save')?.addEventListener('click', async () => {
          const noteVal = document.getElementById('status-note-input')?.value.trim() || null;
          closeModal();
          try {
            await API.put(`/api/machines/${mid}`, { status: newStatus, [noteKey]: noteVal });
            toast('Status updated', 'success');
            await loadDetail();
          } catch (err) {
            toast(err.response?.data?.error || 'Update failed', 'error');
            e.target.value = prevStatus;
          }
        });
        // On cancel, revert select
        document.querySelector('.modal-overlay')?.addEventListener('click', () => { e.target.value = prevStatus; }, { once: true });
        return;
      }

      try {
        await API.put(`/api/machines/${mid}`, { status: newStatus });
        toast('Status updated', 'success');
        await loadDetail();
      } catch (err) {
        toast(err.response?.data?.error || 'Update failed', 'error');
        e.target.value = prevStatus;
      }
    });
    sel.dataset.prev = sel.value;
  });

  // Image upload with canvas compression (1080px) — async non-blocking with instant preview
  document.querySelectorAll('.img-file-input').forEach(input => {
    input.addEventListener('change', async e => {
      const raw = e.target.files[0];
      if (!raw) return;
      const mid = e.target.dataset.mid;

      // Instant local preview using blob URL (no wait for upload)
      const previewUrl = URL.createObjectURL(raw);
      const wrap = input.closest('.machine-card')?.querySelector('.images-row');
      if (wrap) {
        const tempDiv = document.createElement('div');
        tempDiv.className = 'img-wrap';
        tempDiv.style.cssText = 'position:relative;opacity:0.6';
        const tempImg = document.createElement('img');
        tempImg.src = previewUrl;
        tempImg.className = 'img-thumb';
        tempImg.style.cssText = 'filter:blur(1px)';
        const spinner = document.createElement('div');
        spinner.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.5)';
        spinner.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:#E53935;font-size:18px"></i>';
        tempDiv.appendChild(tempImg);
        tempDiv.appendChild(spinner);
        const addBtn = wrap.querySelector('.img-add-btn');
        if (addBtn) wrap.insertBefore(tempDiv, addBtn);
        else wrap.appendChild(tempDiv);

        // Upload asynchronously without blocking UI
        (async () => {
          try {
            const compressed = await compressImage(raw, 1080, 0.82);
            const fd = new FormData();
            fd.append('image', compressed);
            await API.post(`/api/machines/${mid}/images`, fd, {
              headers: { 'Content-Type': 'multipart/form-data' }
            });
            toast('Image saved ✅', 'success');
            URL.revokeObjectURL(previewUrl);
            await loadDetail(); // Refresh to show real image from R2
          } catch (_) {
            toast('Upload failed — retrying…', 'error');
            tempDiv.remove();
            URL.revokeObjectURL(previewUrl);
            // Silent retry once
            try {
              const compressed2 = await compressImage(raw, 800, 0.75);
              const fd2 = new FormData();
              fd2.append('image', compressed2);
              await API.post(`/api/machines/${mid}/images`, fd2, {
                headers: { 'Content-Type': 'multipart/form-data' }
              });
              toast('Image saved ✅', 'success');
              await loadDetail();
            } catch (_2) {
              toast('Image upload failed', 'error');
            }
          }
        })();
      } else {
        // Fallback: old blocking behavior
        try {
          toast('Compressing…', 'info');
          const compressed = await compressImage(raw, 1080, 0.82);
          const fd = new FormData();
          fd.append('image', compressed);
          toast('Uploading…', 'info');
          await API.post(`/api/machines/${mid}/images`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });
          toast('Image saved', 'success');
          await loadDetail();
        } catch (_) { toast('Upload failed', 'error'); }
      }
    });
  });

  // Delete image (admin only)
  document.querySelectorAll('.img-del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Remove this image?')) return;
      try {
        await API.delete(`/api/images/${btn.dataset.iid}`);
        toast('Removed', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Audio recorder — start recording for a machine
  document.querySelectorAll('.btn-rec-audio').forEach(btn => {
    btn.addEventListener('click', () => showAudioRecorderModal(btn.dataset.mid));
  });

  // Delete audio (admin only)
  document.querySelectorAll('.btn-del-audio').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this voice note?')) return;
      try {
        await API.delete(`/api/machines/${btn.dataset.mid}/audio`);
        toast('Voice note deleted', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Request assignment (staff not assigned)
  document.querySelectorAll('.btn-request-assign').forEach(btn => {
    btn.addEventListener('click', () => showRequestAssignModal(btn.dataset.mid, j.id));
  });

  // Add machine
  document.getElementById('btn-add-machine')?.addEventListener('click', () => showAddMachineModal(j.id));

  // Edit machine (admin only)
  document.querySelectorAll('.btn-edit-m').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = j.machines.find(x => x.id == btn.dataset.mid);
      if (m) showEditMachineModal(m);
    });
  });

  // Delete machine (admin only)
  document.querySelectorAll('.btn-del-m').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this machine and its images/audio?')) return;
      try {
        await API.delete(`/api/machines/${btn.dataset.mid}`);
        toast('Machine deleted', 'success'); await loadDetail();
      } catch (_) { toast('Failed', 'error'); }
    });
  });

  // Delete job (admin only)
  document.getElementById('btn-del-job')?.addEventListener('click', async () => {
    if (!confirm(`Delete job ${j.id}? This cannot be undone.`)) return;
    try {
      await API.delete(`/api/jobs/${j.id}`);
      toast(`Job ${j.id} deleted`, 'success'); navigate('dashboard');
    } catch (_) { toast('Delete failed', 'error'); }
  });

  // Update received amount, discount, and payment method (admin only)
  document.getElementById('recv-save')?.addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('recv-input')?.value) || 0;
    const discVal = parseFloat(document.getElementById('discount-input')?.value) || 0;
    const payMethod = document.getElementById('pay-method')?.value || 'cash';
    try {
      await API.put(`/api/jobs/${j.id}`, { received_amount: val, discount: discVal, payment_method: payMethod });
      toast('Saved', 'success'); await loadDetail();
    } catch (_) { toast('Save failed', 'error'); }
  });

  // Mark delivered (admin only)
  document.getElementById('btn-deliver')?.addEventListener('click', () => showDeliveryModal(j));

  // Job card download (admin only)
  document.getElementById('btn-jobcard')?.addEventListener('click', () => generateAndShareJobCard(j, false));

  // WhatsApp share (admin only)
  document.getElementById('btn-share')?.addEventListener('click', () => generateAndShareJobCard(j, true));

  // Job History (all roles)
  document.getElementById('btn-job-history')?.addEventListener('click', () => showJobHistory(j));

  // Print Address Label (admin only)
  document.getElementById('btn-print-addr')?.addEventListener('click', () => printAddressLabel(j));

  // Customer History (admin only)
  document.getElementById('btn-cust-history')?.addEventListener('click', () => showCustomerHistory(j.snap_mobile, j.snap_name));

  // Edit Customer (admin only)
  document.getElementById('btn-edit-customer')?.addEventListener('click', () => showEditCustomerModal(j));

  // ── v36: Batch multi-select machine logic ──────────────────────────────────
  let _batchMode = false;
  const batchBar = document.getElementById('batch-bar');
  const batchCountEl = document.getElementById('batch-count');

  function updateBatchCount() {
    const checked = document.querySelectorAll('.batch-check:checked');
    if (batchCountEl) batchCountEl.textContent = checked.length + ' selected';
    // Disable action buttons if nothing selected
    document.querySelectorAll('.batch-action-btn').forEach(btn => {
      btn.style.opacity = checked.length > 0 ? '1' : '0.5';
      btn.style.pointerEvents = checked.length > 0 ? 'auto' : 'none';
    });
  }

  function enterBatchMode() {
    _batchMode = true;
    if (batchBar) batchBar.style.display = '';
    document.querySelectorAll('.batch-check-wrap').forEach(w => w.style.display = 'flex');
    document.querySelectorAll('.batch-check').forEach(cb => { cb.checked = false; });
    // Hide individual status selects in batch mode
    document.querySelectorAll('.status-sel').forEach(sel => sel.style.display = 'none');
    updateBatchCount();
    const btn = document.getElementById('btn-batch-select');
    if (btn) { btn.innerHTML = '<i class="fas fa-times"></i> Cancel'; btn.style.background = '#E53935'; }
  }

  function exitBatchMode() {
    _batchMode = false;
    if (batchBar) batchBar.style.display = 'none';
    document.querySelectorAll('.batch-check-wrap').forEach(w => w.style.display = 'none');
    document.querySelectorAll('.batch-check').forEach(cb => { cb.checked = false; });
    // Restore individual status selects
    document.querySelectorAll('.status-sel').forEach(sel => sel.style.display = '');
    const btn = document.getElementById('btn-batch-select');
    if (btn) { btn.innerHTML = '<i class="fas fa-check-double"></i> Select'; btn.style.background = '#7B1FA2'; }
  }

  document.getElementById('btn-batch-select')?.addEventListener('click', () => {
    if (_batchMode) exitBatchMode();
    else enterBatchMode();
  });

  document.getElementById('batch-cancel')?.addEventListener('click', exitBatchMode);

  document.getElementById('batch-select-all')?.addEventListener('click', () => {
    const checks = document.querySelectorAll('.batch-check');
    const allChecked = Array.from(checks).every(cb => cb.checked);
    checks.forEach(cb => { cb.checked = !allChecked; });
    updateBatchCount();
    const btn = document.getElementById('batch-select-all');
    if (btn) btn.textContent = allChecked ? 'Select All' : 'Deselect All';
  });

  // Listen for checkbox changes
  document.getElementById('machines-container')?.addEventListener('change', e => {
    if (e.target.classList.contains('batch-check')) updateBatchCount();
  });

  // Tap machine card to toggle checkbox in batch mode
  document.getElementById('machines-container')?.addEventListener('click', e => {
    if (!_batchMode) return;
    const card = e.target.closest('.machine-card');
    if (!card) return;
    // Don't toggle if clicking the checkbox itself, edit/delete buttons, images, or audio
    if (e.target.closest('.batch-check-wrap') || e.target.closest('.btn-edit-m') || e.target.closest('.btn-del-m') ||
        e.target.closest('.img-wrap') || e.target.closest('.img-add-btn') || e.target.closest('.audio-row') ||
        e.target.closest('.btn-request-assign') || e.target.closest('.img-del-btn')) return;
    const cb = card.querySelector('.batch-check');
    if (cb) { cb.checked = !cb.checked; updateBatchCount(); }
  });

  // Batch action buttons
  document.querySelectorAll('.batch-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetStatus = btn.dataset.batchStatus;
      const selectedIds = Array.from(document.querySelectorAll('.batch-check:checked')).map(cb => parseInt(cb.dataset.mid));
      if (!selectedIds.length) { toast('Select machines first', 'error'); return; }
      const selectedNames = selectedIds.map(id => {
        const m = (j.machines || []).find(x => x.id === id);
        return m ? m.product_name : 'Machine #' + id;
      });

      if (targetStatus === 'delivered') {
        // Show delivery modal for batch
        showModal(`
          <h3 class="modal-title"><i class="fas fa-check-double" style="color:#1E88E5"></i> Deliver ${selectedIds.length} Machine${selectedIds.length>1?'s':''}</h3>
          <div style="background:#E3F2FD;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:#1565C0">
            ${selectedNames.map(n => '<div>• ' + esc(n) + '</div>').join('')}
          </div>
          <div class="form-group">
            <label class="form-label">Delivery Method <span class="req">*</span></label>
            <select id="bd-method" class="form-input">
              <option value="in_person">🤝 In Person</option>
              <option value="courier">📮 Courier</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Receiver Name <span style="color:#999;font-size:12px">(optional)</span></label>
            <input id="bd-rname" type="text" class="form-input" placeholder="Person who collected">
          </div>
          <div class="form-group" id="bd-courier-wrap" style="display:none">
            <label class="form-label">Courier Name <span style="color:#999;font-size:12px">(optional)</span></label>
            <input id="bd-courier" type="text" class="form-input" placeholder="e.g. DTDC, BlueDart">
          </div>
          <div class="modal-footer">
            <button onclick="closeModal()" class="btn-ghost">Cancel</button>
            <button id="bd-confirm" class="btn-primary" style="background:#1E88E5"><i class="fas fa-check"></i> Deliver ${selectedIds.length}</button>
          </div>`);
        document.getElementById('bd-method')?.addEventListener('change', ev => {
          document.getElementById('bd-courier-wrap').style.display = ev.target.value === 'courier' ? '' : 'none';
        });
        document.getElementById('bd-confirm')?.addEventListener('click', async () => {
          closeModal();
          toast('Updating ' + selectedIds.length + ' machines…', 'info');
          try {
            await API.put('/api/machines/batch-status', {
              machine_ids: selectedIds, status: 'delivered',
              delivery_method: document.getElementById('bd-method')?.value || 'in_person',
              delivery_receiver_name: document.getElementById('bd-rname')?.value.trim() || null,
              delivery_courier_name: document.getElementById('bd-courier')?.value.trim() || null,
            });
            toast(selectedIds.length + ' machines delivered ✅', 'success');
            exitBatchMode();
            await loadDetail();
          } catch (err) { toast(err.response?.data?.error || 'Batch update failed', 'error'); }
        });
        return;
      }

      if (targetStatus === 'repaired' || targetStatus === 'returned') {
        const label = targetStatus === 'repaired' ? 'Work Done (optional)' : 'Return Reason (optional)';
        const pholder = targetStatus === 'repaired' ? 'e.g. Replaced motor, cleaned…' : 'e.g. Customer collected unrepaired…';
        const noteKey = targetStatus === 'repaired' ? 'work_done' : 'return_reason';
        showModal(`
          <h3 class="modal-title"><i class="fas fa-clipboard-check" style="color:${targetStatus==='repaired'?'#43A047':'#B8860B'}"></i> Mark ${selectedIds.length} as ${sl(targetStatus)}</h3>
          <div style="background:${sb(targetStatus)};border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px;color:${sc(targetStatus)}">
            ${selectedNames.map(n => '<div>• ' + esc(n) + '</div>').join('')}
          </div>
          <div class="form-group">
            <label class="form-label">${label}</label>
            <textarea id="batch-note-input" class="form-input" rows="3" placeholder="${pholder}" style="resize:vertical"></textarea>
          </div>
          <div class="modal-footer">
            <button onclick="closeModal()" class="btn-ghost">Cancel</button>
            <button id="batch-note-save" class="btn-primary" style="background:${sc(targetStatus)}"><i class="fas fa-check"></i> Confirm ${selectedIds.length}</button>
          </div>`);
        document.getElementById('batch-note-save')?.addEventListener('click', async () => {
          const noteVal = document.getElementById('batch-note-input')?.value.trim() || null;
          closeModal();
          toast('Updating ' + selectedIds.length + ' machines…', 'info');
          try {
            await API.put('/api/machines/batch-status', {
              machine_ids: selectedIds, status: targetStatus, [noteKey]: noteVal,
            });
            toast(selectedIds.length + ' machines → ' + sl(targetStatus) + ' ✅', 'success');
            exitBatchMode();
            await loadDetail();
          } catch (err) { toast(err.response?.data?.error || 'Batch update failed', 'error'); }
        });
        return;
      }

      // under_repair — simple direct update
      if (!confirm(`Mark ${selectedIds.length} machine${selectedIds.length>1?'s':''} as Under Repair?`)) return;
      (async () => {
        toast('Updating ' + selectedIds.length + ' machines…', 'info');
        try {
          await API.put('/api/machines/batch-status', { machine_ids: selectedIds, status: targetStatus });
          toast(selectedIds.length + ' machines → Under Repair ✅', 'success');
          exitBatchMode();
          await loadDetail();
        } catch (err) { toast(err.response?.data?.error || 'Batch update failed', 'error'); }
      })();
    });
  });

  // WhatsApp Reminder (admin only)
  document.getElementById('btn-wa-reminder')?.addEventListener('click', () => {
    const phone   = (j.snap_mobile || '').replace(/\D/g, '');
    const waPhone = phone.startsWith('91') ? phone : (phone ? '91' + phone : '');
    const balance = Math.max(0, (j.total_charges||0) - (j.discount||0) - (j.received_amount||0));
    const products = (j.machines||[]).map(m => `• ${m.product_name}${m.quantity>1?' ×'+m.quantity:''}`).join('\n') || '• Your device';
    const trackLink = `${window.location.origin}/track?job=${encodeURIComponent(j.id)}&mobile=${encodeURIComponent(waPhone.replace(/^91/, ''))}`;
    const reminderMsg = `⚡ *ADITION ELECTRIC*

Dear ${j.snap_name || 'Valued Customer'},

⚠️ *Reminder* — Job *#${j.id}* awaits collection.

*Items:*
${products}
${balance > 0 ? `\n*Due: ₹${balance}*\nPlease pay to proceed.\n` : ''}
🔗 *Track:* ${trackLink}

Collect within *25 days* to avoid liability.

📞 7801990001
📢 Join Updates: https://chat.whatsapp.com/ILjfPXXuyiBKuL2VdpMhg4
— *ADITION ELECTRIC* ✨`;
    const text    = encodeURIComponent(reminderMsg);
    const url     = waPhone ? `https://wa.me/${waPhone}?text=${text}` : `https://wa.me/?text=${text}`;
    // Direct wa.me open — no share window
    window.location.href = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIT CUSTOMER MODAL — update name, mobile, address with save button
// ─────────────────────────────────────────────────────────────────────────────
function showEditCustomerModal(j) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-user-edit" style="color:#FB8C00"></i> Edit Customer</h3>
    <div class="form-group">
      <label class="form-label">Customer Name <span class="req">*</span></label>
      <input id="ec-name" type="text" class="form-input" value="${esc(j.snap_name || '')}">
    </div>
    <div class="form-row-2">
      <div class="form-group">
        <label class="form-label">Mobile <span class="req">*</span></label>
        <input id="ec-mobile" type="tel" class="form-input" value="${esc(j.snap_mobile || '')}" inputmode="numeric">
      </div>
      <div class="form-group">
        <label class="form-label">Alt. Mobile</label>
        <input id="ec-mobile2" type="tel" class="form-input" value="${esc(j.snap_mobile2 || '')}" inputmode="numeric">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Address</label>
      <textarea id="ec-address" class="form-input" rows="2">${esc(j.snap_address || '')}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Customer Category</label>
      <select id="ec-category" class="form-input">
        <option value="Salon" ${(j.snap_category||'Salon')==='Salon'?'selected':''}>Salon</option>
        <option value="Consumer" ${j.snap_category==='Consumer'?'selected':''}>Consumer</option>
        <option value="Retailer" ${j.snap_category==='Retailer'?'selected':''}>Retailer</option>
        <option value="N/A" ${j.snap_category==='N/A'?'selected':''}>N/A</option>
      </select>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="ec-save" class="btn-primary"><i class="fas fa-save"></i> Save</button>
    </div>`);

  document.getElementById('ec-save')?.addEventListener('click', async () => {
    const name    = document.getElementById('ec-name')?.value.trim();
    const mobile  = document.getElementById('ec-mobile')?.value.trim();
    const mobile2 = document.getElementById('ec-mobile2')?.value.trim() || null;
    const address = document.getElementById('ec-address')?.value.trim() || null;
    const category = document.getElementById('ec-category')?.value || 'Salon';
    if (!name || !mobile) { toast('Name and mobile are required', 'error'); return; }
    try {
      // Save customer data immediately via customer API using mobile as unique key
      if (j.customer_id) {
        await API.put(`/api/customers/${j.customer_id}`, { name, mobile, mobile2, address, category });
      }
      // Also update snap fields on this job
      await API.put(`/api/jobs/${j.id}`, {
        snap_name: name,
        snap_mobile: mobile,
        snap_mobile2: mobile2,
        snap_address: address,
        snap_category: category
      });
      closeModal();
      toast('Customer info saved ✅', 'success');
      await loadDetail();
    } catch (e) {
      toast(e.response?.data?.error || 'Update failed', 'error');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER HISTORY MODAL
// ─────────────────────────────────────────────────────────────────────────────
async function showCustomerHistory(mobile, name) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-history" style="color:#7B1FA2"></i> Customer History — ${esc(name||mobile)}</h3>
    <div id="ch-list" style="max-height:60vh;overflow-y:auto">
      <div class="loader-wrap"><i class="fas fa-spinner fa-spin"></i></div>
    </div>
    <div class="modal-footer" style="flex-wrap:wrap;gap:8px">
      <button id="ch-ledger-a" class="btn-sm btn-blue"><i class="fas fa-file-excel"></i> Ledger (Summary)</button>
      <button id="ch-ledger-b" class="btn-sm" style="background:#9C27B0;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer"><i class="fas fa-file-excel"></i> Ledger (Detailed)</button>
      <button onclick="closeModal()" class="btn-ghost" style="margin-left:auto">Close</button>
    </div>`);

  try {
    const r = await API.get('/api/customers/history', { params: { mobile } });
    const jobs = r.data || [];
    const el   = document.getElementById('ch-list');
    if (!el) return;
    if (!jobs.length) { el.innerHTML = `<p class="text-muted text-center" style="padding:16px">No jobs found</p>`; return; }
    el.innerHTML = jobs.map(j => `
      <div style="padding:12px 0;border-bottom:1px solid #f0f0f0;cursor:pointer" onclick="closeModal();navigate('detail',{jobId:'${j.id}'})">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:700;color:#1a1a2e">${j.id}</span>
          <span class="status-chip" style="background:${sb(j.status)};color:${sc(j.status)};border:1px solid ${sc(j.status)};font-size:12px;padding:2px 10px;border-radius:6px">${sl(j.status)}</span>
        </div>
        <div style="font-size:13px;color:#666;margin-top:4px">${fmtDate(j.created_at)} · ${j.products||'—'}</div>
        <div style="font-size:13px;color:#E53935;font-weight:600">Due: ${fmtRs(Math.max(0,(j.total_charges||0)-(j.received_amount||0)))}</div>
      </div>`).join('');
  } catch { document.getElementById('ch-list').innerHTML = `<p class="text-muted text-center" style="padding:16px">Failed to load history</p>`; }

  // Ledger export buttons
  const dlLedger = async (mode) => {
    try {
      const resp = await API.get('/api/reports/ledger', { params: { mobile, mode }, responseType: 'blob' });
      const url  = URL.createObjectURL(resp.data);
      const a    = document.createElement('a'); a.href = url;
      a.download = `AES_ledger_${mobile}_${mode}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Ledger downloaded', 'success');
    } catch { toast('Export failed', 'error'); }
  };
  document.getElementById('ch-ledger-a')?.addEventListener('click', () => dlLedger('A'));
  document.getElementById('ch-ledger-b')?.addEventListener('click', () => dlLedger('B'));
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB HISTORY TIMELINE MODAL
// ─────────────────────────────────────────────────────────────────────────────
async function showJobHistory(j) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-history" style="color:#7B1FA2"></i> Job History — ${esc(j.id)}</h3>
    <div id="jh-list" style="max-height:65vh;overflow-y:auto;padding:4px 0">
      <div class="loader-wrap"><i class="fas fa-spinner fa-spin"></i></div>
    </div>
    <div class="modal-footer" style="gap:8px">
      <button id="jh-share-btn" class="btn-sm" style="background:#25D366;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:700"><i class="fab fa-whatsapp"></i> Share</button>
      <button onclick="closeModal()" class="btn-ghost" style="margin-left:auto">Close</button>
    </div>`);

  try {
    const r = await API.get(`/api/jobs/${j.id}/history`);
    const events = r.data || []; // server returns newest first
    const el = document.getElementById('jh-list');
    if (!el) return;

    if (!events.length) {
      el.innerHTML = `<div style="text-align:center;padding:24px;color:#888">
        <i class="fas fa-history fa-2x" style="margin-bottom:8px;display:block"></i>
        No history recorded yet
      </div>`;
      return;
    }

    const ACTION_ICONS = {
      'Job Created':       { icon: 'fa-plus-circle',   color: '#43A047' },
      'Machine Added':     { icon: 'fa-tools',          color: '#1E88E5' },
      'Status: delivered': { icon: 'fa-check-double',   color: '#1E88E5' },
      'Payment Updated':   { icon: 'fa-rupee-sign',     color: '#FB8C00' },
      'Discount Updated':  { icon: 'fa-tag',            color: '#FB8C00' },
      'Note Updated':      { icon: 'fa-sticky-note',    color: '#795548' },
      'Customer Info Updated': { icon: 'fa-user-edit',  color: '#1565C0' },
      'Delivered':         { icon: 'fa-box-open',        color: '#1E88E5' },
      'Machine Edited':    { icon: 'fa-wrench',          color: '#9C27B0' },
    };
    function getIcon(action) {
      if (action.startsWith('Machine: repaired'))   return { icon: 'fa-check-circle', color: '#43A047' };
      if (action.startsWith('Machine: returned'))   return { icon: 'fa-undo-alt',     color: '#B8860B' };
      if (action.startsWith('Machine:'))            return { icon: 'fa-cog',           color: '#9C27B0' };
      if (action.startsWith('Auto Status:'))        return { icon: 'fa-sync-alt',      color: '#FF6F00' };
      if (action.startsWith('Status:'))             return { icon: 'fa-exchange-alt',   color: '#E53935' };
      return ACTION_ICONS[action] || { icon: 'fa-circle', color: '#888' };
    }

    el.innerHTML = `
    <div style="position:relative;padding-left:28px">
      <div style="position:absolute;left:10px;top:0;bottom:0;width:2px;background:#e0e0e0"></div>
      ${events.map((ev, i) => {
        const { icon, color } = getIcon(ev.action);
        const isLast = i === events.length - 1;
        return `
        <div style="position:relative;margin-bottom:${isLast?'0':'16px'}">
          <div style="position:absolute;left:-23px;top:2px;width:22px;height:22px;background:${color};border-radius:50%;display:flex;align-items:center;justify-content:center">
            <i class="fas ${icon}" style="color:#fff;font-size:10px"></i>
          </div>
          <div style="background:#f8f9fa;border-radius:10px;padding:10px 14px;border-left:3px solid ${color}">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
              <span style="font-weight:700;color:#1a1a2e;font-size:14px">${esc(ev.action)}</span>
              <span style="font-size:11px;color:#999">${ev.created_at ? new Date(ev.created_at).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}</span>
            </div>
            ${ev.detail ? `<div style="font-size:13px;color:#555;margin-top:4px">${esc(ev.detail)}</div>` : ''}
            <div style="font-size:12px;color:#aaa;margin-top:3px">
              <i class="fas fa-user" style="margin-right:4px"></i>${esc(ev.user_name || 'System')}
              <span style="margin-left:6px;background:${ev.user_role==='admin'?'#FFEBEE':'#E3F2FD'};color:${ev.user_role==='admin'?'#E53935':'#1E88E5'};border-radius:4px;padding:1px 6px;font-size:10px">${ev.user_role || 'system'}</span>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  } catch (err) {
    console.error('[AES] Job history load error:', err);
    const el = document.getElementById('jh-list');
    if (el) el.innerHTML = `<div style="text-align:center;padding:16px;color:#E53935">
      <i class="fas fa-exclamation-circle" style="font-size:24px;display:block;margin-bottom:8px"></i>
      <p style="font-weight:700">Failed to load history</p>
      <p style="font-size:12px;color:#888;margin-top:4px">The job history database may need to be initialized. Try again or contact admin.</p>
      <button onclick="showJobHistory(S.job)" style="margin-top:10px;background:#1565C0;color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer;font-weight:700"><i class="fas fa-redo"></i> Retry</button>
    </div>`;
  }

  // Share history via WhatsApp
  document.getElementById('jh-share-btn')?.addEventListener('click', () => {
    const phone = (j.snap_mobile || '').replace(/\D/g, '');
    const waPhone = phone.startsWith('91') ? phone : (phone ? '91' + phone : '');
    let histText = `⚡ *ADITION ELECTRIC*\n*Job #${j.id} History*\n\n`;
    const el = document.getElementById('jh-list');
    if (el) {
      const items = el.querySelectorAll('[style*="border-left:3px"]');
      items.forEach((item, i) => {
        const action = item.querySelector('[style*="font-weight:700"]')?.textContent || '';
        const date = item.querySelectorAll('[style*="font-size:11px"]')[0]?.textContent || '';
        const detail = item.querySelector('[style*="font-size:13px;color:#555"]')?.textContent || '';
        histText += `${i+1}. *${action}*${date ? ' — '+date : ''}${detail ? '\n   '+detail : ''}\n`;
      });
    }
    histText += '\n📞 7801990001\n✨ adition™ since 1984';
    const url = waPhone ? `https://wa.me/${waPhone}?text=${encodeURIComponent(histText)}` : `https://wa.me/?text=${encodeURIComponent(histText)}`;
    window.location.href = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO RECORDER MODAL
// ─────────────────────────────────────────────────────────────────────────────
function showAudioRecorderModal(machineId) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-microphone" style="color:#E53935"></i> Voice Note</h3>
    <div id="audio-status" style="text-align:center;padding:16px 0;font-size:15px;color:#666">
      Tap Record to start
    </div>
    <div id="audio-viz" style="height:48px;background:#f5f5f5;border-radius:12px;margin:8px 0;
         display:flex;align-items:center;justify-content:center;gap:3px;overflow:hidden">
      <span style="color:#bbb;font-size:13px">Audio waveform</span>
    </div>
    <div id="audio-preview" style="display:none;margin:8px 0">
      <audio id="audio-playback" controls style="width:100%;border-radius:8px"></audio>
    </div>
    <div class="modal-footer" style="flex-direction:column;gap:8px">
      <div style="display:flex;gap:8px;width:100%">
        <button id="rec-start" class="btn-primary" style="flex:1;background:#E53935">
          <i class="fas fa-circle"></i> Record
        </button>
        <button id="rec-stop" class="btn-primary" style="flex:1;background:#333;display:none">
          <i class="fas fa-stop"></i> Stop
        </button>
      </div>
      <div style="display:flex;gap:8px;width:100%">
        <button onclick="closeModal()" class="btn-ghost" style="flex:1">Cancel</button>
        <button id="rec-save" class="btn-primary" style="flex:1;display:none">
          <i class="fas fa-upload"></i> Upload
        </button>
      </div>
    </div>`);

  let audioBlob = null;
  let audioMime = 'audio/webm';
  let recInterval = null;
  let recSeconds = 0;

  const statusEl = document.getElementById('audio-status');
  const vizEl    = document.getElementById('audio-viz');

  document.getElementById('rec-start')?.addEventListener('click', async () => {
    recSeconds = 0;
    const ok = await startAudioRecorder((blob, mime) => {
      audioBlob = blob; audioMime = mime;
      const url = URL.createObjectURL(blob);
      const aud = document.getElementById('audio-playback');
      if (aud) { aud.src = url; }
      document.getElementById('audio-preview').style.display = 'block';
      document.getElementById('rec-save').style.display = '';
      statusEl.textContent = 'Recording saved — preview and upload';
      statusEl.style.color = '#43A047';
    });
    if (!ok) return;

    document.getElementById('rec-start').style.display = 'none';
    document.getElementById('rec-stop').style.display = '';
    statusEl.style.color = '#E53935';

    recInterval = setInterval(() => {
      recSeconds++;
      statusEl.textContent = `🔴 Recording… ${recSeconds}s`;
      // Animate visualizer bars
      const bars = Array.from({ length: 20 }, () =>
        `<div style="width:5px;height:${8+Math.random()*32}px;background:#E53935;border-radius:3px;
             transition:height 0.1s;will-change:height"></div>`).join('');
      vizEl.innerHTML = bars;
    }, 1000);
  });

  document.getElementById('rec-stop')?.addEventListener('click', () => {
    stopAudioRecorder();
    clearInterval(recInterval);
    document.getElementById('rec-stop').style.display = 'none';
    document.getElementById('rec-start').style.display = '';
    vizEl.innerHTML = '<span style="color:#bbb;font-size:13px">Stopped</span>';
  });

  document.getElementById('rec-save')?.addEventListener('click', async () => {
    if (!audioBlob) { toast('No recording to upload', 'error'); return; }
    const btn = document.getElementById('rec-save');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…';
    try {
      const ext  = audioMime.includes('ogg') ? '.ogg' : '.webm';
      const file = new File([audioBlob], `voice_note${ext}`, { type: audioMime });
      const fd   = new FormData();
      fd.append('audio', file);
      await API.post(`/api/machines/${machineId}/audio`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      closeModal();
      toast('Voice note saved', 'success');
      await loadDetail();
    } catch (_) { toast('Upload failed', 'error'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-upload"></i> Upload'; }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST ASSIGNMENT MODAL (staff)
// ─────────────────────────────────────────────────────────────────────────────
function showRequestAssignModal(machineId, jobId) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-hand-paper" style="color:#1E88E5"></i> Request Assignment</h3>
    <p style="color:#555;font-size:14px;margin-bottom:12px">
      Send an urgent request to the admin to be assigned to this machine.
    </p>
    <div class="form-group">
      <label class="form-label">Note (optional)</label>
      <textarea id="req-note" class="form-input" rows="3"
                placeholder="Why do you want this assignment?"></textarea>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="req-send" class="btn-primary" style="background:#1E88E5">
        <i class="fas fa-paper-plane"></i> Send Request
      </button>
    </div>`);

  document.getElementById('req-send')?.addEventListener('click', async () => {
    const note = document.getElementById('req-note')?.value.trim();
    const btn  = document.getElementById('req-send');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
    try {
      await API.post('/api/requests', { machine_id: parseInt(machineId), note: note || null });
      closeModal();
      toast('Request sent to admin ✅', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to send request', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Request';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALS — Add / Edit Machine, Delivery
// ─────────────────────────────────────────────────────────────────────────────
function showAddMachineModal(jobId) {
  const sc = _sugCache;
  const prodSugs = sc.getProducts();
  const compSugs = sc.getComplaints();
  const amtSugs  = sc.getAmounts();

  showModal(`
    <h3 class="modal-title"><i class="fas fa-plus" style="color:#E53935"></i> Add Machine</h3>

    <!-- 1. Product Photo (Optional) -->
    <div class="form-group">
      <label class="form-label"><i class="fas fa-camera" style="color:#E53935"></i> Product Photo <span style="color:#999;font-size:12px">(optional)</span></label>
      <div style="display:flex;gap:10px;align-items:center">
        <label class="img-upload-label" style="flex:1">
          <i class="fas fa-camera"></i> Take / Pick Photo
          <input id="am-img" type="file" accept="image/*" capture="environment" style="display:none">
        </label>
        <div id="am-img-preview" style="display:none">
          <img id="am-img-thumb" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:2px solid #e0e0e0">
          <button id="am-img-clear" style="margin-left:4px;background:#E53935;color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px"><i class="fas fa-times"></i></button>
        </div>
      </div>
    </div>

    <!-- 2. Voice Note (Optional) -->
    <div class="form-group">
      <label class="form-label"><i class="fas fa-microphone" style="color:#E53935"></i> Voice Note <span style="color:#999;font-size:12px">(optional)</span></label>
      <div id="am-audio-section">
        <button id="am-audio-rec" class="btn-sm btn-orange" style="width:100%;padding:10px">
          <i class="fas fa-microphone"></i> Record Voice Note
        </button>
        <div id="am-audio-preview" style="display:none;margin-top:6px;display:none;align-items:center;gap:8px">
          <audio id="am-audio-play" controls style="flex:1;height:36px"></audio>
          <button id="am-audio-clear" class="btn-sm btn-red" style="padding:6px 10px"><i class="fas fa-times"></i></button>
        </div>
      </div>
    </div>

    <!-- 3. Product Name -->
    <div class="form-group">
      <label class="form-label">Product Name <span class="req">*</span></label>
      <input id="am-prod" type="text" class="form-input" placeholder="e.g. LG AC 1.5T" autocomplete="off">
      <div id="am-prod-sugs">${suggestionTilesHTML(prodSugs, 'am-prod', 'prod-sugs')}</div>
    </div>

    <!-- 4. Complaint / Issue -->
    <div class="form-group">
      <label class="form-label">Complaint / Issue</label>
      <div class="complaint-tags" id="am-ctags">
        <span class="ctag" data-t="Motor Issue">⚙️ Motor Issue</span>
        <span class="ctag" data-t="Power Issue">🔌 Power Issue</span>
        <span class="ctag" data-t="Blade Problem">🔪 Blade Problem</span>
        <span class="ctag" data-t="Heating Issue">🌡️ Heating Issue</span>
        <span class="ctag" data-t="Noise Issue">🔊 Noise Issue</span>
        <span class="ctag" data-t="Not Working">❌ Not Working</span>
        <span class="ctag" data-t="Charging Issue">🔋 Charging Issue</span>
        <span class="ctag" data-t="Speed Problem">💨 Speed Problem</span>
      </div>
      <textarea id="am-comp" class="form-input" rows="2" placeholder="Issue description…"></textarea>
      <div id="am-comp-sugs">${suggestionTilesHTML(compSugs, 'am-comp', 'comp-sugs')}</div>
    </div>

    <!-- 5. Warranty Status -->
    <div class="form-group">
      <label class="form-label"><i class="fas fa-shield-alt" style="color:#1565C0"></i> Warranty Status</label>
      <select id="am-warranty" class="form-input">
        <option value="out_warranty" selected>Out of Warranty</option>
        <option value="warranty">Under Warranty</option>
      </select>
    </div>
    <div id="am-brand-wrap" class="form-group" style="display:none">
      <label class="form-label">Brand / Company</label>
      <select id="am-brand" class="form-input">
        <option value="">— Select Brand —</option>
        <option value="IKONIC">IKONIC</option>
        <option value="HNK">HNK</option>
        <option value="MARC">MARC</option>
        <option value="AYTY Pro">AYTY Pro</option>
      </select>
    </div>

    <!-- 6. Repair Amount -->
    ${isAdmin() ? `
    <div class="form-group">
      <label class="form-label">Repair Amount (₹)</label>
      <input id="am-chg" type="number" class="form-input" min="0" placeholder="0" inputmode="decimal">
      <div id="am-amt-sugs">${suggestionTilesHTML(amtSugs.map(a => '₹' + a), 'am-chg', 'amt-sugs')}</div>
    </div>` : ''}

    <!-- 7. Quantity (below Repair Amount, default 1, clear on focus) -->
    <div class="form-group">
      <label class="form-label">Quantity</label>
      <input id="am-qty" type="number" class="form-input" min="1" value="1" inputmode="numeric"
             onfocus="if(this.value==='1')this.value=''" onblur="if(!this.value)this.value='1'">
    </div>

    <!-- 6. Assign Staff -->
    ${isAdmin() ? `
    <div class="form-group">
      <label class="form-label">Assign Staff</label>
      <select id="am-staff" class="form-input">
        <option value="">— None —</option>
        ${S.staff.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
      </select>
    </div>` : ''}

    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="am-save" class="btn-primary"><i class="fas fa-save"></i> Save Machine</button>
    </div>`);

  // ── Wire suggestion tiles ──────────────────────────────────────────────────
  // Product name tiles → clicking fills name + updates complaint/amount tiles + auto-focus complaint
  bindSuggestionTiles(document.getElementById('am-prod-sugs'), (val, target) => {
    updateComplaintTiles(val);
    updateAmountTiles(val);
    setTimeout(() => document.getElementById('am-comp')?.focus(), 100);
  });
  // Complaint tiles → clicking fills complaint + auto-focus amount
  bindSuggestionTiles(document.getElementById('am-comp-sugs'), () => {
    setTimeout(() => document.getElementById('am-chg')?.focus(), 100);
  });
  // Amount tiles → need special handling for ₹ prefix
  document.querySelectorAll('#am-amt-sugs .sug-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const chg = document.getElementById('am-chg');
      if (chg) { chg.value = tile.dataset.val.replace(/[₹,]/g, ''); chg.dispatchEvent(new Event('input')); }
      tile.style.background = '#E8F5E9';
      setTimeout(() => { tile.style.background = '#f0f4ff'; }, 400);
      setTimeout(() => document.getElementById('am-qty')?.focus(), 100);
    }, { passive: true });
  });

  // Quick complaint tags — tap to append
  function bindCTags() {
    document.querySelectorAll('#am-ctags .ctag').forEach(tag => {
      tag.addEventListener('click', () => {
        const comp = document.getElementById('am-comp');
        if (!comp) return;
        const cur = comp.value.trim();
        comp.value = cur ? `${cur}, ${tag.dataset.t}` : tag.dataset.t;
        tag.style.background = '#FFEBEE';
        setTimeout(() => { tag.style.background = ''; }, 600);
      }, { passive: true });
    });
  }
  bindCTags();

  function updateComplaintTiles(productName) {
    const comps = _sugCache.getComplaints(productName);
    const el = document.getElementById('am-comp-sugs');
    if (el) { el.innerHTML = suggestionTilesHTML(comps, 'am-comp', 'comp-sugs'); bindSuggestionTiles(el); }
    // Also update complaint quick-tags based on product type
    const tagEl = document.getElementById('am-ctags');
    if (!tagEl) return;
    const name = (productName || '').toLowerCase();
    const clipperTags  = ['⚙️ Motor Issue','🔪 Blade Problem','🔊 Noise Issue','💨 Speed Problem','❌ Not Working'];
    const dryerTags    = ['🌡️ Heating Issue','🔌 Power Issue','💨 Speed Problem','🔊 Noise Issue','❌ Not Working'];
    const trimmerTags  = ['⚙️ Motor Issue','🔋 Charging Issue','🔪 Blade Problem','🔌 Power Issue','❌ Not Working'];
    const acTags       = ['🌡️ Heating Issue','🔌 Power Issue','🔊 Noise Issue','💨 Speed Problem','❌ Not Working'];
    const genericTags  = ['⚙️ Motor Issue','🔌 Power Issue','🔪 Blade Problem','🌡️ Heating Issue','🔊 Noise Issue','❌ Not Working','🔋 Charging Issue','💨 Speed Problem'];
    let tags = genericTags;
    if (/clipper|cliper/.test(name))          tags = clipperTags;
    else if (/dryer|drier|blower/.test(name)) tags = dryerTags;
    else if (/trimmer|trim/.test(name))       tags = trimmerTags;
    else if (/ac|air/.test(name))             tags = acTags;
    tagEl.innerHTML = tags.map(t => { const raw = t.replace(/[^a-zA-Z ]/g,'').trim(); return `<span class="ctag" data-t="${raw}">${t}</span>`; }).join('');
    bindCTags();
  }

  function updateAmountTiles(productName) {
    const amts = _sugCache.getAmounts(productName);
    const el = document.getElementById('am-amt-sugs');
    if (!el) return;
    el.innerHTML = suggestionTilesHTML(amts.map(a => '₹' + a), 'am-chg', 'amt-sugs');
    el.querySelectorAll('.sug-tile').forEach(tile => {
      tile.addEventListener('click', () => {
        const chg = document.getElementById('am-chg');
        if (chg) { chg.value = tile.dataset.val.replace(/[₹,]/g, ''); }
        tile.style.background = '#E8F5E9';
        setTimeout(() => { tile.style.background = '#f0f4ff'; }, 400);
      }, { passive: true });
    });
  }

  // Warranty dropdown toggle: show brand select when "warranty" is chosen
  document.getElementById('am-warranty')?.addEventListener('change', e => {
    const brandWrap = document.getElementById('am-brand-wrap');
    if (brandWrap) brandWrap.style.display = e.target.value === 'warranty' ? 'block' : 'none';
  });

  // Smart product name input — filter suggestions + update complaint/amount tiles as user types
  document.getElementById('am-prod')?.addEventListener('input', debounce(e => {
    const val = e.target.value.trim();
    const sugs = _sugCache.getProducts(val);
    const el = document.getElementById('am-prod-sugs');
    if (el) {
      el.innerHTML = suggestionTilesHTML(sugs, 'am-prod', 'prod-sugs');
      bindSuggestionTiles(el, (v) => {
        updateComplaintTiles(v); updateAmountTiles(v);
        setTimeout(() => document.getElementById('am-comp')?.focus(), 100);
      });
    }
    updateComplaintTiles(val);
    updateAmountTiles(val);
  }, 150));

  // Image preview (instant)
  document.getElementById('am-img')?.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const blobUrl = URL.createObjectURL(file);
    document.getElementById('am-img-thumb').src = blobUrl;
    document.getElementById('am-img-preview').style.display = 'flex';
  });
  document.getElementById('am-img-clear')?.addEventListener('click', () => {
    const inp = document.getElementById('am-img'); if (inp) inp.value = '';
    document.getElementById('am-img-preview').style.display = 'none';
  });

  // Audio recorder (inline — no separate modal)
  let _amAudioBlob = null, _amAudioMime = 'audio/webm';
  document.getElementById('am-audio-rec')?.addEventListener('click', async () => {
    const btn = document.getElementById('am-audio-rec');
    if (S.audioRecorder && S.audioRecorder.state === 'recording') {
      // Stop recording
      stopAudioRecorder();
      btn.innerHTML = '<i class="fas fa-microphone"></i> Record Voice Note';
      btn.style.background = '';
      return;
    }
    // Start recording
    const ok = await startAudioRecorder((blob, mime) => {
      _amAudioBlob = blob; _amAudioMime = mime;
      const url = URL.createObjectURL(blob);
      const aud = document.getElementById('am-audio-play');
      if (aud) aud.src = url;
      const prev = document.getElementById('am-audio-preview');
      if (prev) prev.style.display = 'flex';
      btn.innerHTML = '<i class="fas fa-microphone"></i> Record Voice Note';
      btn.style.background = '';
    });
    if (ok) {
      btn.innerHTML = '<i class="fas fa-stop" style="animation:pulse 1s infinite"></i> Stop Recording';
      btn.style.background = '#E53935';
    }
  });
  document.getElementById('am-audio-clear')?.addEventListener('click', () => {
    _amAudioBlob = null;
    document.getElementById('am-audio-preview').style.display = 'none';
    stopAudioRecorder();
  });

  // ── Save machine ────────────────────────────────────────────────────────────
  document.getElementById('am-save')?.addEventListener('click', async () => {
    const prod = document.getElementById('am-prod')?.value.trim();
    if (!prod) { toast('Product name required', 'error'); return; }
    const complaint = document.getElementById('am-comp')?.value.trim() || null;
    const charges   = isAdmin() ? (parseFloat(document.getElementById('am-chg')?.value) || 0) : 0;
    const quantity  = parseInt(document.getElementById('am-qty')?.value) || 1;
    const staffId   = isAdmin() ? (document.getElementById('am-staff')?.value || null) : null;
    const warrantyType = document.getElementById('am-warranty')?.value || 'out_warranty';
    const warrantyBrand = warrantyType === 'warranty' ? (document.getElementById('am-brand')?.value || null) : null;

    // Save to suggestion cache
    _sugCache.addProduct(prod);
    if (complaint) _sugCache.addComplaint(complaint, prod);
    if (charges > 0) _sugCache.addAmount(charges, prod);

    const btn = document.getElementById('am-save');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
    try {
      const machR = await API.post(`/api/jobs/${jobId}/machines`, {
        product_name: prod, product_complaint: complaint,
        charges, quantity, assigned_staff_id: staffId,
        warranty_type: warrantyType, warranty_brand: warrantyBrand,
      });
      const machId = machR.data.id;

      // Upload image + audio in background (non-blocking for modal close)
      const imgFile = document.getElementById('am-img')?.files[0];
      closeModal(); toast('Machine added ✅', 'success');

      // Async uploads after modal close
      const uploads = [];
      if (imgFile && machId) {
        uploads.push((async () => {
          try {
            const compressed = await compressImage(imgFile, 1080, 0.82);
            const fd = new FormData(); fd.append('image', compressed);
            await API.post(`/api/machines/${machId}/images`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
          } catch (_) { toast('Image upload failed', 'error'); }
        })());
      }
      if (_amAudioBlob && machId) {
        uploads.push((async () => {
          try {
            const ext  = _amAudioMime.includes('ogg') ? '.ogg' : '.webm';
            const file = new File([_amAudioBlob], `voice_note${ext}`, { type: _amAudioMime });
            const fd   = new FormData(); fd.append('audio', file);
            await API.post(`/api/machines/${machId}/audio`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
          } catch (_) { toast('Audio upload failed', 'error'); }
        })());
      }
      if (uploads.length) await Promise.allSettled(uploads);
      await loadDetail();
    } catch (_) {
      toast('Failed to add machine', 'error');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Machine';
    }
  });
}

function showEditMachineModal(m) {
  const curWarranty = m.warranty_type || 'out_warranty';
  const curBrand = m.warranty_brand || '';
  showModal(`
    <h3 class="modal-title"><i class="fas fa-edit" style="color:#FB8C00"></i> Edit Machine</h3>
    <div class="form-group">
      <label class="form-label">Product Name <span class="req">*</span></label>
      <input id="em-prod" type="text" class="form-input" value="${esc(m.product_name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Complaint / Issue</label>
      <textarea id="em-comp" class="form-input" rows="2">${esc(m.product_complaint||'')}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label"><i class="fas fa-shield-alt" style="color:#1565C0"></i> Warranty Status</label>
      <select id="em-warranty" class="form-input">
        <option value="out_warranty" ${curWarranty==='out_warranty'?'selected':''}>Out of Warranty</option>
        <option value="warranty" ${curWarranty==='warranty'?'selected':''}>Under Warranty</option>
      </select>
    </div>
    <div id="em-brand-wrap" class="form-group" style="display:${curWarranty==='warranty'?'block':'none'}">
      <label class="form-label">Brand / Company</label>
      <select id="em-brand" class="form-input">
        <option value="">— Select Brand —</option>
        <option value="IKONIC" ${curBrand==='IKONIC'?'selected':''}>IKONIC</option>
        <option value="HNK" ${curBrand==='HNK'?'selected':''}>HNK</option>
        <option value="MARC" ${curBrand==='MARC'?'selected':''}>MARC</option>
        <option value="AYTY Pro" ${curBrand==='AYTY Pro'?'selected':''}>AYTY Pro</option>
      </select>
    </div>
    ${hasSuperRight('view_financials') ? `
    <div class="form-group">
      <label class="form-label">Repair Amount (₹)</label>
      <input id="em-chg" type="number" class="form-input" min="0"
             value="${m.charges||0}" inputmode="decimal">
    </div>` : ''}
    <div class="form-group">
      <label class="form-label">Quantity</label>
      <input id="em-qty" type="number" class="form-input" min="1"
             value="${m.quantity||1}" inputmode="numeric"
             onfocus="if(this.value==='1')this.value=''" onblur="if(!this.value)this.value='1'">
    </div>
    ${hasSuperRight('manage_machines') ? `
    <div class="form-group">
      <label class="form-label">Assign Staff</label>
      <select id="em-staff" class="form-input">
        <option value="">— None —</option>
        ${S.staff.map(s => `<option value="${s.id}" ${m.assigned_staff_id==s.id?'selected':''}>${esc(s.name)}</option>`).join('')}
      </select>
    </div>` : ''}
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="em-save" class="btn-primary">Update</button>
    </div>`);

  // Warranty dropdown toggle
  document.getElementById('em-warranty')?.addEventListener('change', e => {
    const wrap = document.getElementById('em-brand-wrap');
    if (wrap) wrap.style.display = e.target.value === 'warranty' ? 'block' : 'none';
  });

  document.getElementById('em-save')?.addEventListener('click', async () => {
    const prod = document.getElementById('em-prod')?.value.trim();
    if (!prod) { toast('Product name required', 'error'); return; }
    const warrantyType = document.getElementById('em-warranty')?.value || 'out_warranty';
    const warrantyBrand = warrantyType === 'warranty' ? (document.getElementById('em-brand')?.value || null) : null;
    try {
      await API.put(`/api/machines/${m.id}`, {
        product_name:      prod,
        product_complaint: document.getElementById('em-comp')?.value.trim() || null,
        warranty_type: warrantyType,
        warranty_brand: warrantyBrand,
        ...(hasSuperRight('view_financials') ? { charges: parseFloat(document.getElementById('em-chg')?.value) || 0 } : {}),
        quantity:          parseInt(document.getElementById('em-qty')?.value) || 1,
        ...(hasSuperRight('manage_machines') ? { assigned_staff_id: document.getElementById('em-staff')?.value || null } : {}),
      });
      closeModal(); toast('Machine updated', 'success'); await loadDetail();
    } catch (_) { toast('Update failed', 'error'); }
  });
}

function showDeliveryModal(j) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-check-double" style="color:#1E88E5"></i> Mark as Delivered</h3>
    <div class="form-group">
      <label class="form-label">Delivery Method <span class="req">*</span></label>
      <select id="dm-method" class="form-input">
        <option value="in_person">In Person</option>
        <option value="courier">Courier</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Receiver Name <span style="color:#999;font-size:12px">(optional)</span></label>
      <input id="dm-rname" type="text" class="form-input" placeholder="Person who collected the device">
    </div>
    <div class="form-group">
      <label class="form-label">Receiver Mobile <span style="color:#999;font-size:12px">(optional)</span></label>
      <input id="dm-rmob" type="tel" class="form-input" placeholder="Mobile of receiver" inputmode="numeric">
    </div>
    <div class="form-group" id="courier-name-wrap">
      <label class="form-label">Courier Name <span style="color:#999;font-size:12px">(optional)</span></label>
      <input id="dm-courier" type="text" class="form-input" placeholder="e.g. DTDC, BlueDart">
    </div>
    <div class="form-group" id="courier-track-wrap">
      <label class="form-label">Tracking ID <span style="color:#999;font-size:12px">(optional)</span></label>
      <input id="dm-track" type="text" class="form-input" placeholder="Tracking number">
    </div>
    <div class="form-group" id="courier-addr-wrap">
      <label class="form-label">Delivery Address <span style="color:#999;font-size:12px">(optional)</span></label>
      <textarea id="dm-addr" class="form-input" rows="2"></textarea>
    </div>
    ${hasSuperRight('view_financials') ? `
    <div class="form-group">
      <label class="form-label">Discount/Deduction (₹)</label>
      <input id="dm-disc" type="number" class="form-input" value="${j.discount||0}"
             min="0" inputmode="decimal">
    </div>
    <div class="form-group">
      <label class="form-label">Final Received Amount (₹)</label>
      <div style="display:flex;gap:8px">
        <input id="dm-recv" type="number" class="form-input" value="${j.received_amount||0}"
               min="0" inputmode="decimal" style="flex:1">
        <select id="dm-paymethod" class="form-input" style="width:100px">
          <option value="cash" ${(j.payment_method||'cash')==='cash'?'selected':''}>Cash</option>
          <option value="online" ${j.payment_method==='online'?'selected':''}>Online</option>
        </select>
      </div>
    </div>` : ''}
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="dm-confirm" class="btn-primary" style="background:#1E88E5">
        <i class="fas fa-check"></i> Confirm Delivery
      </button>
    </div>`);

  // Show/hide courier-specific optional fields based on method selection
  const toggleCourierFields = (method) => {
    const show = method === 'courier';
    ['courier-name-wrap','courier-track-wrap','courier-addr-wrap'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.opacity = show ? '1' : '0.5';
    });
  };
  document.getElementById('dm-method')?.addEventListener('change', e => toggleCourierFields(e.target.value));
  toggleCourierFields('in_person'); // default dim courier fields

  document.getElementById('dm-confirm')?.addEventListener('click', async () => {
    const rname = document.getElementById('dm-rname')?.value.trim() || null;
    try {
      await API.put(`/api/jobs/${j.id}`, {
        status:                   'delivered',
        delivery_receiver_name:   rname,
        delivery_receiver_mobile: document.getElementById('dm-rmob')?.value.trim() || null,
        delivery_method:          document.getElementById('dm-method')?.value || 'in_person',
        delivery_courier_name:    document.getElementById('dm-courier')?.value || null,
        delivery_tracking:        document.getElementById('dm-track')?.value   || null,
        delivery_address:         document.getElementById('dm-addr')?.value    || null,
        ...(hasSuperRight('view_financials') ? {
          received_amount: parseFloat(document.getElementById('dm-recv')?.value) || 0,
          discount: parseFloat(document.getElementById('dm-disc')?.value) || 0,
          payment_method: document.getElementById('dm-paymethod')?.value || 'cash',
        } : {}),
      });
      closeModal(); toast('Job marked as delivered ✅', 'success');
      // Log delivery to history
      API.post(`/api/jobs/${j.id}/history`, {
        action: 'Delivered',
        detail: `Delivered to: ${rname || 'Customer'}${document.getElementById('dm-method')?.value === 'courier' ? ' via courier' : ' in person'}`
      }).catch(() => {});
      await loadDetail();
      // Auto-download delivered job card (once, no duplicate prompt)
      if (S.job && S.job.status === 'delivered') {
        const dlKey = 'AES_DELIVERED_DL_' + j.id;
        if (!sessionStorage.getItem(dlKey)) {
          sessionStorage.setItem(dlKey, '1');
          setTimeout(() => autoDownloadDeliveredCard(S.job), 800);
        }
      }
    } catch (_) { toast('Failed to update', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB CARD PRINT HTML — Premium mobile-first layout, single-page, high-res
// Centered logo + "Since 1984", aligned Job ID + Date, 2-column customer
// (Name|Mobile, Address|Date, NO call button), horizontal product rows with
// image left, bold name, small complaint, status badge, price (₹XXX),
// financial summary, side-by-side QR+notice layout, tracking QR, footer
// ─────────────────────────────────────────────────────────────────────────────
function jobCardPrintHTML(j) {
  const total      = j.total_charges   || 0;
  const discount   = j.discount        || 0;
  const received   = j.received_amount || 0;
  const balance    = Math.max(0, total - discount - received);
  const color      = sc(j.status);
  const isDelivered = j.status === 'delivered';
  const showPayment = balance > 0 && !isDelivered;
  const trackPhone  = (j.snap_mobile || '').replace(/\D/g, '');
  const printTrackUrl = `${window.location.origin}/track?job=${encodeURIComponent(j.id)}&mobile=${encodeURIComponent(trackPhone)}`;

  // ── 1. PREMIUM HEADER — centered logo + ADITION ELECTRIC SOLUTION Since 1984 ──
  const headerBlock = `
    <div style="background:linear-gradient(135deg,#0d1b2a 0%,#1b2838 50%,#0f3460 100%);padding:24px 30px 18px;text-align:center;position:relative;overflow:hidden">
      <div style="position:absolute;top:-40px;right:-40px;width:160px;height:160px;border-radius:50%;background:rgba(229,57,53,.08)"></div>
      <div style="width:58px;height:58px;background:linear-gradient(135deg,#E53935,#B71C1C);border-radius:14px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-size:32px;box-shadow:0 4px 20px rgba(229,57,53,.4);position:relative;z-index:1">⚡</div>
      <div style="color:#fff;font-size:28px;font-weight:900;letter-spacing:3px;text-shadow:0 2px 10px rgba(0,0,0,.3);position:relative;z-index:1">ADITION ELECTRIC SOLUTION</div>
      <div style="color:rgba(255,255,255,.5);font-size:13px;margin-top:3px;letter-spacing:2px;font-weight:600;position:relative;z-index:1">SINCE 1984 · SERVICE MANAGEMENT</div>
    </div>
    <div style="background:${color};padding:12px 30px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="color:rgba(255,255,255,.7);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase">Job Number</div>
        <div style="color:#fff;font-size:32px;font-weight:900;letter-spacing:3px;line-height:1.1">${j.id}</div>
      </div>
      <div style="text-align:center;display:flex;flex-direction:column;align-items:center">
        <div style="color:#fff;font-size:18px;font-weight:800;background:rgba(0,0,0,.2);padding:8px 24px;border-radius:10px;letter-spacing:1px;display:inline-flex;align-items:center;justify-content:center;min-width:140px;min-height:40px;text-align:center;box-sizing:border-box">${sl(j.status)}</div>
        <div style="color:rgba(255,255,255,.7);font-size:12px;margin-top:4px;font-weight:600">${fmtDate(j.created_at)}</div>
      </div>
    </div>`;

  // ── 2. CUSTOMER DETAILS — 2-column grid, 1.5× font sizes ──
  const custBlock = `
    <div style="padding:16px 30px 10px">
      <div style="font-size:11px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:3px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
        <span style="width:24px;height:2px;background:#E53935;display:inline-block"></span>
        CUSTOMER DETAILS
        <span style="flex:1;height:1px;background:#e0e0e0"></span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 24px">
        <div>
          <div style="font-size:12px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Name</div>
          <div style="font-size:30px;font-weight:900;color:#1a1a2e;line-height:1.2">${esc(j.snap_name)}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Mobile</div>
          <div style="font-size:27px;font-weight:800;color:#1565C0">${j.snap_mobile || '—'}</div>
          ${j.snap_mobile2 ? `<div style="font-size:20px;color:#1976D2;font-weight:600;margin-top:1px">${j.snap_mobile2}</div>` : ''}
        </div>
        ${j.snap_address ? `
        <div>
          <div style="font-size:12px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Address</div>
          <div style="font-size:21px;color:#444;line-height:1.3;font-weight:500">${esc(j.snap_address)}</div>
        </div>` : ''}
        <div>
          <div style="font-size:12px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Date</div>
          <div style="font-size:21px;color:#444;font-weight:600">${fmtDate(j.created_at)}</div>
        </div>
        ${j.snap_category ? `<div>
          <div style="font-size:12px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Category</div>
          <div style="font-size:18px;color:#3949AB;font-weight:700">${esc(j.snap_category)}</div>
        </div>` : ''}
        ${j.dispatch_method === 'courier' ? `<div>
          <div style="font-size:12px;color:#999;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Dispatch</div>
          <div style="font-size:18px;color:#7B1FA2;font-weight:800">📮 Courier${j.dispatch_courier_name ? ' — ' + esc(j.dispatch_courier_name) : ''}</div>
        </div>` : ''}
      </div>
    </div>
    <div style="border-top:2px solid #f0f0f0;margin:0 30px 4px"></div>`;

  // ── 3. PRODUCTS — horizontal rows with image, name, complaint, status badge, price (1.5× fonts) ─
  const machinesBlock = `
    <div style="padding:8px 30px 4px">
      <div style="font-size:11px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:3px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
        <span style="width:24px;height:2px;background:#E53935;display:inline-block"></span>
        PRODUCTS (${(j.machines||[]).reduce((s,m) => s + (parseInt(m.quantity)||1), 0)})
        <span style="flex:1;height:1px;background:#e0e0e0"></span>
      </div>
      ${(j.machines||[]).map((m,i) => {
        const firstImg = (m.images||[])[0];
        const isReturned = m.status === 'returned';
        const lineAmt = (parseFloat(m.charges)||0) * (parseInt(m.quantity)||1);
        const mColor = sc(m.status);
        return `
      <div style="background:${isReturned?'#fafafa':'#f8f9fb'};border-radius:10px;padding:12px;margin-bottom:8px;border-left:4px solid ${mColor};display:flex;align-items:center;gap:12px${isReturned?';opacity:0.65':''}">
        ${firstImg
          ? `<img data-auth-src="${firstImg.url}" data-img-key="m_${m.id}" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" style="width:72px;height:72px;border-radius:8px;object-fit:cover;flex-shrink:0;border:2px solid #e8eaed" crossorigin="anonymous" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        ${firstImg
          ? `<div style="width:72px;height:72px;border-radius:8px;background:#e8eaed;display:none;align-items:center;justify-content:center;flex-shrink:0;font-size:28px;color:#bbb">⚡</div>`
          : `<div style="width:72px;height:72px;border-radius:8px;background:linear-gradient(135deg,#e8eaed,#f0f2f5);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:28px;color:#bbb;border:2px solid #e0e0e0">⚡</div>`}
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:3px">
            <div style="font-size:26px;font-weight:800;color:#1a1a2e;line-height:1.2;flex:1;min-width:0;word-break:break-word">${i+1}. ${esc(m.product_name)}${m.quantity>1?` <span style="color:#888;font-size:20px;font-weight:600">x${m.quantity}</span>`:''}</div>
            <div style="background:${mColor};color:#fff;border-radius:8px;padding:6px 18px;font-size:14px;font-weight:800;white-space:nowrap;letter-spacing:.5px;flex-shrink:0;text-align:center;display:inline-flex;align-items:center;justify-content:center;min-width:120px;min-height:34px;box-sizing:border-box">${sl(m.status)}</div>
          </div>
          ${m.product_complaint ? `<div style="font-size:20px;color:#666;line-height:1.2">${esc(m.product_complaint)}</div>` : ''}
          ${m.work_done ? `<div style="font-size:18px;color:#2E7D32;font-weight:600">✅ ${esc(m.work_done)}</div>` : ''}
          ${m.return_reason ? `<div style="font-size:18px;color:#E65100;font-weight:600">↩ ${esc(m.return_reason)}</div>` : ''}
          ${m.warranty_type === 'warranty' && m.warranty_brand ? `<div style="font-size:16px;color:#1565C0;font-weight:700;margin-top:2px"><i class="fas fa-shield-alt"></i> Warranty: ${esc(m.warranty_brand)}</div>` : ''}
          <div style="margin-top:3px;font-size:26px;font-weight:800;color:${isReturned?'#aaa':'#1a1a2e'}${isReturned?';text-decoration:line-through':''}">
            ${m.warranty_type === 'warranty' && m.warranty_brand ? `<span style="color:#1565C0;font-size:18px;font-weight:700;margin-right:8px">[${esc(m.warranty_brand)}]</span>` : ''}${fmtRs(lineAmt)}${m.quantity>1?` <span style="color:#999;font-size:18px;font-weight:600">(${fmtRs(m.charges||0)} x ${m.quantity})</span>`:''}
          </div>
        </div>
      </div>`;
      }).join('')}
    </div>`;

  // ── 4. FINANCIAL SUMMARY — total, discount, received, due ────────────────────────────
  const financialBlock = `
    <div style="margin:8px 30px 10px;background:linear-gradient(135deg,#f8f9fb,#f0f2f5);border-radius:12px;padding:14px 18px;border:1px solid #e0e0e0">
      <div style="font-size:11px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Financial Summary</div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555;font-size:15px;font-weight:600">Total Amount</span>
        <span style="font-size:17px;font-weight:800;color:#1a1a2e">${fmtRs(total)}</span>
      </div>
      ${discount > 0 ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#FB8C00;font-size:15px;font-weight:600">Discount/Deduction</span>
        <span style="font-size:17px;font-weight:800;color:#FB8C00">- ${fmtRs(discount)}</span>
      </div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555;font-size:15px;font-weight:600">Amount Received${j.payment_method && j.payment_method !== 'cash' ? ' (Online)' : ''}</span>
        <span style="font-size:17px;font-weight:800;color:#43A047">${fmtRs(received)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;margin-top:2px">
        <span style="font-size:17px;font-weight:800;color:#1a1a2e">Balance Due</span>
        <span style="font-size:22px;font-weight:900;color:${balance>0?'#E53935':'#43A047'};letter-spacing:.5px">${fmtRs(balance)}</span>
      </div>
    </div>`;

  // ── 5. NOTE ────────────────────────────────────────────────────────────────
  const noteBlock = j.note ? `
    <div style="margin:0 30px 8px;background:#fffde7;border:1px solid #FFF176;border-radius:8px;padding:10px 14px;font-size:14px;color:#795548;line-height:1.3">
      <span style="font-weight:800;color:#F57F17">📝 Note:</span> ${esc(j.note)}
    </div>` : '';

  // ── 6. PAYMENT SECTION: 1-row 4-column table: Notice|QR|Bank|TrackingQR ──
  const paymentBlock = showPayment ? `
    <div style="margin:0 30px 10px">
      <!-- Notice banner (top) -->
      <div style="background:linear-gradient(135deg,#fff8e1,#ffecb3);border:2px solid #FFA000;border-radius:12px;padding:12px;margin-bottom:10px">
        <div style="font-size:14px;font-weight:900;color:#E65100;margin-bottom:6px">⚠️ Important Notices</div>
        <div style="font-size:13px;color:#5D4037;line-height:1.5">
          1. Collect within <strong>25 days</strong>. After this, we shall <strong>not be liable</strong> for any claims.<br>
          2. Damaged/replacement parts will <strong>NOT</strong> be returned to the customer.<br>
          3. Any damage or loss during repair is the <strong>customer's responsibility</strong>.
        </div>
      </div>
      <!-- 1-row 4-column table: PayQR | BankDetails | Amount | TrackQR -->
      <table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:10px">
        <tr>
          <!-- Col 1: Payment QR (full-HD) -->
          <td style="width:30%;vertical-align:top;background:#f8fff8;border:2px solid #43A047;border-radius:12px;padding:14px;text-align:center">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=upi%3A%2F%2Fpay%3Fpa%3D9375940444%40okbizaxis%26pn%3DADITION%2BELECTRIC%2BSOLUTION%26am%3D${balance}%26cu%3DINR" style="width:200px;height:200px;border-radius:10px;border:3px solid #43A047;background:#fff" crossorigin="anonymous" onerror="this.style.display='none'">
            <div style="font-size:16px;color:#2E7D32;margin-top:8px;font-weight:900">💳 Scan to Pay</div>
            <div style="font-size:22px;color:#2E7D32;font-weight:900">${fmtRs(balance)}</div>
            <div style="font-size:12px;color:#555;margin-top:2px">UPI: 9375940444@okbizaxis</div>
          </td>
          <!-- Col 2: Bank Details -->
          <td style="width:35%;vertical-align:top;background:linear-gradient(135deg,#f8f9fb,#f0f2f5);border:2px solid #43A047;border-radius:12px;padding:14px">
            <div style="font-size:15px;font-weight:800;color:#2E7D32;margin-bottom:10px">🏦 Bank Details</div>
            <table style="border-collapse:collapse;font-size:15px;width:100%">
              <tr><td style="color:#555;padding:5px 0;font-weight:600;width:50px">Phone</td><td style="font-weight:700;color:#1565C0">7801990001</td></tr>
              <tr><td style="color:#555;padding:5px 0;font-weight:600">Bank</td><td style="font-weight:700">State Bank of India</td></tr>
              <tr><td style="color:#555;padding:5px 0;font-weight:600">A/C</td><td style="font-weight:700">37321811864</td></tr>
              <tr><td style="color:#555;padding:5px 0;font-weight:600">IFSC</td><td style="font-weight:700">SBIN0001353</td></tr>
            </table>
          </td>
          <!-- Col 3: Amount Summary -->
          <td style="width:15%;vertical-align:top;background:#f0f8f0;border:2px solid #43A047;border-radius:12px;padding:14px;text-align:center">
            <div style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:6px">Total</div>
            <div style="font-size:20px;font-weight:900;color:#1a1a2e">${fmtRs(total)}</div>
            ${received > 0 ? `<div style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase;margin-top:8px">Received</div>
            <div style="font-size:18px;font-weight:800;color:#43A047">${fmtRs(received)}</div>` : ''}
            <div style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase;margin-top:8px">Balance Due</div>
            <div style="font-size:22px;font-weight:900;color:#E53935">${fmtRs(balance)}</div>
          </td>
          <!-- Col 4: Tracking QR + Link -->
          <td style="width:20%;vertical-align:top;background:linear-gradient(135deg,#E3F2FD,#e8eaf6);border:2px solid #1565C0;border-radius:12px;padding:14px;text-align:center">
            <div style="font-size:12px;font-weight:800;color:#1565C0;margin-bottom:6px">🔗 Track Online</div>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(printTrackUrl)}" style="width:140px;height:140px;border-radius:8px;border:2px solid #1565C0;background:#fff" crossorigin="anonymous" onerror="this.style.display='none'">
            <div style="font-size:10px;color:#555;word-break:break-all;line-height:1.2;margin-top:6px">${printTrackUrl}</div>
          </td>
        </tr>
      </table>
    </div>` : `
    <div style="margin:0 30px 10px">
      <div style="background:linear-gradient(135deg,${isDelivered?'#E3F2FD,#BBDEFB':'#E8F5E9,#C8E6C9'});border:2px solid ${isDelivered?'#1E88E5':'#43A047'};border-radius:12px;padding:16px;margin-bottom:10px">
        <div style="font-size:16px;font-weight:900;color:${isDelivered?'#1565C0':'#2E7D32'};margin-bottom:8px">
          ${isDelivered ? '📦 Delivered' : '✅ Fully Paid'}
        </div>
        ${isDelivered && j.delivery_receiver_name ? `
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            ${j.delivery_receiver_name ? `<tr><td style="color:#555;padding:4px 0;font-weight:600">Receiver</td><td style="font-weight:800">${esc(j.delivery_receiver_name)}</td></tr>` : ''}
            ${j.delivery_method ? `<tr><td style="color:#555;padding:4px 0;font-weight:600">Method</td><td style="font-weight:700">${j.delivery_method==='courier'?'📮 Courier':'🤝 In Person'}</td></tr>` : ''}
            ${j.delivered_at ? `<tr><td style="color:#555;padding:4px 0;font-weight:600">Date</td><td style="font-weight:700">${fmtDate(j.delivered_at)}</td></tr>` : ''}
          </table>` : `
          <div style="font-size:15px;color:#1565C0;font-weight:600">Payment complete. Thank you!</div>`}
      </div>
      <!-- Notices always shown -->
      <div style="background:linear-gradient(135deg,#fff8e1,#ffecb3);border:2px solid #FFA000;border-radius:12px;padding:12px;margin-bottom:10px">
        <div style="font-size:14px;font-weight:900;color:#E65100;margin-bottom:6px">⚠️ Important Notices</div>
        <div style="font-size:13px;color:#5D4037;line-height:1.5">
          1. Damaged/replacement parts will <strong>NOT</strong> be returned to the customer.<br>
          2. Any damage or loss during repair is the <strong>customer's responsibility</strong>.
        </div>
      </div>
      <!-- Tracking -->
      <div style="background:linear-gradient(135deg,#E3F2FD,#e8eaf6);border:2px solid #1565C0;border-radius:12px;padding:12px">
        <div style="font-size:13px;font-weight:800;color:#1565C0;margin-bottom:6px">🔗 Track Your Job Online</div>
        <div style="display:flex;align-items:center;gap:10px">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(printTrackUrl)}" style="width:80px;height:80px;border-radius:8px;border:2px solid #1565C0;background:#fff;flex-shrink:0" crossorigin="anonymous" onerror="this.style.display='none'">
          <div style="font-size:12px;color:#555;word-break:break-all;line-height:1.3">${printTrackUrl}</div>
        </div>
      </div>
    </div>`;

  const sideBlock = paymentBlock;

  // ── 7. FOOTER — centered jurisdiction text ─────────────────────────────────────
  const footerBlock = `
    <div style="background:linear-gradient(135deg,#0d1b2a,#1b2838,#0f3460);padding:18px 30px 14px;margin-top:auto;position:relative;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;position:relative;z-index:1">
        <div>
          <div style="color:#fff;font-size:15px;font-weight:800;letter-spacing:1px">✨ adition™ since 1984</div>
          <div style="color:rgba(255,255,255,.5);font-size:12px;margin-top:3px;line-height:1.3">Opp. Metropolitan Court Gate 2,<br>Gheekanta, Ahmedabad 380001</div>
        </div>
        <div style="text-align:right">
          <div style="color:rgba(255,255,255,.7);font-size:13px;font-weight:700">📞 7801990001</div>
        </div>
      </div>
      <div style="text-align:center;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.15);position:relative;z-index:1">
        <div style="color:rgba(255,255,255,.6);font-size:14px;font-weight:700;letter-spacing:1px">Subjected to Ahmedabad Jurisdiction only</div>
      </div>
    </div>`;

  // ── ASSEMBLE — single-page, 1080px wide, dynamic height, compact ──────────
  return `
  <div style="width:1080px;background:#fff;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;display:flex;flex-direction:column;min-height:1440px">
    ${headerBlock}
    ${custBlock}
    ${machinesBlock}
    ${financialBlock}
    ${noteBlock}
    ${sideBlock}
    ${footerBlock}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE + SHARE JOB CARD — HIGH-RES SINGLE PAGE (min 3072×4096)
// v23: Convert ALL images (product, QR, logo) to base64 data URIs via Promise.all
// Uses canvas-based conversion to avoid CORS/taint issues with html2canvas
// Safety: requestAnimationFrame + setTimeout delay before html2canvas capture
// ─────────────────────────────────────────────────────────────────────────────

// Convert any image URL to base64 data URI (handles CORS + auth + cache bust + retry)
async function imageUrlToBase64(url, token, maxRetries = 2) {
  if (!url) return null;
  if (url.startsWith('data:')) return url; // Already base64
  if (url.startsWith('blob:')) {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return await blobToBase64(blob);
    } catch (_) { return null; }
  }

  // External URLs (QR code API, etc.) — fetch with CORS
  const isExternal = url.startsWith('http') && !url.includes('/api/');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers = {};
      if (!isExternal && token) headers['Authorization'] = 'Bearer ' + token;
      // Cache bust: append timestamp to avoid stale cached images
      const bustChar = url.includes('?') ? '&' : '?';
      const bustUrl = url + bustChar + 't=' + Date.now() + (attempt > 0 ? '&_r=' + attempt : '');
      const resp = await fetch(bustUrl, { headers, cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      return await blobToBase64(blob);
    } catch (_) {
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

// Convert Blob to base64 data URI string
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function generateAndShareJobCard(j, shareMode) {
  toast('Generating premium job card…', 'info');
  try {
    const el = document.getElementById('job-card-print');
    if (!el) { toast('Card element missing', 'error'); return; }

    el.style.left = '-99999px'; el.style.top = '0';

    // ── v41: Step 0: PRE-LOAD all machine images as base64 BEFORE they go into DOM ──
    // Critical fix: fetch images with auth token, convert to base64, inject into DOM
    // Also check _mediaCache for images already loaded by the detail view
    const _imgBase64Cache = new Map();
    const imgUrls = (j.machines || []).map(m => (m.images || [])[0]?.url).filter(Boolean);
    console.log('[AES] Pre-loading', imgUrls.length, 'machine images…');

    // v41: First check if we already have blob URLs from the media cache (detail view)
    for (const url of imgUrls) {
      if (_mediaCache.has(url)) {
        try {
          const blobUrl = _mediaCache.get(url);
          const resp = await fetch(blobUrl);
          const blob = await resp.blob();
          const b64 = await blobToBase64(blob);
          if (b64) _imgBase64Cache.set(url, b64);
        } catch {}
      }
    }

    // Fetch remaining images in parallel with auth token, retry logic
    const remaining = imgUrls.filter(u => !_imgBase64Cache.has(u));
    if (remaining.length) {
      await Promise.allSettled(remaining.map(async (url) => {
        const b64 = await imageUrlToBase64(url, S.token, 3);
        if (b64) _imgBase64Cache.set(url, b64);
      }));
    }
    console.log(`[AES] Pre-loaded ${_imgBase64Cache.size}/${imgUrls.length} images`);

    // ── Step 1: Inject pre-loaded base64 into ALL <img> elements ─────────────
    const imgEls = Array.from(el.querySelectorAll('img'));
    let successCount = 0;
    const pendingLoads = [];

    for (const img of imgEls) {
      const authSrc = img.getAttribute('data-auth-src') || '';
      const cachedB64 = _imgBase64Cache.get(authSrc);
      if (cachedB64) {
        img.src = cachedB64;
        img.removeAttribute('data-auth-src');
        img.crossOrigin = 'anonymous';
        successCount++;
      } else if (authSrc) {
        // Synchronous retry for missed images (block until resolved)
        const retryPromise = imageUrlToBase64(authSrc, S.token, 2).then(b64 => {
          if (b64) { img.src = b64; img.removeAttribute('data-auth-src'); successCount++; }
          else { img.style.display = 'none'; } // Hide broken images cleanly
        }).catch(() => { img.style.display = 'none'; });
        pendingLoads.push(retryPromise);
      }
    }
    // Wait for ALL retry fetches to complete
    if (pendingLoads.length) await Promise.allSettled(pendingLoads);
    console.log(`[AES] Images injected: ${successCount}/${imgEls.length}`);

    // ── Step 2: Wait for ALL base64 images to fully decode in browser ─────────
    await Promise.all(imgEls.filter(img => img.style.display !== 'none').map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        img.onload = () => resolve();
        img.onerror = () => { img.style.display = 'none'; resolve(); };
        setTimeout(resolve, 8000); // 8s safety timeout per image
      });
    }));

    // ── Step 3: Extra paint delay for browser compositing ────────────────────
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 800)));
    });

    // ── Step 4: Generate SINGLE long page (min 3072px wide, dynamic height) ──
    const CARD_WIDTH = 1080;  // CSS layout width
    const actualH    = Math.max(el.scrollHeight || el.offsetHeight || 1440, 1365);
    const SCALE = 3; // 1080 x 3 = 3240px wide (>= 3072)

    console.log(`[AES] Capturing: ${CARD_WIDTH}x${actualH} @ ${SCALE}x = ${CARD_WIDTH*SCALE}x${actualH*SCALE}px`);

    const fullCanvas = await html2canvas(el, {
      scale: SCALE,
      useCORS: true,
      allowTaint: true, // Safe because all images are now base64
      width: CARD_WIDTH,
      height: actualH,
      backgroundColor: '#ffffff',
      logging: false,
      imageTimeout: 30000,
      letterRendering: true,
      removeContainer: false,
    });

    // ── Step 5: Output SINGLE page high-quality JPG ──────────────────────────
    const outW = fullCanvas.width;
    const outH = fullCanvas.height;
    console.log(`[AES] Canvas generated: ${outW}x${outH}px`);

    const blob = await new Promise(resolve =>
      fullCanvas.toBlob(b => resolve(b), 'image/jpeg', 0.95)
    );

    if (!blob || blob.size < 1000) {
      toast('Card generation failed — empty image', 'error');
      return;
    }

    const jobFileName = `Job_${j.id}.jpg`;
    const text    = shareText(j, false);
    const phone   = (j.snap_mobile || '').replace(/\D/g, '');
    const waPhone = phone.startsWith('91') ? phone : (phone ? '91' + phone : '');
    const waText  = encodeURIComponent(text);
    const waUrl   = waPhone ? `https://wa.me/${waPhone}?text=${waText}` : `https://wa.me/?text=${waText}`;

    // ── Auto-download: programmatic <a> click ───────────────────────────────
    function autoDownloadBlob(blobData, fileName) {
      try {
        const bUrl = URL.createObjectURL(blobData);
        const a = document.createElement('a');
        a.href = bUrl;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(bUrl);
        }, 3000);
        return true;
      } catch (e) {
        console.error('[AES] Auto-download failed:', e);
        return false;
      }
    }

    if (shareMode) {
      // ── PARALLEL: Download + WhatsApp simultaneously ──────────────────────
      autoDownloadBlob(blob, jobFileName);
      toast(`Downloading ${jobFileName} (${outW}x${outH}px)…`, 'success');

      setTimeout(() => {
        if (waPhone) {
          window.location.href = `https://wa.me/${waPhone}?text=${waText}`;
        } else {
          window.open(waUrl, '_blank');
        }
      }, 150);

      API.post(`/api/jobs/${j.id}/history`, {
        action: 'Job Card Shared',
        detail: `WhatsApp to ${j.snap_mobile}. File: ${jobFileName} (${outW}x${outH}px, ${(blob.size/1024).toFixed(0)}KB)`
      }).catch(() => {});
      return;
    }

    // ── Download-only mode ───────────────────────────────────────────────────
    const downloaded = autoDownloadBlob(blob, jobFileName);
    if (downloaded) {
      toast(`Job card saved: ${jobFileName} (${outW}x${outH}px, ${(blob.size/1024).toFixed(0)}KB)`, 'success');
    } else {
      toast('Download failed — please try again', 'error');
    }

    API.post(`/api/jobs/${j.id}/history`, {
      action: 'Job Card Downloaded',
      detail: `File: ${jobFileName} (${outW}x${outH}px, ${(blob.size/1024).toFixed(0)}KB)`
    }).catch(() => {});

  } catch (e) {
    console.error('[AES] Job card generation error:', e);
    toast('Failed to generate card — try again', 'error');
  }
}

function shareText(j, multiPage) {
  const custName    = j.snap_name || 'Valued Customer';
  const balance     = Math.max(0, (j.total_charges||0) - (j.discount||0) - (j.received_amount||0));
  const isRepaired  = j.status === 'repaired';
  const isDelivered = j.status === 'delivered';
  const total       = j.total_charges || 0;
  const received    = j.received_amount || 0;
  const phone       = (j.snap_mobile || '').replace(/\D/g, '');
  // v37: Sum quantities — a machine with qty x2 counts as 2 products
  const prodCount   = (j.machines||[]).reduce((s, m) => s + (parseInt(m.quantity) || 1), 0);

  // Tracking link
  const trackLink = `${window.location.origin}/track?job=${encodeURIComponent(j.id)}&mobile=${encodeURIComponent(phone)}`;

  const communityLink = 'https://chat.whatsapp.com/ILjfPXXuyiBKuL2VdpMhg4';

  // Compact format: ADITION header, job #, product count, amount
  if (isRepaired && balance > 0) {
    return `⚡ *ADITION™ ELECTRIC*
Job *#${j.id}* | 📦 ${prodCount} Products | 💰 *₹${total.toLocaleString('en-IN')}*

Dear *${custName}*, your items are *ready!* 🎉
⚠️ *Due: ₹${balance.toLocaleString('en-IN')}*

✅ By collecting, you approve charges.
📞 7801990001

🔗 Track: ${trackLink}
📢 Join Updates: ${communityLink}`;
  }

  if (isDelivered) {
    return `⚡ *ADITION™ ELECTRIC*
Job *#${j.id}* | 📦 ${prodCount} Products | ✅ *Delivered*

Dear *${custName}*, your job is complete! 🙏
${balance > 0 ? `⚠️ Due: ₹${balance.toLocaleString('en-IN')}\n` : ''}
🔗 Track: ${trackLink}
📢 Join Updates: ${communityLink}`;
  }

  // Default: job creation / approval
  return `⚡ *ADITION™ ELECTRIC*
Job *#${j.id}* | 📦 ${prodCount} Products | 💰 *₹${total.toLocaleString('en-IN')}*

Dear *${custName}*, job registered! ✅
${received > 0 ? `Advance: ₹${received.toLocaleString('en-IN')} | ` : ''}${balance > 0 ? `Due: *₹${balance.toLocaleString('en-IN')}*` : 'Paid ✅'}

✅ By handing over, you approve charges.
⚠️ Collect within *25 days*.
📞 7801990001

🔗 Track: ${trackLink}
📢 Join Updates: ${communityLink}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUESTS PANEL (admin only) — approve/deny staff assignment requests
// ─────────────────────────────────────────────────────────────────────────────
function requestsHTML() {
  return `
  <div class="view-pad">
    <div class="filter-bar">
      <button class="filter-chip chip-active" data-req-filter="pending" style="--chip-color:#E53935">Pending</button>
      <button class="filter-chip" data-req-filter="approved" style="--chip-color:#43A047">Approved</button>
      <button class="filter-chip" data-req-filter="denied" style="--chip-color:#888">Denied</button>
    </div>
    <div id="req-list">
      <div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>
    </div>
  </div>`;
}

async function loadRequests(status = 'pending') {
  try {
    const r = await API.get('/api/requests', { params: { status } });
    S.requests = r.data;
    renderRequestsList();
  } catch (_) {
    const el = document.getElementById('req-list');
    if (el) el.innerHTML = `<div class="empty-state"><p>Failed to load requests</p></div>`;
  }

  // Filter buttons
  document.querySelectorAll('[data-req-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-req-filter]').forEach(b => b.classList.remove('chip-active'));
      btn.classList.add('chip-active');
      loadRequests(btn.dataset.reqFilter);
    }, { passive: true });
  });
}

function renderRequestsList() {
  const el = document.getElementById('req-list');
  if (!el) return;
  if (!S.requests.length) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-bell-slash fa-3x"></i><p>No requests</p></div>`;
    return;
  }
  el.innerHTML = S.requests.map(r => `
  <div class="request-card" data-rid="${r.id}" style="will-change:transform,opacity">
    <div class="req-header">
      <span class="req-staff">${esc(r.staff_name)}</span>
      <span class="req-status status-${r.status}">${r.status}</span>
    </div>
    <div class="req-machine">
      <i class="fas fa-tools" style="color:#888;margin-right:6px"></i>
      <strong>${esc(r.product_name)}</strong>
      <span style="color:#888;font-size:13px;margin-left:6px">${esc(r.job_id)}</span>
    </div>
    ${r.product_complaint ? `<div class="req-complaint">${esc(r.product_complaint)}</div>` : ''}
    ${r.note ? `<div class="req-note"><i class="fas fa-comment-alt" style="color:#888"></i> ${esc(r.note)}</div>` : ''}
    <div class="req-date">${fmtDate(r.created_at)}</div>
    ${r.status === 'pending' ? `
    <div class="req-actions">
      <button class="btn-sm btn-green btn-approve-req" data-rid="${r.id}">
        <i class="fas fa-check"></i> Approve
      </button>
      <button class="btn-sm btn-red btn-deny-req" data-rid="${r.id}">
        <i class="fas fa-times"></i> Deny
      </button>
      <button class="btn-sm btn-blue btn-view-job" data-jid="${r.job_id}">
        <i class="fas fa-eye"></i> View Job
      </button>
    </div>` : ''}
  </div>`).join('');

  document.querySelectorAll('.btn-approve-req').forEach(btn => {
    btn.addEventListener('click', () => resolveRequest(btn.dataset.rid, 'approve'));
  });
  document.querySelectorAll('.btn-deny-req').forEach(btn => {
    btn.addEventListener('click', () => resolveRequest(btn.dataset.rid, 'deny'));
  });
  document.querySelectorAll('.btn-view-job').forEach(btn => {
    btn.addEventListener('click', () => navigate('detail', { jobId: btn.dataset.jid }));
  });
}

async function resolveRequest(requestId, action) {
  try {
    const r = await API.put(`/api/requests/${requestId}`, { action });
    toast(r.data.status === 'approved' ? '✅ Approved — staff assigned' : 'Request denied', 'success');
    await loadRequests('pending');
  } catch (e) {
    toast(e.response?.data?.error || 'Failed', 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAFF PANEL (admin only)
// ─────────────────────────────────────────────────────────────────────────────
function staffHTML() {
  return `
  <div class="view-pad">
    <button id="btn-add-staff" class="btn-primary btn-full" style="margin-bottom:14px">
      <i class="fas fa-user-plus"></i> Add Staff Member
    </button>
    <div id="staff-list"><div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div></div>
  </div>`;
}
async function loadStaff() {
  try {
    const r = await API.get('/api/staff');
    S.staff = r.data;
    renderStaffList();
  } catch (_) {
    const el = document.getElementById('staff-list');
    if (el) el.innerHTML = `<div class="empty-state"><p>Failed to load staff</p></div>`;
  }
  document.getElementById('btn-add-staff')?.addEventListener('click', showAddStaffModal);
}
function renderStaffList() {
  const el = document.getElementById('staff-list');
  if (!el) return;
  if (!S.staff.length) { el.innerHTML = `<div class="empty-state"><i class="fas fa-users fa-3x"></i><p>No staff yet</p></div>`; return; }
  el.innerHTML = S.staff.map(s => `
  <div class="staff-card">
    <div>
      <div class="staff-name">${esc(s.name)} <span class="role-badge ${s.role==='admin'?'role-admin':s.role==='director'?'role-director':s.role==='manager'?'role-manager':'role-staff'}">${roleLabel(s.role)}</span></div>
      <div class="staff-email">${esc(s.email)}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="${s.active?'badge-active':'badge-inactive'}">${s.active?'Active':'Inactive'}</span>
      <button class="btn-sm btn-orange btn-edit-staff" data-sid="${s.id}"
              data-name="${esc(s.name)}" data-email="${esc(s.email)}"
              data-role="${s.role}" data-active="${s.active}">
        <i class="fas fa-edit"></i>
      </button>
      <button class="btn-sm btn-red btn-del-staff" data-sid="${s.id}" data-name="${esc(s.name)}" title="Delete staff">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  </div>`).join('');
  document.querySelectorAll('.btn-edit-staff').forEach(btn => {
    btn.addEventListener('click', () => showEditStaffModal({
      id: btn.dataset.sid, name: btn.dataset.name,
      email: btn.dataset.email, role: btn.dataset.role,
      active: parseInt(btn.dataset.active)
    }));
  });
  document.querySelectorAll('.btn-del-staff').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name || 'this staff member';
      if (!confirm(`Delete "${name}"?\n\nTheir job data will be preserved. This will permanently remove their account.`)) return;
      try {
        await API.delete(`/api/staff/${btn.dataset.sid}`);
        toast(`${name} deleted`, 'success');
        await loadStaff();
      } catch (e) {
        toast(e.response?.data?.error || 'Delete failed', 'error');
      }
    });
  });
}
function showAddStaffModal() {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-user-plus" style="color:#E53935"></i> Add Staff</h3>
    <div class="form-group"><label class="form-label">Name <span class="req">*</span></label>
      <input id="as-name" type="text" class="form-input" placeholder="Full name"></div>
    <div class="form-group"><label class="form-label">Email <span class="req">*</span></label>
      <input id="as-email" type="email" class="form-input" placeholder="staff@example.com"></div>
    <div class="form-group"><label class="form-label">Password <span class="req">*</span></label>
      <input id="as-pass" type="password" class="form-input" placeholder="Temporary password"></div>
    <div class="form-group"><label class="form-label">Role</label>
      <select id="as-role" class="form-input">
        <option value="staff">Staff (Assignable Rights)</option>
        <option value="manager">Manager (All except Staff, Dashboard, Settings)</option>
        <option value="director">Director (All except Staff Menu)</option>
        <option value="admin">Admin (Full Rights)</option>
      </select>
    </div>
    <div id="as-rights-wrap" style="display:none">
      <label class="form-label">Staff Rights (select which rights to grant)</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
        ${['view_jobs','edit_jobs','create_jobs','view_financials','deliver','download','share','manage_machines','view_reports','update_machine_status'].map(r =>
          `<label style="display:flex;align-items:center;gap:4px;background:#f0f4ff;border:1px solid #d0d8f0;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;user-select:none">
            <input type="checkbox" class="as-right-cb" value="${r}"> ${r.replace(/_/g,' ')}
          </label>`).join('')}
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="as-save" class="btn-primary">Add</button>
    </div>`);
  // Show/hide rights panel
  document.getElementById('as-role')?.addEventListener('change', e => {
    document.getElementById('as-rights-wrap').style.display = e.target.value === 'staff' ? 'block' : 'none';
  });
  document.getElementById('as-save')?.addEventListener('click', async () => {
    const name  = document.getElementById('as-name')?.value.trim();
    const email = document.getElementById('as-email')?.value.trim();
    const pass  = document.getElementById('as-pass')?.value;
    if (!name || !email || !pass) { toast('All fields required', 'error'); return; }
    const role = document.getElementById('as-role')?.value || 'staff';
    const rights = role === 'staff' ? Array.from(document.querySelectorAll('.as-right-cb:checked')).map(cb => cb.value) : null;
    try {
      await API.post('/api/staff', { name, email, password: pass, role, supervisor_rights: rights });
      closeModal(); toast('Staff added', 'success'); await loadStaff();
    } catch (e) { toast(e.response?.data?.error || 'Failed', 'error'); }
  });
}
function showEditStaffModal(s) {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-user-edit" style="color:#FB8C00"></i> Edit Staff</h3>
    <div class="form-group"><label class="form-label">Name</label>
      <input id="es-name" type="text" class="form-input" value="${esc(s.name)}"></div>
    <div class="form-group"><label class="form-label">Email</label>
      <input id="es-email" type="email" class="form-input" value="${esc(s.email)}"></div>
    <div class="form-group"><label class="form-label">New Password (leave blank to keep)</label>
      <input id="es-pass" type="password" class="form-input" placeholder="Leave blank to keep current"></div>
    <div class="form-row-2">
      <div class="form-group"><label class="form-label">Role</label>
        <select id="es-role" class="form-input">
          <option value="staff" ${s.role==='staff'?'selected':''}>Staff (Assignable)</option>
          <option value="manager" ${s.role==='manager'?'selected':''}>Manager</option>
          <option value="director" ${s.role==='director'?'selected':''}>Director</option>
          <option value="admin" ${s.role==='admin'?'selected':''}>Admin</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Status</label>
        <select id="es-active" class="form-input">
          <option value="1" ${s.active?'selected':''}>Active</option>
          <option value="0" ${!s.active?'selected':''}>Inactive</option>
        </select>
      </div>
    </div>
    <div id="es-rights-wrap" style="display:${s.role==='staff'?'block':'none'}">
      <label class="form-label">Staff Rights (select which rights to grant)</label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
        ${(() => { let existingRights = []; try { existingRights = typeof s.supervisor_rights === 'string' ? JSON.parse(s.supervisor_rights||'[]') : (s.supervisor_rights||[]); } catch{} return ['view_jobs','edit_jobs','create_jobs','view_financials','deliver','download','share','manage_machines','view_reports','update_machine_status'].map(r =>
          `<label style="display:flex;align-items:center;gap:4px;background:#f0f4ff;border:1px solid #d0d8f0;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;user-select:none">
            <input type="checkbox" class="es-right-cb" value="${r}" ${existingRights.includes(r)?'checked':''}> ${r.replace(/_/g,' ')}
          </label>`).join(''); })()}
      </div>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="es-save" class="btn-primary">Save Changes</button>
    </div>`);
  document.getElementById('es-role')?.addEventListener('change', e => {
    document.getElementById('es-rights-wrap').style.display = e.target.value === 'staff' ? 'block' : 'none';
  });
  document.getElementById('es-save')?.addEventListener('click', async () => {
    const selectedRole = document.getElementById('es-role')?.value;
    const rights = selectedRole === 'staff' ? Array.from(document.querySelectorAll('.es-right-cb:checked')).map(cb => cb.value) : null;
    const body = {
      name:   document.getElementById('es-name')?.value.trim(),
      email:  document.getElementById('es-email')?.value.trim(),
      role:   selectedRole,
      active: parseInt(document.getElementById('es-active')?.value),
      supervisor_rights: rights,
    };
    const p = document.getElementById('es-pass')?.value;
    if (p) body.password = p;
    try {
      await API.put(`/api/staff/${s.id}`, body);
      closeModal(); toast('Updated', 'success'); await loadStaff();
    } catch (_) { toast('Update failed', 'error'); }
  });
}

async function loadStaffForSelects() {
  if (S.staff.length) return;
  try { const r = await API.get('/api/staff'); S.staff = r.data; } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS (admin: full reports; staff: my jobs export)
// ─────────────────────────────────────────────────────────────────────────────
function reportsHTML() {
  if (!isAdmin()) {
    // Staff: only export their own jobs
    return `
    <div class="view-pad">
      <div class="report-card">
        <div class="report-title"><i class="fas fa-file-excel" style="color:#43A047"></i> My Jobs Export</div>
        <div class="report-desc">Export your assigned jobs to Excel (.xlsx)</div>
        <div class="form-row-2" style="margin-top:10px">
          <div class="form-group"><label class="form-label">From</label>
            <input id="mj-from" type="date" class="form-input"></div>
          <div class="form-group"><label class="form-label">To</label>
            <input id="mj-to" type="date" class="form-input"></div>
        </div>
        <button id="btn-mj" class="btn-sm btn-green" style="margin-top:6px">
          <i class="fas fa-download"></i> Download .xlsx
        </button>
      </div>
    </div>`;
  }
  return `
  <div class="view-pad">
    <div class="report-card" id="customer-master-card">
      <div class="report-title"><i class="fas fa-address-book" style="color:#00897B"></i> Customer Master</div>
      <div class="report-desc">Search, view all customers and their job history</div>
      <div class="form-group" style="margin-top:10px">
        <div style="display:flex;gap:8px">
          <input id="cm-search" type="text" class="form-input" placeholder="Search by name or mobile…" autocomplete="off" style="flex:1">
          <button id="btn-cm-search" class="btn-sm" style="background:#00897B;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer"><i class="fas fa-search"></i></button>
        </div>
      </div>
      <div id="cm-results" style="max-height:320px;overflow-y:auto;margin-top:8px"></div>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-users" style="color:#1E88E5"></i> Customer Data Export</div>
      <div class="report-desc">Export all customers: name, phone, total jobs (deduplicated)</div>
      <button id="btn-cust-export" class="btn-sm btn-blue" style="margin-top:10px">
        <i class="fas fa-download"></i> Download .xlsx
      </button>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-file-excel" style="color:#43A047"></i> Full Backup</div>
      <div class="report-desc">Export all jobs, machines, images and customers</div>
      <button id="btn-export" class="btn-sm btn-green" style="margin-top:10px">
        <i class="fas fa-download"></i> Download .xlsx
      </button>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-upload" style="color:#1E88E5"></i> Restore Backup</div>
      <div class="report-desc">Import from a previously exported .xlsx file</div>
      <label class="btn-sm btn-blue" style="margin-top:10px;cursor:pointer">
        <i class="fas fa-file-import"></i> Choose File
        <input id="import-file" type="file" accept=".xlsx" style="display:none">
      </label>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-user-chart" style="color:#FB8C00"></i> Staff Work Report</div>
      <div class="report-desc">Machines handled per staff member</div>
      <div class="form-row-2" style="margin-top:10px">
        <div class="form-group"><label class="form-label">From</label>
          <input id="sr-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To</label>
          <input id="sr-to" type="date" class="form-input"></div>
      </div>
      <button id="btn-sr" class="btn-sm btn-orange"><i class="fas fa-download"></i> Export</button>
    </div>
    <div class="report-card">
      <div class="report-title"><i class="fas fa-chart-bar" style="color:#9C27B0"></i> Job Summary</div>
      <div class="report-desc">Revenue, status, balance per job</div>
      <div class="form-row-2" style="margin-top:10px">
        <div class="form-group"><label class="form-label">From</label>
          <input id="jr-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To</label>
          <input id="jr-to" type="date" class="form-input"></div>
      </div>
      <button id="btn-jr" class="btn-sm btn-blue" style="background:#9C27B0"><i class="fas fa-download"></i> Export</button>
    </div>
    <div class="report-card" id="ledger-report-card">
      <div class="report-title"><i class="fas fa-book" style="color:#00897B"></i> Customer Ledger</div>
      <div class="report-desc">View & export full job history for a customer</div>
      <div class="form-group" style="margin-top:10px">
        <label class="form-label">Customer Mobile <span class="req">*</span></label>
        <div style="display:flex;gap:8px">
          <input id="ledger-mobile" type="tel" class="form-input" placeholder="9876543210" inputmode="numeric" style="flex:1">
          <button id="btn-ledger-search" class="btn-sm" style="background:#00897B;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;white-space:nowrap"><i class="fas fa-search"></i> Load</button>
        </div>
      </div>
      <div class="form-row-2" style="margin-bottom:8px">
        <div class="form-group"><label class="form-label">From Date</label>
          <input id="ledger-from" type="date" class="form-input"></div>
        <div class="form-group"><label class="form-label">To Date</label>
          <input id="ledger-to" type="date" class="form-input"></div>
      </div>
      <div id="ledger-results" style="display:none;margin-top:8px">
        <div id="ledger-table" style="overflow-x:auto;max-height:320px;overflow-y:auto;border:1px solid #e0e0e0;border-radius:8px"></div>
        <div id="ledger-totals" style="margin-top:8px;padding:10px 12px;background:#E8F5E9;border-radius:8px;font-size:14px;font-weight:700"></div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button id="btn-ledger-a" class="btn-sm btn-blue"><i class="fas fa-file-excel"></i> Export Summary</button>
          <button id="btn-ledger-b" class="btn-sm" style="background:#7B1FA2;color:#fff;border:none;border-radius:8px;padding:8px 14px;cursor:pointer"><i class="fas fa-file-excel"></i> Export with Machines</button>
        </div>
      </div>
    </div>
  </div>`;
}
function bindReports() {
  // Staff: my jobs export
  if (!isAdmin()) {
    document.getElementById('btn-mj')?.addEventListener('click', async () => {
      const from = document.getElementById('mj-from')?.value;
      const to   = document.getElementById('mj-to')?.value;
      const p    = new URLSearchParams();
      if (from) p.set('from', from);
      if (to)   p.set('to', to);
      try {
        toast('Preparing export…', 'info');
        const r = await API.get('/api/reports/my-jobs?' + p, { responseType: 'blob' });
        const url = URL.createObjectURL(r.data);
        const a = document.createElement('a');
        a.href = url; a.download = 'AES_my_jobs.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast('Export downloaded ✅', 'success');
      } catch (_) { toast('Export failed', 'error'); }
    });
    return;
  }
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    try {
      toast('Preparing backup…', 'info');
      const r = await API.get('/api/backup/export', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = 'AES_backup.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Backup downloaded ✅', 'success');
    } catch (_) { toast('Export failed', 'error'); }
  });
  document.getElementById('btn-cust-export')?.addEventListener('click', async () => {
    try {
      toast('Preparing customer data…', 'info');
      const r = await API.get('/api/reports/customers', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = 'AES_customers.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Customer data downloaded ✅', 'success');
    } catch (_) { toast('Export failed', 'error'); }
  });
  document.getElementById('import-file')?.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('This will merge/overwrite existing data. Proceed?')) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      toast('Importing…', 'info');
      const r = await API.post('/api/backup/import', fd, { headers: { 'Content-Type': 'multipart/form-data' }});
      toast(`Restored: ${r.data.restored.jobs} jobs`, 'success');
    } catch (_) { toast('Import failed', 'error'); }
  });
  document.getElementById('btn-sr')?.addEventListener('click', async () => {
    const from = document.getElementById('sr-from')?.value;
    const to   = document.getElementById('sr-to')?.value;
    const p    = new URLSearchParams(); if (from) p.set('from',from); if (to) p.set('to',to);
    try {
      toast('Preparing staff report…', 'info');
      const r = await API.get('/api/reports/staff?' + p, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = 'AES_staff_report.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Staff report downloaded ✅', 'success');
    } catch (_) { toast('Export failed', 'error'); }
  });
  document.getElementById('btn-jr')?.addEventListener('click', async () => {
    const from = document.getElementById('jr-from')?.value;
    const to   = document.getElementById('jr-to')?.value;
    const p    = new URLSearchParams(); if (from) p.set('from',from); if (to) p.set('to',to);
    try {
      toast('Preparing job summary…', 'info');
      const r = await API.get('/api/reports/jobs?' + p, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url; a.download = 'AES_job_summary.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Job summary downloaded ✅', 'success');
    } catch (_) { toast('Export failed', 'error'); }
  });

  // ── Customer Ledger in-page view ──────────────────────────────────────────────
  const loadLedger = async () => {
    const mobile = document.getElementById('ledger-mobile')?.value.trim();
    if (!mobile) { toast('Enter customer mobile', 'error'); return; }
    const from   = document.getElementById('ledger-from')?.value || '';
    const to     = document.getElementById('ledger-to')?.value   || '';
    try {
      toast('Loading ledger…', 'info');
      const p = new URLSearchParams({ mobile });
      if (from) p.set('from', from);
      if (to)   p.set('to',   to);
      const r = await API.get('/api/customers/history?' + p);
      const jobs = r.data || [];
      const resDiv = document.getElementById('ledger-results');
      const tblDiv = document.getElementById('ledger-table');
      const totDiv = document.getElementById('ledger-totals');
      if (resDiv) resDiv.style.display = 'block';
      if (!jobs.length) {
        if (tblDiv) tblDiv.innerHTML = `<p style="padding:16px;color:#888;text-align:center">No jobs found for this mobile number</p>`;
        if (totDiv) totDiv.textContent = '';
        return;
      }
      let totalAmt = 0, totalRec = 0;
      const rows = jobs.map(j => {
        const amt  = parseFloat(j.total_charges) || 0;
        const rec  = parseFloat(j.received_amount) || 0;
        const due  = Math.max(0, amt - rec);
        totalAmt += amt; totalRec += rec;
        const sc2 = j.status === 'delivered' ? '#1E88E5' : j.status === 'repaired' ? '#43A047' : j.status === 'returned' ? '#B8860B' : '#E53935';
        return `<tr style="border-bottom:1px solid #f5f5f5">
          <td style="padding:8px 10px;font-weight:700;color:#1a1a2e;cursor:pointer;text-decoration:underline" onclick="closeModal();navigate('detail',{jobId:'${j.id}'})">${j.id}</td>
          <td style="padding:8px 10px;color:#666">${fmtDate(j.created_at)}</td>
          <td style="padding:8px 10px;font-size:12px"><span style="background:${sc2}22;color:${sc2};border-radius:4px;padding:2px 6px;font-weight:700">${sl(j.status)}</span></td>
          <td style="padding:8px 10px;font-weight:700;text-align:right">${fmtRs(amt)}</td>
          <td style="padding:8px 10px;color:#43A047;font-weight:600;text-align:right">${fmtRs(rec)}</td>
          <td style="padding:8px 10px;color:${due>0?'#E53935':'#43A047'};font-weight:700;text-align:right">${fmtRs(due)}</td>
        </tr>`;
      }).join('');
      if (tblDiv) tblDiv.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8f9fa;position:sticky;top:0">
            <th style="padding:8px 10px;text-align:left;color:#888;font-weight:700">Job #</th>
            <th style="padding:8px 10px;text-align:left;color:#888;font-weight:700">Date</th>
            <th style="padding:8px 10px;text-align:left;color:#888;font-weight:700">Status</th>
            <th style="padding:8px 10px;text-align:right;color:#888;font-weight:700">Amount</th>
            <th style="padding:8px 10px;text-align:right;color:#888;font-weight:700">Received</th>
            <th style="padding:8px 10px;text-align:right;color:#888;font-weight:700">Due</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      const totalDue = Math.max(0, totalAmt - totalRec);
      if (totDiv) totDiv.innerHTML = `
        <span>Total: <b>${fmtRs(totalAmt)}</b></span> &nbsp;|&nbsp;
        <span style="color:#43A047">Received: <b>${fmtRs(totalRec)}</b></span> &nbsp;|&nbsp;
        <span style="color:${totalDue>0?'#E53935':'#43A047'}">Total Receivable: <b>${fmtRs(totalDue)}</b></span>
        &nbsp;<span style="color:#888;font-weight:400;font-size:12px">(${jobs.length} jobs)</span>`;
      toast(`Loaded ${jobs.length} jobs`, 'success');
    } catch (_) { toast('Ledger load failed', 'error'); }
  };
  document.getElementById('btn-ledger-search')?.addEventListener('click', loadLedger);
  document.getElementById('ledger-mobile')?.addEventListener('keypress', e => { if (e.key === 'Enter') loadLedger(); });

  const dlLedger = async (mode) => {
    const mobile = document.getElementById('ledger-mobile')?.value.trim();
    if (!mobile) { toast('Enter customer mobile first', 'error'); return; }
    const from = document.getElementById('ledger-from')?.value || '';
    const to   = document.getElementById('ledger-to')?.value   || '';
    const p    = new URLSearchParams({ mobile, mode });
    if (from) p.set('from', from);
    if (to)   p.set('to',   to);
    try {
      const resp = await API.get('/api/reports/ledger?' + p, { responseType: 'blob' });
      const url  = URL.createObjectURL(resp.data);
      const a    = document.createElement('a'); a.href = url;
      a.download = `AES_ledger_${mobile}_${mode}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Ledger downloaded ✅', 'success');
    } catch (_) { toast('Export failed', 'error'); }
  };
  document.getElementById('btn-ledger-a')?.addEventListener('click', () => dlLedger('A'));
  document.getElementById('btn-ledger-b')?.addEventListener('click', () => dlLedger('B'));

  // ── Customer Master search ──────────────────────────────────────────────
  const cmSearch = async () => {
    const q = document.getElementById('cm-search')?.value.trim();
    if (!q || q.length < 2) { toast('Enter at least 2 characters', 'error'); return; }
    const resEl = document.getElementById('cm-results');
    if (!resEl) return;
    resEl.innerHTML = '<div class="loader-wrap"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
      const r = await API.get('/api/customers/search', { params: { q } });
      const custs = r.data || [];
      if (!custs.length) {
        resEl.innerHTML = '<p style="text-align:center;color:#888;padding:16px">No customers found</p>';
        return;
      }
      resEl.innerHTML = custs.map(c => `
        <div style="padding:10px 12px;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:700;color:#1a1a2e;font-size:15px">${esc(c.name)}</div>
            <div style="font-size:13px;color:#888">${c.mobile||''}${c.mobile2?' / '+c.mobile2:''}</div>
            ${c.address ? `<div style="font-size:12px;color:#aaa">${esc(c.address)}</div>` : ''}
          </div>
          <button class="btn-sm btn-blue cm-view-history" data-mobile="${c.mobile}" data-name="${esc(c.name)}" style="white-space:nowrap">
            <i class="fas fa-history"></i> History
          </button>
        </div>`).join('');
      // Bind history buttons
      resEl.querySelectorAll('.cm-view-history').forEach(btn => {
        btn.addEventListener('click', () => showCustomerHistory(btn.dataset.mobile, btn.dataset.name));
      });
    } catch (_) {
      resEl.innerHTML = '<p style="text-align:center;color:#e53935;padding:16px">Search failed</p>';
    }
  };
  document.getElementById('btn-cm-search')?.addEventListener('click', cmSearch);
  document.getElementById('cm-search')?.addEventListener('keypress', e => { if (e.key === 'Enter') cmSearch(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// v39: DAILY AUTO-BACKUP SYSTEM
// Schedules a daily backup at user-configured time (default 23:00).
// Downloads an XLSX file with all jobs, machines, customers, images metadata.
// Uses localStorage to persist schedule + last-backup timestamp.
// ─────────────────────────────────────────────────────────────────────────────
const _BACKUP_TIME_KEY = 'AES_BACKUP_TIME';
const _BACKUP_LAST_KEY = 'AES_BACKUP_LAST';
let _backupTimer = null;

function _backupGetTime() {
  return localStorage.getItem(_BACKUP_TIME_KEY) || '23:00';
}
function _backupSetTime(t) {
  localStorage.setItem(_BACKUP_TIME_KEY, t);
  _scheduleBackup(); // Reschedule after change
}
function _backupGetLast() {
  return localStorage.getItem(_BACKUP_LAST_KEY) || null;
}
function _backupSetLast() {
  const now = new Date().toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  localStorage.setItem(_BACKUP_LAST_KEY, now);
}

async function _doBackupDownload() {
  if (!S.token) { toast('Please log in to download backup', 'error'); return; }
  if (_isOffline) { toast('Cannot download backup while offline', 'error'); return; }
  const statusEl = document.getElementById('backup-status');
  if (statusEl) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing backup...';
  try {
    const resp = await fetch('/api/backup/export', {
      headers: { Authorization: 'Bearer ' + S.token }
    });
    if (!resp.ok) throw new Error('Backup failed');
    const blob = await resp.blob();
    const date = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `AES_backup_${date}.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    _backupSetLast();
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-check-circle" style="color:#43A047"></i> Backup downloaded successfully!';
    _updateBackupLastUI();
    toast('Backup downloaded!', 'success');
    // Show notification if app is in background
    showLocalNotification('Daily Backup Complete', `AES_backup_${date}.xlsx saved`, 'backup');
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-exclamation-circle" style="color:#E53935"></i> Backup failed. Try again.';
    toast('Backup download failed', 'error');
  }
}

function _updateBackupLastUI() {
  const el = document.getElementById('backup-last');
  const last = _backupGetLast();
  if (el) el.textContent = last ? `Last backup: ${last}` : 'No backup yet';
}

function _scheduleBackup() {
  if (_backupTimer) clearTimeout(_backupTimer);
  // Only schedule for admin users
  if (!isAdminOnly()) return;
  const timeStr = _backupGetTime(); // "HH:MM"
  const [hh, mm] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  // If target time has passed today, schedule for tomorrow
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();
  _backupTimer = setTimeout(() => {
    _doBackupDownload();
    // Reschedule for tomorrow after download
    setTimeout(() => _scheduleBackup(), 1000);
  }, delay);
}

// Start backup scheduler on app boot (admin only, non-blocking)
setTimeout(() => { if (S.token && S.user) _scheduleBackup(); }, 3000);

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function settingsHTML() {
  return `
  <div class="view-pad">
    <div class="card" style="margin-bottom:12px">
      <div class="section-title"><i class="fas fa-user"></i> Logged In As</div>
      <div style="font-size:16px;font-weight:700">${esc(S.user?.name||'')}</div>
      <div style="font-size:13px;color:#888;margin-top:2px">${esc(S.user?.email||'')} · ${roleLabel(S.user?.role||'')}</div>
    </div>
    ${isAdminOnly() ? `
    <div class="card" style="margin-bottom:12px" id="job-prefix-card">
      <div class="section-title"><i class="fas fa-hashtag" style="color:#1E88E5"></i> Job Number Format</div>
      <div style="font-size:13px;color:#888;margin-bottom:10px">Configure job ID prefix and digit count (e.g. AD-0001)</div>
      <div class="form-row-2">
        <div class="form-group">
          <label class="form-label">Prefix</label>
          <input id="set-prefix" type="text" class="form-input" placeholder="e.g. C, AD, AEW" maxlength="10">
        </div>
        <div class="form-group">
          <label class="form-label">Digits</label>
          <input id="set-digits" type="number" class="form-input" placeholder="3" min="2" max="6">
        </div>
      </div>
      <div style="font-size:12px;color:#888;margin:4px 0 8px">Preview: <b id="prefix-preview">—</b></div>
      <button id="btn-save-prefix" class="btn-sm btn-blue"><i class="fas fa-save"></i> Save Format</button>
    </div>
    <div class="settings-item" id="set-cleanup">
      <div>
        <div class="settings-label"><i class="fas fa-broom settings-icon" style="color:#FB8C00"></i> Cleanup Old Records</div>
        <div class="settings-desc">Delete jobs by date range (non-delivered)</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#ccc"></i>
    </div>
    <div class="settings-item" id="set-reset">
      <div>
        <div class="settings-label"><i class="fas fa-trash-alt settings-icon" style="color:#E53935"></i> Full Reset</div>
        <div class="settings-desc">Delete ALL data and reset counter to C-001</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#ccc"></i>
    </div>` : ''}
    ${isAdminOnly() ? `
    <!-- v39: Daily Auto-Backup -->
    <div class="card" style="margin-bottom:12px" id="backup-card">
      <div class="section-title"><i class="fas fa-cloud-download-alt" style="color:#1E88E5"></i> Daily Auto-Backup</div>
      <div style="font-size:13px;color:#888;margin-bottom:10px">Automatically backs up all data daily. Download anytime.</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <label style="font-size:13px;font-weight:700;color:#555;white-space:nowrap">Backup Time:</label>
        <input id="set-backup-time" type="time" class="form-input" style="flex:1;min-height:36px;padding:4px 10px;font-size:14px" value="${_backupGetTime()}">
        <button id="btn-save-backup-time" class="btn-sm btn-blue" style="white-space:nowrap"><i class="fas fa-save"></i> Save</button>
      </div>
      <div id="backup-status" style="font-size:12px;color:#888;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px">
        <button id="btn-backup-now" class="btn-sm" style="flex:1;background:#1E88E5;color:#fff;border:none;border-radius:8px;padding:10px;font-size:14px;font-weight:700;cursor:pointer"><i class="fas fa-download"></i> Download Backup Now</button>
      </div>
      <div id="backup-last" style="font-size:11px;color:#aaa;margin-top:8px;text-align:center"></div>
    </div>` : ''}
    <div class="settings-item" id="set-install-app" style="${window._pwaInstallPrompt ? '' : 'display:none'}">
      <div>
        <div class="settings-label"><i class="fas fa-mobile-alt settings-icon" style="color:#43A047"></i> Install App</div>
        <div class="settings-desc">Add to Home Screen for standalone app experience</div>
      </div>
      <i class="fas fa-download" style="color:#43A047"></i>
    </div>
    <div class="settings-item" id="set-logout">
      <div>
        <div class="settings-label"><i class="fas fa-sign-out-alt settings-icon" style="color:#E53935"></i> Sign Out</div>
        <div class="settings-desc">Log out of this account</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#ccc"></i>
    </div>
    <div style="text-align:center;margin-top:24px;color:#bbb;font-size:13px">
      ✨ adition™ since 1984 · v39.0<br>
      Gheekanta, Ahmedabad 380001
    </div>
  </div>`;
}
function bindSettings() {
  document.getElementById('set-logout')?.addEventListener('click', logout);
  document.getElementById('set-cleanup')?.addEventListener('click', showCleanupModal);
  // PWA Install from Settings
  document.getElementById('set-install-app')?.addEventListener('click', async () => {
    if (!window._pwaInstallPrompt) { toast('App already installed or not supported', 'info'); return; }
    try {
      window._pwaInstallPrompt.prompt();
      const { outcome } = await window._pwaInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        toast('App installed! \ud83c\udf89', 'success');
        window._pwaInstallPrompt = null;
        document.getElementById('set-install-app')?.remove();
        document.getElementById('hdr-install-btn')?.remove();
      }
    } catch (_) {}
  });
  document.getElementById('set-reset')?.addEventListener('click', () => {
    if (!confirm('⚠️ FULL RESET: Delete ALL jobs, machines, images and reset counter?\n\nCustomer data will be PRESERVED.\nThis CANNOT be undone!')) return;
    API.delete('/api/cleanup', { data: { full_reset: true } })
      .then(() => { toast('Full reset complete', 'success'); navigate('dashboard'); })
      .catch(() => toast('Reset failed', 'error'));
  });

  // Load and bind prefix settings (admin only)
  if (isAdmin()) {
    API.get('/api/settings').then(r => {
      const d = r.data;
      const pfx = document.getElementById('set-prefix');
      const dig = document.getElementById('set-digits');
      const prev = document.getElementById('prefix-preview');
      if (pfx) pfx.value = d.job_prefix || 'C';
      if (dig) dig.value = d.job_seq_digits || '3';
      if (prev) {
        const seq = String(1).padStart(parseInt(d.job_seq_digits || '3'), '0');
        prev.textContent = `${d.job_prefix || 'C'}-${seq}`;
      }
      function updatePreview() {
        const p = pfx?.value.trim() || 'C';
        const n = parseInt(dig?.value || '3') || 3;
        if (prev) prev.textContent = `${p}-${String(1).padStart(n, '0')}`;
      }
      pfx?.addEventListener('input', updatePreview);
      dig?.addEventListener('input', updatePreview);
    }).catch(() => {});

    document.getElementById('btn-save-prefix')?.addEventListener('click', async () => {
      const prefix = document.getElementById('set-prefix')?.value.trim().toUpperCase();
      const digits = parseInt(document.getElementById('set-digits')?.value || '3');
      if (!prefix) { toast('Prefix cannot be empty', 'error'); return; }
      if (digits < 2 || digits > 6) { toast('Digits must be 2–6', 'error'); return; }
      try {
        await API.put('/api/settings', { job_prefix: prefix, job_seq_digits: String(digits) });
        toast(`Format saved: ${prefix}-${String(1).padStart(digits, '0')} ✅`, 'success');
      } catch (_) { toast('Failed to save', 'error'); }
    });
  }

  // v39: Backup controls (admin only)
  if (isAdminOnly()) {
    _updateBackupLastUI();
    // Show next scheduled backup time
    const statusEl = document.getElementById('backup-status');
    if (statusEl) {
      const t = _backupGetTime();
      statusEl.innerHTML = `<i class="fas fa-clock" style="color:#1E88E5"></i> Next auto-backup scheduled at <b>${t}</b>`;
    }
    document.getElementById('btn-backup-now')?.addEventListener('click', () => _doBackupDownload());
    document.getElementById('btn-save-backup-time')?.addEventListener('click', () => {
      const timeInput = document.getElementById('set-backup-time');
      if (!timeInput?.value) { toast('Select a time', 'error'); return; }
      _backupSetTime(timeInput.value);
      const statusEl = document.getElementById('backup-status');
      if (statusEl) statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:#43A047"></i> Backup scheduled at <b>${timeInput.value}</b>`;
      toast(`Daily backup set for ${timeInput.value}`, 'success');
    });
  }
}
function showCleanupModal() {
  showModal(`
    <h3 class="modal-title"><i class="fas fa-broom" style="color:#FB8C00"></i> Cleanup Records</h3>
    <div class="form-row-2">
      <div class="form-group"><label class="form-label">From</label>
        <input id="cl-from" type="date" class="form-input"></div>
      <div class="form-group"><label class="form-label">To</label>
        <input id="cl-to" type="date" class="form-input"></div>
    </div>
    <p style="font-size:13px;color:#888;margin:8px 0">Deletes non-delivered jobs in the date range.</p>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="cl-confirm" class="btn-primary" style="background:#FB8C00">
        <i class="fas fa-broom"></i> Delete Records
      </button>
    </div>`);
  document.getElementById('cl-confirm')?.addEventListener('click', async () => {
    const from = document.getElementById('cl-from')?.value;
    const to   = document.getElementById('cl-to')?.value;
    if (!from || !to) { toast('Select date range', 'error'); return; }
    if (!confirm(`Delete non-delivered jobs from ${from} to ${to}?`)) return;
    try {
      const r = await API.delete('/api/cleanup', { data: { from, to } });
      closeModal(); toast(`Deleted ${r.data.deleted} jobs`, 'success');
    } catch (_) { toast('Cleanup failed', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER SELF-TRACKING PAGE — /track?job=[ID]&mobile=[Number]
// Public view (no auth required) — validates mobile against job data
// ─────────────────────────────────────────────────────────────────────────────
function trackHTML() {
  return `
  <div class="view-pad" style="max-width:500px;margin:0 auto;padding-top:16px">
    <div style="text-align:center;margin-bottom:20px">
      <div style="width:56px;height:56px;background:linear-gradient(135deg,#E53935,#B71C1C);border-radius:14px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff"><i class="fas fa-bolt"></i></div>
      <div style="font-size:22px;font-weight:900;color:#1a1a2e;letter-spacing:1px">ADITION ELECTRIC</div>
      <div style="font-size:13px;color:#888">Track Your Repair Job</div>
    </div>
    <div id="track-content">
      <div class="card">
        <div class="form-group">
          <label class="form-label">Job Number <span class="req">*</span></label>
          <input id="trk-job" type="text" class="form-input" placeholder="e.g. C-001" value="${esc(new URLSearchParams(window.location.search).get('job')||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Mobile Number <span class="req">*</span></label>
          <input id="trk-mobile" type="tel" class="form-input" placeholder="9876543210" inputmode="numeric" value="${esc(new URLSearchParams(window.location.search).get('mobile')||'')}">
        </div>
        <button id="trk-btn" class="btn-primary btn-full"><i class="fas fa-search"></i> Track Job</button>
      </div>
      <div id="trk-result"></div>
    </div>
  </div>`;
}

function bindTrack() {
  const params = new URLSearchParams(window.location.search);
  const autoJob    = params.get('job');
  const autoMobile = params.get('mobile');

  async function doTrack() {
    const jobId  = document.getElementById('trk-job')?.value.trim();
    const mobile = document.getElementById('trk-mobile')?.value.trim();
    if (!jobId || !mobile) { toast('Job number and mobile required', 'error'); return; }
    const btn = document.getElementById('trk-btn');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Tracking…';
    const resEl = document.getElementById('trk-result');
    try {
      const r = await axios.get('/api/track', { params: { job: jobId, mobile } });
      const d = r.data;
      const color = sc(d.status);
      resEl.innerHTML = `
        <div class="card mt-3">
          <div style="background:${color};color:#fff;padding:12px 16px;border-radius:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:22px;font-weight:900">${esc(d.id)}</span>
            <span style="background:rgba(255,255,255,.2);padding:4px 14px;border-radius:8px;font-weight:700">${sl(d.status)}</span>
          </div>
          <div class="info-row"><i class="fas fa-user info-icon" style="color:${color}"></i><span class="info-val fw-bold">${esc(d.customer_name)}</span></div>
          <div class="info-row"><i class="fas fa-calendar info-icon" style="color:${color}"></i><span class="info-val">${fmtDate(d.created_at)}</span></div>
          ${d.delivered_at ? `<div class="info-row"><i class="fas fa-check-double info-icon" style="color:#1E88E5"></i><span class="info-val">Delivered: ${fmtDate(d.delivered_at)}</span></div>` : ''}
        </div>
        <div class="card mt-3">
          <h3 class="section-title" style="margin:0 0 10px"><i class="fas fa-tools" style="color:#E53935"></i> Machines <span style="background:#E53935;color:#fff;border-radius:10px;padding:2px 10px;font-size:13px;font-weight:700">${d.machine_count}</span></h3>
          ${(d.machines||[]).map((m, i) => `
          <div style="background:#f8f9fa;border-radius:10px;padding:10px 14px;margin-bottom:8px;border-left:4px solid ${sc(m.status)}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:700;color:#1a1a2e">${i+1}. ${esc(m.product_name)}${m.quantity>1?' ×'+m.quantity:''}</span>
              <span style="background:${sb(m.status)};color:${sc(m.status)};border:1px solid ${sc(m.status)};border-radius:6px;padding:2px 10px;font-size:12px;font-weight:700">${sl(m.status)}</span>
            </div>
            ${m.product_complaint ? `<div style="font-size:13px;color:#666;margin-top:4px">${esc(m.product_complaint)}</div>` : ''}
            ${m.work_done ? `<div style="font-size:12px;color:#2E7D32;margin-top:2px">Work done: ${esc(m.work_done)}</div>` : ''}
          </div>`).join('')}
        </div>`;
    } catch (e) {
      resEl.innerHTML = `<div class="card mt-3" style="text-align:center;color:#E53935;padding:24px">
        <i class="fas fa-exclamation-triangle fa-2x" style="margin-bottom:8px;display:block"></i>
        ${e.response?.data?.error || 'Failed to track job. Please check job number and mobile.'}
      </div>`;
    }
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> Track Job';
  }

  document.getElementById('trk-btn')?.addEventListener('click', doTrack);
  document.getElementById('trk-mobile')?.addEventListener('keypress', e => { if (e.key === 'Enter') doTrack(); });

  // Auto-track if URL has both params
  if (autoJob && autoMobile) setTimeout(doTrack, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRINT ADDRESS LABEL — 101mm × 152mm single page
// ─────────────────────────────────────────────────────────────────────────────
async function printAddressLabel(j) {
  toast('Generating address label…', 'info');
  try {
    // 101mm × 152mm at 300 DPI = 1193px × 1795px
    // Width constraint: 95mm usable = 1122px (padded from 101mm)
    const W = 1193;
    const H = 1795;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Margins: ensure content fits within 95mm = 1122px usable width
    const padX = 36; // (1193 - 1122) / 2 ≈ 36px each side → 95mm usable
    const maxTextW = W - padX * 2; // 1121px ≈ 95mm

    // ── FROM block height (bottom-left, left-aligned, +10pt fonts) ──
    const fromBlockH = 260;
    const fromDividerY = H - fromBlockH - 20;

    // Available height for TO section — start lower to avoid "T" clipping
    const toStartY = 100; // extra top padding to prevent "To" top-line clipping
    const toAvailH = fromDividerY - toStartY - 20;

    // ── TO content data ──
    const nameText = j.snap_name || 'Customer';
    const addrText = j.snap_address || '';
    const mobText = 'M: ' + (j.snap_mobile || '');
    const mob2Text = j.snap_mobile2 ? 'Alt: ' + j.snap_mobile2 : '';

    // Measure TO block at given scale
    function measureToBlock(scale) {
      let h = 0;
      const toSize = Math.round(38 * scale);
      h += toSize + 16 * scale; // "To," label + gap before name (extra gap to separate)
      const nameSize = Math.round(60 * scale);
      ctx.font = `900 ${nameSize}px "Segoe UI", Arial, sans-serif`;
      const nameLines = wrapText(ctx, nameText, maxTextW);
      h += nameLines.length * (nameSize + 8 * scale) + 10 * scale;
      if (addrText) {
        const addrSize = Math.round(40 * scale);
        ctx.font = `500 ${addrSize}px "Segoe UI", Arial, sans-serif`;
        const addrLines = wrapText(ctx, addrText, maxTextW);
        h += addrLines.length * (addrSize + 6 * scale) + 10 * scale;
      }
      const mobSize = Math.round(46 * scale);
      h += mobSize + 10 * scale;
      if (mob2Text) h += Math.round(38 * scale) + 8 * scale;
      return h;
    }

    // Find best scale to fill available space without overflow
    let bestScale = 1.0;
    for (let s = 2.5; s >= 0.6; s -= 0.05) {
      if (measureToBlock(s) <= toAvailH) { bestScale = s; break; }
    }

    // ── RENDER TO section — top-left aligned, "To" and name clearly separated ──
    let y = toStartY;
    const toSize = Math.round(38 * bestScale);
    ctx.fillStyle = '#888888';
    ctx.font = `bold ${toSize}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('To,', padX, y);
    y += toSize + Math.round(16 * bestScale); // extra gap after "To," before name

    // Name — bold, left-aligned, positioned clearly below "To,"
    const nameSize = Math.round(60 * bestScale);
    ctx.fillStyle = '#1a1a2e';
    ctx.font = `900 ${nameSize}px "Segoe UI", Arial, sans-serif`;
    const nameLines = wrapText(ctx, nameText, maxTextW);
    nameLines.forEach(line => {
      ctx.fillText(line, padX, y);
      y += nameSize + Math.round(6 * bestScale);
    });
    y += Math.round(8 * bestScale);

    // Address — left-aligned, tight after name, wraps properly for long city names
    if (addrText) {
      const addrSize = Math.round(40 * bestScale);
      ctx.fillStyle = '#333333';
      ctx.font = `500 ${addrSize}px "Segoe UI", Arial, sans-serif`;
      // Use character-aware wrapping for long words like "Himmatnagar"
      const addrLines = wrapTextSmart(ctx, addrText, maxTextW);
      addrLines.forEach(line => {
        ctx.fillText(line, padX, y);
        y += addrSize + Math.round(5 * bestScale);
      });
      y += Math.round(8 * bestScale);
    }

    // Mobile — left-aligned, blue
    const mobSize = Math.round(46 * bestScale);
    ctx.fillStyle = '#1565C0';
    ctx.font = `bold ${mobSize}px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(mobText, padX, y); y += mobSize + Math.round(8 * bestScale);
    if (mob2Text) {
      const mob2Size = Math.round(38 * bestScale);
      ctx.font = `bold ${mob2Size}px "Segoe UI", Arial, sans-serif`;
      ctx.fillText(mob2Text, padX, y); y += mob2Size + Math.round(6 * bestScale);
    }

    // ── DIVIDER LINE — placed tightly below TO content ──
    const divY = Math.max(y + 16, fromDividerY);
    ctx.strokeStyle = '#aaaaaa';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(padX, divY); ctx.lineTo(W - padX, divY); ctx.stroke();
    ctx.setLineDash([]);

    // ── FROM section — bottom-left, left-aligned, +4pt larger fonts ──
    let fy = divY + 26;
    ctx.textAlign = 'left';

    ctx.fillStyle = '#888888';
    ctx.font = 'bold 40px "Segoe UI", Arial, sans-serif';  // was 30 → +10pt = 40
    ctx.fillText('From,', padX, fy); fy += 48;

    ctx.fillStyle = '#E53935';
    ctx.font = '900 42px "Segoe UI", Arial, sans-serif';    // was 32 → +10pt = 42
    // Wrap company name if it overflows 95mm
    const compLines = wrapText(ctx, 'ADITION ELECTRIC SOLUTION', maxTextW);
    compLines.forEach(line => {
      ctx.fillText(line, padX, fy); fy += 48;
    });

    ctx.fillStyle = '#555555';
    ctx.font = '500 36px "Segoe UI", Arial, sans-serif';    // was 26 → +10pt = 36
    const fromAddr = ['Opp. Metropolitan Court Gate 2, Gheekanta', 'Ahmedabad 380001 | M: 7801990001'];
    fromAddr.forEach(line => {
      // Wrap from-address lines that exceed 95mm
      const wrapped = wrapText(ctx, line, maxTextW);
      wrapped.forEach(wl => { ctx.fillText(wl, padX, fy); fy += 40; });
    });

    // Convert to blob & share/download
    const blob = await new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', 0.95));
    if (!blob) { toast('Failed to generate address label', 'error'); return; }

    const fileName = `Address_${j.id}.jpg`;
    const file = new File([blob], fileName, { type: 'image/jpeg' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `Address Label - ${j.id}`, text: `To: ${j.snap_name}` });
        toast('Address label shared', 'success');
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }

    const bUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = bUrl; a.download = fileName; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(bUrl); }, 3000);
    toast(`Address label saved: ${fileName}`, 'success');
  } catch (e) {
    console.error('[AES] Print address error:', e);
    toast('Failed to generate address label', 'error');
  }
}

// Canvas text wrap helper
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Smart text wrap that handles long words (e.g. "Himmatnagar") by breaking them
function wrapTextSmart(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth) {
      if (line) lines.push(line);
      // If single word is too wide, break it character by character
      if (ctx.measureText(word).width > maxWidth) {
        let part = '';
        for (const ch of word) {
          if (ctx.measureText(part + ch).width > maxWidth && part) {
            lines.push(part);
            part = ch;
          } else {
            part += ch;
          }
        }
        line = part;
      } else {
        line = word;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD — Summary tiles, revenue charts, staff performance
// ─────────────────────────────────────────────────────────────────────────────
function adminDashHTML() {
  return `
  <div class="view-pad" id="admin-dash-root">
    <div style="display:flex;justify-content:flex-end;padding:4px 0 0">
      <button id="btn-refresh-admin" style="display:inline-flex;align-items:center;gap:4px;background:#f0f4ff;border:1.5px solid #1565C0;border-radius:8px;cursor:pointer;color:#1565C0;padding:5px 12px;font-size:13px;font-weight:700;-webkit-tap-highlight-color:transparent;transition:transform .15s" title="Refresh dashboard"><i class="fas fa-sync-alt" style="font-size:12px"></i> Refresh</button>
    </div>
    <div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>
  </div>`;
}

async function loadAdminDash() {
  const root = document.getElementById('admin-dash-root');
  if (!root) return;
  // Bind refresh button before loading data
  document.getElementById('btn-refresh-admin')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh-admin');
    if (btn) { btn.querySelector('i').style.transform = 'rotate(360deg)'; btn.querySelector('i').style.transition = 'transform .4s'; setTimeout(() => { btn.querySelector('i').style.transform = ''; }, 450); }
    _analyticsCacheTs = 0;
    loadAdminDash();
    toast('Refreshing dashboard…', 'info');
  }, { passive: true });
  try {
    const r = await API.get('/api/analytics');
    const d = r.data;
    const pending = (d.underRepair||0) + (d.repaired||0) + (d.returned||0);

    root.innerHTML = `
    <!-- AI-Enhanced Summary Tiles -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      <div onclick="navigate('dashboard');setFilter('');filterToday()" style="background:linear-gradient(135deg,#1565C0,#1976D2);border-radius:16px;padding:18px 16px;cursor:pointer;text-align:center;box-shadow:0 4px 16px rgba(21,101,192,.25);transition:transform .15s;position:relative;overflow:hidden" ontouchstart="this.style.transform='scale(0.96)'" ontouchend="this.style.transform=''">
        <div style="position:absolute;top:-15px;right:-15px;width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.1)"></div>
        <div style="font-size:28px;margin-bottom:4px">📅</div>
        <div style="font-size:32px;font-weight:900;color:#fff;line-height:1">${d.today || 0}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.8);font-weight:700;text-transform:uppercase;margin-top:6px;letter-spacing:1px">Today's Jobs</div>
      </div>
      <div onclick="navigate('dashboard');filterActive()" style="background:linear-gradient(135deg,#E65100,#F57C00);border-radius:16px;padding:18px 16px;cursor:pointer;text-align:center;box-shadow:0 4px 16px rgba(230,81,0,.25);transition:transform .15s;position:relative;overflow:hidden" ontouchstart="this.style.transform='scale(0.96)'" ontouchend="this.style.transform=''">
        <div style="position:absolute;top:-15px;right:-15px;width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.1)"></div>
        <div style="font-size:28px;margin-bottom:4px">🔧</div>
        <div style="font-size:32px;font-weight:900;color:#fff;line-height:1">${pending}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.8);font-weight:700;text-transform:uppercase;margin-top:6px;letter-spacing:1px">Pending Jobs</div>
      </div>
      <div onclick="navigate('dashboard');filterDone()" style="background:linear-gradient(135deg,#2E7D32,#43A047);border-radius:16px;padding:18px 16px;cursor:pointer;text-align:center;box-shadow:0 4px 16px rgba(46,125,50,.25);transition:transform .15s;position:relative;overflow:hidden" ontouchstart="this.style.transform='scale(0.96)'" ontouchend="this.style.transform=''">
        <div style="position:absolute;top:-15px;right:-15px;width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.1)"></div>
        <div style="font-size:28px;margin-bottom:4px">✅</div>
        <div style="font-size:32px;font-weight:900;color:#fff;line-height:1">${d.completed || 0}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.8);font-weight:700;text-transform:uppercase;margin-top:6px;letter-spacing:1px">Completed</div>
      </div>
      <div onclick="navigate('dashboard');filterAll()" style="background:linear-gradient(135deg,#7B1FA2,#9C27B0);border-radius:16px;padding:18px 16px;cursor:pointer;text-align:center;box-shadow:0 4px 16px rgba(123,31,162,.25);transition:transform .15s;position:relative;overflow:hidden" ontouchstart="this.style.transform='scale(0.96)'" ontouchend="this.style.transform=''">
        <div style="position:absolute;top:-15px;right:-15px;width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.1)"></div>
        <div style="font-size:28px;margin-bottom:4px">📊</div>
        <div style="font-size:32px;font-weight:900;color:#fff;line-height:1">${d.total || 0}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.8);font-weight:700;text-transform:uppercase;margin-top:6px;letter-spacing:1px">Total Jobs</div>
      </div>
    </div>
    <!-- Quick Action Tiles -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div onclick="navigate('dashboard');filterByStatus('under_repair')" style="background:#fff;border:2px solid #E5393520;border-radius:12px;padding:10px;cursor:pointer;text-align:center;transition:transform .15s" ontouchstart="this.style.transform='scale(0.95)'" ontouchend="this.style.transform=''">
        <div style="font-size:20px;font-weight:900;color:#E53935">${d.underRepair || 0}</div>
        <div style="font-size:10px;color:#888;font-weight:700;text-transform:uppercase">Under Repair</div>
      </div>
      <div onclick="navigate('dashboard');filterByStatus('repaired')" style="background:#fff;border:2px solid #43A04720;border-radius:12px;padding:10px;cursor:pointer;text-align:center;transition:transform .15s" ontouchstart="this.style.transform='scale(0.95)'" ontouchend="this.style.transform=''">
        <div style="font-size:20px;font-weight:900;color:#43A047">${d.repaired || 0}</div>
        <div style="font-size:10px;color:#888;font-weight:700;text-transform:uppercase">Repaired</div>
      </div>
      <div onclick="navigate('dashboard');filterByStatus('returned')" style="background:#fff;border:2px solid #B8860B20;border-radius:12px;padding:10px;cursor:pointer;text-align:center;transition:transform .15s" ontouchstart="this.style.transform='scale(0.95)'" ontouchend="this.style.transform=''">
        <div style="font-size:20px;font-weight:900;color:#B8860B">${d.returned || 0}</div>
        <div style="font-size:10px;color:#888;font-weight:700;text-transform:uppercase">Returned</div>
      </div>
    </div>

    <!-- Revenue Cards -->
    <div class="card" style="margin-bottom:12px;background:linear-gradient(135deg,#1b2838,#0f3460);color:#fff;border:none">
      <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">💰 Revenue Overview</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700;text-transform:uppercase">Today</div>
          <div style="font-size:20px;font-weight:900;color:#43A047">${fmtRs(d.todayRevenue || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700;text-transform:uppercase">This Month</div>
          <div style="font-size:20px;font-weight:900;color:#43A047">${fmtRs(d.monthRevenue || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700;text-transform:uppercase">Total Earnings</div>
          <div style="font-size:20px;font-weight:900;color:#43A047">${fmtRs(d.totalRevenue || 0)}</div>
        </div>
        <div style="background:rgba(255,255,255,.1);border-radius:10px;padding:12px;text-align:center">
          <div style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700;text-transform:uppercase">Pending Dues</div>
          <div style="font-size:20px;font-weight:900;color:#FF8A65">${fmtRs(d.pendingDues || 0)}</div>
        </div>
      </div>
      <!-- Online vs Cash breakdown -->
      <div style="display:flex;gap:10px;margin-top:10px">
        <div style="flex:1;background:rgba(67,160,71,.15);border:1px solid rgba(67,160,71,.3);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;color:rgba(255,255,255,.5);font-weight:700;text-transform:uppercase;letter-spacing:.5px">💳 Online</div>
          <div style="font-size:18px;font-weight:900;color:#81C784">${fmtRs(d.onlineTotal || 0)}</div>
        </div>
        <div style="flex:1;background:rgba(255,183,77,.15);border:1px solid rgba(255,183,77,.3);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;color:rgba(255,255,255,.5);font-weight:700;text-transform:uppercase;letter-spacing:.5px">💵 Cash</div>
          <div style="font-size:18px;font-weight:900;color:#FFB74D">${fmtRs(d.cashTotal || 0)}</div>
        </div>
      </div>
    </div>

    <!-- Monthly Revenue Chart (text-based bar chart) -->
    ${(d.monthlyRevenue||[]).length ? `
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px">📈 Monthly Revenue (Last 6 Months)</div>
      ${(d.monthlyRevenue||[]).reverse().map(m => {
        const maxR = Math.max(...(d.monthlyRevenue||[]).map(x => x.charges||1));
        const pct = maxR > 0 ? Math.max(5, Math.round(((m.charges||0)/maxR)*100)) : 5;
        const monthLabel = m.month ? new Date(m.month + '-01').toLocaleDateString('en-IN', { month:'short', year:'2-digit' }) : m.month;
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="width:55px;font-size:12px;font-weight:700;color:#555;text-align:right;flex-shrink:0">${monthLabel}</div>
          <div style="flex:1;background:#f0f2f5;border-radius:6px;height:24px;overflow:hidden;position:relative">
            <div style="background:linear-gradient(90deg,#43A047,#66BB6A);height:100%;width:${pct}%;border-radius:6px;transition:width .3s"></div>
          </div>
          <div style="font-size:12px;font-weight:800;color:#2E7D32;width:80px;text-align:right;flex-shrink:0">${fmtRs(m.charges||0)}</div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <!-- Status Breakdown -->
    ${(d.byStatus||[]).length ? `
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">📊 Status Breakdown</div>
      ${(d.byStatus||[]).map(s => {
        const pct = d.total > 0 ? Math.max(5, Math.round((s.cnt/d.total)*100)) : 0;
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="width:90px;font-size:12px;font-weight:700;color:${sc(s.status)};text-align:right;flex-shrink:0">${sl(s.status)}</div>
          <div style="flex:1;background:#f0f2f5;border-radius:6px;height:20px;overflow:hidden">
            <div style="background:${sc(s.status)};height:100%;width:${pct}%;border-radius:6px;opacity:.7"></div>
          </div>
          <div style="font-size:13px;font-weight:800;color:#1a1a2e;width:40px;text-align:right">${s.cnt}</div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <!-- Staff Performance -->
    ${(d.byStaff||[]).length ? `
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">👥 Staff Performance</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#f8f9fa">
              <th style="padding:8px 12px;text-align:left;color:#888;font-weight:700">Staff</th>
              <th style="padding:8px 12px;text-align:center;color:#888;font-weight:700">Machines</th>
              <th style="padding:8px 12px;text-align:right;color:#888;font-weight:700">Revenue</th>
            </tr>
          </thead>
          <tbody>
            ${(d.byStaff||[]).map((s, i) => `
            <tr style="border-bottom:1px solid #f0f0f0">
              <td style="padding:8px 12px;font-weight:700;color:#1a1a2e">
                <span style="background:#E3F2FD;color:#1565C0;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;margin-right:6px">${i+1}</span>
                ${esc(s.name)}
              </td>
              <td style="padding:8px 12px;text-align:center;font-weight:600">${s.cnt}</td>
              <td style="padding:8px 12px;text-align:right;font-weight:700;color:#2E7D32">${fmtRs(s.total_charges||0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}`;
  } catch (e) {
    root.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle fa-2x" style="color:#e53935"></i><p>Failed to load dashboard</p></div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-DOWNLOAD DELIVERED JOB CARD
// Generate and save "Job [Job No.] Delivered.jpg" without user prompt
// ─────────────────────────────────────────────────────────────────────────────
async function autoDownloadDeliveredCard(j) {
  if (!j || j.status !== 'delivered') return;
  try {
    toast('Auto-generating delivered job card…', 'info');
    const el = document.getElementById('job-card-print');
    if (!el) return;

    el.style.left = '-99999px'; el.style.top = '0';
    const imgEls = Array.from(el.querySelectorAll('img'));
    const base64Results = await Promise.all(imgEls.map(async (img) => {
      const src = img.getAttribute('data-auth-src') || img.getAttribute('src') || '';
      if (!src) return { img, base64: null };
      try { return { img, base64: await imageUrlToBase64(src, S.token, 1) }; } catch { return { img, base64: null }; }
    }));
    base64Results.forEach(({ img, base64 }) => { if (base64) { img.src = base64; img.removeAttribute('data-auth-src'); } });

    await Promise.all(imgEls.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
      return new Promise(resolve => { img.onload = () => resolve(true); img.onerror = () => resolve(false); setTimeout(() => resolve(false), 5000); });
    }));
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 500)));

    const CARD_WIDTH = 1080;
    const actualH = Math.max(el.scrollHeight || el.offsetHeight || 1440, 1365);
    const fullCanvas = await html2canvas(el, {
      scale: 3, useCORS: true, allowTaint: true,
      width: CARD_WIDTH, height: actualH,
      backgroundColor: '#ffffff', logging: false, imageTimeout: 15000,
    });

    const blob = await new Promise(resolve => fullCanvas.toBlob(b => resolve(b), 'image/jpeg', 0.92));
    if (!blob || blob.size < 1000) return;

    const fileName = `Job ${j.id} Delivered.jpg`;
    const bUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = bUrl; a.download = fileName; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(bUrl); }, 3000);
    toast(`Downloaded: ${fileName}`, 'success');
  } catch (e) {
    console.error('[AES] Auto-download delivered card error:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
// Check if URL is /track route — show tracking page even without auth
const _urlParams = new URLSearchParams(window.location.search);
if (window.location.pathname === '/track' || _urlParams.get('view') === 'track' || (_urlParams.has('job') && _urlParams.has('mobile') && !localStorage.getItem('AES_TOKEN'))) {
  S.view = 'track';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}

// v41: Pre-warm search cache from IndexedDB immediately after boot
// This ensures instant search results from the very first keystroke
if (S.token && S.user) _warmupSearchCache();

// Register Service Worker with explicit scope "/"
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

// ── PWA Push Notification helper ─────────────────────────────────────────────
async function requestPushPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied')  return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

function showLocalNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker.ready.then(reg => {
    reg.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: tag || 'aes-notif',
      renotify: true,
      vibrate: [200, 100, 200],
    });
  }).catch(() => {
    // Fallback: browser Notification API
    new Notification(title, { body, icon: '/icons/icon-192.png', tag: tag || 'aes-notif' });
  });
}

// Ask for push permission once after login
window._pushPermAsked = false;
function maybeAskPushPermission() {
  if (window._pushPermAsked) return;
  window._pushPermAsked = true;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    // Delay 3s to not interrupt first render
    setTimeout(() => requestPushPermission(), 3000);
  }
}

// Capture PWA install prompt (Chrome/Edge/Android)
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  window._pwaInstallPrompt = e;
  // Show install button in header if user is logged in
  const installBtn = document.getElementById('hdr-install-btn');
  if (!installBtn) {
    // Re-render header to show install button
    const headerEl = document.querySelector('.app-header');
    if (headerEl) { headerEl.outerHTML = headerHTML(); bindHeaderInstall(); }
  }
  // Also show install card in settings if visible
  const setInstall = document.getElementById('set-install-app');
  if (setInstall) setInstall.style.display = '';
});

// Bind header install button click
function bindHeaderInstall() {
  document.getElementById('hdr-install-btn')?.addEventListener('click', async () => {
    if (!window._pwaInstallPrompt) return;
    try {
      window._pwaInstallPrompt.prompt();
      const { outcome } = await window._pwaInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        toast('App installed! \ud83c\udf89', 'success');
        window._pwaInstallPrompt = null;
        document.getElementById('hdr-install-btn')?.remove();
      }
    } catch (_) {}
  });
  // Re-bind logout/back after header re-render
  document.getElementById('hdr-back-btn')?.addEventListener('click', () => navigate('dashboard'));
  document.getElementById('hdr-logout-btn')?.addEventListener('click', logout);
}

// Handle app installed event
window.addEventListener('appinstalled', () => {
  window._pwaInstallPrompt = null;
  document.getElementById('hdr-install-btn')?.remove();
  toast('App installed successfully! \ud83c\udf89', 'success');
});

// ── Performance: preload suggestion data on app boot ─────────────────────────────
_sugCache.load();

// ── System stability: global error handler ─ prevent UI crash ──────────────────
window.addEventListener('error', e => {
  console.error('[AES] Uncaught error:', e.error?.message || e.message);
  // Don't crash UI — silently log
});
window.addEventListener('unhandledrejection', e => {
  console.warn('[AES] Unhandled promise rejection:', e.reason?.message || e.reason);
  e.preventDefault(); // Prevent console error from crashing UI
});

// ── Performance: smooth mobile scrolling with passive listeners ──────────
document.addEventListener('touchstart', () => {}, { passive: true });
document.addEventListener('touchmove', () => {}, { passive: true });

})();
