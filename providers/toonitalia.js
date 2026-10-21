// Toonitalia - provider per NuvioTV / Nuvio Mobile.
// Il sito e' dietro challenge Cloudflare: i link dei player arrivano da una piccola API
// (catalogo Toonitalia gia' indicizzato da ToastFlix); l'estrazione VOE/Uqload avviene sul dispositivo
// perche' i link VOE sono legati all'IP di chi li richiede.

var TI_API = 'https://ti.stremio-italia.eu';
var TMDB_KEY_FALLBACK = '68e094699525b18a70bab2f86b1fa706';
var UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

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
    return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t || '', url: r.url || url }; });
  }).catch(function () { return { ok: false, status: 0, text: '', url: url }; });
}

function log(msg) { try { console.log('[Toonitalia] ' + msg); } catch (e) { } }

function parseJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

function originOf(u) { return (String(u).match(/^(https?:\/\/[^/]+)/i) || [])[1] || ''; }

function absUrl(u, base) {
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return originOf(base) + u;
  return base.replace(/[^/]*$/, '') + u;
}

function unpack(p, a, c, k) {
  function e(n) { return (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36)); }
  var d = {};
  while (c--) d[e(c)] = k[c] || e(c);
  return p.replace(/\b\w+\b/g, function (w) { return Object.prototype.hasOwnProperty.call(d, w) ? d[w] : w; });
}

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64decode(s) {
  s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  var out = '', buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    buf = (buf << 6) | B64.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xff); }
  }
  return out;
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

// ---------- player ----------

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

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, function (c) {
    var b = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b);
  });
}

// VOE: <script type="application/json">["..."]</script> -> rot13, rimozione marker, base64, shift -3, reverse, base64
function voeDecode(obf) {
  var s = rot13(obf);
  ['@$', '^^', '~@', '%?', '*~', '!!', '#&'].forEach(function (p) { s = s.split(p).join(''); });
  s = b64decode(s);
  var t = '';
  for (var i = s.length - 1; i >= 0; i--) t += String.fromCharCode(s.charCodeAt(i) - 3);
  return parseJson(b64decode(t));
}

