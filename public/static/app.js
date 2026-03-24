// ╔══════════════════════════════════════════════════════════════════════╗
// ║  ADITION ELECTRIC SOLUTION — PWA Frontend v18                       ║
// ║  "iQOO 13 Flagship Edition"                                          ║
// ║  v18 Changes:                                                        ║
// ║  · Auto-download Job_[JobNumber].jpg → Phone/Pictures/JobCard       ║
// ║  · Open WhatsApp Business directly via wa.me/91XXXXXXXXXX           ║
// ║  · Approval request line clearly visible in WhatsApp messages       ║
// ║  · First machine entry: Voice Note + AI tiles + complaint tags      ║
// ║  · Amount suggestion tiles on New Job form                          ║
// ║  · PWA standalone: beforeinstallprompt, Install App button          ║
// ║  · 3× resolution job card, preload all images before canvas         ║
// ║  · Performance: preload suggestions, cache, smooth scrolling        ║
// ║  · Stability: global error handler, retry failed loads              ║
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
  filter : new URLSearchParams(window.location.search).get('status') || 'under_repair',
  search : '',
  fromDate: '',
  toDate  : '',
  myJobsOnly: false,
  audioStream  : null,
  audioRecorder: null,
  audioChunks  : [],
};

const CARD_H = 88;

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
const isAdmin = () => S.user?.role === 'admin';
const fmtRs   = n => '₹' + (parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '';
const esc     = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const STATUS_COLOR = { under_repair:'#E53935', repaired:'#43A047', returned:'#B8860B', delivered:'#1E88E5' };
const STATUS_BG    = { under_repair:'#FFEBEE', repaired:'#E8F5E9', returned:'#FFF8E1', delivered:'#E3F2FD' };
const STATUS_LABEL = { under_repair:'Under Repair', repaired:'Repaired', returned:'Returned', delivered:'Delivered' };
const sc = s => STATUS_COLOR[s] || '#888';
const sb = s => STATUS_BG[s]    || '#f5f5f5';
const sl = s => STATUS_LABEL[s] || s;

// 10ms debounce (iQOO 13 lag killer for search/filter)
function debounce(fn, ms = 10) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
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
    if (!img.src || img.src === window.location.href) loadAuthMedia(img.dataset.authSrc, img, 'src');
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
    S.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    S.audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
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
    toast('Microphone access denied', 'error');
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
  } catch (e) {
    toast(e.response?.data?.error || 'Login failed', 'error');
  }
}
function logout() {
  S.token = null; S.user = null; S.jobs = []; S.job = null; S.staff = []; S.requests = [];
  localStorage.removeItem('AES_TOKEN'); localStorage.removeItem('AES_USER');
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
    history.pushState({ view: 'dashboard' }, '', '/?status=' + (S.filter || ''));
  } else if (view === 'detail') {
    history.pushState({ view: 'detail', jobId: S.jobId }, '', '/?job=' + S.jobId);
  } else if (view !== 'login') {
    history.pushState({ view }, '', '/' + (view !== 'dashboard' ? '?view=' + view : ''));
  }
  render();
}

