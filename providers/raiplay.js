// RaiPlay - provider per NuvioTV / Nuvio Mobile (nessun server esterno).
// Ricerca programma (msearch RaiPlay) -> JSON programma/stagione -> relinker Mediapolis (output=62)
// dall'IP del dispositivo. L'URL HLS ha un token Akamai (hdnea) con validita' breve: va chiesto al momento.
// Con UA non-browser il relinker restituisce anche le varianti 3600/5000 (1080p).

var BASE = 'https://www.raiplay.it';
var TMDB_KEY_FALLBACK = '68e094699525b18a70bab2f86b1fa706';
var WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var PLAY_UA = 'okhttp/4.12.0';
var RAI_HEADERS = { 'User-Agent': WEB_UA, 'Referer': 'https://www.raiplay.it/', 'Accept': 'application/json, text/plain, */*' };
var SEARCH_TEMPLATE = { templateIn: '6470a982e4e0301afe1f81f1', templateOut: '6516ac5d40da6c377b151642' };

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

function getJson(path) {
  return req(path.indexOf('http') === 0 ? path : BASE + path, { headers: RAI_HEADERS }).then(function (r) {
    return r.ok ? parseJson(r.text) : null;
  });
}

function log(msg) { try { console.log('[RaiPlay] ' + msg); } catch (e) { } }

function parseJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

