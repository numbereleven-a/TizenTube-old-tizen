(function (root) {
    'use strict';
    var CONFIG_KEY = 'ytaf-configuration';
    function validMode(value) { return value === '1.2' || value === '1.3' ? value : 'auto'; }
    function resolve(win, value, base) {
        value = String(value);
        if (base && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            var b = win.document.createElement('a'); b.href = base;
            value = value.indexOf('//') === 0 ? b.protocol + value : b.protocol + '//' + b.host +
                (value.charAt(0) === '/' ? value : value.charAt(0) === '?' ? b.pathname + value :
                 value.charAt(0) === '#' ? b.pathname + b.search + value : !value ? b.pathname + b.search :
                 b.pathname.replace(/[^/]*$/, '') + value);
        }
        var a = win.document.createElement('a'); a.href = value; return a;
    }
    function category(url) { return /(^|\.)googlevideo\.com$/i.test(url.hostname) ? 'video' : 'api'; }
    function bytes(win, value, callback) {
        if (value === undefined || value === null) { callback(new root.ArrayBuffer(0)); return; }
        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') { callback(value); return; }
        if (value.buffer && typeof value.byteLength === 'number') {
            callback(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)); return;
        }
        if (win.Blob && value instanceof win.Blob) {
            var reader = new win.FileReader(); reader.onload = function () { callback(reader.result); };
            reader.onerror = function () { callback(null); }; reader.readAsArrayBuffer(value); return;
        }
        if (value.nodeType) value = new win.XMLSerializer().serializeToString(value);
        var text = unescape(encodeURIComponent(String(value))), array = new root.Uint8Array(text.length);
        for (var i = 0; i < text.length; i++) array[i] = text.charCodeAt(i);
        callback(array.buffer);
    }
    function combine(chunks, length, Buffer, ByteArray, setBytes) {
        if (chunks.length === 1 && chunks[0] instanceof Buffer) return chunks[0];
        var all = new ByteArray(length), at = 0;
        for (var i = 0; i < chunks.length; i++) { setBytes.call(all, new ByteArray(chunks[i]), at); at += chunks[i].byteLength; }
        return all.buffer;
    }
    function text(buffer, decoder, final) {
        // Decode only new bytes, retaining an incomplete UTF-8 scalar across chunks.
        var array = new root.Uint8Array(buffer), result = [], part = '';
        for (var i = 0; i < array.length;) {
            var c = array[i], cp;
            if (!decoder.need) {
                i++;
                if (c < 128) cp = c;
                else if (c >= 194 && c <= 244) {
                    decoder.need = c <= 223 ? 1 : c <= 239 ? 2 : 3;
                    decoder.code = c & (decoder.need === 1 ? 31 : decoder.need === 2 ? 15 : 7);
                    decoder.lower = c === 224 ? 160 : c === 240 ? 144 : 128;
                    decoder.upper = c === 237 ? 159 : c === 244 ? 143 : 191;
                    continue;
                } else cp = 65533;
            } else if (c < decoder.lower || c > decoder.upper) {
                decoder.need = 0; cp = 65533; // Reconsume the invalid continuation as a new byte.
            } else {
                i++; decoder.code = decoder.code * 64 + (c & 63);
                decoder.lower = 128; decoder.upper = 191;
                if (--decoder.need) continue;
                cp = decoder.code;
            }
            if (!decoder.first || cp !== 65279) {
                if (cp < 65536) part += String.fromCharCode(cp);
                else { cp -= 65536; part += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023)); }
            }
            decoder.first = false;
            if (part.length > 8192) { result.push(part); part = ''; }
        }
        if (final && decoder.need) { part += '\ufffd'; decoder.need = 0; decoder.first = false; }
        result.push(part); return result.join('');
    }
    function headers(raw) {
        var result = {}, lines = String(raw).split('\r\n');
        for (var i = 0; i < lines.length; i++) {
            var colon = lines[i].indexOf(':'); if (colon < 1) continue;
            var name = lines[i].slice(0, colon).toLowerCase(), value = lines[i].slice(colon + 1).replace(/^\s+|\s+$/g, '');
            if (name === 'set-cookie' || name === 'set-cookie2') continue;
            result[name] = result[name] ? result[name] + ', ' + value : value;
        }
        return result;
    }
    function create(container, log, changed) {
        var module, ready = false, failed = false, sequence = 0, active = 0, requests = {}, queue = [], mode = 'auto';
        var mediaActive = 0, otherActive = 0, backgroundActive = 0, pumpTimer = null;
        var stats = { api: {}, video: {}, errors: 0, completed: 0, bytes: 0 }, extendedDiagnostics = false, collectProblemCDNs = false;
        var last = { api: 'unknown', video: 'unknown' }, diagnostics = [], logDiagnosticReply = false, mediaKey = '', media = { video: 'unknown', audio: 'unknown' }, ciphers = { api: 'unknown', video: 'unknown', audio: 'unknown' }, lastNotice = '';
        try {
            var saved = JSON.parse(root.localStorage.getItem(CONFIG_KEY) || '{}');
            mode = validMode(saved.tlsMode);
            extendedDiagnostics = saved.extendedDiagnostics === true;
            collectProblemCDNs = saved.collectProblemCDNs === true;
            if (saved.tlsMode !== mode) { saved.tlsMode = mode; root.localStorage.setItem(CONFIG_KEY, JSON.stringify(saved)); }
        } catch (_) {}
        var journalStorage;
        try { journalStorage = root.localStorage; } catch (_) { /* Playback remains available without persistent storage. */ }
        var journal = root.LegacyCDNJournal.create(journalStorage, function () { notify(); }, function () { return Date.now(); });
        function notify() {
            var key = [mode, last.api, last.video, media.audio, ciphers.api, ciphers.video, ciphers.audio, ready, failed, collectProblemCDNs, journal.summary().revision].join('|');
            if (changed && key !== lastNotice) { lastNotice = key; changed(summary()); }
        }
        function summary() {
            var cdn = journal.summary();
            return { mode: mode, api: last.api, video: last.video, system: 'unknown', active: active, queued: queue.length,
                cdnProblems: cdn.count, cdnAddedAt: cdn.addedAt, cdnPersistent: cdn.persistent, cdnCollecting: collectProblemCDNs,
                audio: media.audio, apiCipher: ciphers.api, videoCipher: ciphers.video, audioCipher: ciphers.audio,
                completed: stats.completed, bytes: stats.bytes, errors: stats.errors, ready: ready, failed: failed };
        }
        function record(group, tls) {
            last[group] = tls;
            stats[group][tls] = (stats[group][tls] || 0) + 1; notify();
        }
        function endpoint(u) {
            if (u.pathname === '/videoplayback') return 'videoplayback';
            var known = /^\/(?:api\/)?stats\/([a-z_]{1,32})$/.exec(u.pathname) || /^\/youtubei\/v1\/([a-z_]{1,32})$/.exec(u.pathname);
            if (known) return known[1];
            if (/^\/api\/skipSegments(?:\/|$)/.test(u.pathname)) return 'skipSegments';
            if (u.pathname === '/api/branding') return 'branding';
            if (/^\/api\/lounge\//.test(u.pathname)) return 'lounge';
            return u.pathname === '/tv' ? 'document' : 'other';
        }
        function identity(r) {
            return 'rid=' + r.trace + '; id=' + r.id + '; kind=' + r.track + '; host=' + r.parsed.hostname +
                '; endpoint=' + endpoint(r.parsed) + '; method=' + r.method + '; itag=' + r.itag + '; mode=' + r.mode;
        }
        function trace(r, event, detail) {
            if (!extendedDiagnostics) return;
            log.record(event, identity(r) + '; ageMs=' + (Date.now() - r.createdAt) + '; ' + detail);
        }
        function nativeTiming(d) {
            if (!extendedDiagnostics || !d) return;
            var fields = ['elapsedMs', 'dnsMs', 'tcpMs', 'tlsMs', 'sendMs', 'headersMs', 'bodyMs', 'wireReceived', 'wireSent', 'readCompletions', 'tickets'];
            var detail = 'rid=' + d.rid + '; id=' + d.id;
            fields.forEach(function (key) { if (typeof d[key] === 'number') detail += '; ' + key + '=' + Math.round(d[key]); });
            log.record('net.timing', detail);
        }
        function pump() {
            if (!ready || failed) return;
            while (active < 6 && queue.length) {
                var index = -1;
                for (var i = 0; mediaActive < 4 && i < queue.length; i++) if (queue[i].group === 'video') { index = i; break; }
                if (index < 0 && otherActive < 4) for (i = 0; i < queue.length; i++) if (queue[i].group !== 'video' && !queue[i].background) { index = i; break; }
                if (index < 0 && otherActive < 4 && backgroundActive < 1) for (i = 0; i < queue.length; i++) if (queue[i].group !== 'video' && queue[i].background) { index = i; break; }
                if (index < 0) break;
                var r = queue.splice(index, 1)[0]; if (!requests[r.id]) continue;
                active++; r.active = true; r.startedAt = Date.now(); r.tlsReady = false;
                r.slotGroup = r.group;
                if (r.slotGroup === 'video') mediaActive++; else otherActive++;
                if (r.background) backgroundActive++;
                var u = r.parsed, lines = '', h = r.headers;
                log.record('tls.queue', r.group + '; waitMs=' + (Date.now() - r.queuedAt));
                r.received = 0; r.status = 0; r.lastProgress = Date.now();
                trace(r, 'net.start', 'waitMs=' + (Date.now() - r.queuedAt));
                for (var key in h) if (Object.prototype.hasOwnProperty.call(h, key)) lines += key + ': ' + h[key] + '\r\n';
                if (!h['user-agent']) lines += 'User-Agent: ' + root.navigator.userAgent + '\r\n';
                module.postMessage({ type: 'request', id: r.id, method: r.method, host: u.hostname,
                    diagnostics: extendedDiagnostics, rid: r.trace, kind: r.track, endpoint: extendedDiagnostics ? endpoint(u) : '', itag: r.itag,
                    port: +(u.port || 443), path: (u.pathname.charAt(0) === '/' ? u.pathname : '/' + u.pathname) + u.search,
                    headers: lines, body: r.body, mode: r.mode, freshConnection: r.retries > 0 });
            }
            notify();
        }
        function schedulePump() {
            if (pumpTimer !== null) return;
            pumpTimer = setTimeout(function () { pumpTimer = null; pump(); }, 0);
        }
        function releaseSlot(r) {
            if (!r.active) return;
            active--; r.active = false;
            if (r.slotGroup === 'video') mediaActive--; else otherActive--;
            if (r.background) backgroundActive--;
        }
        function remove(r) {
            delete requests[r.id]; releaseSlot(r);
            queue = queue.filter(function (item) { return item !== r; });
            schedulePump();
        }
        function cdnFailure(r, reason) {
            if (!collectProblemCDNs || r.group !== 'video' || r.parsed.pathname !== '/videoplayback' || !r.active || !r.startedAt ||
                (r.status && !r.mediaSuccess)) return;
            try { if (r.guard && !r.guard()) return; } catch (_) { return; }
            journal.failure(r.parsed.hostname, r.mode, reason, r.trace, r.startedAt);
        }
        function abort(r, reason) {
            if (!r || !requests[r.id]) return;
            if (reason === 'timeout') cdnFailure(r, 'timeout');
            else if ((!reason || reason === 'abort') && r.guard && !r.status && !r.received &&
                Date.now() - r.startedAt >= (r.tlsReady ? 15000 : 10000)) {
                cdnFailure(r, r.tlsReady ? 'response-wait' : 'tls-wait');
            }
            trace(r, 'net.end', 'reason=' + (reason || 'abort') + '; bytes=' + (r.received || 0) + '; status=' + (r.status || 0));
            if (r.active) module.postMessage({ type: 'abort', id: r.id });
            remove(r); r.callback = null;
        }
        function requeue(r) {
            delete requests[r.id]; releaseSlot(r);
            r.id = ++sequence; r.queuedAt = Date.now(); r.mediaRecorded = false; requests[r.id] = r; queue.push(r); schedulePump();
            trace(r, 'net.queued', 'attempt=requeued');
        }
        function request(method, url, h, body, callback, guard) {
            var u = resolve(root, url);
            var r = { id: ++sequence, method: method, url: url, parsed: u, headers: h, body: body, callback: callback, mode: mode, redirects: 0, retries: 0, group: category(u), queuedAt: Date.now(),
                background: (/^sponsor\.ajay\.app$/i.test(u.hostname) && u.pathname === '/api/branding') ||
                    (/(^|\.)youtube\.com$/i.test(u.hostname) && /^\/(api\/stats\/|ptracking(?:\?|$)|generate_204|youtubei\/v1\/log_event)/.test(u.pathname) &&
                    !/^\/api\/stats\/(playback|watchtime)$/.test(u.pathname)) };
            var key = /(?:[?&])id=([^&]+)/.exec(u.search), mime = /(?:[?&])mime=([^&]+)/.exec(u.search), itag = /(?:[?&])itag=(\d{1,5})(?:&|$)/.exec(u.search);
            r.trace = r.id; r.createdAt = r.queuedAt; r.itag = itag ? +itag[1] : 0; r.guard = guard;
            r.track = r.group === 'api' ? 'api' : mime && /^audio(?:%2f|\/)/i.test(mime[1]) ? 'audio' : mime && /^video(?:%2f|\/)/i.test(mime[1]) ? 'video' : 'unknown';
            if (r.group === 'video' && u.pathname === '/videoplayback') {
                r.mediaKey = key ? key[1] : mediaKey;
                r.mediaKind = mime && /^audio(?:%2f|\/)/i.test(mime[1]) ? 'audio' : 'video';
                if (r.mediaKey !== mediaKey) { mediaKey = r.mediaKey; media = { video: 'unknown', audio: 'unknown' }; last.video = 'unknown'; ciphers.video = ciphers.audio = 'unknown'; notify(); }
            }
            requests[r.id] = r; queue.push(r);
            trace(r, 'net.queued', 'attempt=initial');
            if (failed) setTimeout(function () { trace(r, 'net.end', 'reason=module-unavailable'); remove(r); callback({ type: 'error', error: 'NaCl transport unavailable' }); }, 0);
            else pump();
            return r;
        }
        function moduleFailure() {
            if (failed) return;
            failed = true; ready = false; log.record('tls.module-error', 'NaCl transport unavailable');
            Object.keys(requests).forEach(function (id) { var r = requests[id]; trace(r, 'net.end', 'reason=module-unavailable'); remove(r); if (r.callback) r.callback({ type: 'error', error: 'NaCl transport unavailable' }); });
            notify();
        }
        container.addEventListener('message', function (event) {
            var m = event.data;
            if (!m || typeof m !== 'object') return;
            if (m.type === 'diagnostics') {
                diagnostics = m.requests;
                if (extendedDiagnostics && logDiagnosticReply) {
                    logDiagnosticReply = false;
                    diagnostics.forEach(function (d) {
                        log.record('net.pending', 'rid=' + d.rid + '; id=' + d.id + '; kind=' + d.kind + '; host=' + d.host +
                            '; endpoint=' + d.endpoint + '; itag=' + d.itag + '; phase=' + d.phase + '; phaseMs=' + Math.round(d.phaseMs) +
                            '; received=' + d.received + '; wireReceived=' + d.wireReceived + '; idleReadMs=' + Math.round(d.idleReadMs) +
                            '; readPending=' + !!d.readPending + '; tickets=' + d.tickets);
                    });
                }
                return;
            }
            if (m.type === 'ready') {
                ready = !!m.ok;
                if (!ready) { log.record('tls.module-init', 'code=' + m.code); moduleFailure(); return; }
                log.record('tls.ready', 'Mbed TLS 3.6.7; certificate and hostname verification required'); pump(); return;
            }
            var r = requests[m.id];
            if (!r || !r.callback) {
                if (extendedDiagnostics && m.diagnostic && (m.type === 'done' || m.type === 'error')) {
                    var d = m.diagnostic;
                    log.record('net.native-end', 'rid=' + d.rid + '; id=' + m.id + '; kind=' + d.kind + '; host=' + d.host + '; endpoint=' + d.endpoint + '; phase=' + d.phase + '; reason=' + (m.error || 'done'));
                    nativeTiming(d);
                }
                return;
            }
            if (m.type === 'tls') {
                r.tlsReady = true;
                if (!m.verified) { var rejected = r.callback; abort(r, 'certificate-rejected'); rejected({ type: 'error', error: 'Certificate verification failed' }); return; }
                r.transport = m.tls.replace('TLSv', 'TLS ');
                r.cipher = m.cipher || 'unknown';
                if (r.group === 'api') ciphers.api = r.cipher;
                if (r.group !== 'video') record(r.group, r.transport);
                log.record('tls.connection', r.group + '; ' + m.tls + '; cipher=' + r.cipher + '; verified=true; mode=' + r.mode + '; reused=' + !!m.reused + '; handshakeMs=' + Math.round(m.handshakeMs || 0) + '; rid=' + r.trace + '; id=' + r.id + '; kind=' + r.track);
            } else if (m.type === 'headers') {
                var h = headers(m.headers), redirect = h.location && [301, 302, 303, 307, 308].indexOf(m.status) >= 0;
                r.status = m.status;
                if (r.group === 'video' && /^audio\//i.test(h['content-type'] || '')) r.track = 'audio';
                else if (r.group === 'video' && /^video\//i.test(h['content-type'] || '')) r.track = 'video';
                trace(r, 'net.headers', 'status=' + m.status + '; phase=' + (m.diagnostic ? m.diagnostic.phase : 'unknown'));
                if (redirect) {
                    var next;
                    try { next = resolve(root, h.location, r.url); } catch (_) {}
                    if (!next || next.protocol !== 'https:' || ++r.redirects > 10) {
                        var cb = r.callback; abort(r, 'redirect-rejected'); cb({ type: 'error', error: 'Unsafe or excessive redirect' }); return;
                    }
                    module.postMessage({ type: 'abort', id: r.id });
                    trace(r, 'net.end', 'reason=redirect; status=' + m.status);
                    if (next.host !== r.parsed.host) { delete r.headers.authorization; delete r.headers.cookie; }
                    if ((m.status === 303 && r.method !== 'HEAD') || ((m.status === 301 || m.status === 302) && r.method === 'POST')) {
                        r.method = 'GET'; r.body = new root.ArrayBuffer(0); delete r.headers['content-type'];
                    }
                    r.url = next.href; r.parsed = next; r.group = category(next); requeue(r); return;
                }
                m.headers = h; m.url = r.url;
                r.mediaSuccess = m.status === 200 || m.status === 206;
                if (/^audio\//i.test(h['content-type'] || '')) r.mediaKind = 'audio';
            } else if (m.type === 'done' || m.type === 'error') {
                if (m.type === 'error' && m.retryable && r.retries++ < 1) {
                    trace(r, 'net.end', 'reason=retry; error=' + m.error); nativeTiming(m.diagnostic);
                    log.record('tls.retry', r.group + '; safe fresh connection retry; mode=' + r.mode);
                    requeue(r); return;
                }
                trace(r, 'net.end', 'reason=' + (m.error || 'done') + '; bytes=' + (r.received || 0) + '; status=' + (r.status || 0) + '; phase=' + (m.diagnostic ? m.diagnostic.phase : 'unknown'));
                if (m.type === 'error') {
                    var errorReason = /^DNS:/.test(m.error) ? 'dns' : /^TCP(?: read| write)?:/.test(m.error) ? 'tcp' :
                        /^(TLS|SSL|X509)/.test(m.error) ? 'tls' : m.error === 'Truncated HTTP response' ? 'truncated' : m.error === 'timeout' ? 'timeout' : '';
                    if (errorReason) cdnFailure(r, errorReason);
                } else if (collectProblemCDNs && r.group === 'video' && r.mediaSuccess && r.received > 0) journal.success(r.parsed.hostname);
                nativeTiming(m.diagnostic); remove(r);
                if (m.type === 'done') stats.completed++;
                else { stats.errors++; log.record('tls.request-error', r.group + '; ' + m.error); }
                notify();
            } else if (m.type === 'data') {
                var first = !r.received; r.received = (r.received || 0) + m.body.byteLength;
                if (extendedDiagnostics && (first || Date.now() - r.lastProgress >= 1000)) {
                    trace(r, first ? 'net.first-data' : 'net.progress', 'bytes=' + r.received); r.lastProgress = Date.now();
                }
                stats.bytes += m.body.byteLength;
                if (r.mediaKind && r.mediaSuccess && r.mediaKey === mediaKey && r.transport) {
                    media[r.mediaKind] = r.transport;
                    ciphers[r.mediaKind] = r.cipher;
                    if (r.mediaKind === 'video' && !r.mediaRecorded) { r.mediaRecorded = true; record('video', r.transport); }
                    else notify();
                }
            }
            r.callback(m);
        }, true);
        container.addEventListener('error', moduleFailure, true);
        container.addEventListener('crash', moduleFailure, true);
        module = root.document.createElement('embed'); module.type = 'application/x-nacl'; module.src = 'tls-client.nmf';
        module.width = 1; module.height = 1; container.appendChild(module);
        var startTimer = setTimeout(function () { if (!ready) moduleFailure(); }, 30000);
        container.addEventListener('load', function () { if (ready) clearTimeout(startTimer); }, true);
        var api = { request: request, abort: abort, summary: summary, problemCDNs: journal,
            setCDNCollection: function (value) {
                collectProblemCDNs = value === true;
                journal.resetCandidates(); notify();
            },
            diagnosticsEnabled: function () { return extendedDiagnostics; },
            recordWork: function (rid, id, event, detail) {
                if (extendedDiagnostics) log.record(event, 'rid=' + rid + '; id=' + id + '; ' + detail);
            },
            setDiagnostics: function (value) {
                extendedDiagnostics = value !== false;
                logDiagnosticReply = false; diagnostics = [];
                module.postMessage({ type: 'diagnostic-setting', enabled: extendedDiagnostics });
                log.record('diagnostics.mode', extendedDiagnostics ? 'extended' : 'basic');
            },
            setMode: function (value) {
                mode = validMode(value);
                // Already-open connections retain their negotiated version until playback/reload creates new ones.
                notify(); log.record('tls.mode', mode);
            },
            system: function (group) { if (group === 'video' && last.video !== 'unknown') { last.video = 'unknown'; media = { video: 'unknown', audio: 'unknown' }; ciphers.video = ciphers.audio = 'unknown'; notify(); } },
            inspect: function (recordReply) { if (!extendedDiagnostics) return []; if (recordReply) logDiagnosticReply = true; module.postMessage({ type: 'inspect' }); return diagnostics; },
            install: function (win) { install(win, api); }
        };
        return api;
    }
    function install(win, transport) {
        var NativeXHR = win.XMLHttpRequest, NativeBuffer = win.ArrayBuffer, NativeBytes = win.Uint8Array;
        var nativeSetBytes = NativeBytes.prototype.set, live = [], assemblyPeakBytes = 0;
        win.__legacyXHRMemory = function () {
            if (!transport.diagnosticsEnabled()) return null;
            var pending = 0;
            live.forEach(function (xhr) { pending += xhr._binaryView ? xhr._binaryView.byteLength : xhr._length; });
            return { pendingBytes: pending, pendingRequests: live.length, assemblyPeakBytes: assemblyPeakBytes };
        };
        var interactionAt = -Infinity, leaving = false;
        function interacted() { interactionAt = Date.now(); }
        function unloading() { leaving = true; }
        win.addEventListener('keydown', interacted, true);
        win.addEventListener('pointerdown', interacted, true);
        win.addEventListener('seeking', interacted, true);
        win.addEventListener('hashchange', interacted, true);
        win.addEventListener('beforeunload', unloading);
        function playbackGuard() {
            var hash = win.location && win.location.hash;
            var video = win.document.querySelector && win.document.querySelector('video');
            return function () {
                return !leaving && win.navigator.onLine !== false && video && win.document.querySelector('video') === video &&
                    (!win.location || win.location.hash === hash) && Date.now() - interactionAt > 3000 && !video.paused && !video.seeking;
            };
        }
        function events(object) {
            var listeners = {};
            object.addEventListener = function (type, cb) { (listeners[type] || (listeners[type] = [])).push(cb); };
            object.removeEventListener = function (type, cb) { var list = listeners[type] || []; listeners[type] = list.filter(function (fn) { return fn !== cb; }); };
            object._event = function (type, loaded, total) {
                var event = { type: type, target: object, currentTarget: object, loaded: loaded || 0, total: total || 0, lengthComputable: total > 0 };
                var callbacks = (listeners[type] || []).slice(); if (typeof object['on' + type] === 'function') callbacks.unshift(object['on' + type]);
                var measured = transport.diagnosticsEnabled() && object._nativeId, started = measured ? Date.now() : 0;
                var rid = object._traceId, id = object._nativeId, ready = object._state;
                callbacks.forEach(function (cb, index) {
                    var callbackStart = measured ? Date.now() : 0;
                    try { if (typeof cb === 'function') cb.call(object, event); else if (cb && cb.handleEvent) cb.handleEvent(event); }
                    catch (e) { setTimeout(function () { throw e; }, 0); }
                    if (measured && Date.now() - callbackStart >= 100) transport.recordWork(rid, id, 'net.xhr-callback',
                        'event=' + type + '; index=' + index + '; elapsedMs=' + (Date.now() - callbackStart));
                });
                if (measured && Date.now() - started >= 100) transport.recordWork(rid, id, 'net.xhr-event',
                    'event=' + type + '; state=' + ready + '; callbacks=' + callbacks.length + '; elapsedMs=' + (Date.now() - started));
            };
        }
        function XHR() {
            this.upload = {}; events(this.upload); events(this);
            this._native = null; this._request = null; this._state = 0; this._status = 0; this._statusText = ''; this._url = '';
            this._headers = {}; this._responseHeaders = {}; this._chunks = []; this._chunkCount = 0; this._length = 0; this._body = null; this._binaryView = null;
            this.timeout = 0; this.withCredentials = false; this.responseType = ''; this._sent = false;
            this._generation = 0; resetText(this);
        }
        function resetText(xhr) {
            xhr._text = ''; xhr._decodeIndex = 0; xhr._textFinal = false; xhr._jsonReady = false; xhr._json = null;
            xhr._decoder = { need: 0, code: 0, lower: 128, upper: 191, first: true };
            xhr._lastProgress = -Infinity;
        }
        function state(xhr, value) { xhr._state = value; xhr._event('readystatechange'); }
        function untrack(xhr) { clearTimeout(xhr._timer); live = live.filter(function (item) { return item !== xhr; }); xhr._request = null; xhr._sent = false; }
        function resetResponse(xhr) {
            xhr._chunks = []; xhr._chunkCount = 0; xhr._body = null; xhr._binaryView = null; xhr._length = 0;
            xhr._status = 0; xhr._statusText = ''; xhr._responseHeaders = {}; xhr._url = '';
            resetText(xhr);
        }
        function fail(xhr, type) {
            var generation = xhr._generation;
            transport.abort(xhr._request, type); untrack(xhr); resetResponse(xhr);
            state(xhr, 4);
            if (xhr._generation !== generation) return;
            xhr._event(type);
            if (xhr._generation === generation) xhr._event('loadend');
        }
        XHR.prototype.open = function (method, url, async, user, password) {
            this.abort(); this._method = String(method).toUpperCase(); this._headers = {}; this._responseHeaders = {}; this._chunks = []; this._chunkCount = 0; this._length = 0; this._body = null; this._binaryView = null;
            this._generation++;
            this._traceId = this._nativeId = 0;
            resetText(this);
            this._status = 0; this._statusText = ''; this._url = ''; this._native = null;
            var u = resolve(win, url);
            this._target = u.href;
            if (u.protocol !== 'https:') {
                if (u.protocol === 'http:') transport.system(category(u));
                this._native = new NativeXHR(); var self = this;
                ['readystatechange', 'loadstart', 'progress', 'abort', 'error', 'timeout', 'load', 'loadend'].forEach(function (name) {
                    self._native.addEventListener(name, function (event) { self._event(name, event.loaded, event.total); });
                });
                this._native.open(method, url, async === undefined ? true : async, user, password); return;
            }
            if (async === false) throw new Error('Synchronous HTTPS XHR is unavailable through NaCl');
            if (u.username || u.password || user || password) throw new Error('URL credentials are unsupported');
            state(this, 1);
        };
        XHR.prototype.setRequestHeader = function (name, value) {
            if (this._native) { this._native.setRequestHeader(name, value); return; }
            if (this._state !== 1 || this._sent) throw new Error('InvalidStateError');
            name = String(name).toLowerCase(); value = String(value);
            if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid HTTP header');
            this._headers[name] = this._headers[name] ? this._headers[name] + ', ' + value : value;
        };
        XHR.prototype.getResponseHeader = function (name) {
            return this._native ? this._native.getResponseHeader(name) : this._state < 2 ? null : this._responseHeaders[String(name).toLowerCase()] || null;
        };
        XHR.prototype.getAllResponseHeaders = function () {
            if (this._native) return this._native.getAllResponseHeaders();
            if (this._state < 2) return '';
            var lines = [], h = this._responseHeaders;
            Object.keys(h).forEach(function (name) { lines.push(name + ': ' + h[name] + '\r\n'); }); return lines.join('');
        };
        XHR.prototype.overrideMimeType = function (value) { this._mime = String(value); if (this._native) this._native.overrideMimeType(value); };
        XHR.prototype.abort = function () {
            if (this._native) { this._native.abort(); return; }
            var generation = this._generation;
            if (this._sent) fail(this, 'abort');
            if (this._generation === generation) { resetResponse(this); this._state = 0; }
        };
        XHR.prototype.send = function (value) {
            if (this._native) { this._native.timeout = this.timeout; this._native.withCredentials = this.withCredentials; this._native.responseType = this.responseType; this._native.send(value); return; }
            if (this._state !== 1 || this._sent) throw new Error('InvalidStateError');
            if (['', 'text', 'arraybuffer', 'blob', 'json', 'document'].indexOf(this.responseType) < 0) throw new Error('Unsupported responseType');
            var self = this, generation = this._generation; this._sent = true; live.push(this); this._event('loadstart');
            if (this._generation !== generation || !this._sent) return;
            if (this.timeout > 0) this._timer = setTimeout(function () { if (self._generation === generation && self._sent) fail(self, 'timeout'); }, this.timeout);
            if (value !== undefined && value !== null && typeof value === 'string' && !this._headers['content-type']) this._headers['content-type'] = 'text/plain;charset=UTF-8';
            bytes(win, this._method === 'GET' || this._method === 'HEAD' ? null : value, function (body) {
                if (!self._sent || self._generation !== generation) return;
                if (!body) { fail(self, 'error'); return; }
                self._request = transport.request(self._method, self._target, self._headers, body, function (m) {
                    if (!self._sent || self._generation !== generation) return;
                    self._traceId = self._request.trace; self._nativeId = m.id;
                    if (m.type === 'headers') {
                        self._status = m.status; self._statusText = m.statusText; self._responseHeaders = m.headers; self._url = m.url; state(self, 2);
                    } else if (m.type === 'data') {
                        try {
                            var expected = +self._responseHeaders['content-length'];
                            var encoding = self._responseHeaders['content-encoding'];
                            if (!self._length && (self.responseType === 'arraybuffer' || self.responseType === 'blob') &&
                                expected > 0 && expected <= 64 * 1024 * 1024 && expected % 1 === 0 &&
                                (!encoding || encoding === 'identity') && !self._responseHeaders['transfer-encoding']) {
                                self._body = new NativeBuffer(expected); self._binaryView = new NativeBytes(self._body);
                            }
                            if (self._binaryView && self._length + m.body.byteLength > self._binaryView.byteLength) {
                                self._chunks.push(self._body.slice(0, self._length)); self._body = null; self._binaryView = null;
                            }
                            if (self._binaryView) nativeSetBytes.call(self._binaryView, new NativeBytes(m.body), self._length);
                            else self._chunks.push(m.body);
                            self._length += m.body.byteLength;
                            self._chunkCount++;
                        } catch (_) { fail(self, 'error'); return; }
                        var now = Date.now();
                        if (now - self._lastProgress < 50) return;
                        self._lastProgress = now;
                        state(self, 3);
                        if (self._sent && self._generation === generation) self._event('progress', self._length, +self._responseHeaders['content-length'] || 0);
                    } else if (m.type === 'done') {
                        var measured = transport.diagnosticsEnabled(), started = measured ? Date.now() : 0;
                        var rid = self._traceId, id = self._nativeId, length = self._length, chunks = self._chunkCount, assembleMs = 0;
                        try {
                            var total = +self._responseHeaders['content-length'] || 0;
                            self._event('progress', self._length, total);
                            if (!self._sent || self._generation !== generation) return;
                            var assembleStart = measured ? Date.now() : 0;
                            // Match native XHR: the response belongs to the requesting window.
                            if (self.responseType === 'arraybuffer' || self.responseType === 'blob') {
                                var assemblyBytes = self._binaryView ? self._binaryView.byteLength : self._length;
                                if (self._binaryView) {
                                    if (self._length !== self._body.byteLength) {
                                        self._body = self._body.slice(0, self._length); assemblyBytes += self._body.byteLength;
                                    }
                                } else {
                                    var reused = self._chunks.length === 1 && self._chunks[0] instanceof NativeBuffer;
                                    self._body = combine(self._chunks, self._length, NativeBuffer, NativeBytes, nativeSetBytes);
                                    if (!reused) assemblyBytes += self._body.byteLength;
                                }
                                if (measured) assemblyPeakBytes = Math.max(assemblyPeakBytes, assemblyBytes);
                                self._binaryView = null;
                            }
                            else decoded(self, true);
                            if (measured) assembleMs = Date.now() - assembleStart;
                            self._chunks = []; untrack(self);
                            state(self, 4);
                            if (self._generation !== generation || self._state !== 4) return;
                            self._event('load', self._length, total);
                            if (self._generation === generation && self._state === 4) self._event('loadend', self._length, total);
                        } catch (_) {
                            if (self._sent && self._generation === generation) fail(self, 'error');
                        } finally {
                            if (measured) transport.recordWork(rid, id, 'net.xhr-done', 'bytes=' + length + '; chunks=' + chunks +
                                '; assembleMs=' + assembleMs + '; elapsedMs=' + (Date.now() - started));
                        }
                    } else if (m.type === 'error') fail(self, m.error === 'timeout' ? 'timeout' : 'error');
                }, playbackGuard());
                self.upload._event('loadstart'); self.upload._event('progress', body.byteLength, body.byteLength);
                self.upload._event('load'); self.upload._event('loadend');
            });
        };
        function decoded(xhr, final) {
            if (xhr._textFinal) return xhr._text;
            var parts = [];
            while (xhr._decodeIndex < xhr._chunks.length) parts.push(text(xhr._chunks[xhr._decodeIndex++], xhr._decoder, false));
            if (final) { parts.push(text(new root.ArrayBuffer(0), xhr._decoder, true)); xhr._textFinal = true; }
            xhr._text += parts.join('');
            return xhr._text;
        }
        function responseText(xhr) {
            if (xhr.responseType && xhr.responseType !== 'text') throw new Error('InvalidStateError');
            return xhr._state < 3 ? '' : decoded(xhr);
        }
        function responseXML(xhr) {
            if (xhr._state !== 4) return null;
            var mime = xhr._mime || xhr._responseHeaders['content-type'] || 'text/xml';
            return new win.DOMParser().parseFromString(decoded(xhr), mime.indexOf('text/html') === 0 ? 'text/html' : 'text/xml');
        }
        var getters = {
            readyState: function () { return this._state; }, status: function () { return this._status; }, statusText: function () { return this._statusText; },
            responseURL: function () { return this._url; }, responseText: function () { return responseText(this); }, responseXML: function () { return responseXML(this); },
            response: function () {
                if (!this.responseType || this.responseType === 'text') return responseText(this);
                if (this._state !== 4) return null;
                if (this.responseType === 'arraybuffer') return this._body;
                if (this.responseType === 'blob') return new win.Blob([this._body], { type: this._mime || this._responseHeaders['content-type'] || '' });
                if (this.responseType === 'document') return responseXML(this);
                if (!this._jsonReady) {
                    try { this._json = JSON.parse(decoded(this)); } catch (_) { this._json = null; }
                    this._jsonReady = true;
                }
                return this._json;
            }
        };
        Object.keys(getters).forEach(function (key) { Object.defineProperty(XHR.prototype, key, { get: function () { return this._native ? this._native[key] : getters[key].call(this); } }); });
        ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (name, index) { XHR[name] = XHR.prototype[name] = index; });
        win.XMLHttpRequest = XHR;
        // The compatibility bundle installs whatwg-fetch over this XHR implementation.
        win.fetch = undefined;
        if (win.navigator.sendBeacon) win.navigator.sendBeacon = function (url, data) { var xhr = new XHR(); xhr.open('POST', url, true); xhr.send(data); return true; };
        win.addEventListener('unload', function () { live.slice().forEach(function (xhr) { xhr.abort(); }); });
    }
    root.LegacyTLS = { create: create, install: install };
}(typeof window !== 'undefined' ? window : this));
