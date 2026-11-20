(function () {
    // Some Samsung Bluetooth keyboards report letters as YouTube TV shortcut
    // keys.  Send searchable characters through the visible TV keyboard,
    // which follows the same code path as a remote-control selection.
    if (window.__ttBluetoothKeyboard) return;
    window.__ttBluetoothKeyboard = true;

    var dispatching = false;
    var named = {
        Semicolon: [';', ':'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
        Backslash: ['\\', '|'], BracketLeft: ['[', '{'], BracketRight: [']', '}'],
        Minus: ['-', '_'], Equal: ['=', '+'], Quote: ["'", '"'], Grave: ['`', '~'],
        Space: [' ', ' '], exclam: ['!', '!'], at: ['@', '@'], numbersign: ['#', '#'],
        dollar: ['$', '$'], percent: ['%', '%'], ampersand: ['&', '&'], asterisk: ['*', '*'],
        parenleft: ['(', '('], parenright: [')', ')'], underscore: ['_', '_'], plus: ['+', '+'],
        colon: [':', ':'], quotedbl: ['"', '"'], question: ['?', '?'], less: ['<', '<'], greater: ['>', '>']
    };
    var shiftedDigits = [')', '!', '@', '#', '$', '%', '^', '&', '*', '('];
    var keyCodes = {
        186: [';', ':'], 187: ['=', '+'], 188: [',', '<'], 189: ['-', '_'],
        190: ['.', '>'], 191: ['/', '?'], 192: ['`', '~'], 219: ['[', '{'],
        220: ['\\', '|'], 221: [']', '}'], 222: ["'", '"']
    };
    var characterKeyCodes = {
        ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188,
        '-': 189, '_': 189, '.': 190, '>': 190, '/': 191, '?': 191,
        '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220, '|': 220,
        ']': 221, '}': 221, "'": 222, '"': 222, ' ': 32
    };

    function isHex(value) { return value.length === 4 && /^[0-9a-f]+$/i.test(value); }
    function decode(event) {
        var identifier = event.keyIdentifier, key = event.key, shifted = !!event.shiftKey;
        var code = event.keyCode || event.which;
        if (typeof identifier === 'string') {
            identifier = identifier.trim();
            if (named[identifier]) return named[identifier][shifted ? 1 : 0];
            if (identifier.slice(0, 2).toUpperCase() === 'U+') {
                var hex = identifier.slice(2, 6);
                if (isHex(hex)) {
                    var charCode = parseInt(hex, 16);
                    if (charCode >= 32 && charCode !== 127) {
                        var character = String.fromCharCode(charCode);
                        if (character >= 'a' && character <= 'z') return shifted ? character.toUpperCase() : character;
                        if (character >= 'A' && character <= 'Z') return shifted ? character : character.toLowerCase();
                        if (charCode >= 48 && charCode <= 57) return shifted ? shiftedDigits[charCode - 48] : character;
                        if (characterKeyCodes[character] && keyCodes[characterKeyCodes[character]]) return keyCodes[characterKeyCodes[character]][shifted ? 1 : 0];
                        return character;
                    }
                }
            }
        }
        if (typeof key === 'string') {
            if (named[key]) return named[key][shifted ? 1 : 0];
            if (key.length === 1 && key.charCodeAt(0) >= 32) return key;
        }
        if (code >= 65 && code <= 90) {
            var letter = String.fromCharCode(code);
            return shifted ? letter : letter.toLowerCase();
        }
        if (code >= 48 && code <= 57) return shifted ? shiftedDigits[code - 48] : String.fromCharCode(code);
        if (keyCodes[code]) return keyCodes[code][shifted ? 1 : 0];
        return code === 32 ? ' ' : null;
    }
    function press(element) {
        function mouse(type) {
            var event = document.createEvent('MouseEvents');
            event.initMouseEvent(type, true, true, window, 1, 0, 0, 0, 0, false, false, false, false, 0, null);
            element.dispatchEvent(event);
        }
        mouse('mousedown'); mouse('mouseup'); mouse('click');
    }
    function label(element) { return (element.textContent || '').replace(/\s+/g, '').toUpperCase(); }
    function virtualKey(character) {
        var wanted = String(character).toUpperCase();
        var keys = document.querySelectorAll('yt-keyboard-key');
        for (var index = 0; index < keys.length; index++) if (label(keys[index]) === wanted) return keys[index];
        return null;
    }
    function keyboardReady() {
        return !!(document.querySelector('ytlr-search-text-box') && document.querySelector('yt-keyboard-key'));
    }
    var opening = false;
    function openSearch(done) {
        if (keyboardReady()) { done(true); return; }
        if (opening) { setTimeout(function () { openSearch(done); }, 100); return; }
        opening = true;
        var candidates = document.querySelectorAll('ytlr-search-button,[aria-label="Search"],[title="Search"]');
        for (var index = 0; index < candidates.length; index++) {
            var rect = candidates[index].getBoundingClientRect();
            if (rect.width && rect.height) { press(candidates[index]); break; }
        }
        var tries = 0;
        function wait() {
            if (keyboardReady()) { opening = false; done(true); return; }
            if (++tries >= 30) { opening = false; done(false); return; }
            setTimeout(wait, 100);
        }
        wait();
    }
    var queue = [], busy = false;
    function process() {
        if (!queue.length) { busy = false; return; }
        if (!keyboardReady()) {
            openSearch(function (ready) { if (ready) process(); else { queue = []; busy = false; } });
            return;
        }
        var character = queue.shift();
        var key = virtualKey(character);
        if (key) { press(key); setTimeout(process, 25); return; }
        var letters = /^[A-Za-z]$/.test(character);
        var keys = document.querySelectorAll('yt-keyboard-key');
        var modeKey = null;
        for (var index = 0; index < keys.length; index++) {
            var mode = label(keys[index]);
            if (letters ? mode === 'ABC' || mode === 'ABCD' : mode === '&123' || mode === '123') { modeKey = keys[index]; break; }
        }
        if (!modeKey) { setTimeout(process, 25); return; }
        press(modeKey);
        setTimeout(function () { var switched = virtualKey(character); if (switched) press(switched); setTimeout(process, 75); }, 100);
    }
    function enqueue(character) { queue.push(character); if (!busy) { busy = true; process(); } }
    function virtualBackspace() {
        var keys = document.querySelectorAll('yt-keyboard-key');
        for (var index = 0; index < keys.length; index++) {
            var details = ((keys[index].getAttribute('aria-label') || '') + ' ' + (keys[index].outerHTML || '')).toLowerCase();
            if (/backspace|back-space|delete|erase/.test(details)) { press(keys[index]); return; }
        }
    }
    function handle(event) {
        if (dispatching || event._ttClean) return;
        var code = event.keyCode || event.which;
        if (code === 10009 || code === 27 || code === 13 || (code >= 37 && code <= 40) || (code >= 403 && code <= 406) || code === 447 || code === 448 || code === 449) return;
        if (code === 8 || code === 46 || event.keyIdentifier === 'U+0008' || event.keyIdentifier === 'Delete' || event.key === 'Delete') {
            event.preventDefault(); event.stopImmediatePropagation();
            if (event.type === 'keydown') virtualBackspace();
            return;
        }
        var character = decode(event);
        if (character === null) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'keydown') enqueue(character);
    }
    window.addEventListener('keydown', handle, true);
    window.addEventListener('keypress', handle, true);
    window.addEventListener('keyup', handle, true);
})();

