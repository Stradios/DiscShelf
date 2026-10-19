/* DiscShelf — local-first disc library. Your library lives in this browser. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LIB_KEY = 'discshelf.library.v1';
const SET_KEY = 'discshelf.settings.v1';
const FORMATS = ['DVD', 'Blu-ray', '4K UHD', 'HD DVD', 'Other'];
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';

function read(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }
  catch { return fallback; }
}
// Address of your community-database Worker, e.g. 'https://discshelf-api.yourname.workers.dev'
// (no trailing slash). Leave empty to run fully local. See worker/SETUP.md.
const COMMUNITY_API = 'https://discshelf-api.discshelf.workers.dev';

let library = read(LIB_KEY, []);
let settings = Object.assign({ tmdbKey: '', share: false, useCommunity: true }, read(SET_KEY, {}));

// Returns true if saved. quiet = don't show the "storage full" alert (caller handles it).
function persist(quiet = false) {
  let ok = true;
  try { localStorage.setItem(LIB_KEY, JSON.stringify(library)); }
  catch { ok = false; if (!quiet) alert('Could not save — browser storage is full or blocked.'); }
  renderLibrary();
  return ok;
}
function saveSettings() { localStorage.setItem(SET_KEY, JSON.stringify(settings)); }

// Ask the browser not to evict our data when storage is low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const byId = id => library.find(x => x.id === id);

// Only https images or small embedded photos are ever shown as posters.
const safePoster = u => (typeof u === 'string' &&
  (/^https:\/\/\S+$/i.test(u) || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u))) ? u : '';

// Tiny DOM helper. Text always goes in as text, never as HTML.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.filter(k => k != null && k !== false));
  return n;
}

/* ---------- Tabs ---------- */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === b));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab !== 'scan') stopScan();
}));

/* ---------- Library view ---------- */
function posterNode(i, cls = 'poster') {
  const wrap = el('div', { class: cls });
  const src = safePoster(i.poster);
  const fallback = () => { wrap.textContent = ''; wrap.append(el('span', { text: i.title })); };
  if (src) {
    const img = el('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', fallback);
    img.src = src;
    wrap.append(img);
  } else fallback();
  return wrap;
}

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
    grid.append(el('button', {
      class: 'item', type: 'button',
      'aria-label': `${i.title}, ${i.format}. Open details`,
      onclick: () => openDetail(i.id)
    },
      posterNode(i),
      el('div', { class: 'meta' },
        el('div', { class: 't', text: i.title }),
        el('div', { class: 's' },
          el('span', { class: 'badge', text: i.format }),
          [i.year, i.edition].filter(Boolean).join(' · ')))));
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
// Sends only barcode, title, format, year and TMDB info. Never notes, edition, photos or the library itself.
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
          barcode: e.barcode, title: e.title, format: e.format, year: e.year, tmdbId: e.tmdbId,
          poster: (e.poster || '').startsWith(IMG) ? e.poster : ''
        })))
      });
      if (r.status === 400) { chunk.forEach(e => { e.shared = true; }); continue; } // nothing valid; don't retry forever
      if (!r.ok) break; // includes 429 (slow down): stay unshared and try again later
      chunk.forEach(e => { e.shared = true; });
      sent += chunk.length;
    } catch { break; }
  }
  if (sent) persist(true);
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
  $('#f-poster').value = ''; $('#f-tmdb').value = ''; $('#f-type').value = '';
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

/* ---------- TMDB ---------- */
async function tmdbGet(path, params = {}) {
  const q = new URLSearchParams({ api_key: settings.tmdbKey, ...params });
  const r = await fetch(`${TMDB}${path}?${q}`);
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}
const yearOf = h => (h.release_date || h.first_air_date || '').slice(0, 4);
const pickFrom = h => ({
  title: h.title || h.name || '', year: yearOf(h), id: String(h.id), type: h.media_type,
  poster: h.poster_path ? IMG + 'w342' + h.poster_path : ''
});

