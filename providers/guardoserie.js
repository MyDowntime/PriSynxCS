// Guardoserie - provider locale per NuvioTV / Nuvio Mobile (nessun server o worker esterno).
// Player supportati: Uqload (episodi/film recenti) e Loadm legacy (loadm.cam/#id).
// Non supportati: mload.cam (solo MP4 cifrato a blocchi), guardabestvid (PoW troppo pesante in QuickJS), vixsrc (gia' coperto da altri provider).

var DOMAINS_URL = 'https://raw.githubusercontent.com/qwertyuiop8899/streamvix/main/config/domains.json';
var DEFAULT_DOMAIN = 'guardoseries.cfd';
var TMDB_KEY_FALLBACK = '68e094699525b18a70bab2f86b1fa706';
var UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
var LOADM_KEY = 'kiemtienmua911ca';
var LOADM_IV = '1234567890oiuytr';

function run(genFn) {
  return new Promise(function (resolve, reject) {
    var it = genFn();
    function step(method, value) {
      var r;
      try { r = it[method](value); } catch (e) { reject(e); return; }
      if (r.done) { resolve(r.value); return; }
      Promise.resolve(r.value).then(function (x) { step('next', x); }, function (e) { step('throw', e); });
    }
    step('next');
  });
}

function req(url, opts) {
  return fetch(url, opts || {}).then(function (r) {
    return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t || '' }; });
  }).catch(function () { return { ok: false, status: 0, text: '' }; });
}

function log(msg) { try { console.log('[Guardoserie] ' + msg); } catch (e) { } }

// ---------- testo / matching ----------

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&hellip;/g, '...').replace(/&nbsp;/g, ' ');
}

