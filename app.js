/* DiscShelf — static, local-first disc library. No server, no accounts. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LIB_KEY = 'discshelf.library.v1';
const SET_KEY = 'discshelf.settings.v1';

function read(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
// Address of your community-database Worker, e.g. 'https://discshelf-api.yourname.workers.dev'
// (no trailing slash). Leave empty to run fully local. See worker/SETUP.md.
const COMMUNITY_API = 'https://discshelf-api.discshelf.workers.dev';

let library = read(LIB_KEY, []);
let settings = Object.assign({ tmdbKey: '', share: false, useCommunity: true }, read(SET_KEY, {}));

function persist() {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(library)); }
  catch { alert('Could not save — browser storage is full or blocked.'); }
  renderLibrary();
}
function saveSettings() { localStorage.setItem(SET_KEY, JSON.stringify(settings)); }

// Ask the browser not to evict our data when storage is low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/* ---------- Tabs ---------- */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === b));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab !== 'scan') stopScan();
}));

/* ---------- Library view ---------- */
function renderLibrary() {
  const q = norm($('#filter-text').value);
  const fmt = $('#filter-format').value;
  const items = library
    .filter(i => (!fmt || i.format === fmt) && (!q || norm(i.title).includes(q)))
    .sort((a, b) => a.title.localeCompare(b.title));
  $('#count').textContent = `${items.length} of ${library.length} discs`;
  const grid = $('#grid');
  grid.textContent = '';
  for (const i of items) {
    const card = document.createElement('div');
    card.className = 'item';
    const p = document.createElement('div');
    p.className = 'poster';
    if (i.poster) p.style.backgroundImage = `url("${i.poster}")`; else p.textContent = i.title;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const t = document.createElement('div'); t.className = 't'; t.textContent = i.title;
    const s = document.createElement('div'); s.className = 's';
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = i.format;
    s.append(badge, [i.year, i.edition].filter(Boolean).join(' · '));
    meta.append(t, s);
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', () => {
      if (confirm(`Remove "${i.title}" (${i.format}) from your library?`)) {
        library = library.filter(x => x.id !== i.id);
        persist();
      }
    });
    card.append(p, meta, del);
    grid.append(card);
  }
}
$('#filter-text').addEventListener('input', renderLibrary);
$('#filter-format').addEventListener('change', renderLibrary);

/* ---------- Ownership check ---------- */
function guessFormat(text) {
  const t = (text || '').toLowerCase();
  if (/4k|uhd|ultra hd/.test(t)) return '4K UHD';
  if (/hd[\s-]?dvd/.test(t)) return 'HD DVD';
  if (/blu[\s-]?ray/.test(t)) return 'Blu-ray';
  if (/dvd/.test(t)) return 'DVD';
  return '';
}
function cleanTitle(text) {
  return (text || '')
    .replace(/[\(\[][^\)\]]*(blu[\s-]?ray|dvd|4k|uhd|widescreen|region|edition|disc)[^\)\]]*[\)\]]/gi, ' ')
    .replace(/\b(blu[\s-]?ray|hd[\s-]?dvd|dvd|4k|uhd|ultra hd|widescreen|full screen)\b/gi, ' ')
    .replace(/\s+/g, ' ').replace(/[-–,:\s]+$/, '').trim();
}
async function lookupBarcode(code) {
  // Free UPC lookup. May be rate-limited or blocked; callers must cope with null.
  try {
    const r = await fetch('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(code));
    if (!r.ok) return null;
    const j = await r.json();
    return j.items && j.items[0] ? j.items[0].title : null;
  } catch { return null; }
}
async function communityLookup(code) {
  if (!COMMUNITY_API || !settings.useCommunity) return null;
  try {
    const r = await fetch(`${COMMUNITY_API}/lookup?barcode=${encodeURIComponent(code)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.found ? j : null;
  } catch { return null; }
}
// Sends only barcode, title, format, year and TMDB info. Never notes, edition or the library itself.
async function contribute(entries) {
  if (!COMMUNITY_API || !settings.share) return 0;
  const todo = entries.filter(e => e.barcode && e.barcode.length >= 8 && !e.shared);
  let sent = 0;
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    try {
      const r = await fetch(`${COMMUNITY_API}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(e => ({
          barcode: e.barcode, title: e.title, format: e.format, year: e.year, tmdbId: e.tmdbId, poster: e.poster
        })))
      });
      if (r.status === 400) { chunk.forEach(e => { e.shared = true; }); continue; } // nothing valid; don't retry forever
      if (!r.ok) break;
      chunk.forEach(e => { e.shared = true; });
      sent += chunk.length;
    } catch { break; }
  }
  if (sent) persist();
  return sent;
}
function titleMatches(title) {
  const n = norm(title);
  if (n.length < 3) return [];
  return library.filter(i => {
    const m = norm(i.title);
    return m === n || (m.length >= 4 && n.includes(m)) || (n.length >= 4 && m.includes(n));
  });
}
const fmtList = items => items.map(i => `${i.title}${i.year ? ' (' + i.year + ')' : ''} — ${i.format}${i.edition ? ', ' + i.edition : ''}`);

