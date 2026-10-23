/* =========================================================================
   DUIT TRACKER — Personal Finance Tracker
   Pure vanilla JS + IndexedDB + Canvas image processing + jsPDF
   ========================================================================= */

// ---------- Constants ----------
// Month names in the selected language (see LOCALE in i18n.js).
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(LOCALE, { month: 'long' }));

// ---------- State ----------
let db = null;
let accounts = [];       // {id, name, initialBalance, createdAt}
let transactions = [];   // {id, accountId, type, category, note, amount, datetime, receipts:[dataURL,...]}
let recurring = [];      // {id, accountId, type, amount, note, frequency, time, dayOfMonth, dayOfWeek, nextRun (ISO date)}
let categories = [];     // {id, name, icon, type: 'expense'|'income'}
let categoryBudgets = [];// {id, accountId, categoryId, limit} — per-account, per-category monthly limits
let goals = [];          // {id, name, target, saved, deadline (YYYY-MM-DD or ''), createdAt}
// Transactions may also carry: transferId (both legs of a transfer share
// it), recurringId (generated from a recurring rule), importBatch (CSV import).
// The app always focuses on exactly one account at a time — there is no
// combined "all accounts" view anywhere (Home, Reports, or Add Transaction).
// null means no account exists yet / none is selected.
let currentAccountFilter = null;
let pendingReceipts = []; // dataURLs staged in the Add Record form

// Keeps currentAccountFilter pointing at a real account. Called after any
// operation that can add/remove accounts (initial load, create, delete) so
// every view always has a single valid account to focus on.
function ensureAccountSelection() {
  const stillExists = accounts.some(a => a.id === currentAccountFilter);
  if (!stillExists) {
    currentAccountFilter = accounts.length > 0 ? accounts[0].id : null;
  }
}

// ---------- IndexedDB helpers ----------
function openDB(){
  return new Promise((resolve, reject) => {
    // Version bumped 4 -> 5 to add the 'goals' store. IndexedDB fires
    // onupgradeneeded automatically for anyone on an older version, and
    // existing data is untouched — only missing stores get created.
    const req = indexedDB.open('DuitKuDB', 5);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('accounts')) {
        d.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('transactions')) {
        const ts = d.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
        ts.createIndex('accountId', 'accountId', { unique: false });
      }
      if (!d.objectStoreNames.contains('recurring')) {
        const rs = d.createObjectStore('recurring', { keyPath: 'id', autoIncrement: true });
        rs.createIndex('accountId', 'accountId', { unique: false });
      }
      if (!d.objectStoreNames.contains('categories')) {
        const cs = d.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
        cs.createIndex('type', 'type', { unique: false });
      }
      if (!d.objectStoreNames.contains('categoryBudgets')) {
        const cbs = d.createObjectStore('categoryBudgets', { keyPath: 'id', autoIncrement: true });
        cbs.createIndex('accountId', 'accountId', { unique: false });
      }
      if (!d.objectStoreNames.contains('goals')) {
        d.createObjectStore('goals', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e);
  });
}

function tx(storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function idbAdd(storeName, obj) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').add(obj);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}

function idbPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(obj);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}

function idbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readonly').getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}

function idbClear(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  });
}

// Runs several writes as ONE IndexedDB transaction: either every write
// lands or none do (e.g. both legs of a transfer, or a full backup
// restore). IndexedDB also serializes overlapping readwrite transactions,
// even across tabs, which is what makes check-then-write steps inside
// `work` safe from double-processing.
function idbAtomic(storeNames, work) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, 'readwrite');
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    try { work(t); } catch (err) { t.abort(); reject(err); }
  });
}

async function loadAllData() {
  accounts = await idbGetAll('accounts');
  transactions = await idbGetAll('transactions');
  recurring = await idbGetAll('recurring');
  categories = await idbGetAll('categories');
  categoryBudgets = await idbGetAll('categoryBudgets');
  goals = await idbGetAll('goals');
  // Most recent activity first. Tie-break on id (higher id = added later) so
  // multiple records sharing the same date/time still show newest-added on top.
  transactions.sort((a, b) => {
    const diff = new Date(b.datetime) - new Date(a.datetime);
    return diff !== 0 ? diff : b.id - a.id;
  });
  ensureAccountSelection();
}

// Seeds a starter set of common categories the very first time the app
// runs, so the category picker isn't empty on day one. Uses a localStorage
// flag (not "categories.length === 0") so it never re-seeds after someone
// intentionally deletes all their categories.
async function seedDefaultCategoriesIfNeeded() {
  let alreadySeeded;
  try { alreadySeeded = localStorage.getItem('duitku-categories-seeded'); } catch (e) { alreadySeeded = null; }
  if (alreadySeeded) return;
  const defaults = [
    { name: 'Food', icon: 'utensils', type: 'expense' },
    { name: 'Transport', icon: 'car', type: 'expense' },
    { name: 'Bills', icon: 'receipt', type: 'expense' },
    { name: 'Shopping', icon: 'shopping-bag', type: 'expense' },
    { name: 'Health', icon: 'heart-pulse', type: 'expense' },
    { name: 'Rent', icon: 'home', type: 'expense' },
    { name: 'Other', icon: 'tag', type: 'expense' },
    { name: 'Salary', icon: 'briefcase', type: 'income' },
    { name: 'Gift', icon: 'gift', type: 'income' },
    { name: 'Other Income', icon: 'tag', type: 'income' }
  ];
  for (const cat of defaults) await idbAdd('categories', cat);
  try { localStorage.setItem('duitku-categories-seeded', '1'); } catch (e) { /* ignore */ }
}

function categoryById(id) {
  return categories.find(c => c.id === id) || null;
}

// ---------- Category Picker & Management ----------
const CATEGORY_ICON_CHOICES = ['utensils', 'car', 'receipt', 'shopping-bag', 'heart-pulse', 'home', 'gift', 'briefcase', 'wallet', 'target', 'repeat', 'tag'];
// Pro-only icon set — locked in the picker unless duitku-pro-unlocked is
// set. NOTE: there is no real payment processor wired up here (this is a
// static single-file app with no backend) — "unlocking" is currently a
// local demo toggle only, meant as a placeholder until real billing
// (e.g. Stripe, Play Billing) is integrated.
const PRO_CATEGORY_ICON_CHOICES = ['coffee', 'plane', 'film', 'gamepad', 'dumbbell', 'shirt', 'fuel', 'zap', 'droplet', 'smartphone', 'paw-print', 'baby', 'sparkles', 'graduation-cap', 'shield', 'wrench', 'music', 'monitor', 'parking', 'cake'];

function isProUnlocked() {
  try { return localStorage.getItem('duitku-pro-unlocked') === '1'; } catch (e) { return false; }
}

function openProUpsellModal() {
  openModal('pro-upsell-modal');
  refreshIcons();
}

function updateRecordCategoryDisplay(categoryId) {
  document.getElementById('record-category-id').value = categoryId || '';
  const label = document.getElementById('record-category-label');
  const iconWrap = document.getElementById('record-category-icon-wrap');
  const cat = categoryId ? categoryById(Number(categoryId)) : null;
  if (cat) {
    label.textContent = cat.name;
    iconWrap.innerHTML = iconSvg(cat.icon, 'w-3.5 h-3.5');
  } else {
    label.textContent = 'Uncategorized';
    iconWrap.innerHTML = iconSvg('tag', 'w-3.5 h-3.5');
  }
}

function openCategoryPicker() {
  const currentType = document.getElementById('record-type').value;
  const grid = document.getElementById('category-picker-grid');
  const scoped = categories.filter(c => c.type === currentType);
  const currentId = document.getElementById('record-category-id').value;

  let html = `
    <button type="button" class="category-pick-btn flex flex-col items-center gap-1.5" data-id="">
      <span class="w-12 h-12 rounded-full flex items-center justify-center ${!currentId ? 'bg-primary-700 text-white' : 'bg-primary-100 text-primary-700'}">${iconSvg('tag', 'w-5 h-5')}</span>
      <span class="text-[11px] font-medium text-ink/70 text-center">Uncategorized</span>
    </button>`;
  html += scoped.map(c => `
    <button type="button" class="category-pick-btn flex flex-col items-center gap-1.5" data-id="${c.id}">
      <span class="w-12 h-12 rounded-full flex items-center justify-center ${String(c.id) === currentId ? 'bg-primary-700 text-white' : 'bg-primary-100 text-primary-700'}">${iconSvg(c.icon, 'w-5 h-5')}</span>
      <span class="text-[11px] font-medium text-ink/70 text-center truncate w-full">${escapeHtml(c.name)}</span>
    </button>`).join('');

  grid.innerHTML = html;
  grid.querySelectorAll('.category-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      updateRecordCategoryDisplay(btn.dataset.id);
      closeModal('category-picker-modal');
    });
  });
  openModal('category-picker-modal');
  refreshIcons();
}

function setCategoryTypeToggle(type) {
  document.getElementById('category-type-input').value = type;
  document.querySelectorAll('.category-type-btn').forEach(b => {
    b.classList.remove('border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200', 'border-primary-100', 'text-ink/50');
  });
  const activeBtn = document.querySelector(`.category-type-btn[data-type="${type}"]`);
  const otherBtn = document.querySelector(`.category-type-btn[data-type="${type === 'expense' ? 'income' : 'expense'}"]`);
  if (type === 'expense') activeBtn.classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
  else activeBtn.classList.add('border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
  otherBtn.classList.add('border-primary-100', 'text-ink/50');
}

// initialType: 'expense'|'income' used for a brand-new category.
// editCategory: an existing category object to edit in place, or null/undefined to add a new one.
function openCategoryAddModal(initialType, editCategory) {
  document.getElementById('category-add-form').reset();
  const isEdit = !!editCategory;
  document.getElementById('category-edit-id').value = isEdit ? editCategory.id : '';
  document.getElementById('category-add-modal-title').textContent = isEdit ? 'Edit Category' : 'Add Category';
  document.getElementById('category-add-submit-btn').textContent = isEdit ? 'Save Changes' : 'Save Category';
  document.getElementById('category-name-input').value = isEdit ? editCategory.name : '';
  const selectedIcon = isEdit ? editCategory.icon : 'tag';
  document.getElementById('category-icon-input').value = selectedIcon;
  setCategoryTypeToggle(isEdit ? editCategory.type : (initialType || 'expense'));

  const grid = document.getElementById('category-icon-grid');
  const proUnlocked = isProUnlocked();
  const allIcons = [
    ...CATEGORY_ICON_CHOICES.map(icon => ({ icon, pro: false })),
    ...PRO_CATEGORY_ICON_CHOICES.map(icon => ({ icon, pro: true }))
  ];

  grid.innerHTML = allIcons.map(({ icon, pro }) => {
    const locked = pro && !proUnlocked;
    const selected = icon === selectedIcon && !locked;
    return `
      <button type="button" class="category-icon-choice-btn relative w-9 h-9 rounded-full flex items-center justify-center ${selected ? 'bg-primary-700 text-white' : 'bg-primary-100 text-primary-700'} ${locked ? 'opacity-50' : ''}" data-icon="${icon}" data-locked="${locked}">
        ${iconSvg(icon, 'w-4 h-4')}
        ${locked ? `<span class="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-ink text-white flex items-center justify-center">${iconSvg('lock', 'w-2 h-2')}</span>` : ''}
      </button>`;
  }).join('');

  grid.querySelectorAll('.category-icon-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.locked === 'true') {
        openProUpsellModal();
        return;
      }
      grid.querySelectorAll('.category-icon-choice-btn').forEach(b => {
        b.classList.remove('bg-primary-700', 'text-white');
        if (b.dataset.locked !== 'true') b.classList.add('bg-primary-100', 'text-primary-700');
      });
      btn.classList.remove('bg-primary-100', 'text-primary-700');
      btn.classList.add('bg-primary-700', 'text-white');
      document.getElementById('category-icon-input').value = btn.dataset.icon;
    });
  });
  closeModal('category-picker-modal');
  closeModal('category-manage-modal');
  openModal('category-add-modal');
  refreshIcons();
}

// ---------- Manage Categories ----------
let categoryManageFilterType = 'expense';

function renderCategoryManageList() {
  const listEl = document.getElementById('category-manage-list');
  const scoped = categories.filter(c => c.type === categoryManageFilterType);
  if (scoped.length === 0) {
    listEl.innerHTML = `<p class="text-sm text-ink/40 text-center py-6">No categories yet.</p>`;
    return;
  }
  listEl.innerHTML = scoped.map(c => `
    <div class="flex items-center gap-3 bg-white rounded-2xl p-3 border border-primary-100">
      <span class="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 shrink-0">${iconSvg(c.icon, 'w-4 h-4')}</span>
      <span class="flex-1 text-sm font-semibold truncate">${escapeHtml(c.name)}</span>
      <button class="category-edit-btn w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center shrink-0" data-id="${c.id}"><i data-lucide="edit" class="w-3.5 h-3.5"></i></button>
      <button class="category-delete-btn w-7 h-7 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0" data-id="${c.id}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
    </div>`).join('');
  refreshIcons(listEl);
  listEl.querySelectorAll('.category-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = categoryById(Number(btn.dataset.id));
      if (cat) openCategoryAddModal(cat.type, cat);
    });
  });
  listEl.querySelectorAll('.category-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(tr('Delete this category? Transactions using it will show as Uncategorized instead — they will not be deleted.'))) return;
      const id = Number(btn.dataset.id);
      try {
        await idbDelete('categories', id);
        const staleBudgets = categoryBudgets.filter(cb => cb.categoryId === id);
        for (const cb of staleBudgets) await idbDelete('categoryBudgets', cb.id);
        await loadAllData();
        renderCategoryManageList();
        renderAll();
        showToast('Category deleted');
      } catch (err) {
        console.error('Category delete failed', err);
        showToast('Could not delete category');
      }
    });
  });
}

function openCategoryManageModal() {
  categoryManageFilterType = 'expense';
  document.querySelectorAll('.category-manage-filter-btn').forEach(b => {
    b.classList.remove('border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200', 'border-primary-100', 'text-ink/50');
  });
  document.querySelector('.category-manage-filter-btn[data-type="expense"]').classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
  document.querySelector('.category-manage-filter-btn[data-type="income"]').classList.add('border-primary-100', 'text-ink/50');
  renderCategoryManageList();
  openModal('category-manage-modal');
  refreshIcons();
}

// ---------- Manage Budgets (overall + per-category) ----------
function categoryBudgetFor(accountId, categoryId) {
  return categoryBudgets.find(cb => cb.accountId === accountId && cb.categoryId === categoryId) || null;
}

function openBudgetManageModal() {
  if (currentAccountFilter === null) { showToast('Select an account first'); return; }
  const acc = accounts.find(a => a.id === currentAccountFilter);
  document.getElementById('budget-manage-account-label').textContent = tr('For {name}', { name: accountName(currentAccountFilter) });
  document.getElementById('budget-manage-overall-input').value = acc && acc.monthlyBudget ? acc.monthlyBudget : '';

  const expenseCats = categories.filter(c => c.type === 'expense');
  const listEl = document.getElementById('budget-manage-category-list');
  if (expenseCats.length === 0) {
    listEl.innerHTML = `<p class="text-sm text-ink/40 text-center py-4">No expense categories yet — add some from Manage Categories first.</p>`;
  } else {
    listEl.innerHTML = expenseCats.map(c => {
      const existing = categoryBudgetFor(currentAccountFilter, c.id);
      return `
        <div class="flex items-center gap-3">
          <span class="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 shrink-0">${iconSvg(c.icon, 'w-4 h-4')}</span>
          <span class="flex-1 text-sm font-medium text-ink/70 truncate">${escapeHtml(c.name)}</span>
          <input type="number" step="0.01" min="0" class="budget-manage-cat-input w-24 rounded-xl border border-primary-100 px-2 py-1.5 text-sm bg-white text-right" data-category-id="${c.id}" placeholder="—" value="${existing ? existing.limit : ''}" />
        </div>`;
    }).join('');
  }
  openModal('budget-manage-modal');
  refreshIcons();
}

// ---------- Money arithmetic ----------
// Amounts are stored as RM numbers (unchanged, so existing data and old
// backups keep working), but every sum and difference is done in whole
// sen (integers) so totals never pick up floating-point drift such as
// 0.1 + 0.2 = 0.30000000000000004.
function toSen(rm) { return Math.round((Number(rm) || 0) * 100); }
function fromSen(sen) { return sen / 100; }
function parseAmount(str) { return fromSen(toSen(parseFloat(str))); }
function sumAmounts(list, pick) {
  return fromSen(list.reduce((s, x) => s + toSen(pick ? pick(x) : x), 0));
}
function signedAmount(t) { return t.type === 'income' ? t.amount : -t.amount; }

// Transfers move money between your own accounts: they change balances but
// are neither income nor spending, so analytics (totals, budgets, trends,
// category breakdowns) skip them.
function isTransfer(t) { return !!t.transferId; }
function isRealExpense(t) { return t.type === 'expense' && !isTransfer(t); }
function isRealIncome(t) { return t.type === 'income' && !isTransfer(t); }

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
function newTransferId() { return 'tr-' + Date.now().toString(36) + '-' + randomHex(4); }

