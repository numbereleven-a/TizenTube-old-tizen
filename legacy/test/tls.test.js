'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Logger = require('../web/logger');

function setup(mode = 'auto', options = { extendedDiagnostics: true }) {
    const listeners = {}, sent = [], timers = new Set();
    const diagnosticSetting = Object.prototype.hasOwnProperty.call(options, 'extendedDiagnostics') ? options.extendedDiagnostics : true;
    const storage = { value: JSON.stringify({ tlsMode: mode, extendedDiagnostics: diagnosticSetting, collectProblemCDNs: options.collectProblemCDNs }),
        getItem(key) { return key === 'ytaf-configuration' ? this.value : this.cdnValue || null; },
        setItem(key, value) { if (key === 'ytaf-configuration') this.value = value; else this.cdnValue = value; } };
    const container = { addEventListener(type, callback) { listeners[type] = callback; }, appendChild() {} };
    const win = { LegacyCDNJournal: require('../web/cdn-journal'), ArrayBuffer, Uint8Array: options.Uint8Array || Uint8Array, navigator: { userAgent: 'Synthetic test' },
        localStorage: storage, addEventListener(type, fn) { if (options.windowListeners) options.windowListeners[type] = fn; },
        document: { createElement(type) {
            if (type === 'embed') return { postMessage: value => sent.push(value) };
            let url;
            return { set href(value) { url = new URL(value, 'https://www.youtube.com/tv'); },
                get href() { return url.href; }, get protocol() { return url.protocol; }, get host() { return url.host; },
                get hostname() { return url.hostname; }, get port() { return url.port; }, get pathname() { return url.pathname; },
                get search() { return url.search; }, get username() { return url.username; }, get password() { return url.password; } };
        } }, XMLHttpRequest: function () { throw new Error('Unexpected system fallback'); } };
    const log = Logger.create(100);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/tls-transport.js'), 'utf8'), { window: win, Date: options.Date || Date, setTimeout(callback, ms) {
        if (options.timerSchedules) options.timerSchedules.push(ms);
        const t = setTimeout(() => { timers.delete(t); callback(); }, ms); timers.add(t); return t;
    }, clearTimeout(t) { clearTimeout(t); timers.delete(t); } });
    const transport = win.LegacyTLS.create(container, log);
    transport.install(win);
    function message(value) { listeners.message({ data: value }); }
    message({ type: 'ready', ok: true });
    return { win, transport, sent, log, message, close() { for (const t of timers) clearTimeout(t); } };
}

test('Binary assembly failure releases buffers and reports an XHR error', () => {
    function LimitedBytes(value) {
        if (typeof value === 'number') throw new RangeError('Synthetic allocation failure');
        return new Uint8Array(value);
    }
    LimitedBytes.prototype = Uint8Array.prototype;
    const env = setup('auto', { Uint8Array: LimitedBytes });
    try {
        const xhr = new env.win.XMLHttpRequest(), events = [];
        for (const type of ['error', 'load', 'loadend']) xhr.addEventListener(type, () => events.push(type));
        xhr.open('GET', 'https://media.googlevideo.com/videoplayback'); xhr.responseType = 'arraybuffer'; xhr.send();
        const id = env.sent.at(-1).id;
        env.message({ type: 'headers', id, status: 200, headers: 'Transfer-Encoding: chunked\r\n' });
        for (let i = 0; i < 2; i++) env.message({ type: 'data', id, body: new Uint8Array([1, 2]).buffer });
        assert.doesNotThrow(() => env.message({ type: 'done', id }));
        assert.deepEqual(events, ['error', 'loadend']);
        assert.equal(xhr.readyState, 4); assert.equal(xhr.status, 0); assert.equal(xhr.response, null);
        assert.equal(env.win.__legacyXHRMemory().pendingBytes, 0);
        assert.equal(env.win.__legacyXHRMemory().pendingRequests, 0);
        assert.equal(env.transport.summary().active, 0);
    } finally { env.close(); }
});

test('Bulk cancellation schedules one pump and releases every media slot', () => {
    const timerSchedules=[],env=setup('1.3',{timerSchedules});
    try {
        const requests=Array.from({length:40},()=>env.transport.request('GET','https://media.googlevideo.com/videoplayback',{},new ArrayBuffer(0),()=>{}));
        assert.equal(env.transport.summary().active,4);assert.equal(env.transport.summary().queued,36);
        const before=timerSchedules.length;
        requests.forEach(r=>env.transport.abort(r));
        assert.equal(timerSchedules.length-before,1);
        assert.equal(env.transport.summary().active,0);assert.equal(env.transport.summary().queued,0);
        for(let i=0;i<4;i++)env.transport.request('GET','https://media.googlevideo.com/videoplayback',{},new ArrayBuffer(0),()=>{});
        for(let i=0;i<2;i++)env.transport.request('GET','https://www.youtube.com/api/stats/watchtime',{},new ArrayBuffer(0),()=>{});
        assert.equal(env.transport.summary().active,6);assert.equal(env.transport.summary().queued,0);
    }finally{env.close();}
});