// Back button: instead of exiting app, go to jobs list
window.addEventListener('popstate', e => {
  const state = e.state;
  if (!S.token || !S.user) { render(); return; }
  if (!state || state.view === 'dashboard') {
    S.view = 'dashboard'; render();
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
  if (!S.token || !S.user) {
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
    dashboard:'Jobs Dashboard', newjob:'New Job',
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
      <span class="role-badge ${isAdmin()?'role-admin':'role-staff'}">${esc((S.user?.name||'').split(' ')[0])}</span>
      <button class="icon-btn" id="hdr-logout-btn" title="Sign out"><i class="fas fa-sign-out-alt"></i></button>
    </div>
  </header>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOTTOM NAV
// ─────────────────────────────────────────────────────────────────────────────
function bottomNavHTML() {
  const tabs = [
    { id:'dashboard', icon:'fa-list-ul',    label:'Jobs'    },
    ...(isAdmin() ? [{ id:'newjob', icon:'fa-plus-circle', label:'New Job' }] : []),
    ...(isAdmin() ? [{ id:'requests', icon:'fa-bell', label:'Requests', badge: true }] : []),
    ...(isAdmin() ? [{ id:'staff',    icon:'fa-users',     label:'Staff'   }] : []),
    { id:'reports',  icon:'fa-chart-bar', label:'Reports' },
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
  switch (S.view) {
    case 'dashboard': return dashboardHTML();
    case 'newjob':    return isAdmin() ? newJobHTML() : deniedHTML();
    case 'detail':    return `<div id="detail-root" class="view-pad"><div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div></div>`;
    case 'staff':     return isAdmin() ? staffHTML()    : deniedHTML();
    case 'reports':   return reportsHTML();
    case 'requests':  return isAdmin() ? requestsHTML() : deniedHTML();
    case 'settings':  return settingsHTML();
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
  if (isAdmin()) {
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
      bar.innerHTML = notes.slice(0, 5).map(n => {
        const icon   = n.status === 'approved' ? '✅' : '❌';
        const color  = n.status === 'approved' ? '#E8F5E9' : '#FFEBEE';
        const border = n.status === 'approved' ? '#43A047' : '#E53935';
        const action = n.status === 'approved' ? 'Assignment Approved' : 'Assignment Denied';
        const ts     = n.resolved_at || n.created_at;
        const tsStr  = ts ? new Date(ts).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
        const msg    = n.status === 'approved'
          ? `${icon} <b>${action}</b> — Job <b>#${esc(n.job_id)}</b> · <i>${esc(n.product_name)}</i>`
          : `${icon} <b>${action}</b> — Job <b>#${esc(n.job_id)}</b> · <i>${esc(n.product_name)}</i>`;
        return `<div style="background:${color};border-left:4px solid ${border};border-radius:8px;padding:10px 14px;margin-bottom:6px;font-size:13px;line-height:1.5">
          ${msg}
          <div style="color:#999;font-size:11px;margin-top:3px">${tsStr}</div>
        </div>`;
      }).join('');
      bar.style.display = 'block';
    }).catch(() => {});
  }

  switch (S.view) {
    case 'dashboard': loadJobs();                                               break;
    case 'newjob':    if (isAdmin()) bindNewJob();                               break;
    case 'detail':    loadDetail();                                             break;
    case 'staff':     if (isAdmin()) loadStaff();                              break;
    case 'reports':   if (isAdmin()) { loadStaffForSelects(); } bindReports(); break;
    case 'requests':  if (isAdmin()) loadRequests();                           break;
    case 'settings':  bindSettings();                                           break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — virtual-scroll list
// ─────────────────────────────────────────────────────────────────────────────
function dashboardHTML() {
  const filters = [
    { s:'',             label:'All',          color:'#1a1a2e' },
    { s:'under_repair', label:'Under Repair',  color:sc('under_repair') },
    { s:'repaired',     label:'Repaired',      color:sc('repaired') },
    { s:'returned',     label:'Returned',      color:sc('returned') },
    { s:'delivered',    label:'Delivered',     color:sc('delivered') },
  ];
  return `
  <div style="display:flex;flex-direction:column;height:100%">
    ${!isAdmin() ? `<div id="staff-notif-bar" style="display:none;padding:8px 12px 0"></div>` : ''}
    <div class="filter-bar" id="filter-chip-bar">
      ${filters.map(f => `
      <button class="filter-chip ${S.filter===f.s?'chip-active':''}"
        style="--chip-color:${f.color}"
        data-filter="${f.s}">${f.label} <span class="chip-count" id="cc-${f.s||'all'}"></span></button>`).join('')}
    </div>
    ${!isAdmin() ? `
    <div class="my-jobs-bar">
      <button id="btn-my-assigned" class="btn-my-assigned ${S.myJobsOnly ? 'btn-my-active' : ''}">
        <i class="fas fa-user-check"></i>
        ${S.myJobsOnly ? 'My Assigned Jobs ✓' : 'My Assigned Jobs'}
      </button>
      ${S.myJobsOnly ? `<button id="btn-clear-my" class="btn-my-clear"><i class="fas fa-times"></i> All Jobs</button>` : ''}
    </div>` : ''}
    <div class="search-wrap">
      <i class="fas fa-search search-icon"></i>
      <input id="dash-search" type="search" class="search-input"
             placeholder="Search name, mobile, job ID…" value="${esc(S.search)}"
             autocomplete="off" autocorrect="off" spellcheck="false">
    </div>
    <div id="vlist-wrap" class="vlist-wrap" style="flex:1"></div>
  </div>`;
}

// Analytics 30-second cache — only used for chip counts (no separate stats bar)
let _analyticsCache = null;
let _analyticsCacheTs = 0;
function loadAnalytics(force) {
  const now = Date.now();
  if (!force && _analyticsCache && (now - _analyticsCacheTs) < 30000) {
    _applyChipCounts(_analyticsCache);
    return;
  }
  API.get('/api/analytics').then(r => {
    _analyticsCache = r.data;
    _analyticsCacheTs = Date.now();
    _applyChipCounts(r.data);
  }).catch(() => {});
}
function _applyChipCounts(d) {
  // Update counts inside filter chip buttons only (no separate stats tiles)
  const map = {
    'cc-all':         d.total      || 0,
    'cc-under_repair': d.underRepair || 0,
    'cc-repaired':    d.repaired    || 0,
    'cc-returned':    d.returned    || 0,
    'cc-delivered':   d.completed  || 0,
  };
  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = `(${val})`;
  });
}

async function loadJobs() {
  const wrap = document.getElementById('vlist-wrap');
  if (wrap) wrap.innerHTML = `<div class="loader-wrap"><i class="fas fa-spinner fa-spin fa-2x"></i></div>`;
  // Load analytics stats in background — use cache to avoid redundant calls
  loadAnalytics();
  try {
    const params = {};
    if (S.filter)     params.status   = S.filter;
    if (S.search)     params.q        = S.search;
    if (S.fromDate)   params.from     = S.fromDate;
    if (S.toDate)     params.to       = S.toDate;
    if (S.myJobsOnly && !isAdmin()) params.staff_id = S.user?.id;
    const r = await API.get('/api/jobs', { params });
    S.jobs = r.data;
    renderVList();
  } catch {
    if (wrap) wrap.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle fa-2x" style="color:#e53935"></i><p>Error loading jobs</p></div>`;
  }

  // My Assigned Jobs toggle (staff only)
  document.getElementById('btn-my-assigned')?.addEventListener('click', () => {
    S.myJobsOnly = !S.myJobsOnly;
    S.fromDate = ''; S.toDate = ''; setFilter('');
    render();
  }, { passive: true });
  document.getElementById('btn-clear-my')?.addEventListener('click', () => {
    S.myJobsOnly = false; render();
  }, { passive: true });

  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      setFilter(btn.dataset.filter);
      render();
    }, { passive: true });
  });

  const dSearch = debounce(() => {
    S.search = document.getElementById('dash-search')?.value.trim() || '';
    loadJobs();
  }, 300);
  document.getElementById('dash-search')?.addEventListener('input', dSearch);
}

function renderVList() {
  const wrap = document.getElementById('vlist-wrap');
  if (!wrap) return;
  if (!S.jobs.length) {
    wrap.innerHTML = `<div class="empty-state"><i class="fas fa-inbox fa-3x"></i><p>No jobs found</p>${isAdmin() ? '<p class="empty-sub">Tap <b>New Job</b> to create one</p>' : ''}</div>`;
    return;
  }
  const total = S.jobs.length;
  const wrapH = wrap.clientHeight || (window.innerHeight - 200);

  function paint() {
    const scrollTop = wrap.scrollTop;
    const startIdx  = Math.max(0, Math.floor(scrollTop / CARD_H) - 4);
    const endIdx    = Math.min(total - 1, startIdx + Math.ceil(wrapH / CARD_H) + 8);
    const topH      = startIdx * CARD_H;
    const botH      = Math.max(0, (total - endIdx - 1) * CARD_H);
    const visible   = S.jobs.slice(startIdx, endIdx + 1);

    wrap.innerHTML =
      `<div style="height:${topH}px;pointer-events:none"></div>` +
      visible.map(j => jobRowHTML(j)).join('') +
      `<div style="height:${botH}px;pointer-events:none"></div>`;

    wrap.querySelectorAll('.job-row').forEach(row => {
      row.addEventListener('click', () => navigate('detail', { jobId: row.dataset.id }), { passive: true });
    });
  }

  paint();
  // Remove old scroll listener before re-attaching to prevent accumulation
  const newWrap = document.getElementById('vlist-wrap');
  if (newWrap) {
    const onScroll = () => { paint(); requestAnimationFrame(() => applyAuthImages(newWrap)); };
    newWrap._scrollHandler && newWrap.removeEventListener('scroll', newWrap._scrollHandler);
    newWrap._scrollHandler = onScroll;
    newWrap.addEventListener('scroll', onScroll, { passive: true });
  }
  setTimeout(() => applyAuthImages(wrap), 50);
}