// Transfers made before transferId existed were saved as a plain
// "Transfer to X" expense + "Transfer from Y" income pair with the same
// timestamp and amount. This pairs them up once and tags both legs, so old
// transfers also stop counting as income/spending.
async function tagLegacyTransfersOnce() {
  try { if (localStorage.getItem('duitku-transfers-tagged') === '1') return; } catch (e) { return; }
  const isOutLeg = t => t.type === 'expense' && !t.transferId && /^Transfer to /.test(t.note || '');
  const isInLeg = t => t.type === 'income' && !t.transferId && /^Transfer from /.test(t.note || '');
  const ins = transactions.filter(isInLeg);
  const used = new Set();
  const updates = [];
  for (const out of transactions.filter(isOutLeg)) {
    const match = ins.find(i => !used.has(i.id) && i.datetime === out.datetime
      && toSen(i.amount) === toSen(out.amount) && i.accountId !== out.accountId);
    if (!match) continue;
    used.add(match.id);
    const transferId = newTransferId();
    updates.push({ ...out, transferId }, { ...match, transferId });
  }
  if (updates.length) {
    await idbAtomic(['transactions'], (t) => {
      const store = t.objectStore('transactions');
      updates.forEach(u => store.put(u));
    });
    await loadAllData();
  }
  try { localStorage.setItem('duitku-transfers-tagged', '1'); } catch (e) { /* ignore */ }
}

// ---------- Utility ----------
function fmtMoney(n) {
  const v = Number(n) || 0;
  return 'RM ' + v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(dtStr) {
  const d = new Date(dtStr);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const time = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return `${dd}/${mm}/${yyyy} · ${time}`;
}
// Date-only variant (no time) — used in the PDF receipt appendix labels
// and CSV export rows, where a timestamp would just add clutter.
function fmtDateOnly(dtStr) {
  const d = new Date(dtStr);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
function nowLocalDatetime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function showToast(msg, opts) {
  const t = document.getElementById('toast');
  const msgEl = document.getElementById('toast-message');
  const undoBtn = document.getElementById('toast-undo-btn');
  msgEl.textContent = tr(msg);
  clearTimeout(showToast._t);

  if (opts && typeof opts.undo === 'function') {
    undoBtn.classList.remove('hidden');
    t.classList.add('pointer-events-auto');
    undoBtn.onclick = () => {
      opts.undo();
      t.style.opacity = '0';
      t.classList.remove('pointer-events-auto');
      clearTimeout(showToast._t);
    };
  } else {
    undoBtn.classList.add('hidden');
    undoBtn.onclick = null;
    t.classList.remove('pointer-events-auto');
  }

  t.style.opacity = '1';
  const duration = (opts && opts.duration) || 2200;
  showToast._t = setTimeout(() => {
    t.style.opacity = '0';
    t.classList.remove('pointer-events-auto');
  }, duration);
}
// ---------- Self-contained icon system ----------
// Icons are drawn as inline SVG strings baked into this file — no external
// icon library or CDN is loaded, so icons can never fail to appear due to
// network conditions, ad-blockers, or CDN outages.
const ICONS = {
  'menu': '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  'plus-circle': '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
  'x': '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  'home': '<path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5V19a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5"/>',
  'wallet': '<rect x="3" y="6.5" width="18" height="12" rx="2"/><path d="M3 10.5h18"/><circle cx="16.5" cy="14.5" r="1.1" fill="currentColor" stroke="none"/>',
  'file-bar-chart': '<line x1="5" y1="20" x2="5" y2="13"/><line x1="12" y1="20" x2="12" y2="9"/><line x1="19" y1="20" x2="19" y2="5"/><line x1="3" y1="20" x2="21" y2="20"/>',
  'more-horizontal': '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  'camera': '<path d="M4 7.5h3.2L9 5.5h6l1.8 2H20a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.3"/>',
  'paperclip': '<path d="M8 12.5V6.2a3.7 3.7 0 1 1 7.4 0v10a2.3 2.3 0 1 1-4.6 0V8"/>',
  'trash-2': '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/>',
  'download': '<path d="M12 4v10.5"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
  'upload': '<path d="M12 20V9.5"/><path d="M7.5 13.5L12 9l4.5 4.5"/><path d="M5 20h14"/>',
  'inbox': '<path d="M4 12h4l1.8 3h4.4l1.8-3h4"/><path d="M4.5 12L6 5.8a1 1 0 0 1 1-.8h10a1 1 0 0 1 1 .8L19.5 12"/><path d="M4 12v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
  'arrow-down-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v7"/><path d="M8.5 11.5L12 15l3.5-3.5"/>',
  'arrow-up-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-7"/><path d="M8.5 12.5L12 9l3.5 3.5"/>',
  'file-down': '<path d="M13.5 3H7.2a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V8z"/><path d="M13.5 3v5h5"/><path d="M12 12v6"/><path d="M9.3 15.7L12 18.3l2.7-2.6"/>',
  'switch': '<path d="M4 8h13.5"/><path d="M14 4.2l3.5 3.8-3.5 3.8"/><path d="M20 16H6.5"/><path d="M10 12.2l-3.5 3.8 3.5 3.8"/>',
  'check': '<path d="M5 13l4.5 4.5L19 7"/>',
  'arrow-right': '<line x1="4" y1="12" x2="18.5" y2="12"/><path d="M14 6.5L19.5 12L14 17.5"/>',
  'edit': '<path d="M4 20l1-4L15 6.5a2 2 0 0 1 3 3L8 19l-4 1z"/><path d="M13.5 6.5l3 3"/>',
  'lock': '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  'target': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"/>',
  'utensils': '<path d="M6 2v6a2 2 0 0 0 4 0V2"/><line x1="8" y1="2" x2="8" y2="22"/><path d="M16 2a3 3 0 0 0-3 3v4a3 3 0 0 0 3 3v10"/>',
  'car': '<path d="M4 16V11l2-5h12l2 5v5"/><path d="M4 16h16"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  'receipt': '<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/>',
  'shopping-bag': '<path d="M6 8h12l1 12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  'heart-pulse': '<path d="M12 21C7 16.5 3 13 3 9a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 21 9c0 4-4 7.5-9 12z"/><path d="M7 11h2l1.5-3L12 14l1.5-3H16"/>',
  'gift': '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M4 9h16v4H4z"/><line x1="12" y1="9" x2="12" y2="20"/><path d="M12 9c0-2-1.5-4-3.5-4S6 6.5 6 8s1 1 3 1"/><path d="M12 9c0-2 1.5-4 3.5-4S18 6.5 18 8s-1 1-3 1"/>',
  'briefcase': '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="13" x2="21" y2="13"/>',
  'tag': '<path d="M11 3H4v7l10 10 7-7L11 3z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>',
  'coffee': '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M7 4c0 1-1 1-1 2"/><path d="M11 4c0 1-1 1-1 2"/>',
  'plane': '<path d="M3 12l18-7-7 18-2-8-9-3z"/>',
  'film': '<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="8" y1="4" x2="8" y2="9"/><line x1="16" y1="4" x2="16" y2="9"/>',
  'gamepad': '<rect x="3" y="7" width="18" height="11" rx="4"/><line x1="7" y1="11" x2="7" y2="15"/><line x1="5" y1="13" x2="9" y2="13"/><circle cx="16" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="14" r="1" fill="currentColor" stroke="none"/>',
  'dumbbell': '<rect x="2" y="9" width="3" height="6" rx="1"/><rect x="19" y="9" width="3" height="6" rx="1"/><line x1="7" y1="12" x2="17" y2="12"/><rect x="5" y="7" width="2" height="10" rx="0.5"/><rect x="17" y="7" width="2" height="10" rx="0.5"/>',
  'shirt': '<path d="M8 4l4 2 4-2 4 4-3 3v11H7V11L4 8z"/>',
  'fuel': '<path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15"/><path d="M4 11h10"/><path d="M16 8l3 3v6a1.5 1.5 0 0 0 3 0v-4l-2-3"/><line x1="2" y1="21" x2="16" y2="21"/>',
  'zap': '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/>',
  'droplet': '<path d="M12 3c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.5 3-7 7-12z"/>',
  'smartphone': '<rect x="6" y="2" width="12" height="20" rx="2"/><line x1="10" y1="19" x2="14" y2="19"/>',
  'paw-print': '<circle cx="7" cy="8" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="17" cy="8" r="1.6"/><path d="M8 13c0-2 2-3 4-3s4 1 4 3c0 2.5-2 3.5-4 3.5S8 15.5 8 13z"/>',
  'baby': '<circle cx="12" cy="8" r="3.5"/><path d="M6 20c0-3.5 2.5-6 6-6s6 2.5 6 6"/><path d="M9 8a1 1 0 1 1-2 0"/><path d="M17 8a1 1 0 1 1-2 0"/>',
  'sparkles': '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  'graduation-cap': '<path d="M2 9l10-4 10 4-10 4z"/><path d="M6 11v4c0 1.5 3 3 6 3s6-1.5 6-3v-4"/><line x1="21" y1="9" x2="21" y2="15"/>',
  'shield': '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  'wrench': '<path d="M14.5 3a4.5 4.5 0 0 0-5.7 5.7L4 13.5V17h3.5l4.8-4.8A4.5 4.5 0 0 0 18 8.2l-3 3-2-2 3-3z"/>',
  'music': '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  'monitor': '<rect x="3" y="4" width="18" height="12" rx="1.5"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>',
  'parking': '<circle cx="12" cy="12" r="9"/><path d="M9 16V8h4a3 3 0 0 1 0 6H9"/>',
  'cake': '<path d="M4 21v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7z"/><line x1="4" y1="17" x2="20" y2="17"/><path d="M8 12V9M12 12V9M16 12V9"/><path d="M8 6c0-1 1-1 1-2s-1-1-1-2"/><path d="M12 6c0-1 1-1 1-2s-1-1-1-2"/><path d="M16 6c0-1 1-1 1-2s-1-1-1-2"/>',
  'search': '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.3" y1="15.3" x2="20" y2="20"/>',
  'repeat': '<path d="M4 7h11a3 3 0 0 1 3 3v1"/><path d="M15.5 8.5L18 11l2.5-2.5"/><path d="M20 17H9a3 3 0 0 1-3-3v-1"/><path d="M8.5 15.5L6 13l-2.5 2.5"/>',
  'undo': '<path d="M4 9h5"/><path d="M4 9V4"/><path d="M4 9c2.2-3 6-4.5 9.5-3.3A8 8 0 1 1 6 17"/>',
  'trending-up': '<path d="M4 16l6-6 4 4 6-8"/><path d="M14 6h6v6"/>',
  'table': '<rect x="4" y="5" width="16" height="14" rx="1.5"/><line x1="4" y1="10.5" x2="20" y2="10.5"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="11" y1="5" x2="11" y2="19"/>',
  'moon': '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  'bell': '<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10z"/><path d="M10 18a2 2 0 0 0 4 0"/>'
};

function iconSvg(name, className) {
  const inner = ICONS[name];
  if (!inner) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${className || ''}">${inner}</svg>`;
}

// Replaces every <i data-lucide="name" class="..."> placeholder in the DOM
// with the matching inline SVG. Safe to call as often as needed (e.g. after
// re-rendering a list) — it only touches elements that still have the
// data-lucide placeholder tag.
function refreshIcons(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-lucide]').forEach(el => {
    const name = el.getAttribute('data-lucide');
    const svg = iconSvg(name, el.getAttribute('class') || '');
    if (svg) {
      const wrapper = document.createElement('span');
      wrapper.innerHTML = svg;
      el.replaceWith(wrapper.firstElementChild);
    }
  });
}

function accountBalance(accountId) {
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) return 0;
  const delta = sumAmounts(transactions.filter(t => t.accountId === accountId), signedAmount);
  return fromSen(toSen(acc.initialBalance) + toSen(delta));
}

// Sum of this month's expenses on the given account (calendar month,
// resets automatically at the start of each new month — no manual
// carry-over needed since it's always computed from live transaction data).
// Transfers out are not spending, so they never eat into the budget.
function monthlySpent(accountId) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return sumAmounts(transactions
    .filter(t => t.accountId === accountId && isRealExpense(t) && new Date(t.datetime) >= start), t => t.amount);
}

function accountName(id) {
  const a = accounts.find(a => a.id === id);
  return a ? a.name : 'Unknown';
}

// ---------- Image Processing: B&W Document Filter ----------
// Converts a photo into a high-contrast monochrome "scanned document" look.
// Important: this NEVER crops the image — drawImage always renders the
// full original photo, only proportionally downscaled if it's larger than
// maxDim (purely to keep file size reasonable for storage). The full
// receipt is always visible, and width/height are returned alongside the
// image so callers (thumbnails, PDF export) can preserve the exact
// original aspect ratio instead of stretching or cropping it later.
function fileToMonochromeDataURL(file, maxDim = 1800, threshold = 150) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = height * (maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = width * (maxDim / height); height = maxDim; }

        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          // Luminance-weighted grayscale
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          // High-contrast document threshold (monochrome)
          const bw = gray > threshold ? 255 : (gray < threshold - 60 ? 0 : gray);
          data[i] = bw; data[i + 1] = bw; data[i + 2] = bw;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), width, height });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Receipts may be stored either as a plain data-URL string (older records
// saved before this version) or as {dataUrl, width, height} (current
// format). These helpers read either shape safely.
function receiptSrc(r) { return typeof r === 'string' ? r : r.dataUrl; }
function receiptDims(r) { return (r && typeof r === 'object' && r.width && r.height) ? { width: r.width, height: r.height } : null; }

// ---------- View Navigation ----------
function switchView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  document.querySelectorAll('.tab-btn[data-view]').forEach(b => {
    b.classList.toggle('active-tab', b.dataset.view === viewId);
  });
  const titles = { 'home-view': 'Overview', 'activity-view': 'Recent Activity', 'reports-view': 'Reports', 'accounts-view': 'Manage Accounts', 'transfer-view': 'Transfer' };
  document.getElementById('page-title').textContent = titles[viewId] || 'Duit Tracker';
  if (viewId === 'reports-view') { renderReportTable(); renderSpendingTrend(); }
  if (viewId === 'transfer-view') renderTransferView();
  window.scrollTo(0, 0);
}

function renderTransferView() {
  const emptyEl = document.getElementById('transfer-empty-state');
  const formEl = document.getElementById('transfer-form');
  if (accounts.length < 2) {
    emptyEl.classList.remove('hidden');
    emptyEl.classList.add('flex');
    formEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  emptyEl.classList.remove('flex');
  formEl.classList.remove('hidden');

  const opts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  const fromSel = document.getElementById('transfer-from');
  const toSel = document.getElementById('transfer-to');
  const prevFrom = fromSel.value, prevTo = toSel.value;
  fromSel.innerHTML = opts;
  toSel.innerHTML = opts;
  // Keep the previous selection if it's still valid, otherwise default to
  // the first two distinct accounts.
  fromSel.value = accounts.some(a => String(a.id) === prevFrom) ? prevFrom : String(accounts[0].id);
  toSel.value = accounts.some(a => String(a.id) === prevTo) && prevTo !== fromSel.value
    ? prevTo
    : String((accounts.find(a => String(a.id) !== fromSel.value) || accounts[1]).id);
}

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  const sheet = modal.querySelector('.sheet');
  if (!sheet) return; // full-screen overlays (e.g. the receipt viewer) have no sheet to animate
  requestAnimationFrame(() => {
    sheet.classList.remove('translate-y-full', 'translate-x-full');
  });
}
function closeModal(id) {
  const modal = document.getElementById(id);
  const sheet = modal.querySelector('.sheet');
  if (!sheet) { modal.classList.add('hidden'); return; }
  sheet.classList.add(id === 'side-menu' ? 'translate-x-full' : 'translate-y-full');
  setTimeout(() => modal.classList.add('hidden'), 280);
}

function openReceiptViewer(src) {
  document.getElementById('receipt-viewer-img').src = src;
  openModal('receipt-viewer');
}

// ---------- Rendering ----------
function renderBanner() {
  const labelEl = document.getElementById('balance-label');
  const headerNameEl = document.getElementById('header-account-name');
  let bal = 0, relevantTx = [], labelText;

  if (currentAccountFilter === null) {
    labelText = 'No Account Yet';
    headerNameEl.textContent = 'No Account';
  } else {
    bal = accountBalance(currentAccountFilter);
    relevantTx = transactions.filter(t => t.accountId === currentAccountFilter);
    labelText = tr('{name} Balance', { name: accountName(currentAccountFilter) });
    headerNameEl.textContent = accountName(currentAccountFilter);
  }

  labelEl.textContent = labelText;
  document.getElementById('total-balance').textContent = fmtMoney(bal);
  const totalIncome = sumAmounts(relevantTx.filter(isRealIncome), t => t.amount);
  const totalExpense = sumAmounts(relevantTx.filter(isRealExpense), t => t.amount);
  document.getElementById('total-income').textContent = fmtMoney(totalIncome);
  document.getElementById('total-expense').textContent = fmtMoney(totalExpense);
}

function selectAccountFilter(value) {
  currentAccountFilter = Number(value);
  renderBanner();
  renderBudgetCard();
  renderCategoryBudgetProgress();
  renderUpcomingBills();
  renderMonthComparison();
  renderTransactionList();
  renderReportTable(); // Reports always mirrors the account selected here
  renderSpendingTrend();
}

function openSwitchModal() {
  const list = document.getElementById('switch-list');

  if (accounts.length === 0) {
    list.innerHTML = `<p class="text-sm text-ink/40 text-center py-6">No accounts yet — create one below.</p>`;
  } else {
    list.innerHTML = accounts.map(a => {
      const active = currentAccountFilter === a.id;
      return `
      <button class="switch-option w-full flex items-center justify-between bg-white rounded-2xl px-4 py-3 border ${active ? 'border-primary-700' : 'border-primary-100'} active:scale-[.98] transition text-left" data-acc="${a.id}">
        <div>
          <p class="text-sm font-semibold">${escapeHtml(a.name)}</p>
          <p class="text-xs text-ink/45">${fmtMoney(accountBalance(a.id))}</p>
        </div>
        ${active ? '<i data-lucide="check" class="w-4 h-4 text-primary-700"></i>' : ''}
      </button>`;
    }).join('');
  }

  refreshIcons(list);
  list.querySelectorAll('.switch-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectAccountFilter(btn.dataset.acc);
      closeModal('switch-modal');
    });
  });
  openModal('switch-modal');
}

