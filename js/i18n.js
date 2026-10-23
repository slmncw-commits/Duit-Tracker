/* =========================================================================
   DUIT TRACKER — Language support (English / Bahasa Melayu)
   The UI is written in English. When Bahasa Melayu is selected, every
   string that matches a key in MS below is swapped:
   - static markup and rendered lists via translateDom() + a MutationObserver
   - strings built in JS via tr('Template {x}', { x })
   ========================================================================= */

const MS = {
  // Lock screen & PIN
  'Duit Tracker Locked': 'Duit Tracker Dikunci',
  'Enter your PIN to continue': 'Masukkan PIN untuk teruskan',
  'Enter your recovery code to reset your PIN': 'Masukkan kod pemulihan untuk set semula PIN',
  'Incorrect PIN. Try again.': 'PIN salah. Cuba lagi.',
  'Unlock': 'Buka Kunci',
  'Incorrect recovery code.': 'Kod pemulihan salah.',
  'Reset PIN': 'Set Semula PIN',
  'Back to PIN entry': 'Kembali ke kemasukan PIN',
  'Forgot PIN?': 'Lupa PIN?',
  'Lost your recovery code too? Reset lock (no verification)': 'Kod pemulihan pun hilang? Set semula kunci (tanpa pengesahan)',
  'Your Recovery Code': 'Kod Pemulihan Anda',
  "Screenshot or write this down now. You'll need it to reset your PIN if you ever forget it.": 'Ambil tangkapan skrin atau tulis kod ini sekarang. Anda perlukannya untuk set semula PIN jika terlupa.',
  'This code will not be shown again.': 'Kod ini tidak akan dipaparkan lagi.',
  "I've Saved It": 'Saya Dah Simpan',
  'Set PIN Lock': 'Tetapkan Kunci PIN',
  'Change / Remove PIN': 'Tukar / Buang PIN',
  'Change PIN': 'Tukar PIN',
  'Remove PIN Lock': 'Buang Kunci PIN',
  'The PIN hides the app on this device. It does not encrypt your data, so keep your device itself locked too.': 'PIN menyembunyikan app pada peranti ini. Ia tidak menyulitkan data anda, jadi pastikan peranti anda sendiri juga berkunci.',
  'Current PIN': 'PIN Semasa',
  'New PIN (4–6 digits)': 'PIN Baharu (4–6 digit)',
  'Confirm New PIN': 'Sahkan PIN Baharu',
  'Set PIN': 'Tetapkan PIN',
  'Update PIN': 'Kemas Kini PIN',
  'Remove PIN': 'Buang PIN',
  'Incorrect current PIN': 'PIN semasa salah',
  'PIN must be 4–6 digits': 'PIN mesti 4–6 digit',
  'PINs do not match': 'PIN tidak sepadan',
  'PIN lock enabled': 'Kunci PIN diaktifkan',
  'PIN updated': 'PIN dikemas kini',
  'PIN lock removed': 'Kunci PIN dibuang',
  'PIN lock removed — your data is safe': 'Kunci PIN dibuang — data anda selamat',
  'Recovery code verified — set a new PIN': 'Kod pemulihan disahkan — tetapkan PIN baharu',
  'Could not save PIN — storage unavailable': 'Tidak dapat simpan PIN — storan tidak tersedia',
  'Too many attempts. Try again in {n} s.': 'Terlalu banyak cubaan. Cuba lagi dalam {n} saat.',
  'Too many attempts. Try again in {n} min.': 'Terlalu banyak cubaan. Cuba lagi dalam {n} minit.',
  'This removes the PIN lock with no verification — anyone with access to this device could do the same. Your accounts and transactions are NOT affected. You can set a new PIN (and get a new recovery code) anytime from the menu.\n\nContinue?': 'Ini membuang kunci PIN tanpa pengesahan — sesiapa yang ada akses ke peranti ini boleh buat perkara sama. Akaun dan transaksi anda TIDAK terjejas. Anda boleh tetapkan PIN baharu (dan dapat kod pemulihan baharu) bila-bila masa dari menu.\n\nTeruskan?',

  // Header, navigation, views
  'Overview': 'Ringkasan',
  'Recent Activity': 'Aktiviti Terkini',
  'Reports': 'Laporan',
  'Manage Accounts': 'Urus Akaun',
  'Transfer': 'Pindahan',
  'Home': 'Utama',
  'Activity': 'Aktiviti',
  'More': 'Lagi',
  'No Account Yet': 'Belum Ada Akaun',
  'No Account': 'Tiada Akaun',
  'Unknown': 'Tidak Diketahui',
  '{name} Balance': 'Baki {name}',
  'in': 'masuk',
  'out': 'keluar',
  'In': 'Masuk',
  'Out': 'Keluar',

  // Budgets
  'Set a Total Budget': 'Tetapkan Bajet Keseluruhan',
  'Track spending against a monthly limit': 'Pantau perbelanjaan berbanding had bulanan',
  'Total Budget': 'Bajet Keseluruhan',
  'Category Budgets': 'Bajet Kategori',
  'Over budget by {x} this month': 'Melebihi bajet sebanyak {x} bulan ini',
  '{x} left this month': 'Baki {x} bulan ini',
  'Over by {x}': 'Lebih {x}',
  'Manage Budgets': 'Urus Bajet',
  'Total Budget (RM)': 'Bajet Keseluruhan (RM)',
  'Per-Category Monthly Budgets (RM)': 'Bajet Bulanan Ikut Kategori (RM)',
  'Save Budgets': 'Simpan Bajet',
  'Monthly Limit (RM)': 'Had Bulanan (RM)',
  'Save Budget': 'Simpan Bajet',
  'Remove Budget': 'Buang Bajet',
  'No limit set': 'Tiada had',
  'No expense categories yet — add some from Manage Categories first.': 'Belum ada kategori perbelanjaan — tambah dahulu di Urus Kategori.',
  'Budget saved': 'Bajet disimpan',
  'Budget removed': 'Bajet dibuang',
  'Budgets saved': 'Bajet disimpan',
  'Could not save budget': 'Tidak dapat simpan bajet',
  'Could not save budgets': 'Tidak dapat simpan bajet',
  'Could not remove budget': 'Tidak dapat buang bajet',
  'For {name}': 'Untuk {name}',

  // Upcoming bills, comparison, goals
  'Upcoming Bills': 'Bil Akan Datang',
  'Recurring payment': 'Bayaran berulang',
  'Today': 'Hari ini',
  'Tomorrow': 'Esok',
  'In {n} days': 'Dalam {n} hari',
  'Bill due {when}: {name} {x}': 'Bil perlu dibayar {when}: {name} {x}',
  '{n} bills due within a day — see Upcoming Bills': '{n} bil perlu dibayar dalam sehari — lihat Bil Akan Datang',
  'This Month vs Last Month': 'Bulan Ini vs Bulan Lepas',
  'Spent so far': 'Belanja setakat ini',
  'vs {x} by this day last month': 'berbanding {x} pada hari yang sama bulan lepas',
  'Savings Goals': 'Matlamat Simpanan',
  'Manage': 'Urus',
  "Track what you're saving towards. Money added here is a record of progress only — it doesn't move money between your accounts.": 'Pantau apa yang anda simpan. Wang yang ditambah di sini hanya rekod kemajuan — ia tidak memindahkan wang antara akaun anda.',
  'Add Goal': 'Tambah Matlamat',
  'Goal Name': 'Nama Matlamat',
  'Target (RM)': 'Sasaran (RM)',
  'Saved So Far': 'Sudah Disimpan',
  'Target Date (optional)': 'Tarikh Sasaran (pilihan)',
  'e.g. Raya fund': 'cth. Tabung Raya',
  'Update Savings': 'Kemas Kini Simpanan',
  'Add': 'Tambah',
  'Withdraw': 'Keluarkan',
  'Save': 'Simpan',
  'No goals yet.': 'Belum ada matlamat.',
  'Goal reached!': 'Matlamat tercapai!',
  '{x} to go': 'Lagi {x}',
  '{x} to go · about {m} a month until {d}': 'Lagi {x} · lebih kurang {m} sebulan hingga {d}',
  'Target date passed — {x} to go': 'Tarikh sasaran sudah lepas — lagi {x}',
  'Delete this goal?': 'Padam matlamat ini?',
  'Goal added': 'Matlamat ditambah',
  'Goal deleted': 'Matlamat dipadam',
  'Savings updated': 'Simpanan dikemas kini',
  'Goal reached — well done!': 'Matlamat tercapai — syabas!',
  'Enter a name and a target above zero': 'Masukkan nama dan sasaran lebih daripada sifar',
  'Could not save goal': 'Tidak dapat simpan matlamat',
  'Could not update goal': 'Tidak dapat kemas kini matlamat',
  'Could not delete goal': 'Tidak dapat padam matlamat',

  // Activity & transactions
  'No transactions yet. Tap "Add Transaction" to start.': 'Belum ada transaksi. Tekan "Tambah Transaksi" untuk mula.',
  'Create an account to get started.': 'Cipta akaun untuk bermula.',
  'Add Transaction': 'Tambah Transaksi',
  'Edit Transaction': 'Sunting Transaksi',
  'Recording to': 'Direkod ke',
  'Category (optional)': 'Kategori (pilihan)',
  'Uncategorized': 'Tiada Kategori',
  'Amount (RM)': 'Amaun (RM)',
  'Date & Time': 'Tarikh & Masa',
  'Purpose / Note': 'Tujuan / Catatan',
  'e.g. Lunch with family': 'cth. Makan tengah hari dengan keluarga',
  'Receipts': 'Resit',
  'Receipts ({n})': 'Resit ({n})',
  'Scan / Upload Receipt(s)': 'Imbas / Muat Naik Resit',
  'Processing images…': 'Memproses imej…',
  'Save Transaction': 'Simpan Transaksi',
  'Save Changes': 'Simpan Perubahan',
  'Transaction Detail': 'Butiran Transaksi',
  'Note': 'Catatan',
  'Edit': 'Sunting',
  'Delete': 'Padam',
  'Delete Transfer': 'Padam Pindahan',
  "This is one side of a transfer between your accounts. It changes the balance but isn't counted as income or spending. Deleting it removes both sides.": 'Ini satu bahagian pindahan antara akaun anda. Ia mengubah baki tetapi tidak dikira sebagai pendapatan atau perbelanjaan. Memadamnya akan membuang kedua-dua bahagian.',
  'Transaction saved': 'Transaksi disimpan',
  'Transaction updated': 'Transaksi dikemas kini',
  'Transaction deleted': 'Transaksi dipadam',
  'Transfer deleted': 'Pindahan dipadam',
  'Transaction restored': 'Transaksi dipulihkan',
  'Could not save transaction': 'Tidak dapat simpan transaksi',
  'Could not restore transaction': 'Tidak dapat pulihkan transaksi',
  'Undo': 'Batal',
  'Search Transactions': 'Cari Transaksi',
  'Search by note or amount': 'Cari ikut catatan atau amaun',
  'No matching transactions': 'Tiada transaksi yang sepadan',
  'No transactions yet': 'Belum ada transaksi',
  'Storage not ready yet — please try again in a moment': 'Storan belum sedia — cuba lagi sebentar',
  'Create an account first': 'Cipta akaun dahulu',
  'Select an account first': 'Pilih akaun dahulu',
  'Enter an amount greater than zero': 'Masukkan amaun lebih daripada sifar',

  // Reports
  'Statement for': 'Penyata untuk',
  'Month': 'Bulan',
  'Year': 'Tahun',
  'All Months': 'Semua Bulan',
  'All Years': 'Semua Tahun',
  'All Time': 'Sepanjang Masa',
  'Generate PDF Statement': 'Jana Penyata PDF',
  'Export CSV': 'Eksport CSV',
  'Brought Forward': 'Baki Awal',
  'Carried Forward': 'Baki Akhir',
  'Transfers (not counted as in/out)': 'Pindahan (tidak dikira masuk/keluar)',
  'Spending Trend — Last 6 Months': 'Trend Perbelanjaan — 6 Bulan Terakhir',
  'Spending by Category': 'Perbelanjaan Ikut Kategori',
  'No expenses for this period': 'Tiada perbelanjaan untuk tempoh ini',
  'PDF library failed to load — check your internet connection and try again': 'Pustaka PDF gagal dimuat — semak sambungan internet dan cuba lagi',
  'PDF statement downloaded': 'Penyata PDF dimuat turun',
  'Could not generate PDF — please try again': 'Tidak dapat jana PDF — sila cuba lagi',
  'CSV exported': 'CSV dieksport',
  'Could not export CSV — please try again': 'Tidak dapat eksport CSV — sila cuba lagi',
  'Financial Statement': 'Penyata Kewangan',
  'Generated by Duit Tracker — Personal Finance Tracker': 'Dijana oleh Duit Tracker — Penjejak Kewangan Peribadi',
  'Page {n} of {total}': 'Muka surat {n} daripada {total}',
  'BROUGHT FORWARD': 'BAKI AWAL',
  'TOTAL IN': 'JUMLAH MASUK',
  'TOTAL OUT': 'JUMLAH KELUAR',
  'CARRIED FORWARD': 'BAKI AKHIR',
  'Period: {x}': 'Tempoh: {x}',
  'Account: {x}': 'Akaun: {x}',
  'Generated: {x}': 'Dijana: {x}',
  'Balance Brought Forward': 'Baki Awal',
  'Balance Carried Forward': 'Baki Akhir',
  'Date': 'Tarikh',
  'Account': 'Akaun',
  'Amount': 'Amaun',
  'Balance': 'Baki',
  'Attached Receipts': 'Resit Dilampirkan',
  'Receipt Appendix': 'Lampiran Resit',

  // Accounts & transfers
  'Create New Account': 'Cipta Akaun Baharu',
  'Your Accounts': 'Akaun Anda',
  'No accounts yet. Create one above.': 'Belum ada akaun. Cipta satu di atas.',
  'No accounts yet — create one below.': 'Belum ada akaun — cipta satu di bawah.',
  'Initial: {x}': 'Awal: {x}',
  'Account Name': 'Nama Akaun',
  'Initial Balance (RM)': 'Baki Awal (RM)',
  'Create Account': 'Cipta Akaun',
  'Switch Account': 'Tukar Akaun',
  'Account created': 'Akaun dicipta',
  'Account deleted': 'Akaun dipadam',
  'Could not save account': 'Tidak dapat simpan akaun',
  'Delete this account?': 'Padam akaun ini?',
  'This account has transactions linked to it. Deleting it will also delete those transactions. Continue?': 'Akaun ini ada transaksi. Memadamnya juga akan memadam transaksi tersebut. Teruskan?',
  'Transfer Between Accounts': 'Pindahan Antara Akaun',
  'Create at least 2 accounts to transfer money between them.': 'Cipta sekurang-kurangnya 2 akaun untuk memindahkan wang antaranya.',
  'From': 'Dari',
  'To': 'Ke',
  'Note (optional)': 'Catatan (pilihan)',
  'e.g. Monthly savings': 'cth. Simpanan bulanan',
  'Choose two different accounts': 'Pilih dua akaun yang berbeza',
  'Could not complete transfer': 'Tidak dapat lengkapkan pindahan',
  'Transfer to {name}': 'Pindahan ke {name}',
  'Transfer from {name}': 'Pindahan dari {name}',
  'Transferred {x} to {name}': '{x} dipindahkan ke {name}',

  // Recurring
  'Recurring Transactions': 'Transaksi Berulang',
  'Add Recurring': 'Tambah Berulang',
  'Frequency': 'Kekerapan',
  'Daily': 'Harian',
  'Weekly': 'Mingguan',
  'Monthly': 'Bulanan',
  'Day of Week': 'Hari dalam Minggu',
  'Day of Month': 'Hari dalam Bulan',
  'Time': 'Masa',
  'e.g. Rent': 'cth. Sewa',
  'Monday': 'Isnin',
  'Tuesday': 'Selasa',
  'Wednesday': 'Rabu',
  'Thursday': 'Khamis',
  'Friday': 'Jumaat',
  'Saturday': 'Sabtu',
  'Sunday': 'Ahad',
  'Daily at {t}': 'Setiap hari pada {t}',
  'Weekly on {d} at {t}': 'Setiap {d} pada {t}',
  'Monthly on day {n} at {t}': 'Setiap bulan hari ke-{n} pada {t}',
  'No recurring transactions yet.': 'Belum ada transaksi berulang.',
  'Recurring transaction added': 'Transaksi berulang ditambah',
  'Recurring transaction removed': 'Transaksi berulang dibuang',
  'Could not add recurring transaction': 'Tidak dapat tambah transaksi berulang',
  'Could not remove': 'Tidak dapat buang',

  // Categories
  'Choose Category': 'Pilih Kategori',
  'Add Category': 'Tambah Kategori',
  'Edit Category': 'Sunting Kategori',
  'Manage Categories': 'Urus Kategori',
  'Name': 'Nama',
  'Icon': 'Ikon',
  'Save Category': 'Simpan Kategori',
  'e.g. Groceries': 'cth. Barang dapur',
  'No categories yet.': 'Belum ada kategori.',
  'Category added': 'Kategori ditambah',
  'Category updated': 'Kategori dikemas kini',
  'Category deleted': 'Kategori dipadam',
  'Could not save category': 'Tidak dapat simpan kategori',
  'Could not delete category': 'Tidak dapat padam kategori',
  'Delete this category? Transactions using it will show as Uncategorized instead — they will not be deleted.': 'Padam kategori ini? Transaksi yang menggunakannya akan dipaparkan sebagai Tiada Kategori — ia tidak akan dipadam.',
  'Food': 'Makanan',
  'Transport': 'Pengangkutan',
  'Bills': 'Bil',
  'Shopping': 'Membeli-belah',
  'Health': 'Kesihatan',
  'Rent': 'Sewa',
  'Other': 'Lain-lain',
  'Salary': 'Gaji',
  'Gift': 'Hadiah',
  'Other Income': 'Pendapatan Lain',

  // Pro
  'Duit Tracker Pro': 'Duit Tracker Pro',
  'Unlock 20+ extra category icons — travel, gym, pets, subscriptions, and more.': 'Buka 20+ ikon kategori tambahan — pelancongan, gim, haiwan peliharaan, langganan dan banyak lagi.',
  'Unlock Pro (Demo)': 'Buka Pro (Demo)',
  "Payment isn't wired up yet — this just flips a local flag for testing.": 'Pembayaran belum disambung — ini hanya menukar tetapan setempat untuk ujian.',
  'Pro unlocked (demo)': 'Pro dibuka (demo)',

  // CSV import
  'Import Bank Statement (CSV)': 'Import Penyata Bank (CSV)',
  'Import Bank Statement': 'Import Penyata Bank',
  "Download your statement as CSV from your bank's website (Maybank2u, CIMB Clicks, etc.), then pick it here. Rows are added to": 'Muat turun penyata anda dalam format CSV dari laman web bank (Maybank2u, CIMB Clicks, dll.), kemudian pilih di sini. Baris akan ditambah ke',
  '. Rows already in the app are skipped.': '. Baris yang sudah ada dalam app akan dilangkau.',
  'Choose CSV File': 'Pilih Fail CSV',
  'Match the columns': 'Padankan lajur',
  'Date Format': 'Format Tarikh',
  'Description': 'Keterangan',
  'Amount Columns': 'Lajur Amaun',
  'One column (negative = money out)': 'Satu lajur (negatif = wang keluar)',
  'Separate Debit / Credit columns': 'Lajur Debit / Kredit berasingan',
  'Debit (Out)': 'Debit (Keluar)',
  'Credit (In)': 'Kredit (Masuk)',
  'Preview': 'Pratonton',
  'Import': 'Import',
  '— none —': '— tiada —',
  'Column {n}': 'Lajur {n}',
  'No rows match these settings yet.': 'Tiada baris yang sepadan dengan tetapan ini.',
  '{n} new transactions': '{n} transaksi baharu',
  '{n} already in the app': '{n} sudah ada dalam app',
  '{n} rows without a valid date or amount': '{n} baris tanpa tarikh atau amaun yang sah',
  'Import {n} Transactions': 'Import {n} Transaksi',
  'Imported {n} transactions': '{n} transaksi diimport',
  'Import undone': 'Import dibatalkan',
  'That file has no rows to import': 'Fail itu tiada baris untuk diimport',
  'Could not read that file': 'Tidak dapat membaca fail itu',
  'Could not import — nothing was added': 'Tidak dapat import — tiada apa yang ditambah',

  // Settings & backup
  'Settings': 'Tetapan',
  'Preferences': 'Keutamaan',
  'Dark Mode': 'Mod Gelap',
  'Language': 'Bahasa',
  'Security': 'Keselamatan',
  'Data Backup': 'Sandaran Data',
  'Next: {d}': 'Seterusnya: {d}',
  'Last backup: Never': 'Sandaran terakhir: Tiada',
  'Last backup: Today': 'Sandaran terakhir: Hari ini',
  'Last backup: 1 day ago': 'Sandaran terakhir: 1 hari lalu',
  'Last backup: {n} days ago': 'Sandaran terakhir: {n} hari lalu',
  'Export Backup (.json)': 'Eksport Sandaran (.json)',
  'Import Backup (.json)': 'Import Sandaran (.json)',
  'Remind Me to Backup': 'Ingatkan Saya untuk Sandarkan',
  'Duit Tracker stores everything on this device using IndexedDB. No internet connection is required. Export a backup regularly, especially before switching devices.': 'Duit Tracker menyimpan semua data pada peranti ini menggunakan IndexedDB. Tiada sambungan internet diperlukan. Eksport sandaran secara berkala, terutamanya sebelum menukar peranti.',
  'Backup exported': 'Sandaran dieksport',
  'Backup imported successfully': 'Sandaran berjaya diimport',
  'Failed to import: invalid backup file': 'Gagal import: fail sandaran tidak sah',
  "You haven't backed up yet — export from the menu to keep your data safe": 'Anda belum buat sandaran — eksport dari menu untuk keselamatan data anda',
  "It's been {n} days since your last backup — export one from the menu": 'Sudah {n} hari sejak sandaran terakhir — eksport satu dari menu',
  'Importing will REPLACE all current data on this device (accounts, transactions, categories, budgets, recurring and goals) with the backup contents. Continue?': 'Import akan MENGGANTIKAN semua data semasa pada peranti ini (akaun, transaksi, kategori, bajet, berulang dan matlamat) dengan kandungan sandaran. Teruskan?',
  'This is an older backup that only contains accounts and transactions. Importing will REPLACE those on this device; categories, budgets, recurring and goals here are kept. Continue?': 'Ini sandaran versi lama yang hanya mengandungi akaun dan transaksi. Import akan MENGGANTIKAN data tersebut pada peranti ini; kategori, bajet, berulang dan matlamat di sini dikekalkan. Teruskan?',
  'Local storage unavailable — try opening this file through a local server instead of double-clicking it': 'Storan setempat tidak tersedia — cuba buka fail ini melalui pelayan setempat dan bukan dengan dwi-klik'
};

