/**
 * Austria WebTV — script.js
 *
 * A lightweight IPTV web player that loads channels from `channels.json` and
 * logos from `logos.json`. Supports HLS streaming, iframe embeds, external
 * links, EPG (TV guide), favourites, and an optional local proxy for
 * geo-blocked streams.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 *   1. On page load, `init()` fetches channels + logos in parallel.
 *   2. Channels are rendered as cards in a responsive grid.
 *   3. Clicking a card routes to the correct player (HLS, iframe, or external).
 *   4. A sidebar shows the current EPG program for the active channel.
 *   5. An optional local proxy (`node proxy.js`) bypasses CORS / geo blocks.
 *
 * ── Files this script expects ────────────────────────────────────────────────
 *   channels.json  — Array of { id, name, type, url, cat, logo?, hint? }
 *   logos.json     — { _base: { kodinerds: "..." }, logos: { id: { src, path } } }
 *
 * ── Optional proxy ──────────────────────────────────────────────────────────
 *   Start with:  node proxy.js
 *   The script auto-detects it via /ping on port 8888.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  1. LOGO HELPER
//      Resolves the best available logo for a channel, with fallback chain.
// ─────────────────────────────────────────────────────────────────────────────

/** Full URLs keyed by channel id, built after logos.json loads. */
let TV_LOGOS = {};

/** Base URL for kodinerds-hosted logos (e.g. "https://www.kodinerds.net/..."). */
let kodinerdsBase = "";

/** Returns the channel number shown in the UI (based on source order). */
function getChannelNumber(ch) {
    return Number.isFinite(ch?._number) ? ch._number : null;
}

/** Formats the channel label with its number when available. */
function formatChannelLabel(ch) {
    const number = getChannelNumber(ch);
    return number ? '#' + String(number).padStart(2, '0') + ' · ' + ch.name : ch.name;
}

/**
 * Returns an <img> tag for the channel logo.
 * Fallback order: TV_LOGOS → channel's own logo → placeholder.
 *
 * @param {Object} ch   Channel object from channels.json
 * @param {string} cls  CSS class for the <img> element
 * @returns {string}    HTML string
 */