test('Completed XHR abort clears binary and JSON data without firing abort events', () => {
    for(const type of ['arraybuffer','json']) {
        const env=setup();try {
            const xhr=new env.win.XMLHttpRequest();xhr.open('GET','https://example.test/data');xhr.responseType=type;xhr.send();const r=env.sent[0];
            env.message({type:'headers',id:r.id,status:200,headers:'Content-Type: application/json\r\n'});
            env.message({type:'data',id:r.id,body:new TextEncoder().encode('{"ok":true}').buffer});env.message({type:'done',id:r.id});
            assert.ok(xhr.response);let events=0;xhr.onabort=xhr.onloadend=()=>events++;xhr.abort();
            assert.equal(xhr.readyState,0);assert.equal(xhr.status,0);assert.equal(xhr.statusText,'');assert.equal(xhr.responseURL,'');assert.equal(xhr.response,null);
            assert.equal(xhr._body,null);assert.equal(xhr._text,'');assert.equal(xhr._json,null);assert.equal(xhr._chunks.length,0);assert.equal(events,0);
        }finally{env.close();}
    }
});

test('Known-length binary responses fill one buffer and handle missing, encoded and mismatched lengths', () => {
    for(const headers of ['Content-Length: 4\r\n','Content-Length: 2\r\n','Content-Length: 8\r\n',
        'Content-Length: 2\r\nContent-Encoding: gzip\r\n','Content-Length: 2\r\nTransfer-Encoding: chunked\r\n','']) {
        const env=setup();try {
            const xhr=new env.win.XMLHttpRequest();xhr.open('GET','https://example.test/data');xhr.responseType='arraybuffer';xhr.send();const r=env.sent[0];
            env.message({type:'headers',id:r.id,status:200,headers});env.message({type:'data',id:r.id,body:Uint8Array.from([1,2]).buffer});
            const allocated=xhr._body;assert.equal(xhr.response,null);env.message({type:'data',id:r.id,body:Uint8Array.from([3,4]).buffer});assert.equal(xhr.response,null);
            env.message({type:'done',id:r.id});assert.deepEqual(Array.from(new Uint8Array(xhr.response)),[1,2,3,4]);
            assert.match(env.log.read().find(entry=>entry.code==='net.xhr-done').detail,/chunks=2;/);
            if(headers==='Content-Length: 4\r\n'){assert.equal(xhr.response,allocated);assert.equal(xhr._chunks.length,0);}
            assert.equal(env.win.__legacyXHRMemory().pendingBytes,0);
        }finally{env.close();}
    }
});

test('Relative redirects retain the resource path for query and fragment references', async () => {
    for(const [location,expected] of [['?token=new','/dir/videoplayback?token=new'],['#part','/dir/videoplayback?token=old'],['../next','/next']]) {
        const env=setup();try {
            const r=env.transport.request('GET','https://example.test/dir/videoplayback?token=old',{},new ArrayBuffer(0),()=>{});
            env.message({type:'headers',id:r.id,status:302,headers:'Location: '+location+'\r\n'});
            await new Promise(resolve=>setTimeout(resolve,10));const requests=env.sent.filter(r=>r.type==='request');
            assert.equal(requests.at(-1).path,expected);
        }finally{env.close();}
    }
});

test('TLS startup defaults to Auto and preserves all three explicit modes', () => {
    for (const saved of [null, undefined, 'invalid', 'auto', '1.2', '1.3']) {
        const env = setup(saved);
        try {
            const expected = saved === '1.2' || saved === '1.3' ? saved : 'auto';
            assert.equal(env.transport.summary().mode, expected);
            assert.equal(JSON.parse(env.win.localStorage.value).tlsMode, expected);
            const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', 'https://www.youtube.com/tv'); xhr.send();
            assert.equal(env.sent[0].mode, expected);
            env.transport.setMode('auto');
            assert.equal(env.transport.summary().mode, 'auto');
        } finally { env.close(); }
    }
});

test('CDN collection defaults to off, preserves its saved choice and toggles live without losing entries', () => {
    for (const saved of [undefined,false,true]) {
        const env=setup('1.3',{extendedDiagnostics:false,collectProblemCDNs:saved});
        try {
            assert.equal(env.transport.summary().cdnCollecting,saved===true);
            function fail(){const r=env.transport.request('GET','https://media.googlevideo.com/videoplayback',{},new ArrayBuffer(0),()=>{});env.message({type:'error',id:r.id,error:'timeout'});}
            fail();fail();assert.equal(env.transport.summary().cdnProblems,saved===true?1:0);
            env.transport.setCDNCollection(true);fail();
            env.transport.setCDNCollection(false);fail();fail();
            env.transport.setCDNCollection(true);fail();
            assert.equal(env.transport.summary().cdnProblems,saved===true?1:0,'Disabled intervals reset incomplete candidates');
            fail();assert.equal(env.transport.summary().cdnProblems,1);
            env.transport.setCDNCollection(false);fail();
            assert.equal(env.transport.problemCDNs.read().length,1,'Disabling preserves the saved journal');
        } finally {env.close();}
    }
});