function extractVoe(playerUrl) {
  return run(function* () {
    var r = yield req(playerUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://toonitalia.xyz/' } });
    if (!r.ok) { log('voe HTTP ' + r.status); return null; }
    var page = r.url, html = r.text;
    var red = html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
    if (red && !/application\/json/.test(html)) {
      page = absUrl(red[1], page);
      r = yield req(page, { headers: { 'User-Agent': UA, 'Referer': playerUrl } });
      if (!r.ok) { log('voe redirect HTTP ' + r.status); return null; }
      page = r.url || page;
      html = r.text;
    }
    var data = null, m, re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while (!data && (m = re.exec(html))) {
      var arr = parseJson(m[1].trim());
      if (arr && typeof arr[0] === 'string') data = voeDecode(arr[0]);
    }
    if (!data) { log('voe: dati non trovati'); return null; }
    var src = data.source || data.direct_access_url || data.file;
    if (!src) return null;
    src = absUrl(src, page);
    var origin = originOf(page);
    var headers = { 'User-Agent': UA, 'Referer': origin + '/', 'Origin': origin };
    var hls = /\.m3u8/i.test(src);
    var chk = hls ? yield checkMaster(src, headers) : { quality: '', variant: null };
    if (!chk) { log('voe master non raggiungibile'); return null; }
    return { url: src, headers: headers, quality: chk.quality, variant: chk.variant, hls: hls, player: 'VOE' };
  });
}

// ---------- flusso principale ----------

function tmdbKey() {
  try { if (typeof TMDB_API_KEY === 'string' && TMDB_API_KEY.length > 10) return TMDB_API_KEY; } catch (e) { }
  return TMDB_KEY_FALLBACK;
}

function getInfo(id, isTv, season, episode) {
  return run(function* () {
    var key = tmdbKey();
    var tmdbId = String(id);
    if (/^tt\d+$/.test(tmdbId)) {
      var f = yield req('https://api.themoviedb.org/3/find/' + tmdbId + '?api_key=' + key + '&external_source=imdb_id');
      var fj = parseJson(f.text);
      var hit = fj ? (isTv ? fj.tv_results : fj.movie_results) || [] : [];
      if (!hit.length) return null;
      tmdbId = String(hit[0].id);
    }
    tmdbId = tmdbId.replace(/^tmdb:/, '');
    var r = yield req('https://api.themoviedb.org/3/' + (isTv ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + key + '&language=it-IT');
    var j = r.ok ? parseJson(r.text) : null;
    if (!j) return null;
    // numero assoluto dell'episodio (anime numerati in continuo, es. One Piece)
    var abs = 0;
    if (isTv) {
      abs = episode;
      (j.seasons || []).forEach(function (x) {
        if (x.season_number > 0 && x.season_number < season) abs += x.episode_count || 0;
      });
    }
    return {
      title: j.name || j.title || '',
      orig: j.original_name || j.original_title || '',
      year: parseInt(String(j.first_air_date || j.release_date || '').slice(0, 4), 10) || 0,
      abs: abs
    };
  });
}

function lookup(info, isTv, s, e) {
  var q = 'type=' + (isTv ? 'series' : 'movie') +
    '&title=' + encodeURIComponent(info.title) +
    '&orig=' + encodeURIComponent(info.orig) +
    '&year=' + info.year;
  if (isTv) q += '&s=' + s + '&e=' + e + '&abs=' + info.abs;
  return req(TI_API + '/streams?' + q, { headers: { 'Accept': 'application/json' } }).then(function (r) {
    if (!r.ok) log('API HTTP ' + r.status);
    return r.ok ? parseJson(r.text) : null;
  });
}

function findStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var isTv = mediaType === 'tv' || mediaType === 'series';
      var s = parseInt(season, 10) || 1;
      var ep = parseInt(episode, 10) || 1;
      var info = yield getInfo(tmdbId, isTv, s, ep);
      if (!info || !info.title) { log('TMDB senza titolo per ' + tmdbId); return []; }

      var data = yield lookup(info, isTv, s, ep);
      if (!data || !data.match) { log('nessun titolo per ' + info.title); return []; }
      var players = data.players || [];
      log('match "' + data.match.title + '" (' + players.length + ' player)');
      if (!players.length) return [];

      var heading = '\uD83D\uDCC1 ' + info.title + (isTv ? ' S' + pad2(s) + 'E' + pad2(ep) : '') + (info.year ? ' (' + info.year + ')' : '');
      var ita = !data.sub;
      var streams = [];
      var seen = {};
      for (var i = 0; i < players.length; i++) {
        var u = players[i].url, res = null;
        if (/uqload/i.test(u)) res = yield extractUqload(u, 'https://toonitalia.xyz/');
        else if (/\/e\/[A-Za-z0-9]+/.test(u)) res = yield extractVoe(u);
        if (!res || seen[res.url]) continue;
        seen[res.url] = 1;
        var quality = res.quality || 'SD';
        var v = res.variant;
        var technical = v ? [
          v.width && v.height ? '\uD83C\uDF9E\uFE0F ' + v.width + '\u00D7' + v.height : '',
          codecLabel(v.codecs),
          formatBitrate(v.bandwidth) ? '\uD83D\uDCF6 ' + formatBitrate(v.bandwidth) : ''
        ].filter(Boolean).join(' \u00B7 ') : '';
        var details = [
          technical,
          ita ? '\uD83D\uDD0A ' + FLAG_IT + ' Italiano' : '\uD83D\uDD0A Originale \u00B7 \uD83D\uDCAC ' + FLAG_IT + ' Sub-ITA',
          '\uD83C\uDFAC Toonitalia \u00B7 ' + res.player + ' \u00B7 ' + (res.hls ? 'HLS' : 'MP4') + ' \u00B7 ' + FLAG_IT
        ].filter(Boolean).join('\n');
        var stream = {
          name: sortPrefix(quality, ita ? 0 : 2) + '🎨 Toonitalia ' + quality + ' ' + FLAG_IT + (ita ? '' : ' SUB'),
          title: heading + '\n' + details,
          size: details,
          url: res.url,
          quality: quality,
          provider: 'toonitalia',
          headers: res.headers,
          behaviorHints: {
            notWebReady: true,
            headers: res.headers,
            proxyHeaders: { request: res.headers },
            bingeGroup: 'toonitalia-' + res.player.toLowerCase(),
            filename: 'toonitalia-' + res.player.toLowerCase() + '-' + quality + (res.hls ? '.m3u8' : '.mp4')
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
var PROBE_MOVIE = { id: 'tt1213012', type: 'movie', season: null, episode: null }; // Alfa & Omega (tt4055276 non e' su TMDB)
var PROBE_TV = { id: 'tt0096697', type: 'tv', season: 1, episode: 1 }; // I Simpson

function getStreams(tmdbId, mediaType, season, episode) {
  if (String(tmdbId || '').replace(/^tmdb:/i, '').trim() !== '603') return findStreams(tmdbId, mediaType, season, episode);
  var p = mediaType === 'movie' ? PROBE_MOVIE : PROBE_TV;
  log('test Nuvio (603) -> ' + p.id);
  return findStreams(p.id, p.type, p.season, p.episode).then(function (list) {
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