function logoImgHtml(ch, cls) {
    cls = cls || 'channel-logo';
    var primary = TV_LOGOS[ch.id] || (ch.logo ? kodinerdsBase + ch.logo : null);
    var secondary = (TV_LOGOS[ch.id] && ch.logo) ? kodinerdsBase + ch.logo : null;
    var fallback = 'https://placehold.co/120x50/1a1a1a/555?text=' + encodeURIComponent(ch.name);
    var src = primary || fallback;

    // If primary fails, try secondary; if that fails too, use the placeholder.
    var onError = secondary
        ? "this.onerror=function(){this.onerror=null;this.src='" + fallback + "'};this.src='" + secondary + "'"
        : "this.onerror=null;this.src='" + fallback + "'";

    return '<img src="' + src + '" class="' + cls + '" alt="' + ch.name + '" loading="lazy" onerror="' + onError + '">';
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. DATA LOADER
//      Fetches channels.json and logos.json once at startup.
// ─────────────────────────────────────────────────────────────────────────────

let allChannels = [];
let EPG_IDS = {};

/**
 * Loads channels, logos, and EPG IDs in parallel and builds lookup maps.
 */
async function loadData() {
    try {
        const [channelsRes, logosRes, epgIdsRes] = await Promise.all([
            fetch('Channels.json'),
            fetch('Logos.json'),
            fetch('epg-ids.json')
        ]);

        const channelsData = await channelsRes.json();
        allChannels = channelsData.map((channel, index) => ({
            ...channel,
            _number: index + 1
        }));

        const logosData = await logosRes.json();
        const bases = logosData._base;
        kodinerdsBase = bases.kodinerds;

        // Build TV_LOGOS = { channelId: "full URL" }
        TV_LOGOS = {};
        for (const [id, entry] of Object.entries(logosData.logos)) {
            TV_LOGOS[id] = bases[entry.src] + entry.path;
        }

        // Load EPG IDs from JSON
        EPG_IDS = await epgIdsRes.json();
        
        console.log('✅ Daten geladen:', { channelCount: allChannels.length, logoCount: Object.keys(TV_LOGOS).length });
    } catch (err) {
        console.error('❌ Fehler beim Laden:', err);
        throw err;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. DOM REFERENCES
//      Cached element handles — all elements must exist in the HTML.
// ─────────────────────────────────────────────────────────────────────────────

const grid         = document.getElementById('channelGrid');
const playerArea   = document.getElementById('player-area');
const channelList  = document.getElementById('channelList');
const label        = document.getElementById('currentLabel');
const statusEl     = document.getElementById('statusIndicator');
const searchInput  = document.getElementById('channelSearch');
const clearBtn     = document.getElementById('clearSearch');
const liveDot      = document.getElementById('liveDot');
const countEl      = document.getElementById('channelCount');
const subtitleBtn  = document.getElementById('subtitleBtn');
const epgBtn       = document.getElementById('epgBtn');
const epgStrip     = document.getElementById('epgStrip');
const epgChanName  = document.getElementById('epgChannelName');
const epgMoreLink  = document.getElementById('epgMoreLink');

// ─────────────────────────────────────────────────────────────────────────────
//  4. APPLICATION STATE
// ─────────────────────────────────────────────────────────────────────────────

let hlsInstance      = null;   // Current HLS.js player instance
let activeId         = null;   // ID of the currently selected channel
let activeChannel    = null;   // Full channel object currently selected
let activeCategory   = 'all';  // Active filter category
let subsEnabled      = false;  // Whether subtitles are toggled on
let currentVideo     = null;   // Reference to the <video> element
let epgVisible       = false;  // Is the EPG strip visible?
let epgAbort         = null;   // AbortController for in-flight EPG requests
let favorites        = JSON.parse(localStorage.getItem('tvFavorites')) || [];
let manualEpgIds     = JSON.parse(localStorage.getItem('manualEpgIds') || '{}');

const ORF2_REGIONAL_IDS = ['orf2b', 'orf2k', 'orf2n', 'orf2o', 'orf2s', 'orf2st', 'orf2t', 'orf2v', 'orf2w'];

function isOrf2Regional(ch) {
    return ORF2_REGIONAL_IDS.includes(ch.id);
}

function cardIdForChannel(ch) {
    return isOrf2Regional(ch) ? 'orf2' : ch.id;
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. PROXY HANDLING
//      Optional local proxy (node proxy.js) for geo-blocked / CORS streams.
//      Runs on localhost:8888.
// ─────────────────────────────────────────────────────────────────────────────

const PROXY_PORT = 8888;
const PROXY_BASE = 'http://localhost:' + PROXY_PORT;
let proxyOnline  = false;
let proxyCountry = null;  // Country code detected by the proxy for the current stream

/** Wraps a stream URL through the local proxy. */
function proxyUrl(streamUrl) {
    return PROXY_BASE + '/proxy?url=' + encodeURIComponent(streamUrl);
}

/**
 * Routes Netplus URLs through the regional proxy (/proxy/ch/, /proxy/at/, /proxy/de/).
 * Returns the proxied URL or the original URL if it's not a Netplus stream.
 */
function netplusProxyUrl(streamUrl) {
    const lower = streamUrl.toLowerCase();
    if (lower.includes('netplus.ch')) {
        // Extrahiere den Pfad nach dem Domain und route durch CH-Proxy
        const path = streamUrl.split('netplus.ch')[1] || '';
        return PROXY_BASE + '/proxy/ch' + path;
    }
    if (lower.includes('netplus.at')) {
        const path = streamUrl.split('netplus.at')[1] || '';
        return PROXY_BASE + '/proxy/at' + path;
    }
    if (lower.includes('netplus.de')) {
        const path = streamUrl.split('netplus.de')[1] || '';
        return PROXY_BASE + '/proxy/de' + path;
    }
    return streamUrl; // Nicht Netplus, direkt verwenden
}

/**
 * Pings the proxy to check if it's running.
 * Updates the proxy badge in the UI.
 */
async function detectProxy() {
    try {
        const r = await fetch(PROXY_BASE + '/ping', { signal: AbortSignal.timeout(800) });
        const j = await r.json();
        if (j.ok) { proxyOnline = true; updateProxyBadge(true); }
    } catch { proxyOnline = false; updateProxyBadge(false); }
    // Note: if proxy is not running, streams will try direct access first, then fallback to blocked-card
}

/** Renders the proxy status badge (top bar). */
function updateProxyBadge(online) {
    const badge = document.getElementById('proxyBadge');
    if (!badge) return;
    badge.textContent = online ? '🔀 Proxy aktiv' : '⚠️ Kein Proxy';
    badge.className = 'proxy-badge ' + (online ? 'proxy-on' : 'proxy-off');
    badge.title = online
        ? 'Lokaler Proxy auf Port ' + PROXY_PORT + ' — Streams werden geo-umgeleitet'
        : 'Proxy offline → starte: node proxy.js';
}

/**
 * Asks the proxy for the stream's geo-country and updates the page theme
 * (flag, accent colour) accordingly.
 */
async function updateThemeForStream(streamUrl) {
    if (!proxyOnline) return;
    try {
        const r = await fetch(PROXY_BASE + '/geo?url=' + encodeURIComponent(streamUrl), { signal: AbortSignal.timeout(600) });
        const j = await r.json();
        if (j.country && j.country !== proxyCountry) {
            proxyCountry = j.country;
            applyLocationTheme(j.country);
        }
    } catch { /* ignore — theme change is cosmetic */ }
}

// ────────────────────────────────────────────────────────────────────────────
//  6. INIT
//      Entry point. Called once the page has loaded.
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
    applyLocationTheme();
    detectProxy();
    setSidebarProgramIdle();

    try {
        await loadData();
        console.log('✅ Init erfolgreich');
    } catch (e) {
        console.error('❌ Fehler beim Laden von Channels/Logos:', e);
        grid.innerHTML = '<div class="no-results">⚠️ Fehler beim Laden der Senderliste. Browser-Console prüfen (F12).</div>';
        return;
    }

    setupCategoryNav();
    setupSubtitleBtn();
    setupEpgBtn();
    setupSidebarProgramActions();
    renderAll();

    // Search
    searchInput.addEventListener('input', () => renderAll());
    clearBtn.addEventListener('click', () => { searchInput.value = ''; renderAll(); searchInput.focus(); });

    // Global keyboard shortcuts (ArrowLeft / ArrowRight / Esc / F)
    document.addEventListener('keydown', (e) => {
        // Ignore when typing in inputs or editable areas
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

        if (e.key === 'ArrowRight') { e.preventDefault(); nextChannel(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); prevChannel(); }
        else if (e.key === 'Escape') { e.preventDefault(); stopPlayback(); }
        else if (e.key.toLowerCase() === 'f') { // toggle favourite for active channel
            if (activeChannel) toggleFav(activeChannel.id);
        }
    });
}

/** Binds click handlers to the category filter buttons. */
function setupCategoryNav() {
    const allCatBtns = document.querySelectorAll('.cat-btn');
    allCatBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            allCatBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = btn.dataset.cat;
            renderAll();
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  7. SUBTITLES
// ─────────────────────────────────────────────────────────────────────────────

/** Toggles subtitle visibility on/off. */
function setupSubtitleBtn() {
    subtitleBtn.addEventListener('click', () => {
        subsEnabled = !subsEnabled;
        subtitleBtn.classList.toggle('active', subsEnabled);
        subtitleBtn.setAttribute('aria-pressed', String(subsEnabled));
        applySubtitles();
    });
}

/** Applies the current subsEnabled state to the active video / HLS instance. */
function applySubtitles() {
    if (!currentVideo) return;
    for (let i = 0; i < currentVideo.textTracks.length; i++)
        currentVideo.textTracks[i].mode = subsEnabled ? 'showing' : 'hidden';
    if (hlsInstance && hlsInstance.subtitleTracks.length > 0)
        hlsInstance.subtitleTrack = subsEnabled ? 0 : -1;
}

/** Shows or hides the subtitle toggle button. */
function showSubtitleBtn(show) {
    subtitleBtn.classList.toggle('hidden', !show);
    if (!show) { subsEnabled = false; subtitleBtn.classList.remove('active'); subtitleBtn.setAttribute('aria-pressed', 'false'); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  8. EPG (TV GUIDE) TOGGLE
// ─────────────────────────────────────────────────────────────────────────────

function setupEpgBtn() {
    epgBtn.addEventListener('click', () => {
        epgVisible = !epgVisible;
        epgBtn.classList.toggle('active', epgVisible);
        epgStrip.classList.toggle('hidden', !epgVisible);
        if (epgVisible && activeChannel) {
            loadEpg(activeChannel);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  9. FILTERING & RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Category hierarchy: All → Favorites → AT → AT-Public → AT-Private → DE → US → HLS → Others
 */
function getFiltered() {
    const term = searchInput.value.toLowerCase().trim();
    return allChannels.filter(ch => {
        if (isOrf2Regional(ch)) return false;
        return matchesSearch(ch, term) && matchesCategory(ch);
    });
}

function matchesSearch(ch, term) {
    return !term || ch.name.toLowerCase().includes(term);
}

function matchesCategory(ch) {
    switch (activeCategory) {
        case 'all': return true;
        case 'fav': return favorites.includes(ch.id);
        case 'at': return ch.cat === 'at-public' || ch.cat === 'at-private';
        case 'at-public': return ch.cat === 'at-public';
        case 'at-private': return ch.cat === 'at-private';
        case 'de': return ch.cat === 'de-public' || ch.cat === 'de-private';
        case 'us': return ch.cat === 'us.public' || ch.cat === 'us-private';
        case 'hls': return ch.type === 'hls';
        default: return ch.cat === activeCategory;
    }
}

/** Re-renders the channel grid with current filters and search term. */
function renderAll() {
    clearBtn.style.display = searchInput.value ? 'block' : 'none';
    const filtered = getFiltered();
    countEl.textContent = filtered.length + ' Sender';

    // Sort: favourites first, then alphabetically (German locale).
    const sorted = [...filtered].sort((a, b) => {
        const af = favorites.includes(a.id), bf = favorites.includes(b.id);
        if (af !== bf) return af ? -1 : 1;
        return a.name.localeCompare(b.name, 'de');
    });

    grid.innerHTML = '';
    if (!sorted.length) { grid.innerHTML = '<div class="no-results">Keine Sender gefunden</div>'; return; }
    sorted.forEach((ch, i) => grid.appendChild(createCard(ch, i)));
}

/** Creates a single channel card DOM element. */
function createCard(ch, index) {
    const isFav    = favorites.includes(ch.id);
    const isActive = cardIdForChannel(ch) === cardIdForChannel(activeChannel || ch) && !!activeChannel;
    const BADGE    = { hls: 'LIVE', orf: 'EXT', iframe: 'WEB', link: 'EXT' };

    const card = document.createElement('div');
    card.className = 'channel-card' + (isFav ? ' is-fav' : '') + (isActive ? ' is-active' : '');
    card.style.animationDelay = Math.min(index * 22, 350) + 'ms';
    card.dataset.id = ch.id;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', ch.name + ' abspielen');

    card.innerHTML =
        '<div class="card-top">' +
        '<span class="type-badge type-' + ch.type + '">' + (BADGE[ch.type] || '') + '</span>' +
        '<button class="fav-btn" aria-label="' + (isFav ? 'Aus Favoriten' : 'Favorit') + '">' + (isFav ? '❤️' : '') + '</button>' +
        '</div>' +
        logoImgHtml(ch) +
        '<div class="channel-name">' + ch.name + '</div>';

    if (ch.id === 'orf2') {
        const variants = allChannels.filter(item => item.id === 'orf2' || isOrf2Regional(item));
        if (variants.length > 1) {
            const select = document.createElement('select');
            select.className = 'orf2-dropdown';
            select.setAttribute('aria-label', 'ORF 2 Region wählen');

            variants.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.textContent = item.name;
                select.appendChild(opt);
            });

            const selectedId = variants.some(item => item.id === activeId) ? activeId : 'orf2';
            select.value = selectedId;

            select.addEventListener('click', e => e.stopPropagation());
            select.addEventListener('keydown', e => e.stopPropagation());
            select.addEventListener('change', e => {
                e.stopPropagation();
                const picked = allChannels.find(item => item.id === e.target.value);
                if (picked) play(picked);
            });

            card.appendChild(select);
        }
    }

    card.querySelector('.fav-btn').addEventListener('click', e => { e.stopPropagation(); toggleFav(ch.id); });
    card.addEventListener('click', () => play(ch));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(ch); } });
    return card;
}

/** Adds or removes a channel from favourites (persisted in localStorage). */
function toggleFav(id) {
    favorites = favorites.includes(id) ? favorites.filter(f => f !== id) : [...favorites, id];
    localStorage.setItem('tvFavorites', JSON.stringify(favorites));
    renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
//  10. PLAYER
//       Routes playback to HLS, iframe, or external link.
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = 'topbar-status status-' + (type || 'default');
}

function setLive(on) { liveDot.classList.toggle('live', on); }

/**
 * Main entry point for playing a channel.
 * Cleans up any existing player, applies the theme, and delegates to the
 * correct sub-player based on ch.type.
 */
function play(ch) {
    activeChannel = ch;
    activeId = ch.id;
    const activeCardId = cardIdForChannel(ch);
    document.querySelectorAll('.channel-card').forEach(c => c.classList.toggle('is-active', c.dataset.id === activeCardId));
    label.textContent = formatChannelLabel(ch);

    applyThemeForChannel(ch);

    setLive(false); currentVideo = null; showSubtitleBtn(false);
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    playerArea.innerHTML = '';

    if (ch.type === 'hls')        playHls(ch);
    else if (ch.type === 'iframe') playIframe(ch);
    else if (ch.type === 'file' || ch.type === 'mp4') playFile(ch);
    else                           showExternalLink(ch);

    loadEpg(ch);
}

/** Plays an HLS (.m3u8) stream using HLS.js or native Safari playback. */
function playHls(ch) {
    if (!Hls.isSupported()) {
        showExternalLink(ch);
        return;
    }

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.style.width = '100%';
    video.style.height = '100%';
    playerArea.innerHTML = '';
    playerArea.appendChild(video);

    const hls = new Hls({
        maxMaxBufferLength: 30,
        enableWorker: true
    });

    hls.loadSource(ch.url);
    hls.attachMedia(video);

    hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
            console.warn("HLS Fatal Error:", data);
            hls.destroy();
            showFallback(ch);
        }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus('● LIVE', 'live'); setLive(true);
        video.play().catch(() => { });
        showSubtitleBtn(hls.subtitleTracks.length > 0);
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (proxyOnline) {
            // Proxy is already on → stream is genuinely unavailable.
            setStatus('Stream nicht verfügbar', 'error');
            setLive(false); showSubtitleBtn(false); showFallback(ch);
        } else {
            // Try enabling the proxy as a last resort.
            setStatus('Direktzugriff blockiert — versuche Proxy…', 'loading');
            detectProxy().then(() => {
                if (proxyOnline) { hlsInstance.destroy(); hlsInstance = null; playHls(ch); }
                else { setStatus('Stream nicht verfügbar', 'error'); setLive(false); showSubtitleBtn(false); showFallback(ch); }
            });
        }
    });
}

/** Plays a direct file (MP4) using the browser's native video element. */
function playFile(ch) {
    let streamUrl = ch.url;
    if (proxyOnline) streamUrl = proxyUrl(streamUrl);

    setStatus('Lade Video…', 'loading');

    const video = document.createElement('video');
    video.controls = true; video.autoplay = true; video.playsInline = true;
    video.src = streamUrl;
    playerArea.appendChild(video);
    currentVideo = video;
    showSubtitleBtn(false);

    video.addEventListener('loadedmetadata', () => {
        setStatus('Wiedergabe gestartet', 'ok');
    });
    video.addEventListener('error', () => {
        setStatus('Video nicht verfügbar', 'error');
        showFallback(ch);
    });
}

/** Renders a "blocked" card with an external link fallback. */
function showBlockedCard(ch, opts) {
    opts = opts || {};
    var btnLabel = opts.btnLabel || (ch.name + ' öffnen');
    var accent   = opts.accentColor ? 'style="background:' + opts.accentColor + '"' : '';
    var hintHtml = ch.hint
        ? '<div class="blocked-hint"><svg viewBox="0 0 20 20" fill="none" width="13" height="13" style="flex-shrink:0;margin-top:1px"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5M10 7v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>' + ch.hint + '</span></div>'
        : '';
    var errorHtml = opts.isError
        ? '<div class="blocked-error">Stream-Fehler: Direktzugriff blockiert (CORS / Geoblocking)</div>'
        : '';

    playerArea.innerHTML =
        '<div class="blocked-card">' +
        logoImgHtml(ch, 'blocked-logo') +
        '<div class="blocked-name">' + ch.name + '</div>' +
        hintHtml + errorHtml +
        '<a href="' + ch.url + '" target="_blank" rel="noopener noreferrer" class="ext-btn blocked-btn" ' + accent + '>' +
        '<svg viewBox="0 0 20 20" fill="none" width="14" height="14"><path d="M11 3h6v6M17 3l-9 9M8 5H4a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        btnLabel +
        '</a>' +
        '</div>';
}

/** Loads a channel that provides its own web player via iframe. */
function playIframe(ch) {
    setStatus('Lädt Web-Player…', 'loading');
    const iframe = document.createElement('iframe');
    iframe.src = ch.url; iframe.allow = 'autoplay; fullscreen; encrypted-media'; iframe.setAttribute('allowfullscreen', '');
    playerArea.appendChild(iframe);
    iframe.addEventListener('load',  () => setStatus('Web-Player geladen', 'ok'));
    iframe.addEventListener('error', () => showBlockedCard(ch));
}

function showExternalLink(ch) { setStatus('Externer Link', 'ext'); showBlockedCard(ch); }
function showFallback(ch) { 
    setStatus('Stream nicht verfügbar', 'error'); 
    
    let fallbackCh = Object.assign({}, ch);
    let btnText = 'Auf Webseite öffnen';

    if (ch.fallback) {
        fallbackCh.url = ch.fallback;
        btnText = ch.name + ' öffnen';
    } else if (ch.id.startsWith('orf') || ch.name.toLowerCase().includes('orf')) {
        fallbackCh.url = 'https://on.orf.at/';
        btnText = 'Auf ORF ON öffnen';
    } 

    showBlockedCard(fallbackCh, { isError: true, btnLabel: btnText });
}

// ─────────────────────────────────────────────────────────────────────────────
//  11. EPG (TV GUIDE)
//       Fetches program data from epg.pw and renders it in the strip + sidebar.
// ─────────────────────────────────────────────────────────────────────────────

const EPG_API = 'https://epg.pw/api/epg.json';
const EPG_WEB = 'https://epg.pw/last/';

/**
 * Fetches EPG data for a channel and renders it in both the bottom strip
 * and the sidebar panel.
 */
async function loadEpg(ch) {
    setSidebarProgramLoading(ch);
    epgChanName.textContent = ch.name;
    epgList.innerHTML = '<div class="epg-loading"><span class="epg-spinner"></span>Lade Programm…</div>';
    epgMoreLink.style.display = 'none';

    // Cancel any previous EPG request
    if (epgAbort) epgAbort.abort();
    epgAbort = new AbortController();
    const { signal } = epgAbort;

    try {
        let cid = getEpgChannelId(ch);
        if (!cid) {
            epgList.innerHTML = '<div class="epg-empty">Kein Programm gefunden</div>';
            setSidebarProgramEmpty('Kein Programm gefunden', ch);
            return;
        }

        epgMoreLink.href = EPG_WEB + cid + '.html?lang=de';
        epgMoreLink.style.display = '';

        const date = epgDateString();
        const reqUrl = EPG_API + '?lang=de&date=' + date + '&channel_id=' + cid;
        const res = await fetch(reqUrl, { signal });
        const rawPrograms = await res.json();
        const programs = normalizeEpgPrograms(rawPrograms);

        renderEpg(programs);
        renderSidebarProgram(programs, ch);
    } catch (err) {
        if (err.name === 'AbortError') return;
        epgList.innerHTML = '<div class="epg-empty">Programm nicht verfügbar</div>';
        setSidebarProgramEmpty('Programm nicht verfügbar', ch);
    }
}

/** Renders the EPG strip (bottom panel). */
function renderEpg(programs) {
    if (!programs?.length) { epgList.innerHTML = '<div class="epg-empty">Kein Programm verfügbar</div>'; return; }

    const now   = Date.now() / 1000;
    const items = programs.filter(p => p.stop > now - 3600).slice(0, 24);
    if (!items.length) { epgList.innerHTML = '<div class="epg-empty">Keine heutigen Sendungen</div>'; return; }

    epgList.innerHTML = '';
    let scrollTarget = null;

    items.forEach(prog => {
        const isNow  = prog.start <= now && now < prog.stop;
        const isPast = prog.stop <= now;
        const pct    = isNow ? Math.round(((now - prog.start) / (prog.stop - prog.start)) * 100) : 0;

        const el = document.createElement('div');
        el.className = 'epg-item' + (isNow ? ' epg-now' : '') + (isPast ? ' epg-past' : '');
        el.innerHTML =
            '<div class="epg-time"><span class="epg-start">' + fmtTime(prog.start) + '</span>' +
            (isNow ? '<span class="epg-now-badge">JETZT</span>' : '') + '</div>' +
            '<div class="epg-info"><div class="epg-show-title">' + esc(prog.title || '—') + '</div>' +
            (prog.description ? '<div class="epg-show-desc">' + esc(prog.description.slice(0, 110)) + (prog.description.length > 110 ? '…' : '') + '</div>' : '') +
            (isNow ? '<div class="epg-progress"><div class="epg-progress-bar" style="width:' + pct + '%"></div></div>' : '') +
            '</div><div class="epg-end">' + fmtTime(prog.stop) + '</div>';

        epgList.appendChild(el);
        if (isNow) scrollTarget = el;
    });

    if (scrollTarget) setTimeout(() => scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' }), 80);
}

/** Formats a Unix timestamp as HH:MM (Austrian locale). */
const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });

/** Escapes HTML entities to prevent XSS. */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Returns today's date as YYYYMMDD for the EPG API. */
function epgDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return String(y) + m + day;
}