test('CDN journal works with extended diagnostics off and excludes HTTP and non-media requests', () => {
    let now=100000;
    const env=setup('1.3',{extendedDiagnostics:false,collectProblemCDNs:true,Date:{now:()=>now}});
    try {
        function fail(url,error){const r=env.transport.request('GET',url,{},new ArrayBuffer(0),()=>{});env.message({type:'error',id:r.id,error});now++;}
        fail('https://www.youtube.com/tv','timeout');fail('https://www.youtube.com/tv','timeout');
        fail('https://media.googlevideo.com/generate_204','timeout');fail('https://media.googlevideo.com/generate_204','timeout');
        assert.equal(env.transport.problemCDNs.read().length,0);
        for(let i=0;i<2;i++){
            const r=env.transport.request('GET','https://media.googlevideo.com/videoplayback',{},new ArrayBuffer(0),()=>{});
            env.message({type:'headers',id:r.id,status:404,headers:''});env.message({type:'done',id:r.id});
        }
        assert.equal(env.transport.problemCDNs.read().length,0);
        fail('https://media.googlevideo.com/videoplayback','SSL - The connection indicated an EOF');
        assert.equal(env.transport.summary().cdnProblems,0);
        fail('https://media.googlevideo.com/videoplayback','SSL - The connection indicated an EOF');
        assert.equal(env.transport.summary().cdnProblems,1);
        assert.equal(env.transport.problemCDNs.read()[0].reason,'tls');
        assert.equal(env.transport.diagnosticsEnabled(),false);
        assert.ok(env.win.localStorage.cdnValue);
    }finally{env.close();}
});

test('CDN journal excludes seek, navigation and short aborts but captures repeated quiet handshake stalls', () => {
    let now=100000;const windowListeners={};
    const env=setup('1.3',{extendedDiagnostics:false,collectProblemCDNs:true,Date:{now:()=>now},windowListeners});
    const video={paused:false,seeking:false};env.win.document.querySelector=()=>video;env.win.location={hash:'#/watch?synthetic'};
    try{
        function start(){const xhr=new env.win.XMLHttpRequest();xhr.open('GET','https://media.googlevideo.com/videoplayback');xhr.responseType='arraybuffer';xhr.send();return xhr;}
        let xhr=start();now+=500;xhr.abort();
        xhr=start();now+=16000;video.seeking=true;xhr.abort();video.seeking=false;
        xhr=start();now+=16000;windowListeners.keydown();xhr.abort();
        now+=4000;xhr=start();now+=16000;env.win.location.hash='#/watch?other';xhr.abort();
        assert.equal(env.transport.problemCDNs.read().length,0);
        for(let i=0;i<2;i++){now+=4000;xhr=start();now+=16000;xhr.abort();}
        assert.equal(env.transport.summary().cdnProblems,1);
        assert.equal(env.transport.problemCDNs.read()[0].reason,'tls-wait');
        env.transport.problemCDNs.clear();
        xhr=start();now+=16000;windowListeners.beforeunload();xhr.abort();
        assert.equal(env.transport.problemCDNs.read().length,0);
    }finally{env.close();}
});

test('Extended diagnostics default to off and preserve an explicit saved choice', () => {
    for (const saved of [undefined, false, true]) {
        const env = setup('1.2', { extendedDiagnostics: saved });
        try {
            assert.equal(env.transport.diagnosticsEnabled(), saved === true);
            const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', 'https://www.youtube.com/tv'); xhr.send();
            assert.equal(env.sent[0].diagnostics, saved === true);
        } finally { env.close(); }
    }
});

test('Extended diagnostics honor the saved setting and can be toggled without interrupting playback', () => {
    const env = setup('1.2', { extendedDiagnostics: false });
    try {
        assert.equal(env.transport.diagnosticsEnabled(), false);
        const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', 'https://media.googlevideo.com/videoplayback'); xhr.send();
        const request = env.sent.at(-1);
        assert.equal(request.diagnostics, false);
        env.transport.inspect(true);
        assert.equal(env.sent.some(m => m.type === 'inspect'), false);
        env.message({ type: 'headers', id: request.id, status: 200, headers: '' });
        env.message({ type: 'data', id: request.id, body: Uint8Array.from([1]).buffer });
        env.message({ type: 'done', id: request.id });
        assert.equal(xhr.readyState, 4); assert.equal(xhr.responseText.length, 1);
        assert.equal(env.log.read().some(e => /^net\./.test(e.code)), false);
        env.transport.setDiagnostics(true);
        xhr.open('GET', 'https://www.youtube.com/tv'); xhr.send();
        assert.equal(env.sent.at(-1).diagnostics, true);
        assert.ok(env.log.read().some(e => e.code === 'net.start'));
        env.transport.setDiagnostics(false);
        assert.equal(env.sent.at(-1).type, 'diagnostic-setting'); assert.equal(env.sent.at(-1).enabled, false);
        const before = env.log.read().length;
        xhr.abort();
        assert.equal(env.log.read().length, before);
        assert.equal(env.transport.summary().active, 0);
    } finally { env.close(); }
});