function norm(s) {
  var t = decodeEntities(s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { }
  return t.replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugify(s) { return norm(s).replace(/\s+/g, '-'); }

function searchQuery(title) {
  return norm(title).split(' ').slice(0, 3).join(' ');
}

function posterFile(p) {
  var m = String(p || '').match(/([A-Za-z0-9]+)\.(?:jpe?g|png|webp)/);
  return m ? m[1] : '';
}

function scoreCandidate(c, info) {
  var t = norm(c.title);
  var score = 0;
  var parts = decodeEntities(c.title).split(/\s+[-\u2013\u2014:|]\s+|:\s+/).map(norm).filter(Boolean);
  var hits = parts.filter(function (p) { return p === info.nTitle || (info.nOrig && p === info.nOrig); }).length;
  if (t && (t === info.nTitle || (info.nOrig && t === info.nOrig))) score += 5;
  // titoli composti tipo "Game of Thrones – Il Trono di Spade"
  else if (parts.length > 1 && hits === parts.length) score += 5;
  else if (hits) score += 3;
  else {
    [info.nTitle, info.nOrig].forEach(function (x) {
      if (!x || !t || score >= 2) return;
      if (t.indexOf(x) !== -1 || x.indexOf(t) !== -1) {
        var ratio = Math.min(t.length, x.length) / Math.max(t.length, x.length);
        if (ratio >= 0.6) score += 2;
      }
    });
  }
  if (c.poster && info.posters.indexOf(c.poster) !== -1) score += 6;
  if (c.year && info.year) {
    var d = Math.abs(c.year - info.year);
    if (d === 0) score += 2; else if (d === 1) score += 1; else score -= 3;
  }
  return score;
}

function parseSearch(html, base) {
  var out = [];
  var blocks = html.split(/<div[^>]*class="ml-item"[^>]*>/).slice(1);
  for (var bi = 0; bi < blocks.length; bi++) {
    var block = blocks[bi].slice(0, 4000);
    var href = (block.match(/<a[^>]*href="([^"]+)"/) || [])[1];
    if (!href || href.indexOf(base) !== 0) continue;
    var title = (block.match(/oldtitle="([^"]*)"/) || [])[1] || (block.match(/<h2>([^<]*)<\/h2>/) || [])[1] || '';
    var poster = posterFile((block.match(/(?:data-original|data-src)="([^"]*image\.tmdb\.org[^"]*)"/) || [])[1]);
    var year = parseInt((block.match(/release-year\/(\d{4})/) || [])[1], 10) || 0;
    out.push({ url: href, title: title, poster: poster, year: year });
  }
  // WordPress reindirizza alla scheda quando la ricerca ha un solo risultato
  if (!out.length && /id="player2"|id="seasons"/.test(html)) {
    var canon = (html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/) || html.match(/property="og:url" content="([^"]+)"/) || [])[1];
    var ogt = (html.match(/property="og:title" content="([^"]+)"/) || [])[1] || '';
    if (canon && canon.indexOf('?s=') === -1) {
      out.push({
        url: canon,
        title: ogt.replace(/\s*-\s*Guardaserie\s*$/i, ''),
        poster: posterFile((html.match(/data-bg-image="url\(&#039;([^&]+)&#039;\)"/) || [])[1]),
        year: parseInt((html.match(/release-year\/(\d{4})/) || [])[1], 10) || 0
      });
    }
  }
  return out;
}

function isSeriesUrl(u) { return /\/serie\//.test(u); }
function isMovieUrl(u, base) { return !/\/(serie|episodio)\//.test(u) && u.replace(base, '').split('/').filter(Boolean).length === 1; }

// ---------- player ----------

function iframeUrl(tag) {
  var re = /\s(?:data-src|src)\s*=\s*["']([^"']+)["']/gi;
  var m;
  while ((m = re.exec(tag))) { if (m[1].indexOf('data:') !== 0) return decodeEntities(m[1]); }
  return null;
}

function extractPlayers(html) {
  var labels = {};
  var lm, lre = /href="#tab(\d+)"[^>]*>([^<]*)</g;
  while ((lm = lre.exec(html))) labels[lm[1]] = decodeEntities(lm[2]).trim();
  var players = [];
  var seen = {};
  var tre = /<div id="tab(\d+)"[^>]*>([\s\S]*?)(?=<div id="tab\d+"|<div id="bar-player"|<div class="player_nav"|$)/gi;
  var tm;
  while ((tm = tre.exec(html))) {
    var ifr = (tm[2].match(/<iframe[^>]*>/i) || [])[0];
    var u = ifr && iframeUrl(ifr);
    if (u && !seen[u]) { seen[u] = 1; players.push({ url: u, label: labels[tm[1]] || '' }); }
  }
  if (!players.length) {
    var ire = /<iframe[^>]*>/gi, im;
    while ((im = ire.exec(html))) {
      var u2 = iframeUrl(im[0]);
      if (u2 && !seen[u2] && /uqload|loadm|mload|guardabest|vixsrc/i.test(u2)) { seen[u2] = 1; players.push({ url: u2, label: '' }); }
    }
  }
  return players;
}

function langOf(label) {
  return /sub/i.test(label) ? 'SUB-ITA' : 'ITA';
}

function unpack(p, a, c, k) {
  function e(n) { return (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); }
  var d = {};
  while (c--) d[e(c)] = k[c] || e(c);
  return p.replace(/\b\w+\b/g, function (w) { return Object.prototype.hasOwnProperty.call(d, w) ? d[w] : w; });
}

function bestVariant(text) {
  var best = null, m, re = /#EXT-X-STREAM-INF:([^\r\n]*)/g;
  while ((m = re.exec(text))) {
    var a = m[1];
    var res = a.match(/RESOLUTION=(\d+)x(\d+)/) || [];
    var v = {
      width: parseInt(res[1], 10) || 0,
      height: parseInt(res[2], 10) || 0,
      bandwidth: parseInt((a.match(/AVERAGE-BANDWIDTH=(\d+)/) || a.match(/(?:^|,)BANDWIDTH=(\d+)/) || [])[1], 10) || 0,
      codecs: (a.match(/CODECS="([^"]*)"/) || [])[1] || ''
    };
    if (!best || v.width > best.width || (v.width === best.width && v.bandwidth > best.bandwidth)) best = v;
  }
  return best;
}

// dalla larghezza: i film in 2.39:1 hanno altezze tipo 800 per un 1080p
function qualityLabel(width) {
  if (!width) return '';
  if (width >= 3800) return '2160p';
  if (width >= 1900) return '1080p';
  if (width >= 1200) return '720p';
  if (width >= 800) return '480p';
  return '360p';
}

function checkMaster(url, headers) {
  return req(url, { headers: headers }).then(function (r) {
    if (!r.ok || r.text.indexOf('#EXTM3U') === -1) return null;
    var v = bestVariant(r.text);
    return { quality: qualityLabel(v && v.width), variant: v };
  });
}

// ---------- formato stream (come PriSynx vixsrc.js) ----------

var FLAG_IT = '\uD83C\uDDEE\uD83C\uDDF9';
var ZW_PREFIX = ['\u200B', '\u200C', '\u200D', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064'];

function sortPrefix(quality, syncLevel) {
  var q = Number(String(quality || '').replace(/[^0-9]/g, '')) || 0;
  var r = q >= 2160 ? 0 : q >= 1080 ? 1 : q >= 720 ? 2 : 3;
  return ZW_PREFIX[r] + ZW_PREFIX[syncLevel];
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function formatBitrate(bps) {
  if (!bps) return '';
  if (bps >= 1000000) {
    var mbps = bps / 1000000;
    return (mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)).replace(/\.0+$/, '') + ' Mbps';
  }
  return Math.round(bps / 1000) + ' kbps';
}

function codecLabel(codecs) {
  var out = [];
  String(codecs || '').split(',').forEach(function (c) {
    c = c.trim().toLowerCase();
    var l = /^(?:avc1|avc3)/.test(c) ? 'H.264' : /^(?:hev1|hvc1)/.test(c) ? 'HEVC' : /^av01/.test(c) ? 'AV1' :
      /^vp09/.test(c) ? 'VP9' : /^mp4a/.test(c) ? 'AAC' : /^ec-3/.test(c) ? 'E-AC-3' : /^ac-3/.test(c) ? 'AC-3' : '';
    if (l && out.indexOf(l) === -1) out.push(l);
  });
  return out.join(' / ');
}

function extractUqload(playerUrl, pageUrl) {
  return run(function* () {
    var host = (playerUrl.match(/^(?:https?:)?\/\/([^/]+)/i) || [])[1] || 'uqload.vc';
    var code = (playerUrl.match(/\/(?:e|embed-)\/?([A-Za-z0-9]+)/) || [])[1];
    if (!code) return null;
    var origin = 'https://' + host;
    var body = 'op=embed&file_code=' + encodeURIComponent(code) + '&auto=1&referer=' + encodeURIComponent(pageUrl);
    var r = yield req(origin + '/dl', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Referer': origin + '/e/' + code, 'Origin': origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });
    if (!r.ok) { log('uqload /dl HTTP ' + r.status); return null; }
    var src = null;
    var pm = r.text.match(/\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
    if (pm) {
      var unpacked = unpack(pm[1], parseInt(pm[2], 10), parseInt(pm[3], 10), pm[4].split('|'));
      src = (unpacked.match(/file\s*:\s*["']([^"']+)/) || [])[1];
    }
    if (!src) src = (r.text.match(/(?:sources|file|src)\s*[:=]\s*\[?\s*\{?\s*(?:file\s*:\s*)?["']([^"']+(?:m3u8|mp4)[^"']*)/i) || [])[1];
    if (!src) return null;
    if (src.indexOf('//') === 0) src = 'https:' + src;
    // video rimosso: Uqload risponde con un video segnaposto
    if (/\/static\//i.test(src)) { log('uqload: video rimosso'); return null; }
    var headers = { 'User-Agent': UA, 'Referer': origin + '/', 'Origin': origin };
    var hls = /\.m3u8/i.test(src);
    var chk = hls ? yield checkMaster(src, headers) : { quality: '', variant: null };
    if (!chk) { log('uqload master non raggiungibile'); return null; }
    return { url: src, headers: headers, quality: chk.quality, variant: chk.variant, hls: hls, player: 'Uqload' };
  });
}

// ---------- AES-128-CBC (solo decifratura, per Loadm) ----------

var AES_SBOX = null, AES_INV = null;
function aesInit() {
  if (AES_SBOX) return;
  AES_SBOX = new Array(256); AES_INV = new Array(256);
  var p = 1, q = 1;
  function rotl8(x, s) { return ((x << s) | (x >>> (8 - s))) & 0xff; }
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q = (q ^ (q << 1)) & 0xff; q = (q ^ (q << 2)) & 0xff; q = (q ^ (q << 4)) & 0xff;
    if (q & 0x80) q ^= 0x09;
    var x = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
    AES_SBOX[p] = x; AES_INV[x] = p;
  } while (p !== 1);
  AES_SBOX[0] = 0x63; AES_INV[0x63] = 0;
}
function gmul(a, b) {
  var r = 0;
  while (b) { if (b & 1) r ^= a; a = ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; b >>= 1; }
  return r;
}
function aesExpand(key) {
  var w = key.slice(0), rcon = 1;
  for (var i = 16; i < 176; i += 4) {
    var t = w.slice(i - 4, i);
    if (i % 16 === 0) {
      t = [AES_SBOX[t[1]] ^ rcon, AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 0xff;
    }
    for (var j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}
function aesDecryptBlock(inp, w) {
  var s = inp.slice(0), r, c, i;
  for (i = 0; i < 16; i++) s[i] ^= w[160 + i];
  for (r = 9; r >= 0; r--) {
    var t = new Array(16);
    for (c = 0; c < 4; c++) for (var row = 0; row < 4; row++) t[row + 4 * ((c + row) % 4)] = s[row + 4 * c];
    for (i = 0; i < 16; i++) s[i] = AES_INV[t[i]] ^ w[16 * r + i];
    if (r > 0) {
      for (c = 0; c < 4; c++) {
        var a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
        s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }
  }
  return s;
}
function strBytes(s) { var b = []; for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0xff); return b; }
function utf8Decode(b) {
  var out = '', i = 0;
  while (i < b.length) {
    var c = b[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    else if (c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    else { var cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f); cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
  }
  return out;
}
function aesCbcDecryptHex(hex, keyStr, ivStr) {
  aesInit();
  hex = hex.replace(/[^0-9a-f]/gi, '');
  if (!hex || hex.length % 32 !== 0) return null;
  var data = [];
  for (var i = 0; i < hex.length; i += 2) data.push(parseInt(hex.substr(i, 2), 16));
  var w = aesExpand(strBytes(keyStr)), prev = strBytes(ivStr), out = [];
  for (var off = 0; off < data.length; off += 16) {
    var blk = data.slice(off, off + 16), dec = aesDecryptBlock(blk, w);
    for (var j = 0; j < 16; j++) out.push(dec[j] ^ prev[j]);
    prev = blk;
  }
  var pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16) out = out.slice(0, out.length - pad);
  return utf8Decode(out);
}

function extractLoadm(playerUrl, domain) {
  return run(function* () {
    var parts = playerUrl.split('#');
    if (parts.length < 2 || !parts[1]) return null;
    var base = parts[0].replace(/\/?$/, '/');
    var api = base + 'api/v1/video?id=' + encodeURIComponent(parts[1].trim()) + '&w=2560&h=1440&r=' + encodeURIComponent(domain);
    var r = yield req(api, { headers: { 'User-Agent': UA, 'Referer': base, 'X-Requested-With': 'XMLHttpRequest' } });
    if (!r.ok) { log('loadm API HTTP ' + r.status + ' (video rimosso?)'); return null; }
    var txt = aesCbcDecryptHex(r.text.trim(), LOADM_KEY, LOADM_IV);
    if (!txt) return null;
    var data;
    try { data = JSON.parse(txt.slice(0, txt.lastIndexOf('}') + 1)); } catch (e) { return null; }
    var headers = { 'User-Agent': UA, 'Referer': base };
    var candidates = [data.source, data.cfNative].filter(function (u) { return typeof u === 'string' && /^https?:\/\//.test(u); });
    for (var i = 0; i < candidates.length; i++) {
      var chk = yield checkMaster(candidates[i], headers);
      if (chk) return { url: candidates[i], headers: headers, quality: chk.quality, variant: chk.variant, hls: true, player: 'Loadm' };
    }
    return null;
  });
}

// ---------- flusso principale ----------

function getDomain() {
  return req(DOMAINS_URL, { headers: { 'Accept': 'application/json' } }).then(function (r) {
    try {
      var d = String(JSON.parse(r.text).guardoserie || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return d;
    } catch (e) { }
    return DEFAULT_DOMAIN;
  });
}

function tmdbKey() {
  try { if (typeof TMDB_API_KEY === 'string' && TMDB_API_KEY.length > 10) return TMDB_API_KEY; } catch (e) { }
  return TMDB_KEY_FALLBACK;
}

function getInfo(id, isTv) {
  return run(function* () {
    var key = tmdbKey();
    var tmdbId = String(id);
    if (/^tt\d+$/.test(tmdbId)) {
      var f = yield req('https://api.themoviedb.org/3/find/' + tmdbId + '?api_key=' + key + '&external_source=imdb_id');
      try {
        var fj = JSON.parse(f.text);
        var hit = (isTv ? fj.tv_results : fj.movie_results) || [];
        if (!hit.length) return null;
        tmdbId = String(hit[0].id);
      } catch (e) { return null; }
    }
    tmdbId = tmdbId.replace(/^tmdb:/, '');
    var r = yield req('https://api.themoviedb.org/3/' + (isTv ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + key + '&language=it-IT');
    if (!r.ok) return null;
    var j;
    try { j = JSON.parse(r.text); } catch (e) { return null; }
    var title = j.name || j.title || '';
    var orig = j.original_name || j.original_title || '';
    return {
      tmdbId: tmdbId,
      title: title,
      orig: orig,
      nTitle: norm(title),
      nOrig: norm(orig),
      year: parseInt(String(j.first_air_date || j.release_date || '').slice(0, 4), 10) || 0,
      posters: [posterFile(j.poster_path)].filter(Boolean)
    };
  });
}

function findTitlePage(base, info, isTv) {
  return run(function* () {
    var queries = [searchQuery(info.title)];
    var q2 = searchQuery(info.orig);
    if (q2 && queries.indexOf(q2) === -1) queries.push(q2);
    for (var qi = 0; qi < queries.length; qi++) {
      if (!queries[qi]) continue;
      var r = yield req(base + '/?s=' + encodeURIComponent(queries[qi]).replace(/%20/g, '+'), { headers: { 'User-Agent': UA, 'Referer': base + '/' } });
      if (!r.ok) { log('ricerca HTTP ' + r.status); continue; }
      var cands = parseSearch(r.text, base).filter(function (c) { return isTv ? isSeriesUrl(c.url) : isMovieUrl(c.url, base); });
      var best = null, bestScore = 0;
      cands.forEach(function (c) {
        var s = scoreCandidate(c, info);
        if (s > bestScore) { best = c; bestScore = s; }
      });
      if (best && bestScore >= 5) { log('match "' + decodeEntities(best.title) + '" score ' + bestScore); return best.url; }
    }
    return null;
  });
}

function hasPlayers(html) { return /id="player2"|<iframe/i.test(html || ''); }

function findEpisodeHtml(base, seriesUrl, season, episode) {
  return run(function* () {
    var slug = (seriesUrl.match(/\/serie\/([^/]+)/) || [])[1];
    var suffix = '-stagione-' + season + '-episodio-' + episode;
    if (slug) {
      var direct = base + '/episodio/' + slug + suffix + '/';
      var r = yield req(direct, { headers: { 'User-Agent': UA, 'Referer': seriesUrl } });
      if (r.ok && hasPlayers(r.text)) return { url: direct, html: r.text };
    }
    var s = yield req(seriesUrl, { headers: { 'User-Agent': UA, 'Referer': base + '/' } });
    if (!s.ok) return null;
    var re = new RegExp('href="([^"]+' + suffix + ')/?"', 'i');
    var m = s.text.match(re);
    if (!m) return null;
    var e = yield req(m[1], { headers: { 'User-Agent': UA, 'Referer': seriesUrl } });
    return e.ok && hasPlayers(e.text) ? { url: m[1], html: e.text } : null;
  });
}

function findStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var isTv = mediaType === 'tv' || mediaType === 'series';
      var s = parseInt(season, 10) || 1;
      var ep = parseInt(episode, 10) || 1;
      var info = yield getInfo(tmdbId, isTv);
      if (!info || !info.title) { log('TMDB senza titolo per ' + tmdbId); return []; }
      var domain = yield getDomain();
      var base = 'https://' + domain;

      var pageUrl = yield findTitlePage(base, info, isTv);
      var page = null;
      if (pageUrl) {
        if (isTv) page = yield findEpisodeHtml(base, pageUrl, s, ep);
        else {
          var pr = yield req(pageUrl, { headers: { 'User-Agent': UA, 'Referer': base + '/' } });
          if (pr.ok && hasPlayers(pr.text)) page = { url: pageUrl, html: pr.text };
        }
      }
      if (!page && isTv) {
        // fallback: URL deterministico dal titolo (come go.py)
        var slugs = [slugify(info.title), slugify(info.orig)].filter(function (x, i, a) { return x && a.indexOf(x) === i; });
        for (var si = 0; si < slugs.length && !page; si++) {
          var u = base + '/episodio/' + slugs[si] + '-stagione-' + s + '-episodio-' + ep + '/';
          var dr = yield req(u, { headers: { 'User-Agent': UA, 'Referer': base + '/' } });
          if (dr.ok && hasPlayers(dr.text)) page = { url: u, html: dr.text };
        }
      }
      if (!page) { log('nessuna pagina per ' + info.title); return []; }

      var players = extractPlayers(page.html);
      log(players.length + ' player: ' + players.map(function (p) { return (p.url.match(/\/\/([^/]+)/) || [])[1]; }).join(', '));

      var heading = '\uD83D\uDCC1 ' + info.title + (isTv ? ' S' + pad2(s) + 'E' + pad2(ep) : '') + (info.year ? ' (' + info.year + ')' : '');
      var streams = [];
      for (var i = 0; i < players.length; i++) {
        var p = players[i], res = null;
        if (/uqload/i.test(p.url)) res = yield extractUqload(p.url, page.url);
        else if (/loadm\.cam\/?#/i.test(p.url)) res = yield extractLoadm(p.url, domain);
        else continue;
        if (!res) continue;
        var ita = langOf(p.label) === 'ITA';
        var quality = res.quality || 'HD';
        var v = res.variant;
        var technical = v ? [
          v.width && v.height ? '\uD83C\uDF9E\uFE0F ' + v.width + '\u00D7' + v.height : '',
          codecLabel(v.codecs),
          formatBitrate(v.bandwidth) ? '\uD83D\uDCF6 ' + formatBitrate(v.bandwidth) : ''
        ].filter(Boolean).join(' \u00B7 ') : '';
        var details = [
          technical,
          ita ? '\uD83D\uDD0A ' + FLAG_IT + ' Italiano' : '\uD83D\uDD0A Originale \u00B7 \uD83D\uDCAC ' + FLAG_IT + ' Sub-ITA',
          '\uD83C\uDFAC Guardoserie \u00B7 ' + res.player + ' \u00B7 ' + (res.hls ? 'HLS' : 'MP4') + ' \u00B7 ' + FLAG_IT
        ].filter(Boolean).join('\n');
        var stream = {
          name: sortPrefix(quality, ita ? 0 : 2) + '🎞️ Guardoserie ' + quality + ' ' + FLAG_IT + (ita ? '' : ' SUB'),
          title: heading + '\n' + details,
          size: details,
          url: res.url,
          quality: quality,
          provider: 'guardoserie',
          headers: res.headers,
          behaviorHints: {
            notWebReady: true,
            headers: res.headers,
            proxyHeaders: { request: res.headers },
            bingeGroup: 'guardoserie-' + res.player.toLowerCase(),
            filename: 'guardoserie-' + res.player.toLowerCase() + '-' + quality + (res.hls ? '.m3u8' : '.mp4')
          }
        };
        if (res.hls) stream.type = 'hls';
        streams.push(stream);
      }
      streams.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      return streams;
    } catch (e) {
      log('errore: ' + (e && e.message ? e.message : e));
      return [];
    }
  });
}

// ---------- Test di Nuvio ----------
// Il Test di Nuvio chiama sempre TMDB 603 (Matrix, assente qui): come PaCC lo si reindirizza a un titolo noto.
var PROBE = { id: 'tt0903747', type: 'tv', season: 1, episode: 1 }; // Breaking Bad

function getStreams(tmdbId, mediaType, season, episode) {
  if (String(tmdbId || '').replace(/^tmdb:/i, '').trim() !== '603') return findStreams(tmdbId, mediaType, season, episode);
  log('test Nuvio (603) -> ' + PROBE.id);
  return findStreams(PROBE.id, PROBE.type, PROBE.season, PROBE.episode).then(function (list) {
    return (list || []).map(function (st) {
      st.name += ' \uD83E\uDDEA';
      st.title = '\uD83E\uDDEA Test Nuvio (603 -> titolo noto)\n' + st.title;
      return st;
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  globalThis.getStreams = getStreams;
}