function currentLang() {
  try {
    const saved = localStorage.getItem('duitku-lang');
    if (saved === 'ms' || saved === 'en') return saved;
  } catch (e) { /* ignore */ }
  return (navigator.language || '').toLowerCase().startsWith('ms') ? 'ms' : 'en';
}
const LANG = currentLang();
const LOCALE = LANG === 'ms' ? 'ms-MY' : 'en-MY';

function tr(text, params) {
  let out = (LANG === 'ms' && MS[text]) ? MS[text] : text;
  if (params) Object.keys(params).forEach(k => { out = out.split('{' + k + '}').join(params[k]); });
  return out;
}

// Only writes when the text actually changes: writing a node re-triggers
// the MutationObserver, so an identical write would loop forever.
function translateTextNode(node) {
  const raw = node.nodeValue;
  const key = raw.trim();
  const value = key && MS[key];
  if (value && value !== key) node.nodeValue = raw.replace(key, value);
}

// Translates text nodes and placeholder/title/aria-label attributes whose
// whole (trimmed) value is a dictionary key. Leading/trailing whitespace is
// preserved so inline layouts don't shift.
function translateDom(root) {
  if (LANG !== 'ms' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) translateTextNode(node);
  if (root.querySelectorAll) {
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(el => {
      ['placeholder', 'title', 'aria-label'].forEach(attr => {
        const v = el.getAttribute(attr);
        if (v && MS[v.trim()] && MS[v.trim()] !== v.trim()) el.setAttribute(attr, MS[v.trim()]);
      });
    });
  }
}

function startAutoTranslate() {
  if (LANG !== 'ms') return;
  document.documentElement.lang = 'ms';
  translateDom(document.body);
  new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        translateTextNode(m.target);
      } else {
        m.addedNodes.forEach(n => {
          if (n.nodeType === Node.TEXT_NODE) {
            translateTextNode(n);
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            translateDom(n);
          }
        });
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