// Searches TMDB and lists the results in `out`. Choosing one calls onPick({title, year, id, type, poster}).
async function runSearch(query, out, onPick) {
  out.className = 'tmdb-results';
  out.textContent = '';
  if (!query) return;
  const note = msg => { out.className = 'tmdb-results muted'; out.textContent = msg; };
  if (!settings.tmdbKey) return note('Add your free TMDB API key in Settings first.');
  out.textContent = 'Searching…';
  try {
    const j = await tmdbGet('/search/multi', { query });
    const hits = (j.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 8);
    out.textContent = '';
    if (!hits.length) return note('No matches. Try a shorter title.');
    for (const h of hits) {
      const p = pickFrom(h);
      const overview = (h.overview || '').trim();
      const img = el('img', { alt: '', referrerpolicy: 'no-referrer' });
      if (h.poster_path) img.src = IMG + 'w92' + h.poster_path;
      out.append(el('button', { type: 'button', class: 'tmdb-pick', onclick: () => onPick(p) },
        img,
        el('span', {},
          el('strong', { text: `${p.title}${p.year ? ' (' + p.year + ')' : ''}` }),
          el('small', { text: h.media_type === 'tv' ? 'TV series' : 'Movie' }),
          overview ? el('small', { text: overview.length > 120 ? overview.slice(0, 117) + '…' : overview }) : null)));
    }
  } catch {
    note('TMDB search failed. Check your API key and connection.');
  }
}

$('#btn-tmdb').addEventListener('click', () => {
  const out = $('#tmdb-results');
  runSearch($('#f-title').value.trim(), out, p => {
    $('#f-title').value = p.title;
    $('#f-year').value = p.year;
    $('#f-poster').value = p.poster;
    $('#f-tmdb').value = p.id;
    $('#f-type').value = p.type;
    out.textContent = '';
  });
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
    posterSource: $('#f-poster').value ? 'tmdb' : '',
    tmdbId: $('#f-tmdb').value,
    mediaType: $('#f-type').value,
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
  $('#f-poster').value = ''; $('#f-tmdb').value = ''; $('#f-type').value = '';
  $('#tmdb-results').textContent = '';
  $('#result').hidden = true;
  $('#manual-code').value = '';
  $('#scan-msg').textContent = `Added "${entry.title}".`;
});

/* ---------- Details screen ---------- */
const dlg = $('#detail');
const tmdbCache = new Map();   // "movie:123" -> TMDB details, kept for this visit only
let detailId = null;           // which disc is open
let detailInfo = null;         // { status, data } for the open disc
let panel = '';                // '', 'match' or 'poster'
let infoToken = 0;             // ignore answers that arrive after the disc was changed or closed

const fmtRuntime = m => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;

// Is TMDB's entry plausibly the same work as our saved title?
function sameWork(entry, d) {
  const mine = norm(entry.title);
  const names = [d.title, d.name, d.original_title, d.original_name].filter(Boolean).map(norm);
  if (names.includes(mine)) return true;
  const dYear = (d.release_date || d.first_air_date || '').slice(0, 4);
  return !!entry.year && dYear === entry.year && names.some(n => n && (n.includes(mine) || mine.includes(n)));
}

// Older entries don't remember whether they are a movie or a TV series, and TMDB reuses the same
// numbers for both. So for those we try movie, then TV, and keep whichever one matches the title.
async function fetchDetails(entry) {
  if (!settings.tmdbKey) return { status: 'nokey' };
  if (!entry.tmdbId) return { status: 'noid' };
  const types = entry.mediaType ? [entry.mediaType] : ['movie', 'tv'];
  let fallback = null, failed = false;
  for (const type of types) {
    const key = type + ':' + entry.tmdbId;
    let d = tmdbCache.get(key);
    if (!d) {
      try {
        d = await tmdbGet(`/${type}/${entry.tmdbId}`,
          { append_to_response: 'credits,images', include_image_language: 'en,sv,null' });
      } catch (err) {
        if (!/TMDB 404/.test(err.message)) failed = true;
        continue;
      }
      d._type = type;
      tmdbCache.set(key, d);
    }
    if (entry.mediaType || sameWork(entry, d)) {
      if (!entry.mediaType) { entry.mediaType = type; persist(true); }
      return { status: 'ok', data: d };
    }
    fallback = fallback || d;
  }
  if (fallback) return { status: 'ok', data: fallback, guessed: true };
  return { status: failed ? 'error' : 'gone' };
}