function filteredTransactions() {
  if (currentAccountFilter === null) return [];
  return transactions.filter(t => t.accountId === currentAccountFilter);
}

function renderTransactionList() {
  const list = document.getElementById('transaction-list');
  const empty = document.getElementById('empty-state');
  const items = filteredTransactions().slice(0, 25);

  if (items.length === 0) {
    list.innerHTML = '';
    document.getElementById('empty-state-text').textContent = currentAccountFilter === null
      ? 'Create an account to get started.'
      : 'No transactions yet. Tap "Add Transaction" to start.';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = items.map(t => {
    const isIncome = t.type === 'income';
    const cat = t.categoryId ? categoryById(t.categoryId) : null;
    const icon = isTransfer(t) ? 'switch' : cat ? cat.icon : (isIncome ? 'arrow-down-circle' : 'arrow-up-circle');
    const iconColor = isTransfer(t) ? 'bg-primary-100 text-primary-700' : (isIncome ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600');
    const title = t.note ? escapeHtml(t.note) : (cat ? escapeHtml(cat.name) : (isIncome ? 'In' : 'Out'));
    return `
      <button class="tx-row w-full flex items-center gap-3 bg-white rounded-2xl p-3 border border-primary-100 active:scale-[.98] transition text-left" data-id="${t.id}">
        <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${iconColor}">
          <i data-lucide="${icon}" class="w-4 h-4"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold truncate">${title}</p>
          <p class="text-[11px] text-ink/45">${accountName(t.accountId)} · ${fmtDate(t.datetime)}</p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-sm font-bold ${isIncome ? 'text-emerald-600' : 'text-rose-600'}">${isIncome ? '+' : '-'} ${fmtMoney(t.amount)}</p>
          ${t.receipts && t.receipts.length ? `<p class="text-[10px] text-ink/40 flex items-center justify-end gap-1"><i data-lucide="paperclip" class="w-3 h-3"></i>${t.receipts.length}</p>` : ''}
        </div>
      </button>`;
  }).join('');

  refreshIcons();
  list.querySelectorAll('.tx-row').forEach(row => {
    row.addEventListener('click', () => openDetail(Number(row.dataset.id)));
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderAccountsList() {
  const wrap = document.getElementById('accounts-list');
  if (accounts.length === 0) {
    wrap.innerHTML = `<p class="text-sm text-ink/40 text-center py-6">No accounts yet. Create one above.</p>`;
    return;
  }
  wrap.innerHTML = accounts.map(a => `
    <div class="bg-white rounded-2xl p-4 border border-primary-100 flex items-center justify-between">
      <div>
        <p class="text-sm font-semibold">${escapeHtml(a.name)}</p>
        <p class="text-xs text-ink/45">${tr('Initial: {x}', { x: fmtMoney(a.initialBalance) })}</p>
      </div>
      <div class="text-right flex items-center gap-3">
        <p class="font-display font-bold text-sm ${accountBalance(a.id) < 0 ? 'text-rose-600' : 'text-primary-700'}">${fmtMoney(accountBalance(a.id))}</p>
        <button class="del-acc-btn w-8 h-8 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center" data-id="${a.id}">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>
  `).join('');
  refreshIcons();
  wrap.querySelectorAll('.del-acc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const hasTx = transactions.some(t => t.accountId === id);
      if (hasTx && !confirm(tr('This account has transactions linked to it. Deleting it will also delete those transactions. Continue?'))) return;
      if (!hasTx && !confirm(tr('Delete this account?'))) return;
      await idbDelete('accounts', id);
      const linked = transactions.filter(t => t.accountId === id);
      for (const t of linked) await idbDelete('transactions', t.id);
      // loadAllData() below calls ensureAccountSelection(), which will
      // automatically fall back to another real account (or null) if the
      // deleted one was the currently selected one.
      await loadAllData();
      renderAll();
      showToast('Account deleted');
    });
  });
}

function populateAccountSelects() {
  // Records now always target whichever account is selected on Home
  // (currentAccountFilter) — there is no per-form account picker to
  // populate anymore. This function is kept only for the account
  // management list, which reads `accounts` directly, so it's a no-op
  // placeholder retained for call-site compatibility.
}

function populateReportFilters() {
  const monthSel = document.getElementById('report-month');
  const yearSel = document.getElementById('report-year');
  // Preserve whatever the person already had selected — this function now
  // runs on every data change (not just when opening Reports), so without
  // this their filter choice would silently reset each time they add a
  // transaction, set a budget, etc.
  const prevMonth = monthSel.value;
  const prevYear = yearSel.value;

  monthSel.innerHTML = '<option value="all">All Months</option>' + MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');

  const years = new Set([new Date().getFullYear()]);
  transactions.forEach(t => years.add(new Date(t.datetime).getFullYear()));
  const sortedYears = Array.from(years).sort((a, b) => b - a);
  yearSel.innerHTML = '<option value="all">All Years</option>' + sortedYears.map(y => `<option value="${y}">${y}</option>`).join('');

  monthSel.value = prevMonth || 'all';
  yearSel.value = (prevYear && sortedYears.includes(Number(prevYear))) ? prevYear : new Date().getFullYear();
}

// Determines the [start, end) date boundary implied by the selected
// month/year filters, so we know exactly what counts as "before this
// period" for the brought-forward balance.
function getReportBoundaries() {
  const month = document.getElementById('report-month').value; // 'all' or 0-11
  const year = document.getElementById('report-year').value;   // 'all' or a year
  let start = null, end = null;
  if (year !== 'all') {
    if (month !== 'all') {
      start = new Date(Number(year), Number(month), 1, 0, 0, 0, 0);
      end = new Date(Number(year), Number(month) + 1, 1, 0, 0, 0, 0);
    } else {
      start = new Date(Number(year), 0, 1, 0, 0, 0, 0);
      end = new Date(Number(year) + 1, 0, 1, 0, 0, 0, 0);
    }
  }
  return { start, end };
}

// Builds the full statement for the current filters: the opening balance
// brought forward from before the period, each transaction within the
// period carrying a running balance, and the closing balance carried
// forward. The account scope always mirrors whichever account is selected
// on Home (currentAccountFilter) — Reports has no account picker of its
// own, so it can never show a different account than what's active there.
function getReportFilteredTx() {
  const { start, end } = getReportBoundaries();
  const relevantAccountIds = currentAccountFilter === null ? [] : [currentAccountFilter];

  // Opening balance = each relevant account's initial balance, plus every
  // transaction on those accounts dated strictly before the period start.
  // All balance arithmetic here runs in sen (see toSen) so the running
  // balance never drifts.
  let openingSen = accounts
    .filter(a => relevantAccountIds.includes(a.id))
    .reduce((sum, a) => sum + toSen(a.initialBalance), 0);

  transactions.forEach(t => {
    if (!relevantAccountIds.includes(t.accountId)) return;
    if (!start) return; // no lower bound selected -> nothing counts as "before"
    if (new Date(t.datetime) >= start) return;
    openingSen += toSen(signedAmount(t));
  });

  // Transactions that fall inside the selected period.
  let inRange = transactions.filter(t => {
    if (!relevantAccountIds.includes(t.accountId)) return false;
    const d = new Date(t.datetime);
    if (start && d < start) return false;
    if (end && d >= end) return false;
    return true;
  });

  // Walk chronologically (oldest first) to build the running balance.
  const chronological = [...inRange].sort((a, b) => {
    const diff = new Date(a.datetime) - new Date(b.datetime);
    return diff !== 0 ? diff : a.id - b.id;
  });
  let runningSen = openingSen;
  const withBalance = chronological.map(t => {
    runningSen += toSen(signedAmount(t));
    return { ...t, runningBalance: fromSen(runningSen) };
  });
  const opening = fromSen(openingSen);
  const closing = fromSen(runningSen);

  // Display newest-first, matching the rest of the app.
  const rows = [...withBalance].sort((a, b) => {
    const diff = new Date(b.datetime) - new Date(a.datetime);
    return diff !== 0 ? diff : b.id - a.id;
  });

  // Two sets of totals: the statement totals (every credit/debit, so
  // opening + in - out = closing, like a bank statement — used by the PDF)
  // and the analytics totals, which leave transfers out (used in the app).
  const stmtIncome = sumAmounts(rows.filter(t => t.type === 'income'), t => t.amount);
  const stmtExpense = sumAmounts(rows.filter(t => t.type === 'expense'), t => t.amount);
  const totalIncome = sumAmounts(rows.filter(isRealIncome), t => t.amount);
  const totalExpense = sumAmounts(rows.filter(isRealExpense), t => t.amount);
  const transferNet = sumAmounts(rows.filter(isTransfer), signedAmount);

  return { rows, opening, closing, totalIncome, totalExpense, transferNet, stmtIncome, stmtExpense, start, end };
}

// ---------- Spending Trend Chart ----------
// A lightweight 6-month bar chart built from plain divs (no canvas/charting
// library needed) for the currently selected account's monthly expenses.
// ---------- Recurring Transactions ----------
function clampToMonth(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

// Computes the first upcoming due date/time for a new recurring rule,
// branching on frequency. All three frequencies share the same "time of
// day" concept; daily/weekly additionally need no other field, monthly
// needs a day-of-month.
function computeNextRun(frequency, time, dayOfWeek, dayOfMonth) {
  const [hh, mm] = time.split(':').map(Number);
  const now = new Date();
  let candidate;

  if (frequency === 'daily') {
    candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  } else if (frequency === 'weekly') {
    candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    const diff = (dayOfWeek - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + diff);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 7);
  } else { // monthly
    candidate = clampToMonth(now.getFullYear(), now.getMonth(), dayOfMonth);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate <= now) {
      candidate = clampToMonth(now.getFullYear(), now.getMonth() + 1, dayOfMonth);
      candidate.setHours(hh, mm, 0, 0);
    }
  }
  return candidate;
}

// Advances a due date to its next occurrence after it has fired, again
// branching on frequency.
function advanceNextRun(r, fromDate) {
  const [hh, mm] = (r.time || '09:00').split(':').map(Number);
  let next;
  if (r.frequency === 'weekly') {
    next = new Date(fromDate);
    next.setDate(next.getDate() + 7);
  } else if (r.frequency === 'daily') {
    next = new Date(fromDate);
    next.setDate(next.getDate() + 1);
  } else { // monthly
    next = clampToMonth(fromDate.getFullYear(), fromDate.getMonth() + 1, r.dayOfMonth || 1);
  }
  next.setHours(hh, mm, 0, 0);
  return next;
}

function toLocalDatetimeInput(d) {
  const copy = new Date(d);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 16);
}

function frequencyLabel(r) {
  if (r.frequency === 'daily') return tr('Daily at {t}', { t: r.time });
  if (r.frequency === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return tr('Weekly on {d} at {t}', { d: tr(days[r.dayOfWeek]), t: r.time });
  }
  return tr('Monthly on day {n} at {t}', { n: r.dayOfMonth, t: r.time });
}

// Called once after data loads on every app open. Generates the actual
// transaction(s) for any recurring rule whose due date has passed,
// catching up multiple missed periods if the app wasn't opened for a
// while (capped as a safety valve against a runaway loop — generous
// enough to cover months of missed daily rules or years of missed
// monthly ones).
//
// Each occurrence is generated in ONE atomic IndexedDB transaction that
// re-reads the rule, checks its nextRun is still the date we expect, then
// writes the transaction and advances nextRun together. If the app is open
// in two tabs (or a write fails halfway), the second attempt sees the
// already-advanced nextRun and skips — so an occurrence can never be
// generated twice.
function fireRecurringOccurrence(ruleId, expectedNextRun) {
  let fired = false;
  return idbAtomic(['recurring', 'transactions'], (t) => {
    const rules = t.objectStore('recurring');
    const getReq = rules.get(ruleId);
    getReq.onsuccess = () => {
      const rule = getReq.result;
      if (!rule || rule.nextRun !== expectedNextRun) return; // deleted, or another tab already fired it
      const due = new Date(rule.nextRun);
      t.objectStore('transactions').add({
        accountId: rule.accountId, type: rule.type, amount: rule.amount,
        datetime: toLocalDatetimeInput(due), note: rule.note, categoryId: rule.categoryId || null,
        receipts: [], recurringId: rule.id
      });
      rule.nextRun = advanceNextRun(rule, due).toISOString();
      rules.put(rule);
      fired = true;
    };
  }).then(() => fired);
}

async function processDueRecurring() {
  if (recurring.length === 0) return;
  const now = new Date();
  let anyChanged = false;
  for (const r of recurring) {
    let expected = r.nextRun;
    let iterations = 0;
    while (new Date(expected) <= now && iterations < 90) {
      let fired;
      try {
        fired = await fireRecurringOccurrence(r.id, expected);
      } catch (err) {
        console.error('Recurring transaction generation failed', err);
        break;
      }
      if (!fired) break; // another tab is handling this rule
      anyChanged = true;
      expected = advanceNextRun(r, new Date(expected)).toISOString();
      iterations++;
    }
  }
  if (anyChanged) await loadAllData();
}

function renderRecurringList() {
  const listEl = document.getElementById('recurring-list');
  document.getElementById('recurring-account-label').textContent =
    currentAccountFilter === null ? 'Select an account first' : tr('For {name}', { name: accountName(currentAccountFilter) });
  const scoped = recurring.filter(r => r.accountId === currentAccountFilter);

  if (scoped.length === 0) {
    listEl.innerHTML = `<p class="text-sm text-ink/40 text-center py-4">No recurring transactions yet.</p>`;
    return;
  }
  listEl.innerHTML = scoped.map(r => {
    const isIncome = r.type === 'income';
    return `
      <div class="flex items-center gap-3 bg-white rounded-2xl p-3 border border-primary-100">
        <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${isIncome ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}">
          <i data-lucide="repeat" class="w-4 h-4"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold truncate">${r.note ? escapeHtml(r.note) : (isIncome ? 'In' : 'Out')}</p>
          <p class="text-[11px] text-ink/45">${frequencyLabel(r)} · ${tr('Next: {d}', { d: fmtDateOnly(r.nextRun) })}</p>
        </div>
        <p class="text-sm font-bold shrink-0 ${isIncome ? 'text-emerald-600' : 'text-rose-600'}">${isIncome ? '+' : '-'} ${fmtMoney(r.amount)}</p>
        <button class="recurring-delete-btn w-7 h-7 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0" data-id="${r.id}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>`;
  }).join('');
  refreshIcons(listEl);
  listEl.querySelectorAll('.recurring-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await idbDelete('recurring', Number(btn.dataset.id));
        await loadAllData();
        renderRecurringList();
        showToast('Recurring transaction removed');
      } catch (err) {
        console.error('Delete failed', err);
        showToast('Could not remove');
      }
    });
  });
}

function openRecurringModal() {
  if (currentAccountFilter === null) { showToast('Select an account first'); return; }
  document.getElementById('recurring-form').reset();
  document.getElementById('recurring-type').value = 'expense';
  document.querySelectorAll('.recurring-type-btn').forEach(b => {
    b.classList.remove('border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200', 'border-primary-100', 'text-ink/50');
  });
  document.querySelector('.recurring-type-btn[data-type="expense"]').classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
  document.querySelector('.recurring-type-btn[data-type="income"]').classList.add('border-primary-100', 'text-ink/50');
  document.getElementById('recurring-frequency').value = 'monthly';
  document.getElementById('recurring-weekday-wrap').classList.add('hidden');
  document.getElementById('recurring-monthday-wrap').classList.remove('hidden');
  document.getElementById('recurring-time').value = '09:00';
  renderRecurringList();
  openModal('recurring-modal');
  refreshIcons();
}

function renderSpendingTrend() {
  const container = document.getElementById('spending-trend-bars');
  if (currentAccountFilter === null) {
    container.innerHTML = '';
    return;
  }

  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const total = sumAmounts(transactions
      .filter(t => t.accountId === currentAccountFilter && isRealExpense(t)
        && new Date(t.datetime) >= monthStart && new Date(t.datetime) < monthEnd), t => t.amount);
    months.push({ label: monthStart.toLocaleDateString(LOCALE, { month: 'short' }), total, isCurrent: i === 0 });
  }

  const max = Math.max(...months.map(m => m.total), 1);
  const barAreaHeight = 72; // px, leaves room below for the month label

  container.innerHTML = months.map(m => {
    const barHeight = m.total > 0 ? Math.max(4, Math.round((m.total / max) * barAreaHeight)) : 2;
    return `
      <div class="flex-1 flex flex-col items-center gap-1.5 min-w-0">
        <div class="w-full flex items-end justify-center" style="height:${barAreaHeight}px" title="${fmtMoney(m.total)}">
          <div class="w-full max-w-[22px] rounded-t-md ${m.isCurrent ? 'bg-primary-700' : 'bg-primary-200'}" style="height:${barHeight}px"></div>
        </div>
        <span class="text-[9px] text-ink/40 font-medium">${m.label}</span>
      </div>`;
  }).join('');
}