/**
 * Normalises the raw EPG API response into a uniform array of
 * { title, description, start, stop } objects.
 */
function normalizeEpgPrograms(payload) {
    if (Array.isArray(payload)) return payload;

    const list = payload && Array.isArray(payload.epg_list) ? payload.epg_list : [];
    if (!list.length) return [];

    const parsed = list
        .map(item => ({
            title: item.title || '—',
            description: item.desc || '',
            start: Math.floor(Date.parse(item.start_date) / 1000)
        }))
        .filter(item => Number.isFinite(item.start))
        .sort((a, b) => a.start - b.start);

    // If stop time is missing, derive it from the next program's start.
    for (let i = 0; i < parsed.length; i++) {
        const next = parsed[i + 1];
        parsed[i].stop = next ? next.start : parsed[i].start + 3600;
    }

    return parsed;
}

// ── Sidebar program panel ───────────────────────────────────────────────────

function setSidebarProgramIdle() {
    if (!channelList) return;
    channelList.innerHTML =
        '<div class="sidebar-program-empty">' +
        '<div class="sidebar-program-title">Programm</div>' +
        '<div class="sidebar-program-text">Wähle einen Sender, um das aktuelle Programm zu sehen.</div>' +
        '</div>';
}

function setSidebarProgramLoading(ch) {
    if (!channelList) return;
    channelList.innerHTML =
        '<div class="sidebar-program-empty">' +
    '<div class="sidebar-program-title">Programm · ' + esc(formatChannelLabel(ch)) + '</div>' +
        '<div class="sidebar-program-text">Lade Sendungen…</div>' +
        sidebarProgramToolsHtml(ch) +
        '</div>';
}