test('XHR completion diagnostics separate assembly from slow event callbacks and preserve request identity on reentry', () => {
    let now = 1000;
    function MeasuredArray(value) { if (typeof value === 'number') now += 120; return new Uint8Array(value); }
    MeasuredArray.prototype = Uint8Array.prototype;
    const env = setup('1.3', { Date: { now: () => now }, Uint8Array: MeasuredArray });
    try {
        const xhr = new env.win.XMLHttpRequest(); xhr.responseType = 'arraybuffer';
        xhr.open('GET', 'https://media.googlevideo.com/videoplayback'); xhr.send();
        const request = env.sent[0];
        env.message({ type: 'headers', id: request.id, status: 200, headers: '' });
        for (let i = 0; i < 2; i++) env.message({ type: 'data', id: request.id, body: Uint8Array.from([65]).buffer });
        xhr.onprogress = () => { now += 250; };
        xhr.onreadystatechange = () => { if (xhr.readyState === 4) now += 500; };
        xhr.onload = () => { now += 700; };
        xhr.onloadend = () => { now += 110; xhr.open('GET', 'https://www.youtube.com/next'); };
        env.message({ type: 'done', id: request.id });
        const records = env.log.read();
        assert.match(records.find(e => e.code === 'net.xhr-done').detail, /rid=1; id=1; bytes=2; chunks=2; assembleMs=120; elapsedMs=1680/);
        const events = records.filter(e => e.code === 'net.xhr-event');
        assert.equal(events.length, 4);
        assert.ok(events.every(e => e.detail.startsWith('rid=1; id=1;')));
        assert.match(events.find(e => /event=load;/.test(e.detail)).detail, /elapsedMs=700/);
        assert.match(records.find(e => e.code === 'net.xhr-callback' && /event=load;/.test(e.detail)).detail,
            /rid=1; id=1; event=load; index=0; elapsedMs=700/);
        assert.equal(xhr.readyState, 1, 'Logging must preserve reopening from loadend');
    } finally { env.close(); }
});

test('Network diagnostics correlate track, request stages and completion without saving URLs or credentials', () => {
    let now = 1000;
    const env = setup('1.2', { Date: { now: () => now } });
    try {
        const xhr = new env.win.XMLHttpRequest();
        xhr.open('GET', 'https://media.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4&token=synthetic-private');
        xhr.setRequestHeader('Authorization', 'Bearer synthetic-private'); xhr.responseType = 'arraybuffer'; xhr.send();
        const request = env.sent[0];
        assert.equal(request.rid, request.id); assert.equal(request.kind, 'audio'); assert.equal(request.itag, 140);
        assert.equal(request.endpoint, 'videoplayback');
        const diagnostic = { id: request.id, rid: request.rid, kind: request.kind, host: request.host, endpoint: request.endpoint,
            phase: 'body', dnsMs: 2, tcpMs: 5, tlsMs: 12, sendMs: 1, headersMs: 50, wireReceived: 100, readCompletions: 3 };
        env.message({ type: 'headers', id: request.id, status: 206, headers: 'Content-Type: audio/mp4\r\n', diagnostic });
        const chunk = Uint8Array.from([1]).buffer;
        for (let i = 0; i < 10; i++) env.message({ type: 'data', id: request.id, body: chunk });
        assert.equal(env.log.read().filter(e => e.code === 'net.first-data').length, 1);
        assert.equal(env.log.read().filter(e => e.code === 'net.progress').length, 0);
        now += 1000; env.message({ type: 'data', id: request.id, body: chunk });
        assert.equal(env.log.read().filter(e => e.code === 'net.progress').length, 1);
        env.message({ type: 'done', id: request.id, diagnostic });
        assert.match(env.log.read().find(e => e.code === 'net.end').detail, /reason=done; bytes=11; status=206/);
        assert.match(env.log.read().find(e => e.code === 'net.timing').detail, /dnsMs=2; tcpMs=5; tlsMs=12/);
        const before = env.log.read().length;
        env.message({ type: 'diagnostics', requests: [diagnostic] }); env.transport.inspect();
        assert.equal(env.log.read().length, before, 'Inspection must not create duplicate lifecycle events');
        env.transport.inspect(true); env.message({ type: 'diagnostics', requests: [diagnostic] });
        assert.match(env.log.read().find(e => e.code === 'net.pending').detail, /kind=audio.*phase=body/);
        const text = JSON.stringify(env.log.read());
        assert.doesNotMatch(text, /synthetic-private|Bearer|https?:|mime=|token=/);

        const api = new env.win.XMLHttpRequest(); api.open('GET', 'https://api/stats/example_ping?private=synthetic-private'); api.send();
        const apiRequest = env.sent.at(-1);
        assert.equal(apiRequest.kind, 'api'); assert.equal(apiRequest.endpoint, 'example_ping');
        api.abort();
        assert.match(env.log.read().filter(e => e.code === 'net.end').at(-1).detail, /host=api; endpoint=example_ping.*reason=abort/);
    } finally { env.close(); }
});