async function handleCode(raw) {
  const code = (raw || '').replace(/\D/g, '');
  if (!code) return;
  $('#scan-msg').textContent = `Barcode ${code} — checking…`;
  $('#f-barcode').value = code;
  const box = $('#result');
  box.hidden = false;
  box.className = 'card result';

  const exact = library.filter(i => i.barcode === code);
  if (exact.length) {
    box.classList.add('result-own');
    show(box, '✓ You own this', 'good', fmtList(exact), 'Same barcode, so same edition. No need to buy it again.');
    $('#scan-msg').textContent = '';
    return;
  }

  // Ask the community database first, then the free UPC lookup.
  const community = await communityLookup(code);
  let found = null, title = '', format = '', source = 'the barcode lookup';
  $('#f-poster').value = ''; $('#f-tmdb').value = '';
  if (community) {
    found = community.title; title = community.title; format = community.format;
    source = 'the community database';
    $('#f-title').value = title;
    $('#f-format').value = format;
    $('#f-year').value = community.year || '';
    $('#f-poster').value = community.poster || '';
    $('#f-tmdb').value = community.tmdbId || '';
  } else {
    found = await lookupBarcode(code);
    title = cleanTitle(found);
    format = guessFormat(found);
    if (found) {
      $('#f-title').value = title;
      if (format) $('#f-format').value = format;
    }
  }
  const similar = found ? titleMatches(title) : [];
  $('#scan-msg').textContent = '';

  if (similar.length) {
    const sameFmt = format && similar.some(i => i.format === format);
    box.classList.add('result-similar');
    show(box,
      sameFmt ? `⚠ You probably own this (${format})` : '⚠ You own this title, maybe a different format or edition',
      'warn', fmtList(similar),
      `This barcode isn't saved, but ${source} says "${found}". ${sameFmt ? 'It may be another edition of a disc you already have.' : 'Check that the format is the one you want.'}`);
  } else if (found) {
    box.classList.add('result-new');
    show(box, 'Not in your library', '', [], `${source[0].toUpperCase() + source.slice(1)} says: "${found}". Check the details below and add it if you buy it.`);
  } else {
    box.classList.add('result-new');
    show(box, 'Barcode not recognised', '', [], 'No title found for this barcode. Search for the title below; the barcode will be remembered once you add it.');
  }
}
function show(box, heading, cls, lines, note) {
  box.textContent = '';
  const h = document.createElement('h2'); if (cls) h.className = cls; h.textContent = heading;
  box.append(h);
  if (lines.length) {
    const ul = document.createElement('ul');
    for (const l of lines) { const li = document.createElement('li'); li.textContent = l; ul.append(li); }
    box.append(ul);
  }
  const p = document.createElement('p'); p.className = 'muted'; p.textContent = note;
  box.append(p);
}
$('#btn-code').addEventListener('click', () => handleCode($('#manual-code').value));
$('#manual-code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleCode(e.target.value); } });

/* ---------- Camera scanning ---------- */
let stream = null, scanning = false, zxingReader = null;

async function startScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('#scan-msg').textContent = 'Camera is not available here. Type the barcode number instead.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch {
    $('#scan-msg').textContent = 'Camera permission was denied. You can type the barcode number instead.';
    return;
  }
  const video = $('#video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('#video-wrap').hidden = false;
  $('#btn-scan').hidden = true;
  $('#btn-stop').hidden = false;
  $('#scan-msg').textContent = 'Point the camera at the barcode on the back of the case.';
  scanning = true;

  if ('BarcodeDetector' in window) {
    const det = new BarcodeDetector({ formats: ['ean_13', 'upc_a', 'ean_8', 'upc_e'] });
    const tick = async () => {
      if (!scanning) return;
      try {
        const codes = await det.detect(video);
        if (codes.length) { onDetected(codes[0].rawValue); return; }
      } catch {}
      setTimeout(tick, 200);
    };
    tick();
  } else {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
      zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromStream(stream, video, (result) => {
        if (result && scanning) onDetected(result.getText());
      });
    } catch {
      $('#scan-msg').textContent = 'Scanner library could not load (offline?). Type the barcode number instead.';
    }
  }
}
function onDetected(code) {
  if (navigator.vibrate) navigator.vibrate(60);
  stopScan();
  $('#manual-code').value = code;
  handleCode(code);
}
function stopScan() {
  scanning = false;
  if (zxingReader) { try { zxingReader.reset(); } catch {} zxingReader = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('#video').srcObject = null;
  $('#video-wrap').hidden = true;
  $('#btn-scan').hidden = false;
  $('#btn-stop').hidden = true;
}
function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.ZXing) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.append(s);
  });
}
$('#btn-scan').addEventListener('click', startScan);
$('#btn-stop').addEventListener('click', () => { stopScan(); $('#scan-msg').textContent = ''; });