function setSidebarProgramEmpty(message, ch) {
    if (!channelList) return;
    channelList.innerHTML =
        '<div class="sidebar-program-empty">' +
    '<div class="sidebar-program-title">Programm' + (ch ? ' · ' + esc(formatChannelLabel(ch)) : '') + '</div>' +
        '<div class="sidebar-program-text">' + esc(message) + '</div>' +
        sidebarProgramToolsHtml(ch) +
        '</div>';
}

/** Renders the program list in the sidebar (max 6 items). */
function renderSidebarProgram(programs, ch) {
    if (!channelList) return;
    if (!programs?.length) { setSidebarProgramEmpty('Kein Programm verfügbar', ch); return; }

    const now = Date.now() / 1000;
    const items = programs.filter(p => p.stop > now - 1200).slice(0, 6);
    if (!items.length) { setSidebarProgramEmpty('Keine heutigen Sendungen', ch); return; }

    let html =
        '<div class="sidebar-program">' +
        '<div class="sidebar-program-header">' +
        '<span class="sidebar-program-title">Programm · ' + esc(formatChannelLabel(ch)) + '</span>' +
        '</div>';

    for (const prog of items) {
        const isNow = prog.start <= now && now < prog.stop;
        html +=
            '<div class="sidebar-epg-item' + (isNow ? ' is-now' : '') + '">' +
            '<div class="sidebar-epg-time">' + fmtTime(prog.start) + ' - ' + fmtTime(prog.stop) + '</div>' +
            '<div class="sidebar-epg-name">' + esc(prog.title || '—') + '</div>' +
            '</div>';
    }

    html += sidebarProgramToolsHtml(ch);
    html += '</div>';
    channelList.innerHTML = html;
}