function renderReportTable() {
  const { rows, opening, closing, totalIncome, totalExpense, transferNet } = getReportFilteredTx();

  document.getElementById('report-account-label').textContent = currentAccountFilter === null ? 'No Account' : accountName(currentAccountFilter);
  document.getElementById('stat-opening').textContent = fmtMoney(opening);
  document.getElementById('stat-closing').textContent = fmtMoney(closing);
  document.getElementById('stat-income').textContent = fmtMoney(totalIncome);
  document.getElementById('stat-expense').textContent = fmtMoney(totalExpense);
  const transferRow = document.getElementById('stat-transfer-row');
  transferRow.classList.toggle('hidden', transferNet === 0);
  document.getElementById('stat-transfer').textContent = (transferNet > 0 ? '+ ' : transferNet < 0 ? '- ' : '') + fmtMoney(Math.abs(transferNet));

  renderCategoryBreakdown(rows);
}

// A simple horizontal-bar breakdown of expenses by category for whichever
// period is currently selected (Month/Year filters above) — reuses the
// same filtered rows renderReportTable() already computed, so it always
// stays in sync with the active filter without a separate data pass.
function renderCategoryBreakdown(rows) {
  const container = document.getElementById('category-breakdown-list');
  if (currentAccountFilter === null) { container.innerHTML = ''; return; }

  const expenseRows = rows.filter(isRealExpense);
  if (expenseRows.length === 0) {
    container.innerHTML = `<p class="text-sm text-ink/40 text-center py-6">No expenses for this period</p>`;
    return;
  }

  const totalsSen = {};
  expenseRows.forEach(t => {
    const key = t.categoryId || 'none';
    totalsSen[key] = (totalsSen[key] || 0) + toSen(t.amount);
  });
  const grandTotal = fromSen(Object.values(totalsSen).reduce((s, v) => s + v, 0));

  const entries = Object.entries(totalsSen).map(([key, sen]) => {
    const cat = key !== 'none' ? categoryById(Number(key)) : null;
    return { name: cat ? cat.name : 'Uncategorized', icon: cat ? cat.icon : 'tag', amount: fromSen(sen) };
  }).sort((a, b) => b.amount - a.amount);

  container.innerHTML = entries.map(e => {
    const pct = grandTotal > 0 ? (e.amount / grandTotal) * 100 : 0;
    return `
      <div class="flex items-center gap-3">
        <span class="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 shrink-0">${iconSvg(e.icon, 'w-4 h-4')}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1 gap-2">
            <span class="text-xs font-semibold text-ink/70 truncate">${escapeHtml(e.name)}</span>
            <span class="text-xs font-semibold text-ink/70 shrink-0">${fmtMoney(e.amount)}</span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-primary-50 overflow-hidden">
            <div class="h-full rounded-full bg-primary-700" style="width:${pct}%"></div>
          </div>
        </div>
      </div>`;
  }).join('');
  refreshIcons(container);
}

// ---------- Upcoming Bills ----------
// Recurring expenses on the current account that fall due within the next
// 7 days. The app has no server, so this can only remind you while it's
// open: the Home card, plus a toast on launch for anything due within a day.
const UPCOMING_DAYS = 7;

function upcomingBills(withinDays) {
  if (currentAccountFilter === null) return [];
  const now = new Date();
  const limit = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  return recurring
    .filter(r => r.accountId === currentAccountFilter && r.type === 'expense')
    .map(r => ({ rule: r, due: new Date(r.nextRun) }))
    .filter(x => x.due <= limit)
    .sort((a, b) => a.due - b.due);
}

function dueLabel(due) {
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOf(due) - startOf(new Date())) / (24 * 60 * 60 * 1000));
  if (days <= 0) return tr('Today');
  if (days === 1) return tr('Tomorrow');
  return tr('In {n} days', { n: days });
}

function renderUpcomingBills() {
  const section = document.getElementById('upcoming-section');
  const list = document.getElementById('upcoming-list');
  const bills = upcomingBills(UPCOMING_DAYS);
  if (bills.length === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  list.innerHTML = bills.map(({ rule, due }) => {
    const cat = rule.categoryId ? categoryById(rule.categoryId) : null;
    return `
      <div class="flex items-center gap-3">
        <span class="w-8 h-8 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">${iconSvg(cat ? cat.icon : 'repeat', 'w-4 h-4')}</span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold truncate">${escapeHtml(rule.note || (cat ? cat.name : tr('Recurring payment')))}</p>
          <p class="text-[11px] text-ink/45">${dueLabel(due)} · ${fmtDateOnly(due)}</p>
        </div>
        <p class="text-sm font-bold text-rose-600 shrink-0">${fmtMoney(rule.amount)}</p>
      </div>`;
  }).join('');
}

// Returns true if it showed a reminder, so the backup nudge can stay quiet.
function maybeShowBillReminder() {
  const soon = upcomingBills(1);
  if (soon.length === 0) return false;
  const first = soon[0];
  const name = first.rule.note || tr('Recurring payment');
  showToast(soon.length === 1
    ? tr('Bill due {when}: {name} {x}', { when: dueLabel(first.due).toLowerCase(), name, x: fmtMoney(first.rule.amount) })
    : tr('{n} bills due within a day — see Upcoming Bills', { n: soon.length }), { duration: 4500 });
  return true;
}

// ---------- This Month vs Last Month ----------
// Compares spending from the 1st up to now against the same stretch of
// last month (1st up to the same day and time), so a half-finished month
// is never compared with a whole one.
function renderMonthComparison() {
  const section = document.getElementById('compare-section');
  if (currentAccountFilter === null) { section.classList.add('hidden'); return; }

  const now = new Date();
  const thisStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastEnd = clampToMonth(now.getFullYear(), now.getMonth() - 1, now.getDate());
  lastEnd.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);

  const spentIn = (from, to) => transactions.filter(t => t.accountId === currentAccountFilter && isRealExpense(t)
    && new Date(t.datetime) >= from && new Date(t.datetime) <= to);
  const thisTx = spentIn(thisStart, now);
  const lastTx = spentIn(lastStart, lastEnd);
  const thisTotal = sumAmounts(thisTx, t => t.amount);
  const lastTotal = sumAmounts(lastTx, t => t.amount);

  if (thisTotal === 0 && lastTotal === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  document.getElementById('compare-this').textContent = fmtMoney(thisTotal);
  const pctEl = document.getElementById('compare-pct');
  if (lastTotal > 0) {
    const pct = Math.round(((thisTotal - lastTotal) / lastTotal) * 100);
    pctEl.textContent = (pct > 0 ? '+' : '') + pct + '%';
    pctEl.className = 'text-sm font-bold shrink-0 ' + (pct > 0 ? 'text-rose-600' : 'text-emerald-600');
  } else {
    pctEl.textContent = '';
  }
  document.getElementById('compare-note').textContent = tr('vs {x} by this day last month', { x: fmtMoney(lastTotal) });

  // Biggest category movers (up to 3), by absolute change in sen.
  const byCat = (list) => list.reduce((m, t) => {
    const k = t.categoryId || 'none';
    m[k] = (m[k] || 0) + toSen(t.amount);
    return m;
  }, {});
  const a = byCat(thisTx), b = byCat(lastTx);
  const movers = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map(k => ({ k, diff: (a[k] || 0) - (b[k] || 0), last: b[k] || 0 }))
    .filter(m => m.diff !== 0)
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
    .slice(0, 3);
  const catsEl = document.getElementById('compare-cats');
  catsEl.classList.toggle('hidden', movers.length === 0);
  catsEl.innerHTML = movers.map(m => {
    const cat = m.k !== 'none' ? categoryById(Number(m.k)) : null;
    const up = m.diff > 0;
    const pct = m.last > 0 ? ` (${up ? '+' : ''}${Math.round((m.diff / m.last) * 100)}%)` : '';
    return `
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="text-ink/60 truncate">${escapeHtml(cat ? cat.name : tr('Uncategorized'))}</span>
        <span class="font-semibold shrink-0 ${up ? 'text-rose-600' : 'text-emerald-600'}">${up ? '+' : '-'} ${fmtMoney(fromSen(Math.abs(m.diff)))}${pct}</span>
      </div>`;
  }).join('');
}

// ---------- Savings Goals ----------
function goalProgressHtml(g) {
  const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
  const remaining = fromSen(Math.max(0, toSen(g.target) - toSen(g.saved)));
  let hint;
  if (remaining === 0) {
    hint = tr('Goal reached!');
  } else if (g.deadline) {
    const end = new Date(g.deadline + 'T23:59:59');
    const now = new Date();
    const monthsLeft = (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth()) + 1;
    hint = end < now
      ? tr('Target date passed — {x} to go', { x: fmtMoney(remaining) })
      : tr('{x} to go · about {m} a month until {d}', { x: fmtMoney(remaining), m: fmtMoney(fromSen(Math.ceil(toSen(remaining) / Math.max(1, monthsLeft)))), d: fmtDateOnly(end) });
  } else {
    hint = tr('{x} to go', { x: fmtMoney(remaining) });
  }
  return `
    <div class="flex items-center justify-between mb-1 gap-2">
      <span class="text-xs font-semibold text-ink/70 truncate">${escapeHtml(g.name)}</span>
      <span class="text-xs font-semibold text-ink/70 shrink-0">${fmtMoney(g.saved)} / ${fmtMoney(g.target)}</span>
    </div>
    <div class="w-full h-1.5 rounded-full bg-primary-50 overflow-hidden">
      <div class="h-full rounded-full ${remaining === 0 ? 'bg-emerald-600' : 'bg-primary-700'}" style="width:${pct}%"></div>
    </div>
    <p class="text-[10px] text-ink/45 mt-1">${hint}</p>`;
}

function renderGoalsHome() {
  const section = document.getElementById('goals-home-section');
  if (goals.length === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  document.getElementById('goals-home-list').innerHTML = goals.map(g => `<div>${goalProgressHtml(g)}</div>`).join('');
}

function renderGoalsList() {
  const listEl = document.getElementById('goals-list');
  if (goals.length === 0) {
    listEl.innerHTML = `<p class="text-sm text-ink/40 text-center py-4">${tr('No goals yet.')}</p>`;
    return;
  }
  listEl.innerHTML = goals.map(g => `
    <div class="bg-white rounded-2xl p-3 border border-primary-100">
      ${goalProgressHtml(g)}
      <div class="flex items-center gap-2 mt-2">
        <button class="goal-contribute-btn flex-1 bg-primary-100 text-primary-700 rounded-xl py-2 text-xs font-semibold" data-id="${g.id}">${tr('Update Savings')}</button>
        <button class="goal-delete-btn w-8 h-8 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0" data-id="${g.id}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>
    </div>`).join('');
  refreshIcons(listEl);
  listEl.querySelectorAll('.goal-contribute-btn').forEach(btn => {
    btn.addEventListener('click', () => openGoalContribute(Number(btn.dataset.id)));
  });
  listEl.querySelectorAll('.goal-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(tr('Delete this goal?'))) return;
      try {
        await idbDelete('goals', Number(btn.dataset.id));
        await loadAllData();
        renderGoalsList();
        renderGoalsHome();
        showToast('Goal deleted');
      } catch (err) {
        console.error('Goal delete failed', err);
        showToast('Could not delete goal');
      }
    });
  });
}

function openGoalsModal() {
  document.getElementById('goal-form').reset();
  renderGoalsList();
  openModal('goals-modal');
  refreshIcons();
}

function setGoalMode(mode) {
  document.getElementById('goal-contribute-mode').value = mode;
  document.querySelectorAll('.goal-mode-btn').forEach(b => {
    b.classList.remove('border-emerald-400', 'text-emerald-700', 'bg-emerald-200', 'border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-primary-100', 'text-ink/50');
    if (b.dataset.mode !== mode) b.classList.add('border-primary-100', 'text-ink/50');
    else if (mode === 'add') b.classList.add('border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
    else b.classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
  });
}

function openGoalContribute(id) {
  const g = goals.find(x => x.id === id);
  if (!g) return;
  document.getElementById('goal-contribute-form').reset();
  document.getElementById('goal-contribute-id').value = id;
  document.getElementById('goal-contribute-title').textContent = g.name;
  setGoalMode('add');
  openModal('goal-contribute-modal');
}

// ---------- Bank Statement CSV Import ----------
// Bank CSV layouts differ, so after parsing, the person maps which column
// is the date / description / amount (best guesses are pre-selected from
// the header names). Rows that already exist on the account (same day,
// amount, direction and description) are skipped, so importing an
// overlapping statement twice doesn't create duplicates.
let csvRows = [];     // parsed rows, header first
let csvHeader = [];

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delims = [',', ';', '\t'];
  const delim = delims.reduce((best, d) => firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field.trim());
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

// "1,234.50", "RM 12.00", "(12.00)", "12.00 DR", "-5" -> signed number, or null
function parseCsvAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/\bDR\b/i.test(s)) negative = true;
  s = s.replace(/\b(CR|DR|RM|MYR)\b/gi, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseAmount(s);
  return negative ? -n : n;
}

const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, mei: 4, jun: 5, jul: 6, aug: 7, ogo: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, dis: 11 };

// Returns a Date at 12:00 local time, or null if it doesn't parse.
function parseCsvDate(raw, format) {
  const s = String(raw || '').trim();
  let y, m, d;
  const named = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[A-Za-z]*[\s\-\/,]+(\d{2,4})/);
  if (named) {
    d = Number(named[1]); m = MONTH_ABBR[named[2].toLowerCase()]; y = Number(named[3]);
  } else {
    const parts = s.split(/[\s\/\-.]+/).slice(0, 3).map(Number);
    if (parts.length < 3 || parts.some(isNaN)) return null;
    if (format === 'YMD') [y, m, d] = parts;
    else if (format === 'MDY') [m, d, y] = parts;
    else [d, m, y] = parts;
    m -= 1;
  }
  if (m === undefined || isNaN(m)) return null;
  if (y < 100) y += 2000;
  const date = new Date(y, m, d, 12, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m || date.getDate() !== d) return null;
  return date;
}

function guessColumn(patterns, exclude) {
  return csvHeader.findIndex((h, i) => !(exclude || []).includes(i) && patterns.some(p => p.test(h)));
}

function guessDateFormat(colIdx) {
  const samples = csvRows.slice(1, 30).map(r => r[colIdx]).filter(Boolean);
  for (const fmt of ['DMY', 'YMD', 'MDY']) {
    if (samples.length && samples.every(s => parseCsvDate(s, fmt))) return fmt;
  }
  return 'DMY';
}

function fillCsvSelect(id, selectedIdx, allowNone) {
  const sel = document.getElementById(id);
  sel.innerHTML = (allowNone ? `<option value="-1">${tr('— none —')}</option>` : '')
    + csvHeader.map((h, i) => `<option value="${i}">${escapeHtml(h || tr('Column {n}', { n: i + 1 }))}</option>`).join('');
  sel.value = String(selectedIdx >= 0 ? selectedIdx : (allowNone ? -1 : 0));
}

function openCsvImportModal() {
  if (currentAccountFilter === null) { showToast('Select an account first'); return; }
  csvRows = []; csvHeader = [];
  document.getElementById('csv-file').value = '';
  document.getElementById('csv-file-label').textContent = tr('Choose CSV File');
  document.getElementById('csv-mapping').classList.add('hidden');
  document.getElementById('csv-account-label').textContent = accountName(currentAccountFilter);
  openModal('csv-import-modal');
  refreshIcons();
}

async function loadCsvFile(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) { showToast('That file has no rows to import'); return; }
  // Some banks put a few lines of account info above the real table: use
  // the first row that has as many columns as most of the rows below it.
  const freq = {};
  rows.forEach(r => { freq[r.length] = (freq[r.length] || 0) + 1; });
  const common = Number(Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0]);
  const headerAt = rows.findIndex(r => r.length === common);
  csvRows = rows.slice(headerAt);
  csvHeader = csvRows[0].map(h => h.replace(/\s+/g, ' '));

  const dateIdx = guessColumn([/date|tarikh/i]);
  const debitIdx = guessColumn([/debit|withdraw|keluar|\bout\b/i]);
  const creditIdx = guessColumn([/credit|deposit|masuk|\bin\b/i]);
  const amountIdx = guessColumn([/amount|amaun|jumlah/i], [debitIdx, creditIdx]);
  const descIdx = guessColumn([/desc|keterangan|butiran|detail|particular|narrat|reference|transaction/i], [dateIdx, debitIdx, creditIdx, amountIdx]);
  fillCsvSelect('csv-col-date', dateIdx);
  fillCsvSelect('csv-col-desc', descIdx, true);
  fillCsvSelect('csv-col-amount', amountIdx);
  fillCsvSelect('csv-col-debit', debitIdx, true);
  fillCsvSelect('csv-col-credit', creditIdx, true);
  const split = amountIdx < 0 && (debitIdx >= 0 || creditIdx >= 0);
  document.getElementById('csv-amount-mode').value = split ? 'split' : 'single';
  document.getElementById('csv-date-format').value = guessDateFormat(dateIdx >= 0 ? dateIdx : 0);
  document.getElementById('csv-file-label').textContent = file.name;
  document.getElementById('csv-mapping').classList.remove('hidden');
  renderCsvPreview();
}