test('Network diagnostics preserve a logical ID across redirects and distinguish XHR timeout from native abort', async () => {
    const env = setup();
    try {
        const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', 'https://www.youtube.com/start'); xhr.send();
        const first = env.sent[0];
        env.message({ type: 'headers', id: first.id, status: 302, headers: 'Location: https://www.youtube.com/next\r\n' });
        await new Promise(resolve => setTimeout(resolve, 10));
        const next = env.sent.filter(m => m.type === 'request').at(-1);
        assert.notEqual(next.id, first.id); assert.equal(next.rid, first.rid);
        xhr.abort();
        const timeout = new env.win.XMLHttpRequest(); timeout.open('GET', 'https://media.googlevideo.com/videoplayback?mime=video%2Fmp4&itag=137');
        timeout.timeout = 5; timeout.send();
        const request = env.sent.filter(m => m.type === 'request').at(-1);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(env.log.read().filter(e => e.code === 'net.end').at(-1).detail, /kind=video.*reason=timeout/);
        env.message({ type: 'error', id: request.id, error: 'abort', diagnostic: {
            id: request.id, rid: request.rid, kind: request.kind, host: request.host, endpoint: request.endpoint, phase: 'tls', tlsMs: 25
        } });
        assert.match(env.log.read().find(e => e.code === 'net.native-end').detail, /kind=video.*phase=tls; reason=abort/);
        assert.equal(env.transport.summary().active, 0);
    } finally { env.close(); }
});

test('Player transport follows successful data for the current media and ignores stale and failed streams', () => {
    const env = setup('1.3');
    try {
        function start(id, mime) {
            const xhr = new env.win.XMLHttpRequest();
            xhr.open('GET', 'https://media.googlevideo.com/videoplayback?id=' + id + '&mime=' + mime);
            xhr.send(); return env.sent[env.sent.length - 1];
        }
        function response(request, tls, status, cipher = 'TLS1-3-CHACHA20-POLY1305-SHA256') {
            env.message({ type: 'tls', id: request.id, tls, cipher, verified: true });
            env.message({ type: 'headers', id: request.id, status, headers: 'Content-Length: 1\r\n' });
            env.message({ type: 'data', id: request.id, body: Uint8Array.from([1]).buffer });
        }
        const old = start('synthetic-old', 'video%2Fmp4');
        assert.equal(old.mode, '1.3');
        response(old, 'TLS 1.3', 200);
        assert.equal(env.transport.summary().video, 'TLS 1.3');
        assert.equal(env.transport.summary().videoCipher, 'TLS1-3-CHACHA20-POLY1305-SHA256');
        env.transport.setMode('1.2');
        const current = start('synthetic-current', 'video%2Fmp4');
        assert.equal(current.mode, '1.2');
        assert.equal(env.transport.summary().video, 'unknown');
        assert.equal(env.transport.summary().videoCipher, 'unknown');
        response(old, 'TLSv1.2', 200);
        assert.equal(env.transport.summary().video, 'unknown');
        response(current, 'TLSv1.3', 206);
        assert.equal(env.transport.summary().video, 'TLS 1.3');
        const audio = start('synthetic-current', 'audio%2Fmp4');
        response(audio, 'TLSv1.2', 200, 'TLS-ECDHE-ECDSA-WITH-AES-128-GCM-SHA256');
        assert.equal(env.transport.summary().audio, 'TLS 1.2');
        assert.equal(env.transport.summary().audioCipher, 'TLS-ECDHE-ECDSA-WITH-AES-128-GCM-SHA256');
        assert.equal(env.transport.summary().videoCipher, 'TLS1-3-CHACHA20-POLY1305-SHA256');
        assert.equal(env.transport.summary().video, 'TLS 1.3');
        const failed = start('synthetic-current', 'video%2Fmp4');
        response(failed, 'TLSv1.2', 403);
        assert.equal(env.transport.summary().video, 'TLS 1.3');
    } finally { env.close(); }
});

