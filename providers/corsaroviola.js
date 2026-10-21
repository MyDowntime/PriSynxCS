var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Dec(s) {
  var str = String(s || '').replace(/\s+/g, '');
  var out = [];
  for (var i = 0; i < str.length; i += 4) {
    var c1 = B64.indexOf(str.charAt(i));
    var c2 = B64.indexOf(str.charAt(i + 1));
    var c3 = str.charAt(i + 2) === '=' ? -1 : B64.indexOf(str.charAt(i + 2));
    var c4 = str.charAt(i + 3) === '=' ? -1 : B64.indexOf(str.charAt(i + 3));
    out.push((c1 << 2) | (c2 >> 4));
    if (c3 !== -1) out.push(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 !== -1) out.push(((c3 & 3) << 6) | c4);
  }
  return out;
}

function decStr(b64, key) {
  var bytes = b64Dec(b64);
  var res = '';
  for (var i = 0; i < bytes.length; i++) {
    res += String.fromCharCode(bytes[i] ^ key.charCodeAt(i % key.length));
  }
  return res;
}

var _K = ['Corsaro', 'Viola', 'Nuvio', 'Key', '2026'].join('_');
var _E_BASE = 'KxsGA1tdQG5lWUFdUG9gQ09HXWpxXUptAw==';
var _E_TOK = 'MAsHGQkUXCg/DAwIGSkRKhIAAC8kFxow';

function getApiEndpoint() { return decStr(_E_BASE, _K); }
function getApiToken() { return decStr(_E_TOK, _K); }

var TMDB_KEY_FALLBACK = '68e094699525b18a70bab2f86b1fa706';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

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
    return r.text().then(function (t) {
      return { ok: r.ok, status: r.status, text: t || '', header: function (k) { try { return r.headers.get(k) || ''; } catch (e) { return ''; } } };
    });
  }).catch(function () { return { ok: false, status: 0, text: '' }; });
}

function log(msg) { try { console.log('[CorsaroViola] ' + msg); } catch (e) { } }
function parseJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

// ---------- Formato stream (PriSynx standard) ----------

var FLAG_IT = '\uD83C\uDDEE\uD83C\uDDF9';
var FLAG_EN = '\uD83C\uDDEC\uD83C\uDDE7';
var ZW_PREFIX = ['\u200B', '\u200C', '\u200D', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064'];

function sortPrefix(quality, fileSize, priority) {
  var qNum = Number(String(quality || '').replace(/[^0-9]/g, '')) || 0;
  var r = 3;
  if (qNum >= 2160) r = 0;
  else if (qNum >= 1080) r = 1;
  else if (qNum >= 720) r = 2;

  // Dimensione invertita: max 262143 MB (~256 GB) su 6 cifre base-8
  var mb = Math.floor((Number(fileSize) || 0) / (1024 * 1024));
  if (mb < 0) mb = 0;
  if (mb > 262143) mb = 262143;
  var inv = 262143 - mb;

  var p = (typeof priority === 'number' && priority >= 0 && priority < ZW_PREFIX.length) ? priority : 0;

  return '\uFEFF' +
         ZW_PREFIX[r] +
         ZW_PREFIX[(inv >> 15) & 7] +
         ZW_PREFIX[(inv >> 12) & 7] +
         ZW_PREFIX[(inv >> 9) & 7] +
         ZW_PREFIX[(inv >> 6) & 7] +
         ZW_PREFIX[(inv >> 3) & 7] +
         ZW_PREFIX[inv & 7] +
         ZW_PREFIX[p];
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  return Math.round(bytes / 1048576) + ' MB';
}

function calculateBitrate(fileSizeBytes, runtimeMinutes) {
  if (!fileSizeBytes || !runtimeMinutes || runtimeMinutes <= 0) return '';
  var seconds = runtimeMinutes * 60;
  var bps = (fileSizeBytes * 8) / seconds;
  if (bps >= 1000000) {
    var mbps = bps / 1000000;
    return (mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)).replace(/\.0+$/, '') + ' Mbps';
  }
  return Math.round(bps / 1000) + ' kbps';
}

function parseQuality(t) {
  var s = String(t || '').toLowerCase();
  if (/2160p|4k|uhd/i.test(s)) return '2160p';
  if (/1080p|fhd/i.test(s)) return '1080p';
  if (/720p|hd\b/i.test(s)) return '720p';
  if (/480p|576p|dvd|sd\b|xvid/i.test(s)) return '480p';
  return 'HD';
}

function parseCodec(t) {
  var s = String(t || '').toLowerCase();
  if (/hevc|h\.?265|x265/i.test(s)) return 'HEVC';
  if (/avc|h\.?264|x264/i.test(s)) return 'H.264';
  if (/av1/i.test(s)) return 'AV1';
  if (/xvid/i.test(s)) return 'XviD';
  return '';
}