// Turns the mapped CSV rows into transaction records for the current
// account, and works out which are new vs already present.
function buildCsvTransactions() {
  const col = id => Number(document.getElementById(id).value);
  const dateCol = col('csv-col-date'), descCol = col('csv-col-desc');
  const fmt = document.getElementById('csv-date-format').value;
  const split = document.getElementById('csv-amount-mode').value === 'split';
  const out = [];
  let skippedInvalid = 0;
  for (const r of csvRows.slice(1)) {
    const date = parseCsvDate(r[dateCol], fmt);
    let signed = null;
    if (split) {
      const debit = parseCsvAmount(r[col('csv-col-debit')]);
      const credit = parseCsvAmount(r[col('csv-col-credit')]);
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
    } else {
      signed = parseCsvAmount(r[col('csv-col-amount')]);
    }
    if (!date || !signed) { skippedInvalid++; continue; }
    out.push({
      accountId: currentAccountFilter,
      type: signed < 0 ? 'expense' : 'income',
      amount: Math.abs(signed),
      datetime: toLocalDatetimeInput(date),
      note: descCol >= 0 ? (r[descCol] || '').replace(/\s+/g, ' ').trim() : '',
      categoryId: null,
      receipts: []
    });
  }
  const key = t => [t.accountId, t.type, toSen(t.amount), String(t.datetime).slice(0, 10), (t.note || '').toLowerCase()].join('|');
  // Counted, not a plain set: two identical rows in the file (two RM 5
  // coffees on the same day) are both real, and only as many as already
  // exist in the app are treated as duplicates.
  const existing = {};
  transactions.forEach(t => { const k = key(t); existing[k] = (existing[k] || 0) + 1; });
  const fresh = [];
  let duplicates = 0;
  out.forEach(t => {
    const k = key(t);
    if (existing[k] > 0) { existing[k]--; duplicates++; return; }
    fresh.push(t);
  });
  return { fresh, duplicates, skippedInvalid };
}

function renderCsvPreview() {
  const split = document.getElementById('csv-amount-mode').value === 'split';
  document.getElementById('csv-single-wrap').classList.toggle('hidden', split);
  document.getElementById('csv-split-wrap').classList.toggle('hidden', !split);
  const { fresh, duplicates, skippedInvalid } = buildCsvTransactions();
  document.getElementById('csv-preview').innerHTML = fresh.slice(0, 5).map(t => `
    <div class="flex items-center gap-3 bg-white rounded-2xl p-3 border border-primary-100">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold truncate">${escapeHtml(t.note || (t.type === 'income' ? tr('In') : tr('Out')))}</p>
        <p class="text-[11px] text-ink/45">${fmtDateOnly(t.datetime)}</p>
      </div>
      <p class="text-sm font-bold shrink-0 ${t.type === 'income' ? 'text-emerald-600' : 'text-rose-600'}">${t.type === 'income' ? '+' : '-'} ${fmtMoney(t.amount)}</p>
    </div>`).join('') || `<p class="text-sm text-ink/40 text-center py-4">${tr('No rows match these settings yet.')}</p>`;
  const parts = [tr('{n} new transactions', { n: fresh.length })];
  if (duplicates) parts.push(tr('{n} already in the app', { n: duplicates }));
  if (skippedInvalid) parts.push(tr('{n} rows without a valid date or amount', { n: skippedInvalid }));
  document.getElementById('csv-summary').textContent = parts.join(' · ');
  const btn = document.getElementById('csv-import-btn');
  btn.textContent = tr('Import {n} Transactions', { n: fresh.length });
  btn.disabled = fresh.length === 0;
  btn.classList.toggle('opacity-50', fresh.length === 0);
}

async function runCsvImport() {
  const { fresh } = buildCsvTransactions();
  if (fresh.length === 0) return;
  const importBatch = 'csv-' + Date.now().toString(36);
  try {
    await idbAtomic(['transactions'], (t) => {
      const store = t.objectStore('transactions');
      fresh.forEach(rec => store.add({ ...rec, importBatch }));
    });
  } catch (err) {
    console.error('CSV import failed', err);
    showToast('Could not import — nothing was added');
    return;
  }
  closeModal('csv-import-modal');
  await loadAllData();
  renderAll();
  showToast(tr('Imported {n} transactions', { n: fresh.length }), {
    duration: 6000,
    undo: async () => {
      const ids = transactions.filter(t => t.importBatch === importBatch).map(t => t.id);
      await idbAtomic(['transactions'], (t) => {
        const store = t.objectStore('transactions');
        ids.forEach(id => store.delete(id));
      });
      await loadAllData();
      renderAll();
      showToast('Import undone');
    }
  });
}

function renderAll() {
  renderBanner();
  renderBudgetCard();
  renderCategoryBudgetProgress();
  renderUpcomingBills();
  renderMonthComparison();
  renderGoalsHome();
  renderTransactionList();
  renderAccountsList();
  populateAccountSelects();
  populateReportFilters();
  renderReportTable();
  renderSpendingTrend();
  refreshIcons();
}