/** Resolves the epg.pw channel ID for a given channel. */
function getEpgChannelId(ch) {
    const manual = manualEpgIds[ch.id];
    if (Number.isFinite(manual)) return manual;
    return EPG_IDS[ch.id] || null;
}

function saveManualEpgIds() {
    localStorage.setItem('manualEpgIds', JSON.stringify(manualEpgIds));
}

/** Renders the "EPG-ID setzen / Reset" tools in the sidebar. */
function sidebarProgramToolsHtml(ch) {
    if (!ch) return '';
    const number = getChannelNumber(ch);
    const defaultId = EPG_IDS[ch.id] || '';
    const manualId = manualEpgIds[ch.id];
    const activeIdNum = getEpgChannelId(ch);
    const activeId = activeIdNum ? String(activeIdNum) : 'nicht gesetzt';
    const source = Number.isFinite(manualId) ? 'manuell' : (defaultId ? 'standard' : 'keine');
    const channelLine = number ? '<div class="sidebar-program-number">Sender #' + String(number).padStart(2, '0') + '</div>' : '';

    let html =
        '<div class="sidebar-program-tools">' +
        channelLine +
        '<div class="sidebar-program-id">EPG-ID: ' + esc(activeId) + ' (' + source + ')</div>' +
        '<div class="sidebar-program-actions">' +
        '<button class="sidebar-tool-btn" data-epg-action="set" data-channel-id="' + esc(ch.id) + '">EPG-ID setzen</button>';

    if (Number.isFinite(manualId)) {
        html += '<button class="sidebar-tool-btn" data-epg-action="clear" data-channel-id="' + esc(ch.id) + '">Reset</button>';
    }

    html += '</div></div>';
    return html;
}