function parseAudio(t) {
  var s = String(t || '').toLowerCase();
  if (/atmos/i.test(s)) return 'Atmos';
  if (/ddp5\.?1|e-?ac-?3(?:\s*5\.?1)?/i.test(s)) return 'E-AC-3 5.1';
  if (/ac-?3(?:\s*5\.?1)?|dd5\.?1/i.test(s)) return 'AC-3 5.1';
  if (/dts-?hd/i.test(s)) return 'DTS-HD';
  if (/dts/i.test(s)) return 'DTS';
  if (/aac/i.test(s)) return 'AAC';
  if (/mp3/i.test(s)) return 'MP3';
  return '';
}

function extractInfoHash(magnet) {
  var m = String(magnet || '').match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : '';
}

// ---------- TMDB / ID resolution ----------

function tmdbKey() {
  try { if (typeof TMDB_API_KEY === 'string' && TMDB_API_KEY.length > 10) return TMDB_API_KEY; } catch (e) { }
  return TMDB_KEY_FALLBACK;
}

function parseId(raw) {
  var v = String(raw || '').trim().replace(/^tmdb:/i, '');
  var imdbMatch = (v.match(/tt\d+/) || [])[0];
  if (imdbMatch) return { imdbId: imdbMatch, tmdbId: null };
  var numMatch = (v.match(/^\d+$/) || [])[0];
  if (numMatch) return { tmdbId: numMatch, imdbId: null };
  return null;
}

function getInfo(rawId, isTv, season, episode) {
  return run(function* () {
    var parsed = parseId(rawId);
    if (!parsed) return null;
    var key = tmdbKey();

    if (parsed.imdbId && !parsed.tmdbId) {
      var findUrl = 'https://api.themoviedb.org/3/find/' + parsed.imdbId + '?api_key=' + key + '&external_source=imdb_id';
      var fRes = yield req(findUrl);
      var fJson = parseJson(fRes.text);
      var hit = (fJson && (isTv ? fJson.tv_results : fJson.movie_results)) || [];
      if (hit.length) {
        parsed.tmdbId = String(hit[0].id);
      }
    }

    if (parsed.tmdbId) {
      var title = '', year = '', runtime = 0;
      if (isTv) {
        var epUrl = 'https://api.themoviedb.org/3/tv/' + parsed.tmdbId + '/season/' + (season || 1) + '/episode/' + (episode || 1) + '?api_key=' + key + '&language=it-IT';
        var epRes = yield req(epUrl);
        var epJson = parseJson(epRes.text);
        if (epJson && epJson.runtime) runtime = parseInt(epJson.runtime, 10) || 0;

        var tvUrl = 'https://api.themoviedb.org/3/tv/' + parsed.tmdbId + '?api_key=' + key + '&language=it-IT';
        var tvRes = yield req(tvUrl);
        var tvJson = parseJson(tvRes.text);
        if (tvJson) {
          title = tvJson.name || '';
          year = String(tvJson.first_air_date || '').slice(0, 4);
          if (!runtime && Array.isArray(tvJson.episode_run_time) && tvJson.episode_run_time.length) {
            runtime = parseInt(tvJson.episode_run_time[0], 10) || 0;
          }
        }
      } else {
        var movieUrl = 'https://api.themoviedb.org/3/movie/' + parsed.tmdbId + '?api_key=' + key + '&language=it-IT';
        var mRes = yield req(movieUrl);
        var mJson = parseJson(mRes.text);
        if (mJson) {
          title = mJson.title || '';
          year = String(mJson.release_date || '').slice(0, 4);
          runtime = parseInt(mJson.runtime, 10) || 0;
        }
      }

      return {
        tmdbId: parsed.tmdbId,
        title: title,
        year: year,
        runtime: runtime
      };
    }

    return null;
  });
}

// ---------- Flusso principale ----------