test('NaCl XHR carries POST authorization and binary media, reports negotiated TLS separately, and never falls back on a TLS error', () => {
    const env = setup('1.3');
    try {
        const xhr = new env.win.XMLHttpRequest();
        xhr.open('POST', 'https://www.youtube.com/youtubei/v1/player');
        xhr.setRequestHeader('Authorization', 'Bearer synthetic-only');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send('{"synthetic":true}');
        const request = env.sent[0];
        assert.equal(request.mode, '1.3');
        assert.match(request.headers, /authorization: Bearer synthetic-only/);
        assert.equal(Buffer.from(request.body).toString(), '{"synthetic":true}');
        env.message({ type: 'tls', id: request.id, tls: 'TLSv1.3', verified: true });
        env.message({ type: 'headers', id: request.id, status: 200, statusText: 'OK', headers: 'Content-Type: application/json\r\nSet-Cookie: synthetic-private\r\n' });
        const json = Buffer.from('{"message":"Привет"}');
        env.message({ type: 'data', id: request.id, body: json.buffer.slice(json.byteOffset, json.byteOffset + json.length) });
        env.message({ type: 'done', id: request.id });
        assert.equal(xhr.readyState, 4);
        assert.equal(JSON.parse(xhr.responseText).message, 'Привет');
        assert.equal(xhr.getResponseHeader('set-cookie'), null);

        env.transport.setMode('1.2');
        const video = new env.win.XMLHttpRequest();
        video.open('GET', 'https://media.googlevideo.com/videoplayback?synthetic=1');
        video.responseType = 'arraybuffer'; video.setRequestHeader('Range', 'bytes=0-3'); video.send();
        const media = env.sent[1];
        assert.equal(media.mode, '1.2'); assert.match(media.headers, /range: bytes=0-3/);
        env.message({ type: 'tls', id: media.id, tls: 'TLSv1.2', verified: true });
        env.message({ type: 'headers', id: media.id, status: 206, statusText: 'Partial Content', headers: 'Content-Length: 4\r\n' });
        env.message({ type: 'data', id: media.id, body: Uint8Array.from([0, 255, 128, 3]).buffer });
        env.message({ type: 'done', id: media.id });
        assert.deepEqual(Array.from(new Uint8Array(video.response)), [0, 255, 128, 3]);
        assert.equal(env.transport.summary().api, 'TLS 1.3'); assert.equal(env.transport.summary().video, 'TLS 1.2');
        assert.equal(env.transport.summary().system, 'unknown');

        let errored = false;
        const bad = new env.win.XMLHttpRequest(); bad.open('GET', 'https://invalid.example/'); bad.onerror = () => { errored = true; }; bad.send();
        env.message({ type: 'error', id: env.sent[2].id, error: 'certificate mismatch' });
        assert.equal(errored, true); assert.equal(bad.status, 0);
        assert.doesNotMatch(JSON.stringify(env.log.read()), /synthetic-only|synthetic-private/);
    } finally { env.close(); }
});

test('NaCl redirects keep forced mode, strip cross-host authorization, and an aborted/reopened XHR ignores old results', async () => {
    const env = setup();
    try {
        env.transport.setMode('1.3');
        const xhr = new env.win.XMLHttpRequest(); xhr.open('POST', 'https://www.youtube.com/redirect');
        xhr.setRequestHeader('Authorization', 'Bearer synthetic-only'); xhr.send('synthetic');
        const original = env.sent[0];
        env.message({ type: 'headers', id: original.id, status: 302, headers: 'Location: https://other.example/next\r\n' });
        env.transport.setMode('1.2');
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 10));
        const redirected = env.sent.find(item => item.type === 'request' && item.id !== original.id);
        assert.equal(redirected.mode, '1.3'); assert.equal(redirected.method, 'GET'); assert.equal(redirected.body.byteLength, 0);
        assert.doesNotMatch(redirected.headers, /authorization/i);
        xhr.abort(); assert.ok(env.sent.some(item => item.type === 'abort' && item.id === redirected.id));
        xhr.open('GET', 'https://www.youtube.com/new'); xhr.send();
        env.message({ type: 'done', id: redirected.id });
        assert.equal(xhr.readyState, 1);
        assert.equal(env.sent[env.sent.length - 1].mode, '1.2');

        let reader;
        env.win.Blob = class Blob {};
        env.win.FileReader = class FileReader { constructor() { reader = this; } readAsArrayBuffer() {} };
        const delayed = new env.win.XMLHttpRequest(); delayed.open('POST', 'https://www.youtube.com/old'); delayed.send(new env.win.Blob());
        delayed.abort(); delayed.open('GET', 'https://www.youtube.com/reopened'); delayed.send();
        const count = env.sent.length;
        reader.result = Uint8Array.from([1]).buffer; reader.onload();
        assert.equal(env.sent.length, count, 'An old FileReader must not submit a body into the reopened request');

        // Only a native-confirmed reset before HTTP may replay the body, with its original forced mode.
        env.transport.setMode('1.3');
        const reset = new env.win.XMLHttpRequest(); reset.open('POST', 'https://www.youtube.com/token'); reset.send('synthetic');
        let failed = 0; reset.onerror = () => { failed++; };
        const first = env.sent[env.sent.length - 1];
        env.transport.setMode('1.2');
        env.message({ type: 'error', id: first.id, error: 'TCP read: -2', retryable: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        const retry = env.sent[env.sent.length - 1];
        assert.notEqual(retry.id, first.id); assert.equal(retry.mode, '1.3');
        assert.equal(Buffer.from(retry.body).toString(), 'synthetic'); assert.equal(failed, 0);
        env.message({ type: 'error', id: retry.id, error: 'TCP read: -2', retryable: true });
        assert.equal(failed, 1, 'A second reset must finish with an error');
    } finally { env.close(); }
});