// ---------- Monthly Budget ----------
function renderBudgetCard() {
  const btn = document.getElementById('budget-card-btn');
  const emptyState = document.getElementById('budget-empty-state');
  const setState = document.getElementById('budget-set-state');

  if (currentAccountFilter === null) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');

  const acc = accounts.find(a => a.id === currentAccountFilter);
  const limit = acc && acc.monthlyBudget ? acc.monthlyBudget : null;

  if (!limit) {
    emptyState.classList.remove('hidden');
    setState.classList.add('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  setState.classList.remove('hidden');

  const spent = monthlySpent(currentAccountFilter);
  const pct = Math.min(100, (spent / limit) * 100);
  const bar = document.getElementById('budget-progress-bar');
  bar.style.width = pct + '%';
  bar.style.backgroundColor = spent > limit ? '#B3261E' : (pct >= 80 ? '#C9A227' : '#5E1220');

  document.getElementById('budget-amounts').textContent = `${fmtMoney(spent)} / ${fmtMoney(limit)}`;
  const statusEl = document.getElementById('budget-status-text');
  const diff = fromSen(Math.abs(toSen(limit) - toSen(spent)));
  if (spent > limit) {
    statusEl.textContent = tr('Over budget by {x} this month', { x: fmtMoney(diff) });
  } else {
    statusEl.textContent = tr('{x} left this month', { x: fmtMoney(diff) });
  }
}

// Shows a mini progress bar on Home for every category that has its own
// budget set for the current account, so spending against per-category
// limits is visible at a glance without opening Reports.
function renderCategoryBudgetProgress() {
  const section = document.getElementById('category-budget-section');
  const container = document.getElementById('category-budget-list');
  if (currentAccountFilter === null) { section.classList.add('hidden'); return; }

  const budgets = categoryBudgets.filter(cb => cb.accountId === currentAccountFilter && cb.limit > 0);
  if (budgets.length === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  container.innerHTML = budgets.map(cb => {
    const cat = categoryById(cb.categoryId);
    if (!cat) return ''; // referenced category was deleted; skip the stale budget entry
    const spent = sumAmounts(transactions
      .filter(t => t.accountId === currentAccountFilter && t.categoryId === cb.categoryId
        && isRealExpense(t) && new Date(t.datetime) >= monthStart), t => t.amount);
    const pct = Math.min(100, (spent / cb.limit) * 100);
    const barColor = spent > cb.limit ? '#B3261E' : (pct >= 80 ? '#C9A227' : '#5E1220');
    const excess = fromSen(toSen(spent) - toSen(cb.limit));
    return `
      <div class="flex items-center gap-3">
        <span class="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 shrink-0">${iconSvg(cat.icon, 'w-4 h-4')}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1 gap-2">
            <span class="text-xs font-semibold text-ink/70 truncate">${escapeHtml(cat.name)}</span>
            <span class="text-xs font-semibold text-ink/70 shrink-0">${fmtMoney(spent)} / ${fmtMoney(cb.limit)}</span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-primary-50 overflow-hidden">
            <div class="h-full rounded-full" style="width:${pct}%;background-color:${barColor}"></div>
          </div>
          ${excess > 0 ? `<p class="text-[10px] text-danger font-semibold mt-1">${tr('Over by {x}', { x: fmtMoney(excess) })}</p>` : ''}
        </div>
      </div>`;
  }).join('');
  refreshIcons(container);
}

function openBudgetModal() {
  if (currentAccountFilter === null) return;
  const acc = accounts.find(a => a.id === currentAccountFilter);
  document.getElementById('budget-modal-account-label').textContent = tr('For {name}', { name: accountName(currentAccountFilter) });
  document.getElementById('budget-input').value = acc && acc.monthlyBudget ? acc.monthlyBudget : '';
  document.getElementById('budget-remove-btn').classList.toggle('hidden', !(acc && acc.monthlyBudget));
  openModal('budget-modal');
}

// ---------- Search Transactions ----------
function openSearchModal() {
  document.getElementById('search-input').value = '';
  renderSearchResults('');
  openModal('search-modal');
  refreshIcons();
  setTimeout(() => document.getElementById('search-input').focus(), 300);
}

function renderSearchResults(query) {
  const resultsEl = document.getElementById('search-results');
  const q = query.trim().toLowerCase();
  const scoped = filteredTransactions(); // already scoped to currentAccountFilter

  let matches;
  if (!q) {
    matches = scoped.slice(0, 30);
  } else {
    matches = scoped.filter(t => {
      const noteMatch = (t.note || '').toLowerCase().includes(q);
      const amountMatch = t.amount.toFixed(2).includes(q) || String(t.amount).includes(q);
      return noteMatch || amountMatch;
    });
  }

  if (matches.length === 0) {
    resultsEl.innerHTML = `<p class="text-sm text-ink/40 text-center py-8">${q ? 'No matching transactions' : 'No transactions yet'}</p>`;
    return;
  }

  resultsEl.innerHTML = matches.map(t => {
    const isIncome = t.type === 'income';
    const cat = t.categoryId ? categoryById(t.categoryId) : null;
    const title = t.note ? escapeHtml(t.note) : (cat ? escapeHtml(cat.name) : (isIncome ? 'In' : 'Out'));
    return `
      <button class="search-result-row w-full flex items-center gap-3 bg-white rounded-2xl p-3 border border-primary-100 active:scale-[.98] transition text-left" data-id="${t.id}">
        <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${isIncome ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}">
          <i data-lucide="${isIncome ? 'arrow-down-circle' : 'arrow-up-circle'}" class="w-4 h-4"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold truncate">${title}</p>
          <p class="text-[11px] text-ink/45">${fmtDate(t.datetime)}</p>
        </div>
        <p class="text-sm font-bold shrink-0 ${isIncome ? 'text-emerald-600' : 'text-rose-600'}">${isIncome ? '+' : '-'} ${fmtMoney(t.amount)}</p>
      </button>`;
  }).join('');

  refreshIcons(resultsEl);
  resultsEl.querySelectorAll('.search-result-row').forEach(row => {
    row.addEventListener('click', () => {
      closeModal('search-modal');
      openDetail(Number(row.dataset.id));
    });
  });
}

// ---------- Transaction Detail ----------
function openDetail(id) {
  const t = transactions.find(t => t.id === id);
  if (!t) return;
  const isIncome = t.type === 'income';
  const transfer = isTransfer(t);
  const cat = t.categoryId ? categoryById(t.categoryId) : null;
  const content = document.getElementById('detail-content');
  content.innerHTML = `
    <div class="flex items-center justify-between">
      <div>
        <p class="text-xs text-ink/45">${escapeHtml(accountName(t.accountId))} · ${fmtDate(t.datetime)}</p>
        <p class="font-display font-bold text-xl mt-1 ${isIncome ? 'text-emerald-600' : 'text-rose-600'}">${isIncome ? '+' : '-'} ${fmtMoney(t.amount)}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${transfer ? 'bg-primary-100 text-primary-700' : isIncome ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}">${transfer ? 'Transfer' : isIncome ? 'In' : 'Out'}</span>
    </div>
    ${transfer ? `
    <p class="text-xs text-ink/50 leading-relaxed">This is one side of a transfer between your accounts. It changes the balance but isn't counted as income or spending. Deleting it removes both sides.</p>` : `
    <div class="flex items-center gap-2 bg-white rounded-2xl border border-primary-100 px-4 py-3">
      <span class="w-7 h-7 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 shrink-0">${iconSvg(cat ? cat.icon : 'tag', 'w-3.5 h-3.5')}</span>
      <span class="text-sm font-medium text-ink/70">${cat ? escapeHtml(cat.name) : 'Uncategorized'}</span>
    </div>`}
    <div class="bg-white rounded-2xl border border-primary-100 p-4">
      <p class="text-[11px] font-semibold text-ink/50 uppercase mb-1">Note</p>
      <p class="text-sm">${t.note ? escapeHtml(t.note) : '—'}</p>
    </div>
    ${t.receipts && t.receipts.length ? `
      <div>
        <p class="text-[11px] font-semibold text-ink/50 uppercase mb-2">${tr('Receipts ({n})', { n: t.receipts.length })}</p>
        <div class="grid grid-cols-3 gap-2">
          ${t.receipts.map(r => `<button type="button" class="receipt-thumb bg-ink/5 rounded-xl border border-primary-100 h-24 flex items-center justify-center overflow-hidden" data-src="${receiptSrc(r)}"><img src="${receiptSrc(r)}" class="max-w-full max-h-full object-contain" /></button>`).join('')}
        </div>
      </div>` : ''}
    <div class="grid ${transfer ? 'grid-cols-1' : 'grid-cols-2'} gap-3">
      ${transfer ? '' : `<button id="edit-tx-btn" class="w-full bg-primary-100 text-primary-700 rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2">
        <i data-lucide="edit" class="w-4 h-4"></i> Edit
      </button>`}
      <button id="delete-tx-btn" class="w-full bg-rose-50 text-rose-600 rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2">
        <i data-lucide="trash-2" class="w-4 h-4"></i> ${transfer ? 'Delete Transfer' : 'Delete'}
      </button>
    </div>
  `;
  refreshIcons();
  content.querySelectorAll('.receipt-thumb').forEach(btn => {
    btn.addEventListener('click', () => openReceiptViewer(btn.dataset.src));
  });
  const editBtn = document.getElementById('edit-tx-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    closeModal('detail-modal');
    openEditRecord(t);
  });
  document.getElementById('delete-tx-btn').addEventListener('click', () => {
    closeModal('detail-modal');
    deleteTransactionWithUndo(t);
  });
  openModal('detail-modal');
}

// Deletes right away (so the change is safely committed to IndexedDB even
// if the page closes before the undo window ends), while "Undo" restores
// the exact same record — including its original id — by writing it back.
// A transfer leg is never deleted on its own: both sides go (and come back
// on undo) together, so balances across accounts stay consistent.
function deleteTransactionWithUndo(tx) {
  const removed = isTransfer(tx)
    ? transactions.filter(t2 => t2.transferId === tx.transferId)
    : [tx];
  const removedIds = new Set(removed.map(r => r.id));
  transactions = transactions.filter(t2 => !removedIds.has(t2.id));
  renderAll();

  idbAtomic(['transactions'], (t) => {
    const store = t.objectStore('transactions');
    removed.forEach(r => store.delete(r.id));
  }).catch(err => console.error('Delete failed', err));

  showToast(isTransfer(tx) ? 'Transfer deleted' : 'Transaction deleted', {
    duration: 4000,
    undo: async () => {
      try {
        // put() with an explicit id restores each record exactly
        await idbAtomic(['transactions'], (t) => {
          const store = t.objectStore('transactions');
          removed.forEach(r => store.put(r));
        });
        await loadAllData();
        renderAll();
        showToast('Transaction restored');
      } catch (err) {
        console.error('Restore failed', err);
        showToast('Could not restore transaction');
      }
    }
  });
}

// Human-readable period for file names and the PDF header, built from the
// filter VALUES (not the displayed option text, which changes with language).
function reportPeriodLabel() {
  const monthVal = document.getElementById('report-month').value;
  const yearVal = document.getElementById('report-year').value;
  const monthLabel = monthVal === 'all' ? '' : MONTHS[Number(monthVal)];
  const yearLabel = yearVal === 'all' ? '' : yearVal;
  return (!monthLabel && !yearLabel) ? tr('All Time') : `${monthLabel} ${yearLabel}`.trim();
}

// ---------- PDF Statement Generation ----------
// A small set of shared drawing helpers give every page of the PDF a
// consistent letterhead and footer, so the exported document reads like a
// real bank/financial statement rather than a raw data dump.

function pdfDrawLetterhead(doc, subtitleLines) {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(61, 12, 20); // primary-900 (maroon)
  doc.rect(0, 0, pageWidth, 26, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(15);
  doc.text('DUIT TRACKER', 14, 11.5);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(241, 222, 225); // primary-100
  doc.text(tr('Financial Statement'), 14, 17.5);

  doc.setFontSize(7.5);
  doc.setTextColor(238, 216, 220);
  subtitleLines.forEach((line, i) => {
    doc.text(line, pageWidth - 14, 8.5 + i * 4, { align: 'right' });
  });
}

function pdfDrawFooter(doc, pageNum, pageCount) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setDrawColor(225, 225, 220);
  doc.setLineWidth(0.2);
  doc.line(14, pageHeight - 14, pageWidth - 14, pageHeight - 14);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(140, 140, 140);
  doc.text(tr('Generated by Duit Tracker — Personal Finance Tracker'), 14, pageHeight - 9);
  doc.text(tr('Page {n} of {total}', { n: pageNum, total: pageCount }), pageWidth - 14, pageHeight - 9, { align: 'right' });
}

function pdfDrawSummaryBar(doc, y, opening, totalIncome, totalExpense, closing) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  const usableWidth = pageWidth - marginX * 2;
  const gap = 4;
  const boxW = (usableWidth - gap * 3) / 4;
  const boxH = 16;

  const items = [
    { label: tr('BROUGHT FORWARD'), value: fmtMoney(opening), color: [36, 22, 25] },
    { label: tr('TOTAL IN'), value: fmtMoney(totalIncome), color: [4, 120, 87] },
    { label: tr('TOTAL OUT'), value: fmtMoney(totalExpense), color: [179, 38, 30] },
    { label: tr('CARRIED FORWARD'), value: fmtMoney(closing), color: [94, 18, 32] }
  ];

  items.forEach((item, i) => {
    const x = marginX + i * (boxW + gap);
    doc.setFillColor(247, 245, 240);
    doc.roundedRect(x, y, boxW, boxH, 1.5, 1.5, 'F');
    doc.setFont(undefined, 'normal');
    doc.setFontSize(6.2);
    doc.setTextColor(120, 120, 115);
    doc.text(item.label, x + 3, y + 5.5);
    doc.setFont(undefined, 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(item.color[0], item.color[1], item.color[2]);
    doc.text(item.value, x + 3, y + 12.5);
  });
  doc.setFont(undefined, 'normal');
}

function generatePDF() {
  if (accounts.length === 0) { showToast('Create an account first'); return; }
  if (!window.jspdf || typeof window.jspdf.jsPDF !== 'function') {
    showToast('PDF library failed to load — check your internet connection and try again');
    return;
  }

  const { rows, opening, closing, stmtIncome: totalIncome, stmtExpense: totalExpense } = getReportFilteredTx();

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const periodLabel = reportPeriodLabel();
  const accLabel = currentAccountFilter === null ? tr('No Account') : accountName(currentAccountFilter);
  const generatedLabel = new Date().toLocaleString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const subtitleLines = [tr('Period: {x}', { x: periodLabel }), tr('Account: {x}', { x: accLabel }), tr('Generated: {x}', { x: generatedLabel })];

  // Chronological (oldest-first) rows for the statement body, matching how
  // real bank statements read top-to-bottom.
  const chronoRows = [...rows].sort((a, b) => {
    const diff = new Date(a.datetime) - new Date(b.datetime);
    return diff !== 0 ? diff : a.id - b.id;
  });

  const bodyRows = chronoRows.map(t => [
    fmtDate(t.datetime),
    accountName(t.accountId),
    t.note || (t.type === 'income' ? 'In' : 'Out'),
    (t.type === 'income' ? '+' : '-') + fmtMoney(t.amount),
    fmtMoney(t.runningBalance)
  ]);

  const openingRow = [{ content: tr('Balance Brought Forward'), colSpan: 3, styles: { fontStyle: 'bold' } }, '', fmtMoney(opening)];
  const closingRow = [{ content: tr('Balance Carried Forward'), colSpan: 3, styles: { fontStyle: 'bold' } }, '', fmtMoney(closing)];
  const fullBody = [openingRow, ...bodyRows, closingRow];
  const closingRowIndex = fullBody.length - 1;

  doc.autoTable({
    head: [[tr('Date'), tr('Account'), tr('Note'), tr('Amount'), tr('Balance')]],
    body: fullBody,
    startY: 50,
    margin: { top: 32, bottom: 18 },
    styles: { fontSize: 8, cellPadding: 3, textColor: [36, 22, 25], lineColor: [235, 233, 227], lineWidth: 0.15 },
    headStyles: { fillColor: [94, 18, 32], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: [250, 249, 246] },
    columnStyles: {
      0: { cellWidth: 26 },
      1: { cellWidth: 30 },
      2: { cellWidth: 'auto' },
      3: { halign: 'right', cellWidth: 26 },
      4: { halign: 'right', cellWidth: 30 }
    },
    didParseCell: (data) => {
      if (data.section === 'body' && (data.row.index === 0 || data.row.index === closingRowIndex)) {
        data.cell.styles.fillColor = [241, 222, 225];
        data.cell.styles.textColor = [61, 12, 20];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: () => {
      pdfDrawLetterhead(doc, subtitleLines);
      if (doc.internal.getCurrentPageInfo().pageNumber === 1) {
        pdfDrawSummaryBar(doc, 30, opening, totalIncome, totalExpense, closing);
      }
    }
  });

  // Appendix: receipt images grid, one letterhead per appendix page too.
  // Each receipt is fit *within* its cell preserving its true aspect ratio
  // (never stretched or cropped) — a light frame is drawn behind it so any
  // leftover space in the cell reads as a clean matte rather than a gap.
  const receiptTx = chronoRows.filter(t => t.receipts && t.receipts.length);
  if (receiptTx.length) {
    doc.addPage();
    pdfDrawLetterhead(doc, [tr('Receipt Appendix')]);
    doc.setFont(undefined, 'bold');
    doc.setFontSize(11);
    doc.setTextColor(28, 43, 40);
    doc.text(tr('Attached Receipts'), 14, 34);
    doc.setFont(undefined, 'normal');

    const cellW = 85, cellH = 62, marginX = 14, marginTop = 40, gapX = 8, gapY = 14;
    let x = marginX, y = marginTop, col = 0;

    const fitContain = (imgW, imgH, boxW, boxH) => {
      const scale = Math.min(boxW / imgW, boxH / imgH);
      return { w: imgW * scale, h: imgH * scale };
    };

    receiptTx.forEach(t => {
      t.receipts.forEach((receipt, idx) => {
        if (y + cellH + 10 > pageHeight - 18) {
          doc.addPage();
          pdfDrawLetterhead(doc, [tr('Receipt Appendix')]);
          x = marginX; y = marginTop; col = 0;
        }
        const src = receiptSrc(receipt);
        const dims = receiptDims(receipt);
        try {
          doc.setDrawColor(225, 225, 220);
          doc.setFillColor(252, 251, 249);
          doc.rect(x, y, cellW, cellH, 'FD');

          let drawW = cellW, drawH = cellH, drawX = x, drawY = y;
          if (dims) {
            const fitted = fitContain(dims.width, dims.height, cellW, cellH);
            drawW = fitted.w; drawH = fitted.h;
            drawX = x + (cellW - drawW) / 2;
            drawY = y + (cellH - drawH) / 2;
          }
          doc.addImage(src, 'JPEG', drawX, drawY, drawW, drawH, undefined, 'FAST');
        } catch (e) { /* skip invalid image */ }
        doc.setFontSize(7.5);
        doc.setTextColor(90, 90, 85);
        const label = `${fmtDateOnly(t.datetime)} · ${(t.note || (t.type === 'income' ? 'In' : 'Out'))}${t.receipts.length > 1 ? ' (' + (idx + 1) + '/' + t.receipts.length + ')' : ''}`;
        doc.text(label.length > 48 ? label.slice(0, 48) + '…' : label, x, y + cellH + 5, { maxWidth: cellW });

        col++;
        if (col >= 2) { col = 0; x = marginX; y += cellH + gapY; }
        else { x = marginX + cellW + gapX; }
      });
    });
  }

  // Footer + page numbers are drawn last, in one pass over every page, so
  // the total page count is accurate even after the appendix adds pages.
  const finalPageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= finalPageCount; i++) {
    doc.setPage(i);
    pdfDrawFooter(doc, i, finalPageCount);
  }

  const fileSafePeriod = periodLabel.replace(/\s+/g, '-');
  // Build our own Blob + download link (the same proven pattern used by
  // exportBackup()) instead of relying on jsPDF's built-in .save(), which
  // internally does its own blob/anchor handling and can silently fail on
  // some browsers when the page itself was opened via file:// — the most
  // common reason "Generate PDF" appears to do nothing.
  const pdfBlob = doc.output('blob');
  const url = URL.createObjectURL(pdfBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `duit-tracker-statement-${fileSafePeriod}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('PDF statement downloaded');
}

// ---------- Export CSV ----------
function exportCSV() {
  if (accounts.length === 0) { showToast('Create an account first'); return; }
  const { rows, opening, closing } = getReportFilteredTx();
  const chronoRows = [...rows].sort((a, b) => {
    const diff = new Date(a.datetime) - new Date(b.datetime);
    return diff !== 0 ? diff : a.id - b.id;
  });

  const escapeCsv = (val) => {
    const s = String(val);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csvRow = (arr) => arr.map(escapeCsv).join(',');

  const lines = [csvRow(['Date', 'Account', 'Note', 'Type', 'Amount', 'Balance'])];
  lines.push(csvRow(['', '', 'Balance Brought Forward', '', '', opening.toFixed(2)]));
  chronoRows.forEach(t => {
    lines.push(csvRow([
      fmtDateOnly(t.datetime),
      accountName(t.accountId),
      t.note || (t.type === 'income' ? 'In' : 'Out'),
      t.type === 'income' ? 'In' : 'Out',
      t.amount.toFixed(2),
      t.runningBalance.toFixed(2)
    ]));
  });
  lines.push(csvRow(['', '', 'Balance Carried Forward', '', '', closing.toFixed(2)]));

  // A UTF-8 BOM so Excel (which otherwise guesses the wrong encoding for
  // non-ASCII text like "RM" symbols or accented notes) opens this cleanly.
  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const periodLabel = reportPeriodLabel().replace(/\s+/g, '-');
  a.href = url;
  a.download = `duit-tracker-statement-${periodLabel}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('CSV exported');
}

// ---------- Export / Import JSON ----------
// Version 2 backups hold every store plus display preferences, so a
// restore on a new device brings back categories, budgets, recurring
// rules and goals too (version 1 only held accounts + transactions).
// The PIN is deliberately NOT included: a backup file should never carry
// anything that unlocks the app.
const BACKUP_STORES = ['accounts', 'transactions', 'recurring', 'categories', 'categoryBudgets', 'goals'];
const BACKUP_SETTING_KEYS = ['duitku-dark-mode', 'duitku-backup-reminder', 'duitku-categories-seeded', 'duitku-lang', 'duitku-transfers-tagged'];

async function exportBackup() {
  const settings = {};
  BACKUP_SETTING_KEYS.forEach(k => {
    try { const v = localStorage.getItem(k); if (v !== null) settings[k] = v; } catch (e) { /* ignore */ }
  });
  const data = {
    app: 'DuitTracker', version: 2, exportedAt: new Date().toISOString(),
    accounts, transactions, recurring, categories, categoryBudgets, goals, settings
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `duit-tracker-backup-${nowLocalDatetime().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  try { localStorage.setItem('duitku-last-backup', String(Date.now())); } catch (e) { /* ignore */ }
  renderBackupStatus();
  showToast('Backup exported');
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.accounts) || !Array.isArray(data.transactions)) throw new Error('Invalid backup file');
    // A version 1 file only knows accounts + transactions; the other stores
    // on this device are left alone rather than wiped.
    const storesInFile = BACKUP_STORES.filter(s => Array.isArray(data[s]));
    const message = storesInFile.length === BACKUP_STORES.length
      ? tr('Importing will REPLACE all current data on this device (accounts, transactions, categories, budgets, recurring and goals) with the backup contents. Continue?')
      : tr('This is an older backup that only contains accounts and transactions. Importing will REPLACE those on this device; categories, budgets, recurring and goals here are kept. Continue?');
    if (!confirm(message)) return;

    // One atomic transaction: a bad record aborts the whole restore and
    // leaves the current data untouched, instead of half-replacing it.
    await idbAtomic(storesInFile, (t) => {
      storesInFile.forEach(s => {
        const store = t.objectStore(s);
        store.clear();
        data[s].forEach(rec => store.put(rec));
      });
    });

    if (data.settings && typeof data.settings === 'object') {
      Object.entries(data.settings).forEach(([k, v]) => {
        if (BACKUP_SETTING_KEYS.includes(k) && typeof v === 'string') {
          try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
        }
      });
      setDarkMode(localStorage.getItem('duitku-dark-mode') === '1');
      setBackupReminder(isBackupReminderEnabled());
    }

    await loadAllData(); // also re-selects a valid account via ensureAccountSelection()
    // Re-run the legacy transfer pairing for whatever was just imported
    // (it only touches untagged "Transfer to/from" pairs, so it's idempotent).
    try { localStorage.removeItem('duitku-transfers-tagged'); } catch (e) { /* ignore */ }
    await tagLegacyTransfersOnce();
    renderAll();
    closeModal('side-menu');
    showToast('Backup imported successfully');
  } catch (err) {
    console.error(err);
    showToast('Failed to import: invalid backup file');
  }
}

// ---------- Dark Mode ----------
// The theme class itself is already applied pre-paint by the inline script
// in <head>; this function keeps the toggle UI and future changes in sync.
function setDarkMode(isDark) {
  document.documentElement.classList.toggle('dark', isDark);
  try { localStorage.setItem('duitku-dark-mode', isDark ? '1' : '0'); } catch (e) { /* ignore */ }
  const toggle = document.getElementById('dark-mode-toggle');
  const knob = document.getElementById('dark-mode-toggle-knob');
  if (toggle) {
    toggle.setAttribute('aria-checked', String(isDark));
    toggle.classList.toggle('bg-primary-700', isDark);
    toggle.classList.toggle('bg-primary-100', !isDark);
  }
  if (knob) {
    knob.classList.toggle('translate-x-5', isDark);
  }
}

// ---------- Backup Reminder ----------
// Since every account/transaction lives only in this browser's IndexedDB,
// losing that (clearing site data, switching devices, browser reinstall)
// means losing everything unless a .json backup was exported first. This
// nudges the person to do that periodically, without being naggy about it.
const BACKUP_REMINDER_THRESHOLD_DAYS = 14;

function daysSinceLastBackup() {
  let last;
  try { last = localStorage.getItem('duitku-last-backup'); } catch (e) { return null; }
  if (!last) return null;
  return Math.floor((Date.now() - Number(last)) / (1000 * 60 * 60 * 24));
}

function isBackupReminderEnabled() {
  try {
    const v = localStorage.getItem('duitku-backup-reminder');
    return v === null ? true : v === '1'; // enabled by default until explicitly turned off
  } catch (e) { return true; }
}

function renderBackupStatus() {
  const el = document.getElementById('backup-status-text');
  if (!el) return;
  const days = daysSinceLastBackup();
  el.textContent = days === null ? tr('Last backup: Never')
    : days === 0 ? tr('Last backup: Today')
    : days === 1 ? tr('Last backup: 1 day ago')
    : tr('Last backup: {n} days ago', { n: days });
}

function setBackupReminder(isOn) {
  try { localStorage.setItem('duitku-backup-reminder', isOn ? '1' : '0'); } catch (e) { /* ignore */ }
  const toggle = document.getElementById('backup-reminder-toggle');
  const knob = document.getElementById('backup-reminder-toggle-knob');
  if (toggle) {
    toggle.setAttribute('aria-checked', String(isOn));
    toggle.classList.toggle('bg-primary-700', isOn);
    toggle.classList.toggle('bg-primary-100', !isOn);
  }
  if (knob) knob.classList.toggle('translate-x-5', isOn);
}

// Called once after accounts/transactions are loaded. Only nudges when
// there's real data worth protecting, the person hasn't turned reminders
// off, and it's genuinely been a while (or never) since the last export.
function maybeShowBackupReminder() {
  if (!isBackupReminderEnabled()) return;
  if (accounts.length === 0) return;
  const days = daysSinceLastBackup();
  if (days === null) {
    showToast("You haven't backed up yet — export from the menu to keep your data safe");
  } else if (days >= BACKUP_REMINDER_THRESHOLD_DAYS) {
    showToast(tr("It's been {n} days since your last backup — export one from the menu", { n: days }));
  }
}

// ---------- PIN Lock ----------
// A lightweight app-lock (not encryption) — it hides the UI behind a PIN
// screen so someone glancing at or briefly picking up the device can't see
// transaction data. The PIN itself is never stored, only a slow salted
// hash: PBKDF2-SHA256 with a random per-device salt, stored as
// "pbkdf2$<iterations>$<saltHex>$<hashHex>". A 4–6 digit PIN has at most a
// million combinations, so the slow hash plus the attempt limit below is
// what makes guessing impractical. Hashes from older versions (plain
// salted SHA-256) are still accepted and upgraded on the next correct entry.
let pinModalMode = 'set'; // 'set' | 'change' | 'remove'

const PBKDF2_ITERATIONS = 150000;

async function pbkdf2Hex(secret, saltHex, iterations) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}

// legacyHash is only used where Web Crypto is missing (very old browsers).
async function makeSecretHash(secret, legacyHash) {
  if (!(window.crypto && crypto.subtle)) return legacyHash(secret);
  const saltHex = randomHex(16);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${await pbkdf2Hex(secret, saltHex, PBKDF2_ITERATIONS)}`;
}

// legacyHash is the pre-PBKDF2 scheme; kept only to verify old stored hashes.
async function verifySecret(secret, stored, legacyHash) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const [, iter, saltHex, hashHex] = stored.split('$');
    return (await pbkdf2Hex(secret, saltHex, Number(iter))) === hashHex;
  }
  return (await legacyHash(secret)) === stored;
}

async function verifyPin(pin) {
  let stored;
  try { stored = localStorage.getItem('duitku-pin-hash'); } catch (e) { return false; }
  const ok = await verifySecret(pin, stored, hashPin);
  if (ok && !stored.startsWith('pbkdf2$') && window.crypto && crypto.subtle) {
    try { localStorage.setItem('duitku-pin-hash', await makeSecretHash(pin, hashPin)); } catch (e) { /* ignore */ }
  }
  return ok;
}

async function verifyRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  let stored;
  try { stored = localStorage.getItem('duitku-recovery-hash'); } catch (e) { return false; }
  return verifySecret(normalized, stored, () => hashRecoveryCode(code));
}

function normalizeRecoveryCode(code) { return code.toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// ---------- Attempt limiting ----------
// After 5 wrong PINs/recovery codes in a row, further attempts are blocked
// for 30 s, doubling with each extra miss (capped at 15 min). Stored in
// localStorage so reloading the page doesn't reset the wait.
const PIN_FREE_ATTEMPTS = 5;

function readPinThrottle() {
  try { return JSON.parse(localStorage.getItem('duitku-pin-attempts')) || { fails: 0, until: 0 }; }
  catch (e) { return { fails: 0, until: 0 }; }
}
function pinWaitSeconds() {
  return Math.max(0, Math.ceil((readPinThrottle().until - Date.now()) / 1000));
}
function registerPinFailure() {
  const s = readPinThrottle();
  s.fails += 1;
  if (s.fails >= PIN_FREE_ATTEMPTS) {
    const waitMs = Math.min(15 * 60 * 1000, 30000 * Math.pow(2, s.fails - PIN_FREE_ATTEMPTS));
    s.until = Date.now() + waitMs;
  }
  try { localStorage.setItem('duitku-pin-attempts', JSON.stringify(s)); } catch (e) { /* ignore */ }
}
function clearPinFailures() {
  try { localStorage.removeItem('duitku-pin-attempts'); } catch (e) { /* ignore */ }
}
function pinWaitMessage(seconds) {
  return seconds >= 60
    ? tr('Too many attempts. Try again in {n} min.', { n: Math.ceil(seconds / 60) })
    : tr('Too many attempts. Try again in {n} s.', { n: seconds });
}

async function sha256Hex(input) {
  if (window.crypto && window.crypto.subtle) {
    try {
      const enc = new TextEncoder().encode(input);
      const buf = await window.crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* fall through to the simple hash below */ }
  }
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return 'fallback-' + hash.toString(16);
}

async function hashPin(pin) {
  return sha256Hex('duitku-salt-' + pin);
}

// Recovery codes use a separate salt namespace from PINs so the two hashes
// can never collide, and are normalized (uppercased, dashes stripped)
// before hashing so it doesn't matter how the person types it back in.
async function hashRecoveryCode(code) {
  return sha256Hex('duitku-recovery-salt-' + code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

// Avoids visually-ambiguous characters (0/O, 1/I/L) so a screenshotted or
// hand-copied code is easy to read back correctly.
// Uses the cryptographic RNG; 32 symbols means `byte & 31` picks each one
// with no bias.
function generateRecoveryCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) group += chars[bytes[g * 4 + i] & 31];
    groups.push(group);
  }
  return groups.join('-');
}

function hasPinSet() {
  try { return !!localStorage.getItem('duitku-pin-hash'); } catch (e) { return false; }
}

function updatePinMenuLabel() {
  const label = document.getElementById('pin-lock-label');
  if (label) label.textContent = hasPinSet() ? 'Change / Remove PIN' : 'Set PIN Lock';
}

function renderPinModalMode() {
  const titleEl = document.getElementById('pin-modal-title');
  const currentWrap = document.getElementById('pin-current-wrap');
  const newWrap = document.getElementById('pin-new-wrap');
  const confirmWrap = document.getElementById('pin-confirm-wrap');
  const submitBtn = document.getElementById('pin-submit-btn');
  const removeBtn = document.getElementById('pin-remove-btn');

  if (pinModalMode === 'set') {
    titleEl.textContent = 'Set PIN Lock';
    currentWrap.classList.add('hidden');
    newWrap.classList.remove('hidden');
    confirmWrap.classList.remove('hidden');
    submitBtn.textContent = 'Set PIN';
    removeBtn.classList.add('hidden');
  } else if (pinModalMode === 'change') {
    titleEl.textContent = 'Change PIN';
    currentWrap.classList.remove('hidden');
    newWrap.classList.remove('hidden');
    confirmWrap.classList.remove('hidden');
    submitBtn.textContent = 'Update PIN';
    removeBtn.classList.remove('hidden');
  } else if (pinModalMode === 'remove') {
    titleEl.textContent = 'Remove PIN Lock';
    currentWrap.classList.remove('hidden');
    newWrap.classList.add('hidden');
    confirmWrap.classList.add('hidden');
    submitBtn.textContent = 'Remove PIN';
    removeBtn.classList.add('hidden');
  }
}

function openPinModal() {
  pinModalMode = hasPinSet() ? 'change' : 'set';
  document.getElementById('pin-form').reset();
  renderPinModalMode();
  openModal('pin-modal');
  refreshIcons();
}

// ---------- Event Wiring ----------
// IMPORTANT: all click/tap listeners are wired up FIRST and synchronously,
// before any async storage work runs. This guarantees the UI stays
// interactive even if IndexedDB is slow, blocked, or unavailable
// (e.g. some browsers restrict/delay IndexedDB when a file is opened
// directly via file:// instead of served over http/https).
document.addEventListener('DOMContentLoaded', () => {
  try { startAutoTranslate(); } catch (err) { console.error('Translation failed', err); }
  try { refreshIcons(); } catch (err) { console.error('Icon render failed', err); }
  // Sync the toggle's visual state with whatever the pre-paint <head>
  // script already applied (reads the class rather than localStorage
  // directly, so both stay in agreement even if storage was unavailable).
  setDarkMode(document.documentElement.classList.contains('dark'));
  updatePinMenuLabel();
  setBackupReminder(isBackupReminderEnabled());
  renderBackupStatus();
  wireUpEventListeners();
  initStorageAndData();
  // Offline support / "Add to Home Screen". Service workers only run over
  // http(s), so this is skipped when the file is opened directly.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('Service worker registration failed', err));
  }
});

function wireUpEventListeners() {
  // Bottom nav
  document.querySelectorAll('.tab-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('fab-add').addEventListener('click', () => openAddRecord());
  document.getElementById('menu-btn').addEventListener('click', () => openModal('side-menu'));

  // "More" sheet — slides up from the bottom nav and holds every
  // management destination (Accounts, Categories, Budgets, Recurring,
  // Transfer). Each button below is wired individually further down.
  document.getElementById('more-tab-btn').addEventListener('click', () => openModal('more-modal'));

  // Account switcher (icon button in the top header)
  document.getElementById('switch-account-btn').addEventListener('click', () => openSwitchModal());
  document.getElementById('switch-new-account-btn').addEventListener('click', () => {
    closeModal('switch-modal');
    switchView('accounts-view');
    openModal('new-account-modal');
    document.getElementById('acc-name').focus();
  });

  // Manage Accounts, Categories, Budgets — all accessed from the More sheet
  document.getElementById('more-manage-accounts-btn').addEventListener('click', () => {
    closeModal('more-modal');
    switchView('accounts-view');
  });
  document.getElementById('manage-categories-open-btn').addEventListener('click', () => {
    closeModal('more-modal');
    openCategoryManageModal();
  });
  document.getElementById('manage-budgets-open-btn').addEventListener('click', () => {
    closeModal('more-modal');
    openBudgetManageModal();
  });
  document.getElementById('more-transfer-btn').addEventListener('click', () => {
    closeModal('more-modal');
    switchView('transfer-view');
  });

  // Dark mode toggle, in the hamburger side menu
  document.getElementById('dark-mode-toggle').addEventListener('click', () => {
    setDarkMode(!document.documentElement.classList.contains('dark'));
  });

  // Language, in the hamburger side menu. Reloading is the simplest way to
  // re-render every screen (and the static markup) in the new language.
  const languageSelect = document.getElementById('language-select');
  languageSelect.value = LANG;
  languageSelect.addEventListener('change', () => {
    try { localStorage.setItem('duitku-lang', languageSelect.value); } catch (err) { /* ignore */ }
    location.reload();
  });

  // Backup reminder toggle, in the hamburger side menu
  document.getElementById('backup-reminder-toggle').addEventListener('click', () => {
    setBackupReminder(!document.getElementById('backup-reminder-toggle').classList.contains('bg-primary-700'));
  });

  // Recurring Transactions
  const recurringDaySelect = document.getElementById('recurring-day');
  recurringDaySelect.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  document.getElementById('recurring-open-btn').addEventListener('click', () => {
    closeModal('more-modal');
    openRecurringModal();
  });
  document.querySelectorAll('.recurring-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.recurring-type-btn').forEach(b => {
        b.classList.remove('border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200', 'border-primary-100', 'text-ink/50');
      });
      const type = btn.dataset.type;
      document.getElementById('recurring-type').value = type;
      if (type === 'expense') btn.classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
      else btn.classList.add('border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
      const other = document.querySelector(`.recurring-type-btn[data-type="${type === 'expense' ? 'income' : 'expense'}"]`);
      other.classList.add('border-primary-100', 'text-ink/50');
    });
  });
  document.getElementById('recurring-frequency').addEventListener('change', (e) => {
    const freq = e.target.value;
    document.getElementById('recurring-weekday-wrap').classList.toggle('hidden', freq !== 'weekly');
    document.getElementById('recurring-monthday-wrap').classList.toggle('hidden', freq !== 'monthly');
  });
  document.getElementById('recurring-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentAccountFilter === null) return;
    const type = document.getElementById('recurring-type').value;
    const amount = parseAmount(document.getElementById('recurring-amount').value) || 0;
    const frequency = document.getElementById('recurring-frequency').value;
    const time = document.getElementById('recurring-time').value || '09:00';
    const dayOfMonth = Number(document.getElementById('recurring-day').value);
    const dayOfWeek = Number(document.getElementById('recurring-weekday').value);
    const note = document.getElementById('recurring-note').value.trim();
    if (amount <= 0) { showToast('Enter an amount greater than zero'); return; }
    try {
      const nextRun = computeNextRun(frequency, time, dayOfWeek, dayOfMonth);
      await idbAdd('recurring', {
        accountId: currentAccountFilter, type, amount, note,
        frequency, time, dayOfMonth, dayOfWeek,
        nextRun: nextRun.toISOString()
      });
      await loadAllData();
      renderRecurringList();
      document.getElementById('recurring-form').reset();
      document.getElementById('recurring-frequency').value = 'monthly';
      document.getElementById('recurring-weekday-wrap').classList.add('hidden');
      document.getElementById('recurring-monthday-wrap').classList.remove('hidden');
      showToast('Recurring transaction added');
    } catch (err) {
      console.error('Add recurring failed', err);
      showToast('Could not add recurring transaction');
    }
  });

  // Monthly Budget
  document.getElementById('budget-card-btn').addEventListener('click', () => openBudgetModal());
  document.getElementById('budget-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentAccountFilter === null) return;
    const amount = parseAmount(document.getElementById('budget-input').value) || 0;
    if (amount <= 0) { showToast('Enter an amount greater than zero'); return; }
    const acc = accounts.find(a => a.id === currentAccountFilter);
    if (!acc) return;
    try {
      acc.monthlyBudget = amount;
      await idbPut('accounts', acc);
      await loadAllData();
      renderAll();
      closeModal('budget-modal');
      showToast('Budget saved');
    } catch (err) {
      console.error('Budget save failed', err);
      showToast('Could not save budget');
    }
  });
  document.getElementById('budget-remove-btn').addEventListener('click', async () => {
    if (currentAccountFilter === null) return;
    const acc = accounts.find(a => a.id === currentAccountFilter);
    if (!acc) return;
    try {
      delete acc.monthlyBudget;
      await idbPut('accounts', acc);
      await loadAllData();
      renderAll();
      closeModal('budget-modal');
      showToast('Budget removed');
    } catch (err) {
      console.error('Budget remove failed', err);
      showToast('Could not remove budget');
    }
  });

  // Search Transactions
  document.getElementById('search-tx-btn').addEventListener('click', () => openSearchModal());
  document.getElementById('search-input').addEventListener('input', (e) => {
    renderSearchResults(e.target.value);
  });

  // PIN lock setup/change/remove, in the hamburger side menu
  document.getElementById('pin-lock-btn').addEventListener('click', () => {
    closeModal('side-menu');
    openPinModal();
  });
  document.getElementById('pin-remove-btn').addEventListener('click', () => {
    pinModalMode = 'remove';
    document.getElementById('pin-form').reset();
    renderPinModalMode();
  });
  document.getElementById('pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPin = document.getElementById('pin-current').value;
    const newPin = document.getElementById('pin-new').value;
    const confirmPin = document.getElementById('pin-confirm').value;

    if (pinModalMode !== 'set') {
      const wait = pinWaitSeconds();
      if (wait > 0) { showToast(pinWaitMessage(wait)); return; }
      if (!(await verifyPin(currentPin))) {
        registerPinFailure();
        showToast('Incorrect current PIN');
        return;
      }
      clearPinFailures();
    }

    if (pinModalMode === 'remove') {
      try {
        localStorage.removeItem('duitku-pin-hash');
        localStorage.removeItem('duitku-recovery-hash');
      } catch (err) { /* ignore */ }
      showToast('PIN lock removed');
      closeModal('pin-modal');
      updatePinMenuLabel();
      return;
    }

    if (!/^\d{4,6}$/.test(newPin)) { showToast('PIN must be 4–6 digits'); return; }
    if (newPin !== confirmPin) { showToast('PINs do not match'); return; }

    const newHash = await makeSecretHash(newPin, hashPin);
    try { localStorage.setItem('duitku-pin-hash', newHash); } catch (err) {
      showToast('Could not save PIN — storage unavailable');
      return;
    }
    clearPinFailures();

    // A fresh recovery code is issued every time the PIN is set or changed,
    // so there's always exactly one code that's guaranteed to still work.
    const recoveryCode = generateRecoveryCode();
    try {
      const recoveryHash = await makeSecretHash(normalizeRecoveryCode(recoveryCode), hashRecoveryCode);
      localStorage.setItem('duitku-recovery-hash', recoveryHash);
    } catch (err) { /* ignore — recovery code is a bonus, not required for the PIN itself to work */ }

    showToast(pinModalMode === 'set' ? 'PIN lock enabled' : 'PIN updated');
    closeModal('pin-modal');
    updatePinMenuLabel();

    document.getElementById('recovery-code-display').textContent = recoveryCode;
    openModal('recovery-code-modal');
    refreshIcons();
  });

  document.getElementById('recovery-code-done-btn').addEventListener('click', () => {
    closeModal('recovery-code-modal');
  });

  // Lock screen unlock form
  document.getElementById('lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = document.getElementById('lock-pin-input').value;
    const errorEl = document.getElementById('lock-error');
    const wait = pinWaitSeconds();
    if (wait > 0) {
      errorEl.textContent = pinWaitMessage(wait);
      errorEl.classList.remove('hidden');
      document.getElementById('lock-pin-input').value = '';
      return;
    }
    if (await verifyPin(entered)) {
      clearPinFailures();
      document.documentElement.classList.remove('pin-locked');
      errorEl.classList.add('hidden');
      document.getElementById('lock-pin-input').value = '';
    } else {
      registerPinFailure();
      const nowWait = pinWaitSeconds();
      errorEl.textContent = nowWait > 0 ? pinWaitMessage(nowWait) : tr('Incorrect PIN. Try again.');
      errorEl.classList.remove('hidden');
      document.getElementById('lock-pin-input').value = '';
      document.getElementById('lock-pin-input').focus();
    }
  });

  function resetLockScreenToNormalMode() {
    document.getElementById('lock-form').classList.remove('hidden');
    document.getElementById('lock-recovery-form').classList.add('hidden');
    document.getElementById('lock-subtitle').textContent = 'Enter your PIN to continue';
    document.getElementById('forgot-pin-btn').classList.remove('hidden');
    document.getElementById('wipe-pin-btn').classList.add('hidden');
    document.getElementById('lock-pin-input').value = '';
    document.getElementById('lock-recovery-input').value = '';
    document.getElementById('lock-error').classList.add('hidden');
    document.getElementById('lock-recovery-error').classList.add('hidden');
  }

  // Forgot PIN — switches the lock screen into recovery-code mode. The
  // recovery code (set whenever a PIN is created/changed) is the primary,
  // verified way back in; the "lost that too" link below it is the
  // last-resort unverified reset, kept only so nobody is ever permanently
  // locked out of their own data.
  document.getElementById('forgot-pin-btn').addEventListener('click', () => {
    document.getElementById('lock-form').classList.add('hidden');
    document.getElementById('lock-recovery-form').classList.remove('hidden');
    document.getElementById('lock-subtitle').textContent = 'Enter your recovery code to reset your PIN';
    document.getElementById('forgot-pin-btn').classList.add('hidden');
    document.getElementById('wipe-pin-btn').classList.remove('hidden');
  });

  document.getElementById('lock-recovery-cancel-btn').addEventListener('click', () => {
    resetLockScreenToNormalMode();
  });

  document.getElementById('lock-recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = document.getElementById('lock-recovery-input').value;
    const recoveryErrorEl = document.getElementById('lock-recovery-error');
    const wait = pinWaitSeconds();
    if (wait > 0) {
      recoveryErrorEl.textContent = pinWaitMessage(wait);
      recoveryErrorEl.classList.remove('hidden');
      return;
    }
    if (await verifyRecoveryCode(entered)) {
      clearPinFailures();
      try {
        localStorage.removeItem('duitku-pin-hash');
        localStorage.removeItem('duitku-recovery-hash');
      } catch (err) { /* ignore */ }
      document.documentElement.classList.remove('pin-locked');
      resetLockScreenToNormalMode();
      updatePinMenuLabel();
      showToast('Recovery code verified — set a new PIN');
      openPinModal(); // hasPinSet() is now false, so this opens in "set" mode
    } else {
      registerPinFailure();
      const nowWait = pinWaitSeconds();
      recoveryErrorEl.textContent = nowWait > 0 ? pinWaitMessage(nowWait) : tr('Incorrect recovery code.');
      recoveryErrorEl.classList.remove('hidden');
      document.getElementById('lock-recovery-input').value = '';
    }
  });

  // Last-resort fallback if the recovery code is lost too — the PIN hash
  // lives only in localStorage, completely separate from the actual
  // accounts/transactions in IndexedDB, so resetting it here removes the
  // lock without touching any financial data at all.
  document.getElementById('wipe-pin-btn').addEventListener('click', () => {
    const ok = confirm(tr('This removes the PIN lock with no verification — anyone with access to this device could do the same. Your accounts and transactions are NOT affected. You can set a new PIN (and get a new recovery code) anytime from the menu.\n\nContinue?'));
    if (!ok) return;
    try {
      localStorage.removeItem('duitku-pin-hash');
      localStorage.removeItem('duitku-recovery-hash');
    } catch (err) { /* ignore */ }
    document.documentElement.classList.remove('pin-locked');
    resetLockScreenToNormalMode();
    updatePinMenuLabel();
    showToast('PIN lock removed — your data is safe');
  });

  // New account
  document.getElementById('open-new-account-modal-btn').addEventListener('click', () => {
    openModal('new-account-modal');
    document.getElementById('acc-name').focus();
  });

  // Modal close handlers
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  });

  // Type toggle in record form
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => {
        b.classList.remove('border-danger', 'text-danger', 'bg-danger/5', 'border-primary-500', 'text-primary-700', 'bg-primary-100', 'border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
        b.classList.add('border-primary-100', 'text-ink/50');
      });
      const type = btn.dataset.type;
      document.getElementById('record-type').value = type;
      btn.classList.remove('border-primary-100', 'text-ink/50');
      if (type === 'expense') btn.classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
      else btn.classList.add('border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
      updateRecordCategoryDisplay(null); // categories are type-specific, so switching Out/In resets the pick
    });
  });

  // Category picker
  document.getElementById('record-category-btn').addEventListener('click', () => openCategoryPicker());
  document.getElementById('category-add-new-btn').addEventListener('click', () => openCategoryAddModal(document.getElementById('record-type').value, null));
  document.querySelectorAll('.category-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setCategoryTypeToggle(btn.dataset.type));
  });
  document.getElementById('category-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('category-name-input').value.trim();
    const icon = document.getElementById('category-icon-input').value;
    const type = document.getElementById('category-type-input').value;
    const editId = document.getElementById('category-edit-id').value;
    if (!name) return;
    try {
      let categoryId;
      if (editId) {
        categoryId = Number(editId);
        await idbPut('categories', { id: categoryId, name, icon, type });
      } else {
        categoryId = await idbAdd('categories', { name, icon, type });
      }
      await loadAllData();
      closeModal('category-add-modal');
      updateRecordCategoryDisplay(categoryId);
      renderCategoryManageList();
      renderAll();
      showToast(editId ? 'Category updated' : 'Category added');
    } catch (err) {
      console.error('Category save failed', err);
      showToast('Could not save category');
    }
  });

  // Manage Categories
  document.getElementById('manage-categories-open-btn').addEventListener('click', () => openCategoryManageModal());
  document.querySelectorAll('.category-manage-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      categoryManageFilterType = btn.dataset.type;
      document.querySelectorAll('.category-manage-filter-btn').forEach(b => {
        b.classList.remove('border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200', 'border-primary-100', 'text-ink/50');
      });
      if (btn.dataset.type === 'expense') btn.classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
      else btn.classList.add('border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
      const other = document.querySelector(`.category-manage-filter-btn[data-type="${btn.dataset.type === 'expense' ? 'income' : 'expense'}"]`);
      other.classList.add('border-primary-100', 'text-ink/50');
      renderCategoryManageList();
    });
  });
  document.getElementById('category-manage-add-btn').addEventListener('click', () => openCategoryAddModal(categoryManageFilterType, null));

  // Manage Budgets (overall + per-category)
  document.getElementById('budget-manage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (currentAccountFilter === null) return;
    try {
      const overallVal = parseAmount(document.getElementById('budget-manage-overall-input').value);
      const acc = accounts.find(a => a.id === currentAccountFilter);
      if (acc) {
        if (overallVal > 0) acc.monthlyBudget = overallVal; else delete acc.monthlyBudget;
        await idbPut('accounts', acc);
      }
      const catInputs = document.querySelectorAll('.budget-manage-cat-input');
      for (const input of catInputs) {
        const categoryId = Number(input.dataset.categoryId);
        const limit = parseAmount(input.value);
        const existing = categoryBudgetFor(currentAccountFilter, categoryId);
        if (limit > 0) {
          if (existing) await idbPut('categoryBudgets', { id: existing.id, accountId: currentAccountFilter, categoryId, limit });
          else await idbAdd('categoryBudgets', { accountId: currentAccountFilter, categoryId, limit });
        } else if (existing) {
          await idbDelete('categoryBudgets', existing.id);
        }
      }
      await loadAllData();
      renderAll();
      closeModal('budget-manage-modal');
      showToast('Budgets saved');
    } catch (err) {
      console.error('Budget save failed', err);
      showToast('Could not save budgets');
    }
  });

  // Pro unlock — demo toggle only (see note on #pro-upsell-modal).
  document.getElementById('pro-unlock-demo-btn').addEventListener('click', () => {
    try { localStorage.setItem('duitku-pro-unlocked', '1'); } catch (err) { /* ignore */ }
    closeModal('pro-upsell-modal');
    showToast('Pro unlocked (demo)');
    setTimeout(() => openCategoryAddModal(), 300); // re-render the icon grid unlocked
  });

  // Account creation
  document.getElementById('new-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!db) { showToast('Storage not ready yet — please try again in a moment'); return; }
    const name = document.getElementById('acc-name').value.trim();
    const balance = parseAmount(document.getElementById('acc-balance').value) || 0;
    if (!name) return;
    // The database write is the only step that determines whether saving
    // succeeded — rendering/UI refresh happens afterwards and must never
    // cause a successful save to be reported as a failure.
    try {
      await idbAdd('accounts', { name, initialBalance: balance, createdAt: new Date().toISOString() });
    } catch (err) {
      console.error('Account save failed', err);
      showToast('Could not save account');
      return;
    }
    showToast('Account created');
    e.target.reset();
    closeModal('new-account-modal');
    try {
      await loadAllData();
      renderAll();
    } catch (err) {
      console.error('Post-save refresh failed', err);
    }
  });

  // Receipt file input -> B&W processing
  document.getElementById('record-receipts').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const processingEl = document.getElementById('receipt-processing');
    processingEl.classList.remove('hidden');
    for (const file of files) {
      try {
        const receipt = await fileToMonochromeDataURL(file);
        pendingReceipts.push(receipt);
      } catch (err) { console.error('Image processing failed', err); }
    }
    processingEl.classList.add('hidden');
    renderReceiptPreview();
    e.target.value = '';
  });

  // Record form submit
  document.getElementById('record-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!db) { showToast('Storage not ready yet — please try again in a moment'); return; }
    if (accounts.length === 0) { showToast('Create an account first'); return; }
    if (currentAccountFilter === null) { showToast('Select an account first'); return; }
    const idField = document.getElementById('record-id').value;
    const categoryIdRaw = document.getElementById('record-category-id').value;
    const record = {
      accountId: currentAccountFilter,
      type: document.getElementById('record-type').value,
      amount: parseAmount(document.getElementById('record-amount').value) || 0,
      datetime: document.getElementById('record-datetime').value,
      note: document.getElementById('record-note').value.trim(),
      categoryId: categoryIdRaw ? Number(categoryIdRaw) : null,
      receipts: [...pendingReceipts]
    };
    // Same principle: only a genuine write failure should report "could not
    // save" — rendering/closing the modal happens afterwards and is kept
    // out of this try block so it can never flip a real success into an
    // incorrectly-reported failure.
    try {
      if (idField) {
        record.id = Number(idField);
        await idbPut('transactions', record);
      } else {
        await idbAdd('transactions', record);
      }
    } catch (err) {
      console.error('Transaction save failed', err);
      showToast('Could not save transaction');
      return;
    }
    showToast(idField ? 'Transaction updated' : 'Transaction saved');
    closeModal('record-modal');
    try {
      await loadAllData();
      renderAll();
    } catch (err) {
      console.error('Post-save refresh failed', err);
    }
  });

  // Transfer between accounts — records as a linked expense (from) + income
  // (to) pair sharing the same timestamp, so balances and reports stay
  // accurate without needing a special "transfer" transaction type.
  document.getElementById('transfer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!db) { showToast('Storage not ready yet — please try again in a moment'); return; }
    const fromId = Number(document.getElementById('transfer-from').value);
    const toId = Number(document.getElementById('transfer-to').value);
    const amount = parseAmount(document.getElementById('transfer-amount').value) || 0;
    const note = document.getElementById('transfer-note').value.trim();

    if (fromId === toId) { showToast('Choose two different accounts'); return; }
    if (amount <= 0) { showToast('Enter an amount greater than zero'); return; }

    const datetime = nowLocalDatetime();
    const fromName = accountName(fromId);
    const toName = accountName(toId);
    const transferId = newTransferId();

    // Both legs share a transferId and are written in one atomic
    // transaction, so a transfer can never end up half-recorded.
    try {
      await idbAtomic(['transactions'], (t) => {
        const store = t.objectStore('transactions');
        store.add({
          accountId: fromId, type: 'expense', amount, datetime, transferId,
          note: note ? `${tr('Transfer to {name}', { name: toName })} — ${note}` : tr('Transfer to {name}', { name: toName }),
          receipts: []
        });
        store.add({
          accountId: toId, type: 'income', amount, datetime, transferId,
          note: note ? `${tr('Transfer from {name}', { name: fromName })} — ${note}` : tr('Transfer from {name}', { name: fromName }),
          receipts: []
        });
      });
    } catch (err) {
      console.error('Transfer failed', err);
      showToast('Could not complete transfer');
      return;
    }

    showToast(tr('Transferred {x} to {name}', { x: fmtMoney(amount), name: toName }));
    document.getElementById('transfer-note').value = '';
    document.getElementById('transfer-amount').value = '';
    try {
      await loadAllData();
      renderAll();
      renderTransferView();
    } catch (err) {
      console.error('Post-transfer refresh failed', err);
    }
  });

  // Report filters
  ['report-month', 'report-year'].forEach(id => {
    document.getElementById(id).addEventListener('change', renderReportTable);
  });
  document.getElementById('generate-pdf-btn').addEventListener('click', () => {
    try {
      generatePDF();
    } catch (err) {
      console.error('PDF generation failed', err);
      showToast('Could not generate PDF — please try again');
    }
  });
  document.getElementById('export-csv-btn').addEventListener('click', () => {
    try {
      exportCSV();
    } catch (err) {
      console.error('CSV export failed', err);
      showToast('Could not export CSV — please try again');
    }
  });

  // Savings goals
  document.getElementById('more-goals-btn').addEventListener('click', () => {
    closeModal('more-modal');
    openGoalsModal();
  });
  document.getElementById('goals-home-manage-btn').addEventListener('click', () => openGoalsModal());
  document.getElementById('goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('goal-name').value.trim();
    const target = parseAmount(document.getElementById('goal-target').value);
    const saved = Math.max(0, parseAmount(document.getElementById('goal-saved').value));
    const deadline = document.getElementById('goal-deadline').value || '';
    if (!name || target <= 0) { showToast('Enter a name and a target above zero'); return; }
    try {
      await idbAdd('goals', { name, target, saved, deadline, createdAt: new Date().toISOString() });
      await loadAllData();
      document.getElementById('goal-form').reset();
      renderGoalsList();
      renderGoalsHome();
      showToast('Goal added');
    } catch (err) {
      console.error('Goal save failed', err);
      showToast('Could not save goal');
    }
  });
  document.querySelectorAll('.goal-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setGoalMode(btn.dataset.mode));
  });
  document.getElementById('goal-contribute-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = goals.find(x => x.id === Number(document.getElementById('goal-contribute-id').value));
    const amount = parseAmount(document.getElementById('goal-contribute-amount').value);
    if (!g || amount <= 0) return;
    const sign = document.getElementById('goal-contribute-mode').value === 'withdraw' ? -1 : 1;
    const updated = { ...g, saved: fromSen(Math.max(0, toSen(g.saved) + sign * toSen(amount))) };
    try {
      await idbPut('goals', updated);
      await loadAllData();
      closeModal('goal-contribute-modal');
      renderGoalsList();
      renderGoalsHome();
      showToast(updated.saved >= updated.target ? 'Goal reached — well done!' : 'Savings updated');
    } catch (err) {
      console.error('Goal update failed', err);
      showToast('Could not update goal');
    }
  });

  // Bank statement CSV import
  document.getElementById('more-csv-import-btn').addEventListener('click', () => {
    closeModal('more-modal');
    openCsvImportModal();
  });
  document.getElementById('csv-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadCsvFile(file).catch(err => {
      console.error('CSV read failed', err);
      showToast('Could not read that file');
    });
  });
  document.querySelectorAll('.csv-map').forEach(sel => sel.addEventListener('change', renderCsvPreview));
  document.getElementById('csv-import-btn').addEventListener('click', runCsvImport);

  // Backup
  document.getElementById('export-btn').addEventListener('click', exportBackup);
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = '';
  });
}