function openDetail(id) {
  detailId = id; panel = ''; detailInfo = { status: 'loading' };
  $('#d-panel').textContent = '';
  renderDetail();
  if (!dlg.open) dlg.showModal();
  loadInfo();
}
async function loadInfo() {
  const id = detailId, token = ++infoToken;
  const entry = byId(id);
  if (!entry) return;
  detailInfo = { status: 'loading' };
  renderDetail();
  const res = await fetchDetails(entry);
  if (token !== infoToken) return;
  detailInfo = res;
  renderDetail();
  if (panel === 'poster' && byId(id)) buildPosterPanel(byId(id)); // refresh the TMDB poster options
}

const STATUS_TEXT = {
  loading: 'Loading details from TMDB…',
  nokey: 'Add your TMDB API key in Settings to see the overview, director and cast.',
  noid: "This disc isn't linked to a TMDB entry yet. Use Change match to link it.",
  gone: 'TMDB no longer has an entry with this id. Use Change match to pick another one.',
  error: "Couldn't reach TMDB. Check your connection and try again."
};

function renderDetail() {
  const e = byId(detailId);
  if (!e) { if (dlg.open) dlg.close(); return; }
  $('#d-title').textContent = e.title;
  const box = $('#d-info');
  box.textContent = '';
  const st = detailInfo ? detailInfo.status : 'loading';
  const d = st === 'ok' ? detailInfo.data : null;

  const facts = el('div', { class: 'd-facts' });
  const add = (label, value) => { if (value) facts.append(el('p', { class: 'd-line' }, el('strong', { text: label + ': ' }), value)); };
  facts.append(el('p', { class: 'd-line' },
    el('span', { class: 'badge', text: e.format }), [e.year, e.edition].filter(Boolean).join(' · ')));
  if (d) {
    const isTv = d._type === 'tv';
    add('Genre', (d.genres || []).slice(0, 3).map(g => g.name).join(', '));
    if (isTv) {
      add('Length', [d.number_of_seasons && `${d.number_of_seasons} season${d.number_of_seasons === 1 ? '' : 's'}`,
        d.number_of_episodes && `${d.number_of_episodes} episodes`].filter(Boolean).join(' · '));
      add('Created by', (d.created_by || []).map(p => p.name).join(', '));
    } else {
      add('Runtime', d.runtime ? fmtRuntime(d.runtime) : '');
      const dirs = [...new Set(((d.credits && d.credits.crew) || []).filter(c => c.job === 'Director').map(c => c.name))];
      add(dirs.length > 1 ? 'Directors' : 'Director', dirs.join(', '));
    }
    add('Cast', ((d.credits && d.credits.cast) || []).slice(0, 8).map(c => c.name).join(', '));
  }
  add('Barcode', e.barcode);
  box.append(el('div', { class: 'd-top' }, posterNode(e, 'poster d-poster'), facts));

  if (d && d.overview) box.append(el('p', { class: 'd-over', text: d.overview }));

  if (d) {
    const dYear = (d.release_date || d.first_air_date || '').slice(0, 4);
    const label = `${d.title || d.name}${dYear ? ' (' + dYear + ')' : ''} · ${d._type === 'tv' ? 'TV series' : 'Movie'}`;
    if (detailInfo.guessed || !sameWork(e, d)) {
      box.append(el('p', { class: 'd-note warn',
        text: `Check this match. TMDB's entry for this id is "${label}", which may not be your disc. If that's wrong, use Change match.` }));
    } else {
      box.append(el('p', { class: 'd-note muted', text: `Matched on TMDB: ${label}` }));
    }
  } else {
    box.append(el('p', { class: 'd-note muted', text: STATUS_TEXT[st] || '' }));
  }

  const type = e.mediaType || (d && d._type);
  box.append(el('div', { class: 'd-actions' },
    el('button', { type: 'button', text: 'Change match', 'aria-expanded': String(panel === 'match'), onclick: () => togglePanel('match') }),
    el('button', { type: 'button', text: 'Change poster', 'aria-expanded': String(panel === 'poster'), onclick: () => togglePanel('poster') }),
    e.tmdbId && type ? el('a', { class: 'btn', href: `https://www.themoviedb.org/${type}/${e.tmdbId}`, target: '_blank', rel: 'noopener noreferrer', text: 'Open on TMDB' }) : null,
    el('button', { type: 'button', class: 'danger', text: 'Remove', onclick: () => removeDisc(e) })));
}