test('Media and API keep reserved slots, API precedes telemetry, and abort releases its slot', async () => {
    const historyEnv = setup();
    try {
        for (const endpoint of ['qoe', 'qoe', 'playback', 'watchtime']) {
            const xhr = new historyEnv.win.XMLHttpRequest();
            xhr.open('GET', 'https://www.youtube.com/api/stats/' + endpoint); xhr.send();
        }
        assert.deepEqual(historyEnv.sent.map(r => r.path), ['/api/stats/qoe', '/api/stats/playback', '/api/stats/watchtime'],
            'A pending telemetry request must not block history; extra telemetry stays queued');
        assert.equal(historyEnv.transport.summary().active, 3);
        assert.equal(historyEnv.transport.summary().queued, 1);
    } finally { historyEnv.close(); }

    const env = setup();
    try {
        const xhrs = [];
        function start(url) { const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); xhrs.push(xhr); }
        for (let i = 0; i < 5; i++) start('https://www.youtube.com/youtubei/v1/browse?synthetic=' + i);
        assert.equal(env.sent.length, 4);
        start('https://www.youtube.com/api/stats/watchtime');
        start('https://media.googlevideo.com/videoplayback?id=synthetic');
        assert.equal(env.sent.length, 5, 'Media must start despite waiting API and telemetry');
        xhrs[0].abort();
        await new Promise(resolve => setTimeout(resolve, 10));
        const dispatched = env.sent.filter(r => r.type === 'request');
        assert.equal(dispatched[5].path, '/youtubei/v1/browse?synthetic=4');
        env.message({type:'done', id:dispatched[1].id});
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(env.sent.filter(r => r.type === 'request')[6].path, '/api/stats/watchtime', 'History traffic must still run');
    } finally { env.close(); }

    const mediaEnv = setup();
    try {
        function start(url) { const xhr = new mediaEnv.win.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); }
        for (let i = 0; i < 6; i++) start('https://media.googlevideo.com/videoplayback?id=synthetic&part=' + i);
        assert.equal(mediaEnv.sent.length, 4, 'Media must leave two slots available for API/history');
        start('https://www.youtube.com/youtubei/v1/player');
        start('https://www.youtube.com/api/stats/watchtime');
        assert.equal(mediaEnv.sent[4].path, '/youtubei/v1/player');
        assert.equal(mediaEnv.sent[5].path, '/api/stats/watchtime');
        assert.equal(mediaEnv.transport.summary().active, 6);
        mediaEnv.message({ type: 'done', id: mediaEnv.sent[0].id });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(mediaEnv.sent[6].path, '/videoplayback?id=synthetic&part=4', 'Queued media must resume when a media slot is released');
        assert.equal(mediaEnv.transport.summary().active, 6);
        assert.equal(mediaEnv.transport.summary().queued, 1);
    } finally { mediaEnv.close(); }
});

test('Cached JSON response keeps identity and reopening discards the old response', () => {
    const env = setup();
    try {
        const xhr = new env.win.XMLHttpRequest();
        function reply(value) {
            const id = env.sent.filter(r => r.type === 'request').at(-1).id;
            const data = Buffer.from(JSON.stringify(value));
            env.message({type:'headers',id,status:200,headers:'Content-Type: application/json\r\n'});
            env.message({type:'data',id,body:data.buffer.slice(data.byteOffset,data.byteOffset+data.length)});
            env.message({type:'done',id});
        }
        xhr.open('GET','https://www.youtube.com/synthetic'); xhr.responseType = 'json'; xhr.send(); reply({message:'Привет'});
        const first = xhr.response;
        assert.equal(first.message,'Привет'); assert.equal(xhr.response,first);
        xhr.open('GET','https://www.youtube.com/synthetic2'); xhr.send(); reply({message:'second'});
        assert.equal(xhr.response.message,'second'); assert.notEqual(xhr.response,first);
    } finally { env.close(); }
});

test('XHR decodes growing UTF-8 once without prefix copies and reuses a single binary chunk', () => {
    let allocated = 0, now = 1000;
    function TrackedArray(value) { if (typeof value === 'number') allocated += value; return new Uint8Array(value); }
    const env = setup('auto', { Uint8Array: TrackedArray, Date: { now: () => now } });
    try {
        const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', 'https://www.youtube.com/synthetic'); xhr.send();
        const id = env.sent[0].id;
        env.message({ type: 'headers', id, status: 200, headers: '' });
        const decoder = new TextDecoder(); let expected = '';
        for (const chunk of [[239], [187], [191, 65, 208], [150, 240, 159], [152, 128, 255, 226, 66, 226, 130]]) {
            const body = Uint8Array.from(chunk);
            expected += decoder.decode(body, { stream: true }); now += 100;
            env.message({ type: 'data', id, body: body.buffer });
            assert.equal(xhr.responseText, expected, 'Only complete UTF-8 scalars should be visible during loading');
            assert.equal(xhr.responseText, expected);
        }
        env.message({ type: 'done', id }); expected += decoder.decode();
        assert.equal(xhr.responseText, expected, 'Truncated final UTF-8 becomes a replacement character');
        xhr.open('GET', 'https://www.youtube.com/large-text'); xhr.send();
        const next = env.sent.at(-1).id; env.message({ type: 'headers', id: next, status: 200, headers: '' });
        const block = new Uint8Array(256 * 1024).fill(65).buffer;
        for (let i = 0; i < 8; i++) {
            now += 100; env.message({ type: 'data', id: next, body: block });
            assert.equal(xhr.responseText.length, (i + 1) * block.byteLength);
        }
        env.message({ type: 'done', id: next });
        assert.equal(allocated, 0, 'Growing text must not allocate combined byte prefixes, including at DONE');
        xhr.open('GET', 'https://media.googlevideo.com/videoplayback'); xhr.responseType = 'arraybuffer'; xhr.send();
        const binary = env.sent.at(-1).id;
        env.message({ type: 'headers', id: binary, status: 200, headers: '' });
        env.message({ type: 'data', id: binary, body: block });
        assert.equal(xhr.response, null, 'Binary response remains unavailable before DONE');
        env.message({ type: 'done', id: binary });
        assert.equal(xhr.response, block, 'A single complete chunk must not be copied');
    } finally { env.close(); }
});