(function () {
    'use strict';
    function report(entry) {
        if (parent !== window) {
            parent.__legacyLog.record(entry.code, entry.detail);
        }
    }
    var log = LegacyLogger.create(300, report);
    function extendedDiagnostics() {
        return !parent.__legacyTLS || !parent.__legacyTLS.diagnosticsEnabled || parent.__legacyTLS.diagnosticsEnabled();
    }
    window.__legacyLog = log;
    window.addEventListener('error', function (event) {
        if (event.target !== window) return;
        var source = event.filename;
        log.record('page.error', event.message + ' script=' + (source ? source.split('?')[0].split('/').pop() : 'inline') + ' line=' + event.lineno + ' column=' + event.colno);
    });
    window.addEventListener('unhandledrejection', function (event) {
        log.record('promise.error', event.reason && event.reason.message ? event.reason.message : 'Unhandled rejection');
        if (event.reason && event.reason.stack) log.record('promise.stack', event.reason.stack);
    });
    window.addEventListener('error', function (event) {
        if (event.target && event.target !== window) log.record('resource.error', event.target.tagName || 'unknown');
    }, true);
    function diagnosticKey(event) {
        var key = event.keyCode;
        if (key === 403 || key === 406) {
            if (parent !== window) {
                if (event.type === 'keydown') parent.__legacyCommand(key);
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }
    }
    ['keydown', 'keypress', 'keyup'].forEach(function (type) { document.addEventListener(type, diagnosticKey, true); });
    window.addEventListener('beforeunload', function () {
        if (parent !== window) parent.__legacyFrameNavigation(window);
    });
    log.record('page.start', 'fetch=' + typeof window.fetch + '; Promise=' + typeof window.Promise + '; MSE=' + !!(window.MediaSource || window.WebKitMediaSource));
    window.addEventListener('DOMContentLoaded', function () {
        log.record('page.dom', 'DOM ready; video=' + !!document.querySelector('video'));
        var video = null;
        var detachVideo = function () {};
        var mediaStatus = '';
        var appReady = false;
        function updateStatus() {
            if (!appReady && parent.__legacyReady) {
                var app = window._yttv;
                if (!app || !Object.keys(app).some(function (key) {
                    var entry = app[key];
                    return entry && entry.instance && typeof entry.instance.resolveCommand === 'function';
                })) return;
                appReady = true;
                parent.__legacyReady(window);
                log.record('page.ready', 'YouTube application initialized');
            }
            var current = document.querySelector('video');
            if (current !== video) {
                detachVideo(); detachVideo = function () {}; sampleVideo = function () {}; sampleStall = function () {};
                video = current; mediaStatus = '';
                if (video) attach(video);
            }
            if (video && /^https?:/i.test(video.currentSrc || '') && parent.__legacyTLS) parent.__legacyTLS.system('video');
            var text = mediaStatus;
            var playing = video && !video.paused && !video.seeking && video.readyState >= 3;
            if (playing && mediaStatus === 'Buffering…') { mediaStatus = ''; text = ''; }
            if (!text && !playing) {
                var spinners = document.querySelectorAll('yt-spinner');
                for (var i = 0; i < spinners.length; i++) {
                    var element = spinners[i], rect = element.getBoundingClientRect();
                    if (!rect.width || !rect.height) continue;
                    var shown = true;
                    for (var node = element; node && node.nodeType === 1; node = node.parentNode) {
                        var style = window.getComputedStyle(node);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { shown = false; break; }
                    }
                    if (shown) { text = 'Loading…'; break; }
                }
            }
            if (parent !== window) parent.__legacyStatus(text, window, text !== 'Unable to play video');
        }
        function attach(element) {
            var listeners = [];
            var followups = 0, lastStallSample = -Infinity;
            function trackAhead(value) {
                if (typeof value !== 'string') return 'unknown';
                if (!value.trim()) return '0.0';
                var ranges = value.split(','), ahead = 0;
                for (var i = 0; i < ranges.length; i++) {
                    var range = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(ranges[i]);
                    if (!range || +range[2] < +range[1]) return 'unknown';
                    if (+range[1] <= element.currentTime && +range[2] >= element.currentTime) ahead = Math.max(ahead, +range[2] - element.currentTime);
                }
                return ahead.toFixed(1);
            }
            function stallSnapshot(reason) {
                if (!extendedDiagnostics()) { followups = 0; return; }
                lastStallSample = Date.now();
                var stats = {}, quality = {}, transport = {};
                try {
                    var player = document.querySelector('.html5-video-player');
                    if (player && player.getVideoStats) stats = player.getVideoStats() || {};
                } catch (_) { /* Missing player statistics must not interrupt playback. */ }
                try { if (element.getVideoPlaybackQuality) quality = element.getVideoPlaybackQuality() || {}; } catch (_) {}
                try { if (parent.__legacyTLS) { transport = parent.__legacyTLS.summary(); parent.__legacyTLS.inspect(true); } } catch (_) {}
                function count(value) { return typeof value === 'number' && isFinite(value) ? value : 'unknown'; }
                log.record('video.stall-tracks', 'reason=' + reason + '; time=' + element.currentTime.toFixed(1) +
                    '; audioAhead=' + trackAhead(stats.lab) + '; videoAhead=' + trackAhead(stats.lvb) +
                    '; ready=' + element.readyState + '; paused=' + !!element.paused + '; seeking=' + !!element.seeking +
                    '; rate=' + count(element.playbackRate) + '; mediaError=' + (element.error ? element.error.code : 0) +
                    '; trackErrors=unknown; decoded=' + count(typeof element.webkitDecodedFrameCount === 'number' ? element.webkitDecodedFrameCount : quality.totalVideoFrames) +
                    '; dropped=' + count(typeof element.webkitDroppedFrameCount === 'number' ? element.webkitDroppedFrameCount : quality.droppedVideoFrames));
                log.record('video.stall-network', 'active=' + count(transport.active) + '; queued=' + count(transport.queued) +
                    '; completed=' + count(transport.completed) + '; bytes=' + count(transport.bytes) + '; transportErrors=' + count(transport.errors));
            }
            ['waiting', 'stalled'].forEach(function (type) {
                listen(type, function () {
                    if (!extendedDiagnostics()) return;
                    followups = 5;
                    if (Date.now() - lastStallSample >= 500) stallSnapshot(type);
                });
            });
            ['loadstart', 'emptied', 'ended'].forEach(function (type) { listen(type, function () { followups = 0; }); });
            sampleStall = function () {
                if (followups && Date.now() - lastStallSample >= 1000) { followups--; stallSnapshot('followup'); }
            };
            function listen(type, fn) { element.addEventListener(type, fn); listeners.push([type, fn]); }
            detachVideo = function () { listeners.forEach(function (entry) { element.removeEventListener(entry[0], entry[1]); }); };
            ['loadstart', 'waiting', 'stalled', 'seeking', 'playing', 'canplay', 'seeked', 'emptied', 'ended', 'error'].forEach(function (type) {
                listen(type, function () {
                    if (type === 'loadstart') mediaStatus = 'Loading video…';
                    else if (type === 'waiting' || type === 'stalled') mediaStatus = element.readyState < 3 ? 'Buffering…' : '';
                    else if (type === 'seeking') mediaStatus = 'Seeking…';
                    else if (type === 'error') mediaStatus = 'Unable to play video';
                    else mediaStatus = '';
                    updateStatus();
                });
            });
            function state() {
                var ahead = 0;
                for (var i = 0; i < element.buffered.length; i++) {
                    if (element.buffered.start(i) <= element.currentTime && element.buffered.end(i) >= element.currentTime) {
                        ahead = element.buffered.end(i) - element.currentTime; break;
                    }
                }
                return 'ready=' + element.readyState + '; network=' + element.networkState +
                    '; time=' + element.currentTime.toFixed(1) + '; buffer=' + ahead.toFixed(1) +
                    '; paused=' + !!element.paused + '; seeking=' + !!element.seeking + '; rate=' + element.playbackRate +
                    '; size=' + element.videoWidth + 'x' + element.videoHeight +
                    '; decoded=' + element.webkitDecodedFrameCount + '; dropped=' + element.webkitDroppedFrameCount +
                    '; error=' + (element.error ? element.error.code : 0);
            }
            ['loadedmetadata', 'playing', 'waiting', 'stalled', 'pause', 'seeking', 'seeked', 'ratechange', 'ended', 'error'].forEach(function (type) {
                listen(type, function () {
                    if (type === 'error' || extendedDiagnostics()) log.record('video.' + type, state());
                });
            });
            sampleVideo = function () { if (extendedDiagnostics() && !element.paused && !element.ended) log.record('video.sample', state()); };
            log.record('video.attached', 'Media events enabled');
        }
        var sampleVideo = function () {};
        var sampleStall = function () {};
        var lastTick = Date.now();
        setInterval(function () {
            var now = Date.now(), elapsed = now - lastTick; lastTick = now;
            if (extendedDiagnostics() && video && !video.paused && elapsed > 1000) log.record('video.loop-delay', 'intervalMs=' + elapsed + '; lateMs=' + (elapsed - 500));
            var started = extendedDiagnostics() ? Date.now() : 0;
            updateStatus();
            if (started && Date.now() - started >= 50) log.record('ui.status-work', 'elapsedMs=' + (Date.now() - started));
            sampleStall();
        }, 500);
        setInterval(function () { if (video) sampleVideo(); }, 10000);
        updateStatus();
        setTimeout(function () {
            log.record('page.check', 'video=' + !!document.querySelector('video') + '; yttv=' + !!window._yttv);
        }, 20000);
    });
}());