function findStreams(tmdbId, mediaType, season, episode) {
  return run(function* () {
    try {
      var isTv = mediaType === 'tv' || mediaType === 'series';
      var s = parseInt(season, 10) || 1;
      var ep = parseInt(episode, 10) || 1;

      var info = yield getInfo(tmdbId, isTv, s, ep);
      var resolvedTmdbId = (info && info.tmdbId) || String(tmdbId || '').replace(/^tmdb:/i, '').trim();
      if (!/^\d+$/.test(resolvedTmdbId)) {
        log('ID TMDB non valido: ' + tmdbId);
        return [];
      }

      var apiBase = getApiEndpoint();
      var apiToken = getApiToken();

      var apiUrl = '';
      if (isTv) {
        apiUrl = apiBase + '/tv?tmdb_id=' + encodeURIComponent(resolvedTmdbId + ':' + s + ':' + ep) + '&token=' + encodeURIComponent(apiToken);
      } else {
        apiUrl = apiBase + '/movie?tmdb_id=' + encodeURIComponent(resolvedTmdbId) + '&token=' + encodeURIComponent(apiToken);
      }

      var res = yield req(apiUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      var data = parseJson(res.text);
      if (!data || !Array.isArray(data.results) || !data.results.length) {
        log('Nessun torrent per ' + (info && info.title ? info.title : tmdbId));
        return [];
      }

      var title = (info && info.title) || '';
      var year = (info && info.year) || '';
      var runtime = (info && info.runtime) || (isTv ? 45 : 100);
      var epLabel = isTv ? ' S' + pad2(s) + 'E' + pad2(ep) : '';

      var streams = [];
      var seenMagnets = {};

      for (var i = 0; i < data.results.length; i++) {
        var item = data.results[i];
        if (!item || !item.magnet || seenMagnets[item.magnet]) continue;
        seenMagnets[item.magnet] = 1;

        var rawTitle = item.title || '';
        var quality = parseQuality(rawTitle);
        var codec = parseCodec(rawTitle);
        var audio = parseAudio(rawTitle);
        var seeders = typeof item.seeders === 'number' ? item.seeders : 0;
        var fileSize = (item.file && item.file.size) || (item.size) || 0;
        var fileName = (item.file && item.file.title) || rawTitle;
        var bitrate = calculateBitrate(fileSize, runtime);

        var isIta = /ita|italian|italiano/i.test(rawTitle);
        var isSub = /sub\s*ita|multisub/i.test(rawTitle);
        var langTag = isIta ? FLAG_IT : (isSub ? FLAG_IT + ' SUB' : FLAG_EN);

        var heading = '\uD83D\uDCC1 ' + (title || rawTitle) + epLabel + (year ? ' (' + year + ')' : '');

        var technical = [
          '\uD83C\uDF9E\uFE0F ' + quality + (codec ? ' \u00B7 ' + codec : ''),
          bitrate ? '\uD83D\uDCE1 ' + bitrate : '',
          audio ? '\uD83D\uDD0A ' + audio : '',
          fileSize ? '\uD83D\uDCBE ' + formatSize(fileSize) : '',
          '\uD83D\uDC65 ' + seeders + ' seed' + (seeders === 1 ? '' : 's')
        ].filter(Boolean).join(' \u00B7 ');

        var details = [
          technical,
          '\uD83D\uDCC4 ' + fileName,
          '\uD83C\uDFAC IlCorsaroViola \u00B7 P2P Torrent \u00B7 ' + langTag
        ].filter(Boolean).join('\n');

        // Ordinamento: priorità alta per ITA, secondaria per altri
        var priority = isIta ? (seeders >= 10 ? 0 : 1) : 2;
        var infoHash = extractInfoHash(item.magnet);
        var fileIdx = item.file && typeof item.file.file_index === 'number' ? item.file.file_index : undefined;

        streams.push({
          name: sortPrefix(quality, fileSize, priority) + '\uD83C\uDFF4\u200D\u2620\uFE0F IlCorsaroViola ' + quality + ' ' + langTag + ' \uD83D\uDC65 ' + seeders,
          title: heading + '\n' + details,
          size: details,
          url: item.magnet,
          infoHash: infoHash || undefined,
          fileIdx: fileIdx,
          quality: quality,
          provider: 'corsaroviola',
          behaviorHints: {
            bingeGroup: 'corsaroviola-' + quality,
            videoSize: fileSize || undefined,
            filename: fileName || 'video.mkv'
          }
        });
      }

      // Ordinamento alfabetico con zero-width prefix
      streams.sort(function (a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      log('Composti ' + streams.length + ' torrent per ' + (title || tmdbId));
      return streams;
    } catch (err) {
      log('Errore: ' + (err && err.message ? err.message : err));
      return [];
    }
  });
}

// ---------- Test Nuvio (603 -> Matrix) ----------
var PROBE = { id: '603', type: 'movie', season: 1, episode: 1 };

function getStreams(tmdbId, mediaType, season, episode) {
  var clean = String(tmdbId || '').replace(/^tmdb:/i, '').trim();
  if (clean === '603') {
    return findStreams(PROBE.id, PROBE.type, PROBE.season, PROBE.episode).then(function (list) {
      return (list || []).map(function (st) {
        st.name += ' \uD83E\uDDEA';
        st.title = '\uD83E\uDDEA Test Nuvio (603 -> Matrix)\n' + st.title;
        return st;
      });
    });
  }
  return findStreams(tmdbId, mediaType, season, episode);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  globalThis.getStreams = getStreams;
}