// Storage init runs independently of UI wiring, so a slow/blocked
// IndexedDB never prevents the interface from responding to taps.
async function initStorageAndData() {
  try {
    await openDB();
    await loadAllData();
    await seedDefaultCategoriesIfNeeded();
    await loadAllData(); // reload once more so freshly-seeded categories are in memory
    await tagLegacyTransfersOnce();
    await processDueRecurring();
  } catch (err) {
    console.error('Storage init failed', err);
    showToast('Local storage unavailable — try opening this file through a local server instead of double-clicking it');
    return;
  }
  // Rendering is separated from the storage try/catch above so a rendering
  // hiccup (e.g. an icon library still loading) is never mistaken for a
  // storage failure.
  try {
    renderAll();
    if (!maybeShowBillReminder()) maybeShowBackupReminder();
  } catch (err) {
    console.error('Initial render failed', err);
  }
}

function openAddRecord() {
  if (accounts.length === 0 || currentAccountFilter === null) {
    showToast('Create an account first');
    switchView('accounts-view');
    return;
  }
  document.getElementById('record-form').reset();
  document.getElementById('record-id').value = '';
  document.getElementById('record-type').value = 'expense';
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.remove('border-danger', 'text-danger', 'bg-danger/5', 'border-primary-500', 'text-primary-700', 'bg-primary-100', 'border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
    b.classList.add('border-primary-100', 'text-ink/50');
  });
  document.querySelector('.type-btn[data-type="expense"]').classList.remove('border-primary-100', 'text-ink/50');
  document.querySelector('.type-btn[data-type="expense"]').classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
  document.getElementById('record-account-label').textContent = accountName(currentAccountFilter);
  document.getElementById('record-datetime').value = nowLocalDatetime();
  document.getElementById('record-modal-title').textContent = 'Add Transaction';
  document.getElementById('record-submit-btn').textContent = 'Save Transaction';
  updateRecordCategoryDisplay(null);
  pendingReceipts = [];
  renderReceiptPreview();
  openModal('record-modal');
  refreshIcons();
}