function jobRowHTML(j) {
  const color   = sc(j.status);
  const bg      = sb(j.status);
  const balance = Math.max(0, (j.total_charges || 0) - (j.received_amount || 0));
  return `
  <div class="job-row" data-id="${j.id}" style="border-left-color:${color};will-change:transform,opacity">
    <div class="job-row-thumb">
      ${j.thumb
        ? `<img data-auth-src="${j.thumb}" class="thumb-img" loading="lazy" alt="thumb">`
        : `<i class="fas fa-tools" style="color:#bbb;font-size:22px"></i>`}
    </div>
    <div class="job-row-body">
      <div class="job-row-top">
        <span class="job-id">${j.id}</span>
        <span class="status-chip" style="background:${bg};color:${color};border-color:${color}">${sl(j.status)}</span>
      </div>
      <div class="job-name">${esc(j.snap_name)}</div>
      <div class="job-row-foot">
        <span class="job-meta"><i class="fas fa-tools"></i> ${j.machine_count || 0}</span>
        ${isAdmin()
          ? `<span class="job-balance" style="color:${balance>0?'#E53935':'#43A047'}">Bal: ${fmtRs(balance)}</span>`
          : `<span class="job-meta" style="color:#888">${fmtDate(j.created_at)}</span>`}
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
      <div class="form-group">
        <label class="form-label">Customer Name <span class="req">*</span></label>
        <input id="nj-name" type="text" class="form-input" placeholder="Full name" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Address</label>
        <textarea id="nj-address" class="form-input" rows="2" placeholder="Street, area, city"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Internal Note</label>
        <textarea id="nj-note" class="form-input" rows="2" placeholder="Remarks for this job…"></textarea>
      </div>
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Received Amount (₹)</label>
        <input id="nj-received" type="number" class="form-input" placeholder="0" min="0" inputmode="decimal">
      </div>` : ''}
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

      <!-- 5. Repair Amount + Quantity -->
      <div class="form-row-2">
        ${isAdmin() ? `
        <div class="form-group">
          <label class="form-label">Repair Amount (₹)</label>
          <input id="nj-charges" type="number" class="form-input" placeholder="0" min="0" inputmode="decimal">
          <div id="nj-amt-sugs"></div>
        </div>` : ''}
        <div class="form-group">
          <label class="form-label">Quantity</label>
          <input id="nj-qty" type="number" class="form-input" placeholder="1" min="1" value="1" inputmode="numeric">
        </div>
      </div>

      <!-- 6. Assign Staff -->
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
        toast('Customer found — auto-filled ✅', 'success');
        // Auto-focus product name after auto-fill
        setTimeout(() => document.getElementById('nj-product')?.focus(), 150);
      }
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
    const _njChg = isAdmin() ? (parseFloat(document.getElementById('nj-charges')?.value) || 0) : 0;
    if (_njChg > 0) _sugCache.addAmount(_njChg, product);

    const btn = document.getElementById('nj-submit');
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…';
    try {
      const jobR = await API.post('/api/jobs', {
        customer_name:    name,
        customer_mobile:  mobile,
        customer_mobile2: document.getElementById('nj-mobile2')?.value.trim() || null,
        customer_address: document.getElementById('nj-address')?.value.trim() || null,
        note:             document.getElementById('nj-note')?.value.trim()    || null,
        received_amount:  isAdmin() ? (parseFloat(document.getElementById('nj-received')?.value) || 0) : 0,
      });
      const jid = jobR.data.id;
      const machR = await API.post(`/api/jobs/${jid}/machines`, {
        product_name:      product,
        product_complaint: document.getElementById('nj-complaint')?.value.trim() || null,
        charges:           isAdmin() ? (parseFloat(document.getElementById('nj-charges')?.value) || 0) : 0,
        quantity:          parseInt(document.getElementById('nj-qty')?.value) || 1,
        assigned_staff_id: isAdmin() ? (document.getElementById('nj-staff')?.value || null) : null,
      });

      // Upload image + audio in background (non-blocking)
      const machId = machR.data.id;
      const imgFile = document.getElementById('nj-img')?.files[0];
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
      if (_njAudioBlob && machId) {
        uploads.push((async () => {
          try {
            const ext  = _njAudioMime.includes('ogg') ? '.ogg' : '.webm';
            const file = new File([_njAudioBlob], `voice_note${ext}`, { type: _njAudioMime });
            const fd   = new FormData(); fd.append('audio', file);
            await API.post(`/api/machines/${machId}/audio`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
          } catch (_) { toast('Audio upload failed (job still created)', 'error'); }
        })());
      }
      if (uploads.length) {
        toast('Uploading media…', 'info');
        await Promise.allSettled(uploads);
      }

      toast(`✅ Job ${jid} created!`, 'success');
      S.jobId = jid;
      navigate('detail');
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
  try {
    const r = await API.get(`/api/jobs/${S.jobId}`);
    S.job   = r.data;
    if (isAdmin() && !S.staff.length) {
      try { const sr = await API.get('/api/staff'); S.staff = sr.data; } catch (_) {}
    }
    renderDetail();
  } catch {
    const root = document.getElementById('detail-root');
    if (root) root.innerHTML = `<div class="empty-state" style="color:#e53935"><i class="fas fa-exclamation-triangle fa-2x"></i><p>Failed to load job</p></div>`;
  }
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
  const received = j.received_amount || 0;
  const balance  = Math.max(0, total - received);
  const userId   = S.user?.id;

  root.innerHTML = `
    <!-- Status Banner -->
    <div class="detail-banner" style="background:${color}">
      <span class="detail-job-id">${j.id}</span>
      <span class="detail-status-label">${sl(j.status)}</span>
    </div>

    <!-- Customer Card -->
    <div class="card mt-3">
      <div class="info-row">
        <i class="fas fa-user info-icon" style="color:${color}"></i>
        <span class="info-val fw-bold">${esc(j.snap_name)}</span>
      </div>
      ${isAdmin() ? `
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
      ${isAdmin() && j.snap_mobile ? `
      <div class="info-row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <button id="btn-cust-history" class="btn-sm" style="background:#7B1FA2;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer">
          <i class="fas fa-history"></i> Customer History
        </button>
        <button id="btn-wa-reminder" class="btn-sm" style="background:#25D366;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer">
          <i class="fab fa-whatsapp"></i> Send Reminder
        </button>
      </div>` : ''}
    </div>

    <!-- Financial Panel
         Admin: Total + Received + Balance + edit received amount
         Staff: HIDDEN — no financial data visible -->
    ${isAdmin() ? `
    <div class="card mt-3 financial-panel">
      <div class="fin-title"><i class="fas fa-rupee-sign"></i> Financials</div>
        <div class="fin-row">
          <span class="fin-label fw-bold">= Total Amount</span>
          <span class="fin-amount fw-bold">${fmtRs(total)}</span>
        </div>
        <div class="fin-row">
          <span class="fin-label">Received Amount</span>
          <span class="fin-amount" style="color:#43A047">${fmtRs(received)}</span>
        </div>
      <div class="fin-row fin-balance">
        <span class="fin-label fw-bold">Balance Due</span>
        <span class="fin-amount fw-bold" style="color:${balance>0?'#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
      ${true ? `
      <div class="fin-edit-row">
        <label class="form-label" style="margin:0">Update Received Amount (₹)</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input id="recv-input" type="number" class="form-input" style="flex:1"
                 value="${received}" min="0" placeholder="0" inputmode="decimal">
          <button id="recv-save" class="btn-sm btn-green">Save</button>
        </div>
      </div>` : ''}
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

    <!-- Action Buttons — RBAC: admin-only download/share/deliver/delete -->
    <div class="action-row mt-3">
      ${isAdmin() ? `
      <button id="btn-deliver" class="action-btn" style="background:#1E88E5">
        <i class="fas fa-check-double"></i><span>Deliver</span>
      </button>` : ''}
      ${isAdmin() ? `
      <button id="btn-jobcard" class="action-btn" style="background:#43A047">
        <i class="fas fa-file-image"></i><span>Download</span>
      </button>
      <button id="btn-share" class="action-btn" style="background:#25D366">
        <i class="fab fa-whatsapp"></i><span>${j.status==='delivered'?'Share':'Share'}</span>
      </button>
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
        </h3>
        <button id="btn-add-machine" class="btn-sm btn-red">+ Add</button>
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
  const isAssigned = isAdmin() || (m.assigned_staff_id === currentUserId);
  const staffNotAssigned = !isAdmin() && m.assigned_staff_id !== currentUserId;
  // Normalize audio URL: old records stored /api/images/audio/..., new ones /api/audio/...
  const audioUrl = m.audio_note_url
    ? m.audio_note_url.replace('/api/images/audio/', '/api/audio/')
    : null;

  return `
  <div class="machine-card" style="border-left-color:${color};will-change:transform,opacity">
    <div class="machine-top">
      <div style="flex:1;min-width:0">
        <div class="machine-name">${esc(m.product_name)}${m.quantity>1?` <span class="machine-qty">×${m.quantity}</span>`:''}</div>
        ${m.product_complaint ? `<div class="machine-complaint">${esc(m.product_complaint)}</div>` : ''}
        ${m.work_done ? `<div class="machine-complaint" style="color:#2E7D32">✅ Work done: ${esc(m.work_done)}</div>` : ''}
        ${m.return_reason ? `<div class="machine-complaint" style="color:#E65100">↩ Returned: ${esc(m.return_reason)}</div>` : ''}
        ${m.staff_name ? `<div class="machine-staff"><i class="fas fa-user-cog"></i> ${esc(m.staff_name)}</div>` : ''}
      </div>
      <div class="machine-right">
        ${isAdmin() ? `<div class="machine-charges">${fmtRs(m.charges)}</div>` : ''}
        ${isAssigned ? `
        <select data-mid="${m.id}" class="status-sel" style="border-color:${color};color:${color}">
          <option value="under_repair" ${m.status==='under_repair'?'selected':''}>Under Repair</option>
          <option value="repaired"     ${m.status==='repaired'    ?'selected':''}>Repaired</option>
          <option value="returned"     ${m.status==='returned'    ?'selected':''}>Returned</option>
        </select>` : `
        <span class="status-chip" style="background:${sb(m.status)};color:${color};border:1px solid ${color}">${sl(m.status)}</span>`}
      </div>
    </div>

    <!-- Images row with embedded camera upload -->
    <div class="images-row">
      ${(m.images||[]).map(img => `
      <div class="img-wrap" onclick="openImageViewer('${img.url}')" style="cursor:pointer">
        <img data-auth-src="${img.url}" class="img-thumb" loading="lazy" alt="">
        ${isAdmin() ? `<button class="img-del-btn" data-iid="${img.id}" title="Remove" onclick="event.stopPropagation()">×</button>` : ''}
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
        ${isAdmin() ? `<button data-mid="${m.id}" class="btn-sm btn-red btn-del-audio" title="Delete"><i class="fas fa-trash"></i></button>` : ''}
      </div>` : `
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-rec-audio">
        <i class="fas fa-microphone"></i> Voice Note
      </button>`}
    </div>

    ${isAdmin() ? `
    <div class="machine-actions">
      <button data-mid="${m.id}" class="btn-sm btn-orange btn-edit-m">
        <i class="fas fa-edit"></i> Edit
      </button>
      <button data-mid="${m.id}" class="btn-sm btn-red btn-del-m">
        <i class="fas fa-trash"></i>
      </button>
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

  // Update received amount (admin only)
  document.getElementById('recv-save')?.addEventListener('click', async () => {
    const val = parseFloat(document.getElementById('recv-input')?.value) || 0;
    try {
      await API.put(`/api/jobs/${j.id}`, { received_amount: val });
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

  // Customer History (admin only)
  document.getElementById('btn-cust-history')?.addEventListener('click', () => showCustomerHistory(j.snap_mobile, j.snap_name));

  // WhatsApp Reminder (admin only)
  document.getElementById('btn-wa-reminder')?.addEventListener('click', () => {
    const phone   = (j.snap_mobile || '').replace(/\D/g, '');
    const waPhone = phone.startsWith('91') ? phone : (phone ? '91' + phone : '');
    const balance = Math.max(0, (j.total_charges||0) - (j.received_amount||0));
    const products = (j.machines||[]).map(m => `• ${m.product_name}${m.quantity>1?' ×'+m.quantity:''}`).join('\n') || '• Your device';
    const reminderMsg = `Hello ${j.snap_name || 'Valued Customer'},

⚠️ *Reminder* — Your job *#${j.id}* is ready and awaiting collection.

*Products:*
${products}
${balance > 0 ? `\n*Amount Due: ₹${balance}*\nPlease complete payment to proceed with delivery.\n` : ''}
Kindly collect within *25 days* from repair date to avoid liability.

— *ADITION ELECTRIC SOLUTION*`;
    const text    = encodeURIComponent(reminderMsg);
    const url     = waPhone ? `https://wa.me/${waPhone}?text=${text}` : `https://wa.me/?text=${text}`;
    if (waPhone) {
      window.location.href = `whatsapp://send?phone=${waPhone}&text=${text}`;
      setTimeout(() => { try { window.open(url, '_blank'); } catch(_){} }, 1800);
    } else {
      window.open(url, '_blank');
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
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost" style="margin-left:auto">Close</button>
    </div>`);

  try {
    const r = await API.get(`/api/jobs/${j.id}/history`);
    const events = r.data || [];
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
      'Job Created':     { icon: 'fa-plus-circle',   color: '#43A047' },
      'Machine Added':   { icon: 'fa-tools',          color: '#1E88E5' },
      'Status: delivered': { icon: 'fa-check-double', color: '#1E88E5' },
      'Payment Updated': { icon: 'fa-rupee-sign',     color: '#FB8C00' },
    };
    function getIcon(action) {
      if (action.startsWith('Machine:')) return { icon: 'fa-cog', color: '#9C27B0' };
      if (action.startsWith('Status:'))  return { icon: 'fa-exchange-alt', color: '#E53935' };
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
              <span style="font-size:11px;color:#999">${fmtDate(ev.created_at)}</span>
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
  } catch (_) {
    const el = document.getElementById('jh-list');
    if (el) el.innerHTML = `<p style="text-align:center;padding:16px;color:#888">Failed to load history</p>`;
  }
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

    <!-- 5. Repair Amount -->
    <div class="form-row-2">
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Repair Amount (₹)</label>
        <input id="am-chg" type="number" class="form-input" min="0" placeholder="0" inputmode="decimal">
        <div id="am-amt-sugs">${suggestionTilesHTML(amtSugs.map(a => '₹' + a), 'am-chg', 'amt-sugs')}</div>
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">Qty</label>
        <input id="am-qty" type="number" class="form-input" min="1" value="1" inputmode="numeric">
      </div>
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
    <div class="form-row-2">
      ${isAdmin() ? `
      <div class="form-group">
        <label class="form-label">Repair Amount (₹)</label>
        <input id="em-chg" type="number" class="form-input" min="0"
               value="${m.charges||0}" inputmode="decimal">
      </div>` : ''}
      <div class="form-group">
        <label class="form-label">Qty</label>
        <input id="em-qty" type="number" class="form-input" min="1"
               value="${m.quantity||1}" inputmode="numeric">
      </div>
    </div>
    ${isAdmin() ? `
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

  document.getElementById('em-save')?.addEventListener('click', async () => {
    const prod = document.getElementById('em-prod')?.value.trim();
    if (!prod) { toast('Product name required', 'error'); return; }
    try {
      await API.put(`/api/machines/${m.id}`, {
        product_name:      prod,
        product_complaint: document.getElementById('em-comp')?.value.trim() || null,
        ...(isAdmin() ? { charges: parseFloat(document.getElementById('em-chg')?.value) || 0 } : {}),
        quantity:          parseInt(document.getElementById('em-qty')?.value) || 1,
        ...(isAdmin() ? { assigned_staff_id: document.getElementById('em-staff')?.value || null } : {}),
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
      <label class="form-label">Receiver Name <span class="req">*</span></label>
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
    ${isAdmin() ? `
    <div class="form-group">
      <label class="form-label">Final Received Amount (₹)</label>
      <input id="dm-recv" type="number" class="form-input" value="${j.received_amount||0}"
             min="0" inputmode="decimal">
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
    const rname = document.getElementById('dm-rname')?.value.trim();
    if (!rname) { toast('Receiver name required', 'error'); return; }
    try {
      await API.put(`/api/jobs/${j.id}`, {
        status:                   'delivered',
        delivery_receiver_name:   rname,
        delivery_receiver_mobile: document.getElementById('dm-rmob')?.value.trim() || null,
        delivery_method:          document.getElementById('dm-method')?.value || 'in_person',
        delivery_courier_name:    document.getElementById('dm-courier')?.value || null,
        delivery_tracking:        document.getElementById('dm-track')?.value   || null,
        delivery_address:         document.getElementById('dm-addr')?.value    || null,
        ...(isAdmin() ? { received_amount: parseFloat(document.getElementById('dm-recv')?.value) || 0 } : {}),
      });
      closeModal(); toast('Job marked as delivered ✅', 'success'); await loadDetail();
    } catch (_) { toast('Failed to update', 'error'); }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB CARD PRINT HTML  — Dynamic height, ALL products, no overflow truncation
// Multi-page: generateAndShareJobCard slices long cards into 1080×1920 pages
// ─────────────────────────────────────────────────────────────────────────────
function jobCardPrintHTML(j) {
  const total      = j.total_charges   || 0;
  const received   = j.received_amount || 0;
  const balance    = Math.max(0, total - received);
  const color      = sc(j.status);
  const isDelivered = j.status === 'delivered';
  const isRepaired  = j.status === 'repaired';
  const showPayment = balance > 0 && !isDelivered;

  const deliveryBlock = isDelivered ? `
    <div style="margin:0 30px 14px;background:#E3F2FD;border:2px solid #1E88E5;border-radius:12px;padding:14px 16px">
      <div style="font-size:18px;font-weight:800;color:#1565C0;margin-bottom:8px">📦 Delivery Information</div>
      <table style="width:100%;border-collapse:collapse;font-size:16px">
        ${j.delivery_receiver_name   ? `<tr><td style="color:#555;padding:3px 0;width:160px">Received By</td><td style="font-weight:700;color:#1a1a2e">${esc(j.delivery_receiver_name)}</td></tr>` : ''}
        ${j.delivery_receiver_mobile ? `<tr><td style="color:#555;padding:3px 0">Mobile</td><td style="font-weight:700;color:#1565C0">${j.delivery_receiver_mobile}</td></tr>` : ''}
        ${j.delivery_method          ? `<tr><td style="color:#555;padding:3px 0">Method</td><td style="font-weight:700">${j.delivery_method==='courier'?'Courier':'In Person'}</td></tr>` : ''}
        ${j.delivery_courier_name    ? `<tr><td style="color:#555;padding:3px 0">Courier</td><td style="font-weight:700">${esc(j.delivery_courier_name)}</td></tr>` : ''}
        ${j.delivery_tracking        ? `<tr><td style="color:#555;padding:3px 0">Tracking</td><td style="font-weight:700">${esc(j.delivery_tracking)}</td></tr>` : ''}
        ${j.delivered_at             ? `<tr><td style="color:#555;padding:3px 0">Date</td><td style="font-weight:700">${fmtDate(j.delivered_at)}</td></tr>` : ''}
      </table>
    </div>` : `
    <div style="margin:0 30px 14px;background:#fff8e1;border:2px solid #FFC107;border-radius:12px;padding:14px 16px">
      <div style="font-size:17px;font-weight:800;color:#e65100;margin-bottom:6px">⚠️ Collection Notice</div>
      <div style="font-size:15px;color:#5D4037;line-height:1.5">
        Kindly collect your machine(s) within <strong>25 days</strong> from the date of this notice.
        After this period, we shall <strong>not be held liable</strong> for any claims, loss, or damage to uncollected items.
      </div>
    </div>`;

  const paymentBlock = showPayment ? `
    <div style="margin:0 30px 14px;background:#E8F5E9;border:2px solid #43A047;border-radius:12px;padding:16px">
      <div style="font-size:18px;font-weight:900;color:#2E7D32;margin-bottom:10px;text-align:center">💳 Complete Payment to Proceed</div>
      <div style="display:flex;gap:16px;align-items:flex-start">
        <div style="text-align:center;flex-shrink:0">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=upi%3A%2F%2Fpay%3Fpa%3D9375940444%40okbizaxis%26pn%3DADITION%2BELECTRIC%2BSOLUTION%26am%3D${balance}%26cu%3DINR" style="width:150px;height:150px;border-radius:8px;border:2px solid #43A047" crossorigin="anonymous" onerror="this.style.display='none'">
          <div style="font-size:13px;color:#555;margin-top:4px">Scan to Pay ₹${balance}</div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:16px;font-weight:800;color:#1a1a2e;margin-bottom:8px">UPI / Bank Details</div>
          <table style="border-collapse:collapse;font-size:14px;width:100%">
            <tr><td style="color:#555;padding:3px 0;width:80px">UPI</td><td style="font-weight:700">9375940444@okbizaxis</td></tr>
            <tr><td style="color:#555;padding:3px 0">Phone</td><td style="font-weight:700;color:#1565C0">7801990001</td></tr>
            <tr><td colspan="2" style="padding:4px 0"><hr style="border:1px solid #ccc"></td></tr>
            <tr><td style="color:#555;padding:3px 0">Bank</td><td style="font-weight:700">State Bank Of India</td></tr>
            <tr><td style="color:#555;padding:3px 0">A/C No.</td><td style="font-weight:700">37321811864</td></tr>
            <tr><td style="color:#555;padding:3px 0">IFSC</td><td style="font-weight:700">SBIN0001353</td></tr>
          </table>
        </div>
      </div>
    </div>` : '';

  // Compact header
  const headerBlock = `
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#0f3460 100%);padding:24px 30px 18px;text-align:center">
      <div style="width:56px;height:56px;background:linear-gradient(135deg,#E53935,#B71C1C);border-radius:14px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-size:32px">⚡</div>
      <div style="color:#fff;font-size:28px;font-weight:900;letter-spacing:2px">ADITION ELECTRIC SOLUTION</div>
      <div style="color:rgba(255,255,255,.6);font-size:14px;margin-top:3px;letter-spacing:1px">SERVICE MANAGEMENT SYSTEM</div>
    </div>
    <div style="background:${color};padding:12px 30px;display:flex;justify-content:space-between;align-items:center">
      <div style="color:#fff;font-size:36px;font-weight:900;letter-spacing:3px">${j.id}</div>
      <div style="color:#fff;font-size:18px;font-weight:700;background:rgba(0,0,0,.2);padding:5px 14px;border-radius:8px">${sl(j.status)}</div>
    </div>`;

  // Machines — compact cards with images and individual prices
  const machinesBlock = `
    <div style="padding:10px 30px 0">
      <div style="font-size:13px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">Products (${(j.machines||[]).length})</div>
      ${(j.machines||[]).map((m,i) => {
        const firstImg = (m.images||[])[0];
        return `
      <div style="background:#f8f9fa;border-radius:10px;padding:10px 12px;margin-bottom:8px;border-left:4px solid ${sc(m.status)};display:flex;align-items:flex-start;gap:10px">
        ${firstImg
          ? `<img src="${firstImg.url}" data-auth-src="${firstImg.url}" style="width:70px;height:70px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
          : `<div style="width:70px;height:70px;border-radius:6px;background:#e8eaed;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:26px;color:#bbb">⚡</div>`}
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px">
            <div style="font-size:18px;font-weight:800;color:#1a1a2e">${i+1}. ${esc(m.product_name)}${m.quantity>1?` <span style="color:#888;font-weight:600">×${m.quantity}</span>`:''}</div>
            <div style="background:${sc(m.status)};color:#fff;border-radius:5px;padding:2px 8px;font-size:12px;font-weight:700;white-space:nowrap">${sl(m.status)}</div>
          </div>
          ${m.product_complaint ? `<div style="font-size:13px;color:#666;margin-top:2px">${esc(m.product_complaint)}</div>` : ''}
          ${m.work_done ? `<div style="font-size:12px;color:#2E7D32;margin-top:2px">✅ ${esc(m.work_done)}</div>` : ''}
          <div style="margin-top:4px;font-size:16px;font-weight:700;color:#1a1a2e">₹${((m.charges||0)*1).toLocaleString('en-IN')}${m.quantity>1?` <span style="color:#888;font-size:13px">(×${m.quantity} = ${fmtRs((m.charges||0)*m.quantity)})</span>`:''}</div>
        </div>
      </div>`;
      }).join('')}
    </div>`;

  const financialBlock = `
    <div style="margin:10px 30px;background:#f8f9fa;border-radius:12px;padding:14px 18px">
      <div style="display:flex;justify-content:space-between;font-size:18px;padding:5px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555;font-weight:600">Total Amount</span><span style="font-weight:800;color:#1a1a2e">${fmtRs(total)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:18px;padding:5px 0;border-bottom:1px solid #e0e0e0">
        <span style="color:#555;font-weight:600">Amount Received</span><span style="font-weight:800;color:#43A047">${fmtRs(received)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:22px;padding:7px 0">
        <span style="font-weight:700;color:#1a1a2e">Amount Due</span>
        <span style="font-weight:900;color:${balance>0?'#E53935':'#43A047'}">${fmtRs(balance)}</span>
      </div>
    </div>`;

  const noteBlock = j.note ? `<div style="margin:0 30px 8px;background:#fffde7;border-radius:8px;padding:10px 14px;font-size:15px;color:#795548"><b>Note:</b> ${esc(j.note)}</div>` : '';

  const footerBlock = `
    <div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);padding:18px 30px;margin-top:auto">
      <div style="color:#fff;font-size:16px;font-weight:700">✨ adition™ since 1984</div>
      <div style="color:rgba(255,255,255,.6);font-size:13px;margin-top:3px">Opp. Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001</div>
      <div style="color:rgba(255,255,255,.35);font-size:11px;margin-top:2px">Subjected to Ahmedabad Jurisdiction only</div>
    </div>`;

  // Customer info — 2-column: Name/Mobile left, Address/Date right — compact, mobile-optimized
  const custBlock = `
    <div style="padding:14px 30px 8px">
      <div style="font-size:13px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">Customer Details</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px">
        <div>
          <div style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Name</div>
          <div style="font-size:20px;font-weight:800;color:#1a1a2e;line-height:1.2">${esc(j.snap_name)}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Mobile</div>
          <div style="font-size:18px;font-weight:700;color:#1565C0">${j.snap_mobile}${j.snap_mobile2?'<br><span style="font-size:14px">'+j.snap_mobile2+'</span>':''}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Address</div>
          <div style="font-size:14px;color:#333;line-height:1.3">${j.snap_address ? esc(j.snap_address) : '<span style="color:#bbb">—</span>'}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#999;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Date</div>
          <div style="font-size:15px;color:#555;font-weight:600">${fmtDate(j.created_at)}</div>
        </div>
      </div>
    </div>
    <div style="border-top:2px solid #f0f0f0;margin:0 30px 4px"></div>`;

  // Compact layout — 1080px wide, minimal padding, fits more products per page
  return `
  <div style="width:1080px;background:#fff;font-family:'Segoe UI',Arial,sans-serif;display:flex;flex-direction:column">
    ${headerBlock}
    ${custBlock}
    ${machinesBlock}
    ${financialBlock}
    ${noteBlock}
    ${paymentBlock}
    ${deliveryBlock}
    ${footerBlock}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE + SHARE JOB CARD  (html2canvas — multi-page slice for long cards)
// ─────────────────────────────────────────────────────────────────────────────
async function generateAndShareJobCard(j, shareMode) {
  toast('Generating job card…', 'info');
  try {
    const el = document.getElementById('job-card-print');
    if (!el) { toast('Card element missing', 'error'); return; }

    // Temporarily make print element visible to measure actual height
    el.style.left = '-99999px'; el.style.top = '0';

    // Pre-load ALL authenticated images as blob URLs so html2canvas can paint them
    const blobUrls = [];
    const imgEls = Array.from(el.querySelectorAll('img'));
    // Fetch all images in parallel, wait for ALL to complete
    const imgResults = await Promise.allSettled(imgEls.map(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-auth-src') || '';
      if (!src) return Promise.resolve();
      if (src.startsWith('blob:') || src.startsWith('data:')) { img.crossOrigin = 'anonymous'; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        fetch(src, { headers: { Authorization: `Bearer ${S.token}` } })
          .then(r => r.ok ? r.blob() : Promise.reject('fetch failed'))
          .then(b => {
            const bu = URL.createObjectURL(b);
            blobUrls.push(bu);
            img.src = bu;
            img.crossOrigin = 'anonymous';
            // Wait for image to actually decode/load in DOM
            return img.decode ? img.decode().then(resolve).catch(resolve) : resolve();
          })
          .catch(() => {
            img.crossOrigin = 'anonymous';
            resolve(); // Don't block on failed images
          });
      });
    }));

    // Verify all images are actually loaded before canvas capture
    await Promise.allSettled(imgEls.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        img.onload = resolve;
        img.onerror = resolve;
        setTimeout(resolve, 3000); // Max 3s wait per image
      });
    }));

    // Extra paint delay for browser rendering
    await new Promise(r => setTimeout(r, 500));

    const actualH = el.scrollHeight || el.offsetHeight || 1440;
    const PAGE_W  = 1080;  // output page width
    const PAGE_H  = 1440;  // output page height (3:4 ratio, optimized for WhatsApp)
    const SCALE   = 3;     // 3× resolution for crisp high-DPI

    // Capture full long canvas at 3× scale for high DPI, sharp text
    const fullCanvas = await html2canvas(el, {
      scale: SCALE,
      useCORS: true,
      allowTaint: false,
      width: PAGE_W,
      height: actualH,
      backgroundColor: '#ffffff',
      logging: false,
      imageTimeout: 30000,
      letterRendering: true,
    });

    // Revoke blob URLs after capture
    blobUrls.forEach(u => URL.revokeObjectURL(u));

    // Slice into 1080×1440 page canvases (3× scale for sharp output)
    const pageH_scaled = PAGE_H * SCALE;  // 4320
    const pageW_scaled = PAGE_W * SCALE;  // 3240
    const totalPages   = Math.ceil(fullCanvas.height / pageH_scaled);
    const pageBlobs    = [];

    for (let p = 0; p < totalPages; p++) {
      const srcY   = p * pageH_scaled;
      const srcH   = Math.min(pageH_scaled, fullCanvas.height - srcY);
      const pc     = document.createElement('canvas');
      pc.width     = pageW_scaled;
      pc.height    = pageH_scaled;
      const ctx    = pc.getContext('2d');
      // Enable high-quality image rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pc.width, pc.height);
      ctx.drawImage(fullCanvas, 0, srcY, pageW_scaled, srcH, 0, 0, pageW_scaled, srcH);
      await new Promise(res => pc.toBlob(b => { pageBlobs.push(b); res(); }, 'image/jpeg', 0.95));
    }

    const text     = shareText(j, totalPages > 1);
    const phone    = (j.snap_mobile || '').replace(/\D/g, '');
    const waPhone  = phone.startsWith('91') ? phone : (phone ? '91' + phone : '');
    const waText   = encodeURIComponent(text);
    const waUrl    = waPhone ? `https://wa.me/${waPhone}?text=${waText}` : `https://wa.me/?text=${waText}`;

    // ── Auto-download to Phone Storage/Pictures/JobCard as Job_[JobNumber].jpg ──
    const jobFileName = `Job_${j.id}.jpg`;
    for (let i = 0; i < pageBlobs.length; i++) {
      const bUrl = URL.createObjectURL(pageBlobs[i]);
      const a    = document.createElement('a');
      a.href = bUrl;
      a.download = totalPages > 1 ? `Job_${j.id}_p${i+1}.jpg` : jobFileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      await new Promise(r => setTimeout(r, 400));
      URL.revokeObjectURL(bUrl);
    }
    toast(`📸 ${jobFileName} saved to Downloads`, 'success');

    if (shareMode) {
      // ── WhatsApp share flow ─────────────────────────────────────────────────
      const files = pageBlobs.map((b, i) =>
        new File([b], totalPages > 1 ? `Job_${j.id}_p${i+1}.jpg` : jobFileName, { type: 'image/jpeg' })
      );

      // 1st try: Web Share API with file(s) — Android Chrome / modern WebView
      if (navigator.share && navigator.canShare?.({ files })) {
        try { await navigator.share({ files, title: `Job ${j.id}`, text }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }

      // 2nd: Open WhatsApp Business directly to customer chat via wa.me
      setTimeout(() => {
        if (waPhone) {
          // Try whatsapp:// deep link first (works in PWA/WebView)
          window.location.href = `whatsapp://send?phone=${waPhone}&text=${waText}`;
          // Fallback: wa.me link after 1.8s if deep link didn't work
          setTimeout(() => { try { window.open(waUrl, '_blank'); } catch(_){} }, 1800);
        } else {
          window.open(waUrl, '_blank');
        }
      }, 600);

      toast(`📸 ${jobFileName} saved — opening WhatsApp…`, 'success');
      return;
    }

    // Download-only mode — already downloaded above
    toast(`📸 Job card downloaded (${pageBlobs.length} page${pageBlobs.length > 1 ? 's' : ''})`, 'success');
  } catch (e) {
    console.error(e);
    toast('Failed to generate card', 'error');
  }
}

function shareText(j, multiPage) {
  const custName    = j.snap_name || 'Valued Customer';
  const balance     = Math.max(0, (j.total_charges||0) - (j.received_amount||0));
  const isRepaired  = j.status === 'repaired';
  const isDelivered = j.status === 'delivered';
  const total       = j.total_charges || 0;
  const received    = j.received_amount || 0;

  // Build itemized product list with individual prices
  const products = (j.machines||[]).map(m => {
    const price    = parseFloat(m.charges) || 0;
    const qty      = m.quantity || 1;
    const lineAmt  = price * qty;
    const priceStr = price > 0 ? ` — ₹${lineAmt.toLocaleString('en-IN')}${qty>1?' (×'+qty+')':''}` : '';
    return `• ${m.product_name}${qty>1?' ×'+qty:''}${priceStr}`;
  }).join('\n') || '• Your device';

  if (isRepaired && balance > 0) {
    return `🔧 *ADITION ELECTRIC SOLUTION* 🔧
—————————————————

Hello *${custName}*,

Your repair job *#${j.id}* is ready for collection! 🎉

📋 *Products Repaired:*
${products}

💰 *Payment Summary:*
Total Repair Amount: ₹${total.toLocaleString('en-IN')}
Amount Received: ₹${received.toLocaleString('en-IN')}
⚠️ *Amount Due: ₹${balance.toLocaleString('en-IN')}*

To receive your device, kindly complete the payment.
Payment details (UPI / Bank) are shown in the job card image.

✅ *Approval:* By collecting the device, you confirm that the repair work has been completed to your satisfaction and you approve the charges mentioned above.

⚠️ *Important:* Please collect your device within *25 days* from this notice. After this period, we shall not be held liable for any claims, loss, or damage.

📞 *Contact:* 7801990001
📍 Opp. Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001

— *ADITION ELECTRIC SOLUTION* ✨
_Since 1984_`;
  }

  if (isDelivered) {
    return `🔧 *ADITION ELECTRIC SOLUTION* 🔧
—————————————————

Hello *${custName}*,

Your job *#${j.id}* has been successfully delivered! ✅

📋 *Products:*
${products}

✅ *Approval:* Delivery confirmed. Thank you for approving the completed repair work.

Thank you for trusting us with your repair needs! 🙏

📞 *Contact:* 7801990001
📍 Opp. Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001

— *ADITION ELECTRIC SOLUTION* ✨
_Since 1984_`;
  }

  // Under repair / just created — job creation message with exact format
  return `🔧 *ADITION ELECTRIC SOLUTION* 🔧
—————————————————

Hello *${custName}*,

Your job has been successfully registered! ✅

🆔 *Job Number:* ${j.id}
📅 *Date:* ${fmtDate(j.created_at)}

📋 *Products Registered:*
${products}
${total > 0 ? `\n💰 *Estimated Repair Amount:* ₹${total.toLocaleString('en-IN')}` : ''}
${received > 0 ? `\n✅ *Advance Received:* ₹${received.toLocaleString('en-IN')}` : ''}
${balance > 0 ? `\n⚠️ *Balance Due:* ₹${balance.toLocaleString('en-IN')}` : ''}

✅ *Approval:* By handing over the device for repair, you approve the estimated charges and agree to the terms of service.

We will notify you once the repair is complete. 🔔

⚠️ *Important:* Please collect your device within *25 days* from the date of notification. After this period, we shall not be held liable for any claims, loss, or damage to uncollected items.

📞 *Contact:* 7801990001
📍 Opp. Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001

— *ADITION ELECTRIC SOLUTION* ✨
_Since 1984_`;
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
      <div class="staff-name">${esc(s.name)} <span class="role-badge ${s.role==='admin'?'role-admin':'role-staff'}">${s.role}</span></div>
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
        <option value="staff">Staff</option>
        <option value="admin">Admin</option>
      </select>
    </div>
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="as-save" class="btn-primary">Add</button>
    </div>`);
  document.getElementById('as-save')?.addEventListener('click', async () => {
    const name  = document.getElementById('as-name')?.value.trim();
    const email = document.getElementById('as-email')?.value.trim();
    const pass  = document.getElementById('as-pass')?.value;
    if (!name || !email || !pass) { toast('All fields required', 'error'); return; }
    try {
      await API.post('/api/staff', { name, email, password: pass, role: document.getElementById('as-role')?.value || 'staff' });
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
          <option value="staff" ${s.role==='staff'?'selected':''}>Staff</option>
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
    <div class="modal-footer">
      <button onclick="closeModal()" class="btn-ghost">Cancel</button>
      <button id="es-save" class="btn-primary">Save Changes</button>
    </div>`);
  document.getElementById('es-save')?.addEventListener('click', async () => {
    const body = {
      name:   document.getElementById('es-name')?.value.trim(),
      email:  document.getElementById('es-email')?.value.trim(),
      role:   document.getElementById('es-role')?.value,
      active: parseInt(document.getElementById('es-active')?.value),
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
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function settingsHTML() {
  return `
  <div class="view-pad">
    <div class="card" style="margin-bottom:12px">
      <div class="section-title"><i class="fas fa-user"></i> Logged In As</div>
      <div style="font-size:16px;font-weight:700">${esc(S.user?.name||'')}</div>
      <div style="font-size:13px;color:#888;margin-top:2px">${esc(S.user?.email||'')} · ${S.user?.role||''}</div>
    </div>
    ${isAdmin() ? `
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
      ✨ adition™ since 1984 · v18.0<br>
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
    if (!confirm('⚠️ FULL RESET: Delete ALL jobs, machines, images and reset counter to C-001?\n\nThis CANNOT be undone!')) return;
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
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}

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