/* ---------- TMDB search ---------- */
$('#btn-tmdb').addEventListener('click', async () => {
  const q = $('#f-title').value.trim();
  const out = $('#tmdb-results');
  out.textContent = '';
  if (!q) return;
  if (!settings.tmdbKey) { out.textContent = 'Add your free TMDB API key in Settings first.'; out.className = 'tmdb-results muted'; return; }
  out.className = 'tmdb-results';
  out.textContent = 'Searching…';
  try {
    const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(settings.tmdbKey)}&query=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const hits = (j.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 6);
    out.textContent = '';
    if (!hits.length) { out.textContent = 'No matches. You can still add it by hand.'; return; }
    for (const h of hits) {
      const title = h.title || h.name;
      const year = (h.release_date || h.first_air_date || '').slice(0, 4);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tmdb-pick';
      const img = document.createElement('img');
      if (h.poster_path) img.src = 'https://image.tmdb.org/t/p/w92' + h.poster_path;
      const span = document.createElement('span');
      span.textContent = `${title}${year ? ' (' + year + ')' : ''} · ${h.media_type === 'tv' ? 'TV series' : 'Movie'}`;
      b.append(img, span);
      b.addEventListener('click', () => {
        $('#f-title').value = title;
        $('#f-year').value = year;
        $('#f-poster').value = h.poster_path ? 'https://image.tmdb.org/t/p/w342' + h.poster_path : '';
        $('#f-tmdb').value = h.id;
        out.textContent = '';
      });
      out.append(b);
    }
  } catch {
    out.textContent = 'TMDB search failed. Check your API key and connection.';
  }
});