function togglePanel(name) {
  const e = byId(detailId);
  if (!e) return;
  panel = panel === name ? '' : name;
  const box = $('#d-panel');
  box.textContent = '';
  if (panel === 'match') buildMatchPanel(e);
  else if (panel === 'poster') buildPosterPanel(e);
  renderDetail();
  if (panel) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function closePanel() { panel = ''; $('#d-panel').textContent = ''; }

function removeDisc(e) {
  if (!confirm(`Remove "${e.title}" (${e.format}) from your library?`)) return;
  library = library.filter(x => x.id !== e.id);
  persist();
  dlg.close();
}

/* -- Change match -- */
function buildMatchPanel(e) {
  const box = $('#d-panel');
  const out = el('div', { class: 'tmdb-results' });
  const input = el('input', { value: e.title, placeholder: 'Search TMDB…', 'aria-label': 'Search TMDB' });
  const run = () => runSearch(input.value.trim(), out, p => applyMatch(e, p));
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); run(); } });
  box.append(el('div', { class: 'd-sec' },
    el('h3', { text: 'Pick the right title' }),
    el('div', { class: 'row' }, input, el('button', { type: 'button', class: 'primary', text: 'Search', onclick: run })),
    out));
  if (settings.tmdbKey) run();
  else out.textContent = 'Add your free TMDB API key in Settings first.';
}
function applyMatch(e, p) {
  e.title = p.title; e.year = p.year; e.tmdbId = p.id; e.mediaType = p.type;
  if (e.posterSource !== 'custom') { e.poster = p.poster; e.posterSource = p.poster ? 'tmdb' : ''; } // keep your own photo
  e.shared = false;
  persist();
  contribute([e]); // only if you opted in; adds your corrected answer to the community database
  closePanel();
  loadInfo();
}

/* -- Change poster -- */
function applyPoster(e, url, source, msg) {
  const prev = [e.poster, e.posterSource];
  e.poster = url; e.posterSource = source;
  if (!persist(true)) {
    [e.poster, e.posterSource] = prev;
    renderLibrary();
    msg.textContent = 'Not enough browser storage for that image. Try a link or one of the TMDB posters instead.';
    return;
  }
  closePanel();
  renderDetail();
}
function testImage(url) {
  return new Promise(res => {
    const i = new Image();
    i.referrerPolicy = 'no-referrer';
    i.onload = () => res(true);
    i.onerror = () => res(false);
    setTimeout(() => res(false), 10000);
    i.src = url;
  });
}
// Crops the middle of the photo to a poster shape and shrinks it so it stays small in browser storage.
function photoToPoster(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const W = 280, H = 420, c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        resolve(c.toDataURL('image/jpeg', 0.72));
      } catch (err) { reject(err); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}