function norm(s) {
  var t = String(s || '').toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { }
  return t.replace(/'/g, '').replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim();
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

function audioNames(text) {
  var out = [], m, re = /#EXT-X-MEDIA:([^\r\n]*TYPE=AUDIO[^\r\n]*)/g;
  while ((m = re.exec(text))) {
    var n = (m[1].match(/NAME="([^"]*)"/) || [])[1];
    if (n && out.indexOf(n) === -1) out.push(n);
  }
  return out;
}

function qualityLabel(width) {
  if (!width) return '';
  if (width >= 3800) return '2160p';
  if (width >= 1900) return '1080p';
  if (width >= 1200) return '720p';
  if (width >= 800) return '480p';
  return '360p';
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

// ---------- flusso principale ----------

function tmdbKey() {
  try { if (typeof TMDB_API_KEY === 'string' && TMDB_API_KEY.length > 10) return TMDB_API_KEY; } catch (e) { }
  return TMDB_KEY_FALLBACK;
}

function getInfo(id, isMovie) {
  return run(function* () {
    var key = tmdbKey();
    var tmdbId = String(id).replace(/^tmdb:/, '');
    if (/^tt\d+$/.test(tmdbId)) {
      var f = yield req('https://api.themoviedb.org/3/find/' + tmdbId + '?api_key=' + key + '&external_source=imdb_id');
      var fj = parseJson(f.text);
      var hit = (fj && (isMovie ? fj.movie_results : fj.tv_results)) || [];
      if (!hit.length) return null;
      tmdbId = String(hit[0].id);
    }
    var r = yield req('https://api.themoviedb.org/3/' + (isMovie ? 'movie/' : 'tv/') + tmdbId + '?api_key=' + key + '&language=it-IT');
    var j = r.ok ? parseJson(r.text) : null;
    if (!j) return null;
    return {
      tmdbId: tmdbId,
      title: j.title || j.name || '',
      orig: j.original_title || j.original_name || '',
      year: parseInt(String(j.release_date || j.first_air_date || '').slice(0, 4), 10) || 0
    };
  });
}

function titleScore(candidate, info) {
  var t = norm(candidate);
  if (!t) return 0;
  var best = 0;
  [norm(info.title), norm(info.orig)].forEach(function (x) {
    if (!x) return;
    if (t === x) best = Math.max(best, 3);
    else if (t.indexOf(x) !== -1 || x.indexOf(t) !== -1) {
      if (Math.min(t.length, x.length) / Math.max(t.length, x.length) >= 0.6) best = Math.max(best, 2);
    }
  });
  return best;
}

function slugCandidates(title) {
  var n = norm(title);
  var out = [n.replace(/ /g, '-'), n.replace(/ /g, '')];
  return out.filter(function (c, i) { return c && out.indexOf(c) === i; });
}

// restituisce i path JSON dei programmi candidati, in ordine di somiglianza
function findPrograms(info, isMovie) {
  return run(function* () {
    var queries = [info.title, info.orig].map(norm).filter(function (q, i, a) { return q && a.indexOf(q) === i; });
    var found = [];
    for (var qi = 0; qi < queries.length && !found.length; qi++) {
      var r = yield req(BASE + '/atomatic/raiplay-search-service/api/v1/msearch', {
        method: 'POST',
        headers: { 'User-Agent': WEB_UA, 'Referer': 'https://www.raiplay.it/', 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateIn: SEARCH_TEMPLATE.templateIn, templateOut: SEARCH_TEMPLATE.templateOut,
          params: { param: queries[qi], from: null, sort: 'relevance', onlyVideoQuery: false }
        })
      });
      var d = r.ok ? parseJson(r.text) : null;
      var cards = (d && d.agg && d.agg.titoli && d.agg.titoli.cards) || [];
      cards.forEach(function (c) {
        if (!c || !c.path_id) return;
        var s = titleScore(c.titolo, info);
        if (s >= 2) found.push({ path: c.path_id, score: s, name: c.titolo });
      });
    }
    found.sort(function (a, b) { return b.score - a.score; });
    var paths = found.map(function (f) { return f.path; });
    if (!paths.length) {
      // ricerca non disponibile: provo gli slug classici
      var prefixes = isMovie ? ['film', 'programmi'] : ['programmi', 'fiction'];
      slugCandidates(info.title).forEach(function (c) {
        prefixes.forEach(function (p) { paths.push('/' + p + '/' + c + '.json'); });
      });
    }
    return paths.slice(0, 4);
  });
}

// stagione TMDB (numero, data e titoli degli episodi): serve quando RaiPlay non usa la numerazione TMDB
function getSeasonInfo(tmdbId, season) {
  return run(function* () {
    var id = String(tmdbId).replace(/^tmdb:/, '');
    var r = yield req('https://api.themoviedb.org/3/tv/' + id + '/season/' + season + '?api_key=' + tmdbKey() + '&language=it-IT');
    var j = r.ok ? parseJson(r.text) : null;
    if (!j) return null;
    return {
      airDate: j.air_date || '',
      episodes: (j.episodes || []).map(function (e) { return { n: e.episode_number, name: e.name || '', date: e.air_date || '' }; })
    };
  });
}

// anni nel nome del set: "Stagione 2014-2015", "St 2014/15", "Stagione 2005"
function setYears(name) {
  var m = String(name || '').match(/\b((?:19|20)\d{2})(?:\s*[-\/]\s*(\d{2}|\d{4}))?\b/);
  if (!m) return null;
  var a = parseInt(m[1], 10);
  var b = m[2] ? parseInt(m[2].length === 2 ? m[1].slice(0, 2) + m[2] : m[2], 10) : a;
  return { from: a, to: b };
}

// set candidati in ordine: "Stagione N", poi i set per anno della stagione TMDB, poi gli altri set di puntate
function seasonSets(program, season, seasonInfo) {
  var blocks = program.blocks || [];
  var re = new RegExp('(?:^|\\b)(?:stagione|st\\.?)\\s*' + season + '\\b', 'i');
  var epBlocks = blocks.filter(function (b) { return /episodi|puntate/i.test(b.name || ''); });
  var ordered = epBlocks
    .concat(blocks.filter(function (b) { return !/episodi|puntate|clip|extra|highlights|anticipazioni|backstage|speciali?/i.test(b.name || ''); }));
  var all = [];
  ordered.forEach(function (b) {
    (b.sets || []).forEach(function (st) {
      if (!st || !st.path_id) return;
      var exists = all.some(function (entry) { return entry.set.path_id === st.path_id; });
      if (!exists) {
        all.push({
          block: b,
          set: st,
          fullName: ((b.name || '') + ' ' + (st.name || '')).trim()
        });
      }
    });
  });

  var out = [];
  function add(entry, byNumber) {
    if (!out.some(function (o) { return o.set.path_id === entry.set.path_id; })) {
      out.push({ set: entry.set, byNumber: byNumber });
    }
  }

  // 1. Match per "Stagione N" su blocco+set
  all.forEach(function (e) {
    if (re.test(e.fullName)) add(e, true);
  });

  // 2. Match per anno TMDB
  var air = seasonInfo && seasonInfo.airDate;
  if (air) {
    var y = parseInt(air.slice(0, 4), 10), mo = parseInt(air.slice(5, 7), 10) || 1;
    var start = mo >= 7 ? y : y - 1; // stagione TV: da settembre a giugno
    var exact = [], near = [];
    all.forEach(function (e) {
      var yr = setYears(e.fullName);
      if (!yr) return;
      if (yr.from === y || yr.to === y || (y >= yr.from && y <= yr.to)) exact.push(e);
      else if (yr.from === start) near.push(e);
    });
    function sortEpSets(a, b) {
      var aEp = /puntat|episod/i.test(a.set.name || '') ? 1 : 0;
      var bEp = /puntat|episod/i.test(b.set.name || '') ? 1 : 0;
      return bEp - aEp;
    }
    exact.sort(sortEpSets).forEach(function (e) { add(e, false); });
    near.sort(sortEpSets).forEach(function (e) { add(e, false); });
  }

  // 3. Miniserie: un solo blocco episodi con un solo set senza numero di stagione
  if (!out.length && season === 1 && epBlocks.length === 1 && (epBlocks[0].sets || []).length === 1) {
    var single = all[0];
    if (single) add(single, true);
  }

  // 4. Fallback per tutti gli altri con precedenza ai set puntate/episodi
  if (seasonInfo) {
    all.slice().sort(function (a, b) {
      var aEp = /puntat|episod/i.test(a.fullName) ? 1 : 0;
      var bEp = /puntat|episod/i.test(b.fullName) ? 1 : 0;
      return bEp - aEp;
    }).forEach(function (e) { add(e, false); });
  }
  return out.slice(0, 6);
}

function itemNumbers(it) {
  var s = parseInt(it.season, 10), e = parseInt(it.episode, 10);
  if (e) return { s: s || 0, e: e };
  var m = String(it.name || '').match(/\bS(\d+)\s*E(\d+)\b/i) || String(it.subtitle || '').match(/\bSt\.?\s*(\d+)\s*Ep\.?\s*(\d+)\b/i);
  if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
  return null;
}

function isGenericEpisodeName(name) {
  return !name || /^(?:episodio|puntata|episode|ep\.?)\s*\d+$/i.test(String(name).trim());
}

function itemDate(it) {
  var m = String(it.name || '').match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
}

// numerazione RaiPlay -> titolo dell'episodio TMDB -> data di messa in onda (solo se univoca)
// l'ordine dei video (fallback) vale solo per i set "Stagione N": i set per anno sono spesso al contrario
function findEpisodePath(set, season, episode, seasonInfo, byNumber) {
  return run(function* () {
    var d = yield getJson(set.path_id);
    var items = (d && d.items) || [];
    var numbered = false;
    for (var i = 0; i < items.length; i++) {
      var n = itemNumbers(items[i]);
      if (!n) continue;
      numbered = true;
      if (n.e === episode && (!n.s || n.s === season)) return items[i].path_id;
    }
    var tmdbEp = seasonInfo && seasonInfo.episodes.filter(function (e) { return e.n === episode; })[0];
    if (tmdbEp && !isGenericEpisodeName(tmdbEp.name)) {
      var want = norm(tmdbEp.name);
      for (var k = 0; k < items.length; k++) {
        if (norm(items[k].episode_title) === want || norm(String(items[k].name || '').split(' - ')[0]) === want) {
          return items[k].path_id;
        }
      }
    }
    if (tmdbEp && tmdbEp.date && seasonInfo.episodes.filter(function (e) { return e.date === tmdbEp.date; }).length === 1) {
      var sameDay = items.filter(function (it) { return itemDate(it) === tmdbEp.date; });
      if (sameDay.length === 1) return sameDay[0].path_id;
    }
    if (byNumber && !numbered && episode <= items.length) return items[episode - 1].path_id;
    return null;
  });
}

function relinker(contentUrl) {
  return run(function* () {
    var u = contentUrl.indexOf('http') === 0 ? contentUrl : BASE + contentUrl;
    var r = yield req(u + (u.indexOf('?') === -1 ? '?' : '&') + 'output=62', { headers: { 'User-Agent': PLAY_UA } });
    var j = r.ok ? parseJson(r.text) : null;
    var url = j && j.video && j.video[0];
    if (!url || j.ct !== 'm3u8' && url.indexOf('.m3u8') === -1) { log('relinker senza HLS (HTTP ' + r.status + ')'); return null; }
    return url;
  });
}

function findStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var isMovie = mediaType === 'movie';
      var s = parseInt(season, 10) || 1;
      var ep = parseInt(episode, 10) || 1;
      var info = yield getInfo(tmdbId, isMovie);
      if (!info || !info.title) { log('TMDB senza titolo per ' + tmdbId); return []; }

      var paths = yield findPrograms(info, isMovie);
      var videoPath = null, programName = '', seasonInfo;
      for (var pi = 0; pi < paths.length && !videoPath; pi++) {
        var program = yield getJson(paths[pi]);
        if (!program || !program.name || titleScore(program.name, info) < 2) continue;
        var pinfo = program.program_info || {};
        var typ = String(pinfo.typology || '');
        if (isMovie) {
          var py = parseInt(pinfo.year, 10) || 0;
          // l'anno RaiPlay e' spesso quello di messa in onda: scarto solo se precede l'uscita
          if (info.year && py && py < info.year - 1) continue;
          if (!/film/i.test(typ) && (program.blocks || []).some(function (b) { return /episodi|puntate/i.test(b.name || ''); })) continue;
          videoPath = program.first_item_path || null;
        } else {
          if (/^film$/i.test(typ)) continue;
          if (seasonInfo === undefined) seasonInfo = yield getSeasonInfo(info.tmdbId, s);
          var sets = seasonSets(program, s, seasonInfo);
          for (var si = 0; si < sets.length && !videoPath; si++) {
            videoPath = yield findEpisodePath(sets[si].set, s, ep, seasonInfo, sets[si].byNumber);
          }
        }
        if (videoPath) { programName = program.name; log('programma "' + program.name + '" (' + paths[pi] + ')'); }
      }
      if (!videoPath) { log('nessun contenuto per ' + info.title + (isMovie ? '' : ' S' + s + 'E' + ep)); return []; }

      var video = yield getJson(videoPath);
      var drm = video && video.rights_management && video.rights_management.rights && video.rights_management.rights.drm;
      if (drm && Object.keys(drm).length) { log('contenuto con DRM'); return []; }
      var contentUrl = video && ((video.video && video.video.content_url) || video.video_url);
      if (!contentUrl) { log('content_url mancante'); return []; }
      var url = yield relinker(contentUrl);
      if (!url) return [];

      var headers = { 'User-Agent': PLAY_UA };
      var mr = yield req(url, { headers: headers });
      if (!mr.ok || mr.text.indexOf('#EXTM3U') === -1) { log('master HTTP ' + mr.status); return []; }
      var v = bestVariant(mr.text);
      var quality = qualityLabel(v && v.width) || 'HD';
      var audio = audioNames(mr.text);
      var ad = audio.some(function (a) { return /audiodescri/i.test(a); });

      var heading = '\uD83D\uDCC1 ' + info.title + (isMovie ? '' : ' S' + pad2(s) + 'E' + pad2(ep)) + (info.year ? ' (' + info.year + ')' : '');
      var technical = v ? [
        v.width && v.height ? '\uD83C\uDF9E\uFE0F ' + v.width + '\u00D7' + v.height : '',
        codecLabel(v.codecs),
        formatBitrate(v.bandwidth) ? '\uD83D\uDCF6 ' + formatBitrate(v.bandwidth) : ''
      ].filter(Boolean).join(' \u00B7 ') : '';
      var details = [
        technical,
        '\uD83D\uDD0A ' + FLAG_IT + ' Italiano' + (ad ? ' \u00B7 Audiodescrizione' : ''),
        '\uD83C\uDFAC RaiPlay \u00B7 Rai \u00B7 HLS \u00B7 ' + FLAG_IT
      ].filter(Boolean).join('\n');
      var slug = norm(programName || info.title).replace(/ /g, '-');
      return [{
        name: sortPrefix(quality, 0) + '🏛️ RaiPlay ' + quality + ' ' + FLAG_IT,
        title: heading + '\n' + details,
        size: details,
        url: url,
        type: 'hls',
        quality: quality,
        provider: 'raiplay',
        headers: headers,
        behaviorHints: {
          notWebReady: true,
          headers: headers,
          proxyHeaders: { request: headers },
          bingeGroup: 'raiplay',
          filename: 'raiplay-' + slug + (isMovie ? '' : '-S' + pad2(s) + 'E' + pad2(ep)) + '.m3u8'
        }
      }];
    } catch (e) {
      log('errore: ' + (e && e.message ? e.message : e));
      return [];
    }
  });
}

// ---------- Test di Nuvio ----------
// Il Test di Nuvio chiama sempre TMDB 603 (Matrix, assente qui): come PaCC lo si reindirizza a un titolo noto.
var PROBE = { id: 'tt0178132', type: 'tv', season: 1, episode: 1 }; // Don Matteo

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