/* ---------- Add form ---------- */
$('#add-form').addEventListener('submit', e => {
  e.preventDefault();
  const entry = {
    id: uid(),
    title: $('#f-title').value.trim(),
    format: $('#f-format').value,
    year: $('#f-year').value.trim(),
    edition: $('#f-edition').value.trim(),
    barcode: $('#f-barcode').value.replace(/\D/g, ''),
    poster: $('#f-poster').value,
    tmdbId: $('#f-tmdb').value,
    addedAt: new Date().toISOString()
  };
  if (!entry.title) return;
  const dupe = library.find(i =>
    (entry.barcode && i.barcode === entry.barcode) ||
    (norm(i.title) === norm(entry.title) && i.format === entry.format && (i.year || '') === (entry.year || '')));
  if (dupe && !confirm(`You already have "${dupe.title}" on ${dupe.format}. Add another copy anyway?`)) return;
  library.push(entry);
  persist();
  contribute([entry]); // only does anything if the person opted in
  e.target.reset();
  $('#f-poster').value = ''; $('#f-tmdb').value = '';
  $('#tmdb-results').textContent = '';
  $('#result').hidden = true;
  $('#manual-code').value = '';
  $('#scan-msg').textContent = `Added "${entry.title}".`;
});

/* ---------- Settings, export / import ---------- */
$('#s-tmdb').value = settings.tmdbKey || '';
$('#btn-save-key').addEventListener('click', () => {
  settings.tmdbKey = $('#s-tmdb').value.trim();
  saveSettings();
  $('#btn-save-key').textContent = 'Saved ✓';
  setTimeout(() => $('#btn-save-key').textContent = 'Save key', 1500);
});

/* ---------- Community database settings ---------- */
{
  const share = $('#c-share'), use = $('#c-use'), all = $('#btn-share-all'), msg = $('#c-msg');
  share.checked = !!settings.share;
  use.checked = settings.useCommunity !== false;
  if (!COMMUNITY_API) {
    [share, use, all].forEach(el => { el.disabled = true; });
    msg.textContent = 'The community database is not set up in this copy of the app yet.';
  }
  share.addEventListener('change', () => { settings.share = share.checked; saveSettings(); });
  use.addEventListener('change', () => { settings.useCommunity = use.checked; saveSettings(); });
  all.addEventListener('click', async () => {
    if (!settings.share) { msg.textContent = 'Turn on "Share barcode info" first.'; return; }
    const pending = library.filter(i => i.barcode && !i.shared);
    if (!pending.length) { msg.textContent = 'Nothing new to share: every disc with a barcode has already been shared.'; return; }
    msg.textContent = 'Sharing…';
    const n = await contribute(pending);
    msg.textContent = n ? `Shared ${n} disc${n === 1 ? '' : 's'}. Thank you!` : 'Could not reach the community database. Try again later.';
  });
}

$('#btn-export').addEventListener('click', () => {
  const data = { app: 'discshelf', version: 1, exportedAt: new Date().toISOString(), library };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `discshelf-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  $('#io-msg').textContent = `Exported ${library.length} discs.`;
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.library;
    if (!Array.isArray(incoming)) throw new Error('bad format');
    let added = 0;
    for (const i of incoming) {
      if (!i || !i.title) continue;
      const exists = library.some(x => x.id === i.id ||
        (i.barcode && x.barcode === i.barcode && x.format === i.format) ||
        (norm(x.title) === norm(i.title) && x.format === i.format && (x.year || '') === (i.year || '')));
      if (!exists) {
        library.push({ id: i.id || uid(), title: String(i.title), format: i.format || 'Other', year: i.year || '',
          edition: i.edition || '', barcode: i.barcode || '', poster: i.poster || '', tmdbId: i.tmdbId || '',
          addedAt: i.addedAt || new Date().toISOString(), shared: i.shared === true });
        added++;
      }
    }
    persist();
    $('#io-msg').textContent = `Imported ${added} new discs (${incoming.length - added} already in your library).`;
  } catch {
    $('#io-msg').textContent = 'That file is not a valid DiscShelf library.';
  }
});
$('#btn-wipe').addEventListener('click', () => {
  if (confirm('Delete your whole library from this device? Export first if you want a backup.') &&
      confirm('Really delete everything?')) {
    library = [];
    persist();
  }
});

/* ---------- Offline support ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

renderLibrary();