test('Binary XHR responses belong to the requesting frame, including single-chunk responses', () => {
    const env = setup();
    try {
        const constructors = vm.runInNewContext('({ArrayBuffer, Uint8Array})');
        const frame = Object.assign({}, env.win, constructors);
        env.transport.install(frame);
        constructors.Uint8Array.prototype.set=function(){throw Error('A later compatibility shim must not replace the captured native media copy');};
        for (const pieces of [[new Uint8Array([1, 2]).buffer], [new Uint8Array([1]).buffer, new Uint8Array([2]).buffer]]) {
            const xhr = new frame.XMLHttpRequest();
            xhr.open('GET', 'https://media.googlevideo.com/videoplayback'); xhr.responseType = 'arraybuffer'; xhr.send();
            const id = env.sent.at(-1).id;
            env.message({type:'headers', id, status:200, headers:''});
            pieces.forEach(body => env.message({type:'data', id, body}));
            env.message({type:'done', id});
            assert.ok(xhr.response instanceof constructors.ArrayBuffer);
            assert.deepEqual(Array.from(new constructors.Uint8Array(xhr.response)), [1, 2]);
            assert.equal(xhr.response, xhr.response, 'Repeated reads keep response identity');
        }
    } finally { env.close(); }
});

test('XHR repeats LOADING notifications at bounded frequency and stops old events after reentry', () => {
    let now = 1000;
    const env = setup('auto', { Date: { now: () => now } });
    try {
        const xhr = new env.win.XMLHttpRequest(), events = [];
        xhr.onreadystatechange = () => events.push('state:' + xhr.readyState);
        xhr.onprogress = e => events.push('progress:' + e.loaded);
        xhr.onload = () => events.push('load'); xhr.onloadend = () => events.push('loadend');
        xhr.open('GET', 'https://www.youtube.com/synthetic'); xhr.send();
        const id = env.sent[0].id;
        env.message({ type: 'headers', id, status: 200, headers: 'Content-Length: 33\r\n' });
        for (let i = 0; i < 32; i++) env.message({ type: 'data', id, body: Uint8Array.from([65]).buffer });
        assert.equal(events.filter(e => e.startsWith('progress')).length, 1);
        now += 100; env.message({ type: 'data', id, body: Uint8Array.from([66]).buffer });
        assert.equal(events.filter(e => e === 'state:3').length, 2);
        env.message({ type: 'done', id });
        assert.deepEqual(events.slice(-4), ['progress:33', 'state:4', 'load', 'loadend']);
        assert.equal(xhr.responseText.length, 33);

        // Reopening from LOADING must suppress the old progress and completion.
        xhr.open('GET', 'https://www.youtube.com/old'); xhr.send();
        const old = env.sent.at(-1).id;
        env.message({ type: 'headers', id: old, status: 200, headers: '' });
        xhr.onreadystatechange = () => { if (xhr.readyState === 3) { xhr.open('GET', 'https://www.youtube.com/new'); xhr.send(); } };
        events.length = 0;
        env.message({ type: 'data', id: old, body: Uint8Array.from([67]).buffer });
        env.message({ type: 'done', id: old });
        assert.equal(xhr.readyState, 1); assert.deepEqual(events, ['loadend'], 'Only the aborted request may emit loadend');

        // Reopening from the final progress must also suppress DONE/load/loadend.
        const current = env.sent.at(-1).id;
        events.length = 0;
        xhr.onreadystatechange = null;
        xhr.onprogress = () => { xhr.open('GET', 'https://www.youtube.com/final-new'); xhr.send(); };
        env.message({ type: 'headers', id: current, status: 200, headers: '' });
        env.message({ type: 'done', id: current });
        assert.equal(xhr.readyState, 1); assert.deepEqual(events, ['loadend']);
    } finally { env.close(); }
});

test('Branding stays below history and SponsorBlock and uses one background slot', () => {
    const env = setup();
    try {
        function start(url) { const xhr = new env.win.XMLHttpRequest(); xhr.open('GET', url); xhr.send(); }
        for (let i = 0; i < 10; i++) start('https://sponsor.ajay.app/api/branding?videoID=synthetic-' + i);
        assert.equal(env.sent.length, 1);
        start('https://media.googlevideo.com/videoplayback?id=synthetic');
        start('https://media.googlevideo.com/videoplayback?id=synthetic&mime=audio%2Fmp4');
        start('https://www.youtube.com/api/stats/watchtime');
        start('https://sponsor.ajay.app/api/skipSegments/abcd');
        assert.deepEqual(env.sent.slice(-2).map(r => r.path), ['/api/stats/watchtime', '/api/skipSegments/abcd']);
        assert.equal(env.transport.summary().active, 5); assert.equal(env.transport.summary().queued, 9);
    } finally { env.close(); }
});