/** Handles "EPG-ID setzen" and "Reset" button clicks in the sidebar. */
function setupSidebarProgramActions() {
    if (!channelList) return;
    channelList.addEventListener('click', e => {
        const btn = e.target.closest('[data-epg-action]');
        if (!btn) return;

        const channelId = btn.dataset.channelId;
        const action = btn.dataset.epgAction;
        const ch = allChannels.find(c => c.id === channelId);
        if (!ch) return;

        if (action === 'set') {
            const current = getEpgChannelId(ch);
            const input = window.prompt('EPG-ID für ' + ch.name + ' eingeben (nur Zahl):', current ? String(current) : '');
            if (input === null) return;
            const value = input.trim();
            if (!value) return;
            if (!/^\d+$/.test(value)) {
                window.alert('Bitte nur Zahlen eingeben.');
                return;
            }
            manualEpgIds[ch.id] = Number(value);
            saveManualEpgIds();
            loadEpg(ch);
            return;
        }

        if (action === 'clear') {
            delete manualEpgIds[ch.id];
            saveManualEpgIds();
            loadEpg(ch);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  12. LOCATION / FLAG THEMING
//       Changes accent colour, flag emoji, and page title based on the
//       channel's country (or browser timezone as fallback).
// ─────────────────────────────────────────────────────────────────────────────

const TZ_MAP = [
    { country: 'AT', tz: 'Europe/Vienna',     flag: '🇦🇹',  label: 'Österreich' },
    { country: 'DE', tz: 'Europe/Berlin',     flag: '🇩🇪' , label: 'Deutschland' },
    { country: 'CH', tz: 'Europe/Zurich',     flag: '🇨🇭' , label: 'Schweiz' },
    { country: 'LI', tz: 'Europe/Vaduz',      flag: '🇱🇮' , label: 'Liechtenstein' },
    { country: 'LU', tz: 'Europe/Luxembourg', flag: '🇱🇺' , label: 'Luxemburg' },
    { country: 'US', tz: 'America/New_York',  flag: '🇺🇸',  label: 'USA' }
];

/**
 * Derives a country code from the channel's category string.
 * Returns null if the channel doesn't belong to a known country.
 */
function getCountryFromChannel(ch) {
    const cat = String(ch?.cat || '').toLowerCase();
    if (cat === 'at' || cat.startsWith('at-')) return 'AT';
    if (cat === 'de' || cat.startsWith('de-')) return 'DE';
    if (cat === 'us' || cat.startsWith('us-')) return 'US';
    if (cat === 'ch' || cat.startsWith('ch-')) return 'CH';
    if (cat === 'li' || cat.startsWith('li-')) return 'LI';
    if (cat === 'lu' || cat.startsWith('lu-')) return 'LU';
    return null;
}

/** Chooses the best theme: channel country → proxy-detected country → browser timezone. */
function applyThemeForChannel(ch) {
    const country = getCountryFromChannel(ch);
    if (country) {
        applyLocationTheme(country);
    } else if (proxyCountry) {
        applyLocationTheme(proxyCountry);
    } else {
        applyLocationTheme();
    }
}

/**
 * Applies CSS variables (--accent, --accent-dim, --accent-glow), updates the
 * flag emoji, and sets the page title based on the matched country.
 *
 * @param {string|null} countryOverride  Optional 2-letter country code.
 */
function applyLocationTheme(countryOverride) {
    const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let match = TZ_MAP.find(t => t.tz === tz) || TZ_MAP[0];

    if (countryOverride) {
        const code = String(countryOverride).toUpperCase();
        const ov   = TZ_MAP.find(t => t.country === code);
        if (ov) match = ov;
    }

    const hex2rgba = (h, a) => {
        const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    };

    const accentColor = match.accent || '#0066CC';
    document.documentElement.style.setProperty('--accent',      accentColor);
    document.documentElement.style.setProperty('--accent-dim',  hex2rgba(accentColor, 0.15));
    document.documentElement.style.setProperty('--accent-glow', hex2rgba(accentColor, 0.30));

    const brandLogo = document.querySelector('.brand-logo');
    if (brandLogo) brandLogo.textContent = match.flag;

    document.title = match.flag + ' Austria WebTV';

    const badge = document.getElementById('locationBadge');
    if (badge) { badge.textContent = match.flag + ' ' + match.label; badge.title = 'Standort: ' + match.label + ' (' + tz + ')'; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────────────────

/* Utility: visible/filtered channels according to current UI state */
function getVisibleChannels() {
    try { return getFiltered(); } catch (e) { return allChannels || []; }
}

function findActiveIndex(list) {
    if (!list || !list.length) return -1;
    return list.findIndex(c => c.id === activeId);
}

function nextChannel() {
    const list = getVisibleChannels(); if (!list.length) return;
    let idx = findActiveIndex(list);
    idx = idx < 0 ? 0 : (idx + 1) % list.length;
    play(list[idx]);
}

function prevChannel() {
    const list = getVisibleChannels(); if (!list.length) return;
    let idx = findActiveIndex(list);
    idx = idx <= 0 ? list.length - 1 : idx - 1;
    play(list[idx]);
}

function stopPlayback() {
    if (hlsInstance) { try { hlsInstance.destroy(); } catch (e) {} hlsInstance = null; }
    if (currentVideo && currentVideo.pause) { try { currentVideo.pause(); } catch (e) {} }
    currentVideo = null; activeId = null; activeChannel = null;
    playerArea.innerHTML = '<div class="player-placeholder"><div class="placeholder-icon">📡</div><p>Wähle einen Sender aus der Liste</p><p class="placeholder-sub">HLS-Streams, Web-Player und externe Links unterstützt</p></div>';
    setStatus('Bereit', 'default'); setLive(false);
    document.querySelectorAll('.channel-card').forEach(c => c.classList.remove('is-active'));
}

window.addEventListener('load', init);