function buildPosterPanel(e) {
  const box = $('#d-panel');
  box.textContent = '';
  const msg = el('p', { class: 'muted', role: 'status' });
  const st = detailInfo ? detailInfo.status : 'loading';
  const d = st === 'ok' ? detailInfo.data : null;

  // 1. Other posters TMDB has for this title
  const alt = el('div', { class: 'alt-grid' });
  const posters = d && d.images && d.images.posters
    ? d.images.posters.slice().sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)).slice(0, 18) : [];
  for (const p of posters) {
    const img = el('img', { alt: 'Poster option', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.src = IMG + 'w185' + p.file_path;
    alt.append(el('button', { type: 'button', class: 'alt', 'aria-label': 'Use this poster',
      onclick: () => applyPoster(e, IMG + 'w342' + p.file_path, 'tmdb', msg) }, img));
  }
  const altNote = d ? (posters.length ? '' : 'TMDB has no other posters for this title.')
    : st === 'loading' ? 'Loading poster options…'
    : 'Poster options come from TMDB. Link this disc to a TMDB entry first with Change match.';

  // 2. A link
  const link = el('input', { type: 'url', placeholder: 'https://… link to an image', 'aria-label': 'Image link' });
  const useLink = async () => {
    const u = link.value.trim();
    if (!/^https:\/\/\S+$/i.test(u)) { msg.textContent = 'Paste a link that starts with https://'; return; }
    msg.textContent = 'Checking the image…';
    if (!(await testImage(u))) { msg.textContent = "That link didn't load as an image."; return; }
    applyPoster(e, u, 'custom', msg);
  };
  link.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); useLink(); } });

  // 3. A photo of your own case
  const file = el('input', { type: 'file', accept: 'image/*', hidden: '' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    msg.textContent = 'Preparing the photo…';
    try { applyPoster(e, await photoToPoster(f), 'custom', msg); }
    catch { msg.textContent = "That file couldn't be read as an image."; }
  });

  box.append(el('div', { class: 'd-sec' },
    el('h3', { text: 'Other posters from TMDB' }),
    altNote ? el('p', { class: 'muted', text: altNote }) : alt),
    el('div', { class: 'd-sec' },
      el('h3', { text: 'Use an image link' }),
      el('div', { class: 'row' }, link, el('button', { type: 'button', text: 'Use link', onclick: useLink }))),
    el('div', { class: 'd-sec' },
      el('h3', { text: 'Use a photo of your own case' }),
      el('p', { class: 'muted', text: 'Hold the case so the cover fills the picture. The middle is cropped to poster shape and stored only on this device.' }),
      el('label', { class: 'btn' }, 'Take or choose a photo', file)),
    el('div', { class: 'd-sec row' },
      d && d.poster_path ? el('button', { type: 'button', text: "Use TMDB's main poster",
        onclick: () => applyPoster(e, IMG + 'w342' + d.poster_path, 'tmdb', msg) }) : null,
      e.poster ? el('button', { type: 'button', text: 'Remove poster', onclick: () => applyPoster(e, '', '', msg) }) : null),
    msg);
}

$('#d-close').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); }); // click on the dark backdrop
dlg.addEventListener('close', () => { detailId = null; infoToken++; closePanel(); });

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
        // Imported files are treated as untrusted: keep only values of the expected shape.
        const poster = safePoster(i.poster);
        library.push({
          id: String(i.id || uid()),
          title: String(i.title).slice(0, 200),
          format: FORMATS.includes(i.format) ? i.format : 'Other',
          year: /^\d{4}$/.test(String(i.year || '')) ? String(i.year) : '',
          edition: String(i.edition || '').slice(0, 200),
          barcode: String(i.barcode || '').replace(/\D/g, ''),
          poster,
          posterSource: !poster ? '' : (i.posterSource === 'custom' ? 'custom' : 'tmdb'),
          tmdbId: /^\d{1,10}$/.test(String(i.tmdbId || '')) ? String(i.tmdbId) : '',
          mediaType: i.mediaType === 'movie' || i.mediaType === 'tv' ? i.mediaType : '',
          addedAt: i.addedAt || new Date().toISOString(),
          shared: i.shared === true
        });
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