// Reuses the same Add Transaction sheet, pre-filled with an existing
// transaction's data. Submitting updates that record in place (the form's
// submit handler already checks record-id to decide add vs update).
function openEditRecord(tx) {
  document.getElementById('record-form').reset();
  document.getElementById('record-id').value = tx.id;
  document.getElementById('record-type').value = tx.type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.remove('border-danger', 'text-danger', 'bg-danger/5', 'border-primary-500', 'text-primary-700', 'bg-primary-100', 'border-rose-400', 'text-rose-700', 'bg-rose-200', 'border-emerald-400', 'text-emerald-700', 'bg-emerald-200');
    b.classList.add('border-primary-100', 'text-ink/50');
  });
  const activeTypeBtn = document.querySelector(`.type-btn[data-type="${tx.type}"]`);
  activeTypeBtn.classList.remove('border-primary-100', 'text-ink/50');
  if (tx.type === 'expense') activeTypeBtn.classList.add('border-rose-400', 'text-rose-700', 'bg-rose-200');
  else activeTypeBtn.classList.add('border-emerald-400', 'text-emerald-700', 'bg-emerald-200');

  document.getElementById('record-account-label').textContent = accountName(tx.accountId);
  document.getElementById('record-amount').value = tx.amount;
  document.getElementById('record-datetime').value = tx.datetime;
  document.getElementById('record-note').value = tx.note || '';
  document.getElementById('record-modal-title').textContent = 'Edit Transaction';
  document.getElementById('record-submit-btn').textContent = 'Save Changes';
  updateRecordCategoryDisplay(tx.categoryId || null);
  pendingReceipts = tx.receipts ? [...tx.receipts] : [];
  renderReceiptPreview();
  openModal('record-modal');
  refreshIcons();
}

function renderReceiptPreview() {
  const wrap = document.getElementById('receipt-preview');
  wrap.innerHTML = pendingReceipts.map((r, i) => `
    <div class="relative bg-ink/5 rounded-lg border border-primary-100 h-16 flex items-center justify-center overflow-hidden">
      <img src="${receiptSrc(r)}" class="max-w-full max-h-full object-contain" />
      <button type="button" class="remove-receipt absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center text-[10px]" data-idx="${i}">✕</button>
    </div>
  `).join('');
  wrap.querySelectorAll('.remove-receipt').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingReceipts.splice(Number(btn.dataset.idx), 1);
      renderReceiptPreview();
    });
  });
}
