'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');
const Logger = require('../web/logger');
const proxy = require('../proxy');
const { createServer } = require('../service');

test('legacy constructor helper uses native copying for full byte views and retains generic copies', async () => {
    const { legacyByteArrayCopy } = await import('../../mods/rollup.legacy.config.js');
    const file = path.resolve(__dirname, '../../mods/node_modules/core-js/internals/array-from-constructor-and-list.js');
    const plugin = legacyByteArrayCopy();
    const transformed = plugin.transform(fs.readFileSync(file, 'utf8'), file);
    let fast = 0;
    const module = { exports: {} };
    vm.runInNewContext(transformed.code, { module, require: () => value => value.length,
        parent: { __legacyTLS: {}, Object, Uint8Array: { prototype: { set(source) { fast++; return Uint8Array.prototype.set.call(this, source); } } } } });
    const copy = module.exports, source = new Uint8Array([3, 4, 5]);
    const result = copy(Uint8Array, source);
    assert.deepEqual([...result], [3, 4, 5]);
    assert.notEqual(result.buffer, source.buffer);
    source[0] = 9; assert.equal(result[0], 3);
    assert.equal(fast, 1);
    assert.deepEqual([...copy(Uint8Array, source, 2)], [9, 4]);
    assert.deepEqual([...copy(Uint8Array, [1, 2])], [1, 2]);
    assert.deepEqual([...copy(Uint16Array, new Uint16Array([300]))], [300]);
    assert.equal(fast, 1, 'Other element types, arrays and explicit truncation keep core-js behavior');
    assert.equal(plugin.transform('unchanged', '/other.js'), null);
    assert.throws(() => plugin.transform('changed helper', file), /Unsupported core-js/);
});

test('Seek preview uses HTTPS without mutating shared frames and shows signed time from the seek origin', () => {
    const frame = { url: 'file://i.ytimg.com/sb/synthetic/storyboard.jpg', width: 100, height: 50 };
    function Storyboard() { this.props = { seekTime: 90 }; }
    Storyboard.prototype.getStoryboardFrame = function () { const position = this.props.seekTime; return frame; };
    Object.defineProperty(Storyboard.prototype, 'timeLabel', { configurable: true, get() {
        return Math.floor(this.props.seekTime / 60) + ':' + String(this.props.seekTime % 60).padStart(2, '0');
    } });
    const instance = new Storyboard(), video = { currentTime: 80 };
    const thumb = { style: { backgroundImage: 'url("' + frame.url + '")' } }, label = {};
    const element = { __instance: instance, querySelector: selector => selector.includes('storyboard-thumb') ? thumb : label };
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/seekPreview.js'), 'utf8');
    vm.runInNewContext(source, { window: { __legacyDirect: true },
        document: { readyState: 'complete', querySelector: selector => selector === 'video' ? video : element } });
    assert.equal(instance.getStoryboardFrame().url, 'https://i.ytimg.com/sb/synthetic/storyboard.jpg');
    assert.equal(frame.url, 'file://i.ytimg.com/sb/synthetic/storyboard.jpg');
    assert.equal(label.textContent, '1:30 (+0:10)');
    assert.match(thumb.style.backgroundImage, /^url\("https:/);
    instance.props.seekTime = 65;
    assert.equal(instance.timeLabel, '1:05 (\u22120:15)');
    video.currentTime = 90; instance.props.seekTime = 170;
    assert.equal(instance.timeLabel, '2:50 (+1:20)', 'A new seek uses the newly committed playback position');
    frame.url = 'https://i.ytimg.com/sb/synthetic/storyboard.jpg';
    assert.equal(instance.getStoryboardFrame(), frame, 'An HTTPS frame is already valid');
});

test('Player actions preserve constructor identity and native listeners when patched after mount', () => {
    let cdnCount=0;
    const parser = fs.readFileSync(path.resolve(__dirname, '../../mods/utils/ASTParser.js'), 'utf8')
        .replace(/^import[^\n]*\n/gm, '').replace('export function', 'function');
    const extractAssignedFunctions = vm.runInNewContext(parser + '\nextractAssignedFunctions;', {
        esprima: require('../../mods/node_modules/esprima'), estraverse: require('../../mods/node_modules/estraverse')
    });
    function NativeActions(props) {
        this.props = props;
        this.on = (type, listener) => this.listeners.push(listener);
        this.listeners = [];
        this.state={selectedIndex:-1};this.refreshes=0;
        this.keyHandler = function () {};
        this.subscription = function () { const marker='TRANSPORT_CONTROLS_BUTTON_TYPE_SUBSCRIBE'; return this.props.data.promotedActions[0].type; };
        this.promoted = function () { const marker = 'TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION'; return this.props.data.promotedActions; };
        this.openSettings = function () { this.popup = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS'; };
        this.settings = function () {
            const type = 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS';
            return function () { return this.props.data.settingActions; };
        }();
        this.engagement = function () { return this.props.data.engagementActions; };
        this.previous = function () { const data=this.props.data; return false ? data.skipNextButton : data.skipPreviousButton; };
        this.next = function () { const data=this.props.data; return false ? data.skipPreviousButton : data.skipNextButton; };
        this.canIndex = function (index) {
            const length=this.promoted().length;
            return index<length||index>=length+3 ? true : index===length ? !!this.previous() : index===length+1 ? true : !!this.next();
        };
        this.step = function (direction) {
            const buttons=this.buttons,current=this.state.selectedIndex;
            for(let index=current+direction;index>=0&&index<buttons.length;index+=direction)if(this.canIndex(index))return index;
            return current;
        };
        Object.defineProperty(this,'buttons',{get:()=>Array(this.promoted().length+3+this.engagement().length+this.settings().length).fill({})});
    }
    NativeActions.prototype.mount = function () { this.on('keydown', this.keyHandler); };
    NativeActions.prototype.forceRender=function(){this.gD={GF:!0,Tv:this.state};this.refreshes++;};
    const props = () => ({ data: { promotedActions: [{type:'native-promoted'}], settingActions: [{ type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS' }], engagementActions: [],skipPreviousButton:{},skipNextButton:{} } });
    const existing = new NativeActions(props()); existing.mount();
    const popup = existing.openSettings;
    const subscription = existing.subscription;
    const window = { __legacyDirect: true, _yttv: { actions: NativeActions } };
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/customUI.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    vm.runInNewContext(source, {
        window, parent: { __legacyTLS: {summary:()=>({cdnProblems:cdnCount})} }, setInterval() {},
        document: { readyState: 'complete', querySelectorAll: () => [{ __instance: existing }] },
        configRead: key => ['enablePatchingVideoPlayer', 'enableMPButton', 'enableSpeedControlsButton', 'enableSuperThanksButton', 'enableAIAskButton'].includes(key),
        extractAssignedFunctions, ButtonRenderer: (_toggle, _text, icon, command) => ({ icon, command }), t: key => key
    });
    assert.equal(window._yttv.actions, NativeActions, 'Patching must keep the component constructor registered by YouTube');
    assert.equal(existing.openSettings, popup, 'The settings popup action must not be mistaken for the settings button list');
    assert.equal(existing.subscription,subscription,'Subscription lookup also reads promotedActions but must not be patched as the visible button group');
    assert.equal(existing.listeners.length, 1, 'Patching a mounted component must not mount a replacement');
    assert.equal(existing.settings().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP').length, 1);
    assert.equal(existing.settings().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP').length, 1);
    const next = new NativeActions(props()); next.mount();
    assert.equal(next.constructor, NativeActions);
    assert.equal(next.listeners.length, 1);
    assert.equal(next.settings().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP').length, 1);
    assert.equal(next.engagement().filter(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED').length, 1);
    assert.equal(next.engagement().find(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED').button.buttonRenderer.icon, 'SPEEDOMETER');
    for (const instance of [existing, next]) {
        assert.equal(instance.promoted().length,2);
        assert.equal(instance.promoted()[0].type,'native-promoted');
        assert.equal(instance.promoted()[1].button.buttonRenderer.command.customAction.action,'SKIP');
        assert.equal(instance.promoted()[1].button.buttonRenderer.command.customAction.parameters.time,0);
        assert.equal(instance.promoted()[1].button.buttonRenderer.icon,'REPLAY');
        assert.equal(instance.promoted()[1],instance.promoted()[1],'Reuse the shortcut renderer across native reads');
        assert.equal(instance.props.data.promotedActions.length,1,'The shortcut must not mutate or duplicate native actions');
    }
    const loading = new NativeActions({data:{settingActions:[],engagementActions:[]}});loading.mount();
    assert.equal(loading.promoted().length,1,'A missing native action list during loading must not break the player');
    assert.ok(!next.promoted().some(item=>item.type==='TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN'));
    cdnCount=2;next.__ttRefreshCDNButton(true);
    const cdnAction=()=>next.promoted().find(item=>item.type==='TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN');
    assert.equal(cdnAction().button.buttonRenderer.command.customAction.action,'CDN_SHOW');
    assert.equal(cdnAction(),cdnAction(),'Reuse the CDN renderer while the journal is nonempty');
    assert.equal(next.promoted().filter(item=>item.type==='TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN').length,1);
    assert.ok(!next.engagement().some(item=>item.type==='TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN'),'The CDN action must not enlarge the rating group');
    assert.equal(next.refreshes,1);next.__ttRefreshCDNButton(true);assert.equal(next.refreshes,1);
    const actions=next.promoted(),cdnIndex=actions.indexOf(cdnAction()),startIndex=actions.length-1;
    const previousIndex=actions.length,playIndex=previousIndex+1,nextIndex=previousIndex+2,engagementIndex=previousIndex+3;
    const visualOrder=[0,startIndex,previousIndex,playIndex,nextIndex,cdnIndex,engagementIndex];
    for(let index=0;index<visualOrder.length-1;index++) {
        next.state.selectedIndex=visualOrder[index];assert.equal(next.step(1),visualOrder[index+1],'Right must follow the visible shortcut positions');
        next.state.selectedIndex=visualOrder[index+1];assert.equal(next.step(-1),visualOrder[index],'Left must return along the same route');
    }
    next.state.selectedIndex=nextIndex;
    next.state.selectedIndex=next.step(1);
    assert.equal(next.promoted()[next.state.selectedIndex].button.buttonRenderer.command.customAction.action,'CDN_SHOW','The selected shortcut must execute its own command');
    next.props.data.skipPreviousButton=null;next.state.selectedIndex=playIndex;assert.equal(next.step(-1),startIndex,'Hidden Previous must remain skipped');
    next.props.data.skipNextButton=null;next.state.selectedIndex=startIndex;assert.equal(next.step(-1),cdnIndex,'Without a Next anchor retain the original shortcut order');
    cdnCount=0;next.__ttRefreshCDNButton(false);
    assert.equal(next.refreshes,2);
    assert.ok(!next.promoted().some(item=>item.type==='TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN'));
    assert.ok(!next.props.data.engagementActions.some(item=>item.type==='TRANSPORT_CONTROLS_BUTTON_TYPE_TT_CDN'));
    next.state.selectedIndex=0;assert.equal(next.step(1),1,'An empty journal must retain native navigation');
});

test('Player CDN counter respects its independent setting and stays hidden at zero', () => {
    let tick, showCount=true, hidden=false, scans=0, refreshes=0;
    const state={cdnProblems:0,cdnAddedAt:0,video:'TLS 1.3'};
    const controls={classList:{contains:()=>hidden},querySelectorAll:()=>{scans++;return [];},__instance:{__ttRefreshCDNButton(){refreshes++;}}};
    const badge={style:{},textContent:''};
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/ui/customUI.js'),'utf8').replace(/^import[^\n]*\n/gm,'');
    vm.runInNewContext(source,{
        window:{__legacyDirect:true,addEventListener(){},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})},
        parent:{__legacyTLS:{summary:()=>state}},setInterval:fn=>{tick=fn;},
        document:{readyState:'loading',querySelector:selector=>selector==='ytlr-player-actions-container'?controls:selector==='.tt-media-transport'?badge:null},
        configRead:key=>key==='showCDNCount'?showCount:key==='showPlayerProtocol'?true:key==='sponsorBlockStatusDisplay'?'never':false,
        t:(key,args)=>key+(args&&args.count!==undefined?':'+args.count:'')
    });
    tick();assert.doesNotMatch(badge.textContent,/cdnJournal.counter/);
    state.cdnProblems=1;tick();assert.match(badge.textContent,/cdnJournal.counter:1/);
    showCount=false;tick();assert.doesNotMatch(badge.textContent,/cdnJournal.counter/);
    assert.match(badge.textContent,/legacyNetwork.playerVideo/);
    const oldScans=scans,oldRefreshes=refreshes;
    hidden=true;state.cdnProblems=3;tick();tick();
    assert.equal(scans,oldScans,'Hidden controls must not scan or measure shortcut elements');
    assert.equal(refreshes,oldRefreshes,'Hidden controls must not force native renders');
    assert.equal(badge.style.display,'none');
});

test('Player shortcuts align beside Previous and Next without position drift', () => {
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/ui/customUI.js'),'utf8').replace(/^import[^\n]*\n/gm,'');
    const align=vm.runInNewContext(source+'\nalignPlayerShortcuts;',{
        window:{addEventListener(){}},document:{readyState:'loading'},t:key=>key
    });
    const start={tagName:'YTLR-BUTTON-RENDERER',style:{},getBoundingClientRect(){return {left:613+(parseFloat(this.style.left)||0),top:817+(parseFloat(this.style.top)||0),width:72,height:72};}};
    const previous={tagName:'YTLR-BUTTON-RENDERER',getBoundingClientRect:()=>({left:822,top:803,width:72,height:72})};
    const cdn={tagName:'YTLR-BUTTON-RENDERER',style:{},getBoundingClientRect(){return {left:1308+(parseFloat(this.style.left)||0),top:817+(parseFloat(this.style.top)||0),width:72,height:72};}};
    const next={tagName:'YTLR-BUTTON-RENDERER',getBoundingClientRect:()=>({left:1026,top:803,width:72,height:72})};
    let writes=0;
    for(const item of [start,cdn]){
        const values={};
        for(const name of ['position','left','top'])Object.defineProperty(item.style,name,{get:()=>values[name],set:value=>{values[name]=value;writes++;}});
    }
    const controls={querySelectorAll:()=>[
        {getAttribute:()=> 'player.start',parentNode:start},
        {getAttribute:()=> 'player.previous',parentNode:previous},
        {getAttribute:()=> 'cdnJournal.title',parentNode:cdn},
        {getAttribute:()=> 'player.next',parentNode:next}
    ]};
    align(controls);assert.equal(start.style.left,'119px');assert.equal(start.style.top,'-14px');
    assert.equal(cdn.style.left,'-192px');assert.equal(cdn.style.top,'-14px');
    align(controls);assert.equal(start.style.left,'119px');assert.equal(start.style.top,'-14px');
    previous.getBoundingClientRect=()=>({left:822.4,top:803,width:72,height:72});
    for(let n=0;n<5;n++){align(controls);assert.equal(start.style.left,'119px');}
    assert.equal(previous.style,undefined,'The native Previous button must not be moved');
    assert.equal(next.style,undefined,'The native Next button must not be moved');
    assert.equal(writes,6,'Stable positions must not repeatedly invalidate CSS layout');
});

test('Playback settings route both speed icons to the custom menu and preserve unrelated actions', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/resolveCommand.js'), 'utf8')
        .replace(/^import[^\n]*\n/gm, '').replace(/^export default /gm, '').replace(/^export /gm, '');
    let forwarded;
    const window = { _yttv: { app: { instance: { resolveCommand(cmd) { forwarded = cmd; return 'native'; } } } } };
    vm.runInNewContext(source + '\npatchResolveCommand();', { window, t: key => key, buttonItem: () => ({ injected: true }) });
    const items = ['SLOW_MOTION_VIDEO', 'SPEEDOMETER', 'SETTINGS'].map(iconType => ({ compactLinkRenderer: {
        icon: { iconType }, subtitle: { simpleText: 'Original' }, serviceEndpoint: { original: true }
    } }));
    const renderers = items.map(item => item.compactLinkRenderer);
    const cmd = { openPopupAction: { uniqueId: 'playback-settings', popup: { overlaySectionRenderer: { overlay: {
        overlayTwoPanelRenderer: { actionPanel: { overlayPanelRenderer: { content: { overlayPanelItemListRenderer: { items } } } } }
    } } } } };
    assert.equal(window._yttv.app.instance.resolveCommand(cmd), 'native');
    assert.equal(forwarded, cmd);
    for (const renderer of renderers.slice(0, 2)) {
        assert.equal(renderer.serviceEndpoint.signalAction.customAction.action, 'TT_SPEED_SETTINGS_SHOW');
        assert.equal(renderer.subtitle.simpleText, 'player.withTizenTube');
    }
    assert.deepEqual(renderers[2].serviceEndpoint, { original: true });
});

test('Guide JSON hook accepts unrelated values and preserves unknown guide entries', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/customGuideAction.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    const context = vm.createContext({ configRead: key => key === 'sidebarContentsOrder' ? ['known'] : false,
        configWrite() {}, configChangeEmitter: { addEventListener() {} } });
    vm.runInContext(source, context);
    for (const json of ['null','{"items":[]}','{"items":[{}]}','[1,2]']) {
        assert.equal(vm.runInContext('JSON.stringify(JSON.parse(' + JSON.stringify(json) + '))',context),json);
    }
    const input = {items:[{guideSectionRenderer:{items:[
        {guideEntryRenderer:{navigationEndpoint:{browseEndpoint:{browseId:'known'}}}},
        {guideEntryRenderer:{navigationEndpoint:{custom:'synthetic'}}}
    ]}}]};
    const result = vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(input)) + ')',context);
    assert.equal(result.items[0].guideSectionRenderer.items.length,2);
});

test('DeArrow updates video cards, deduplicates and caches branding, and cancels pending navigation work', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/features/adblock.js'), 'utf8');
    const requests = []; let enabled = true, now = 1000, navigation;
    const timers = new Map(); let timerID = 0;
    function pump() {
        const entry = Array.from(timers).find(([, timer]) => timer.delay === 0);
        if (entry) { timers.delete(entry[0]); entry[1].fn(); }
    }
    const deArrowify = vm.runInNewContext(source.slice(source.indexOf('const brandingCache'), source.indexOf('function hqify(')) + '\ndeArrowify;', {
        configRead: () => enabled,
        setTimeout(fn, delay) { timers.set(++timerID, { fn, delay }); return timerID; }, clearTimeout(id) { timers.delete(id); },
        Date: { now: () => now }, window: { addEventListener(type, fn) { navigation = fn; } },
        XMLHttpRequest: function () {
            this.open = (method, url) => { this.url = url; };
            this.send = () => { requests.push(this); };
            this.abort = () => { this.aborted = true; this.onabort(); };
        }
    });
    const tile = { tileRenderer: { style: 'TILE_STYLE_YTLR_DEFAULT', contentId: 'synthetic-tile',
        metadata: { tileMetadataRenderer: { title: { simpleText: 'Original' } } }, header: { tileHeaderRenderer: { thumbnail: { thumbnails: [] } } } } };
    const lockup = { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: 'synthetic-lockup',
        metadata: { lockupMetadataViewModel: { title: { content: 'Original' } } }, contentImage: { thumbnailViewModel: { image: { sources: [] } } } } };
    const items = [{ adSlotRenderer: {} }, { adSlotRenderer: {} }, tile, lockup,
        { tileRenderer: { style: 'TILE_STYLE_YTLR_CHANNEL' } }, { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } }];
    deArrowify(items);
    deArrowify(items);
    pump();
    assert.equal(requests.length, 1, 'Only one branding XHR may run at a time');
    for (let i = 0; i < 2; i++) {
        const xhr = requests[i];
        assert.equal(xhr.timeout, 10000);
        xhr.status = 200; xhr.response = { titles: [{ title: 'Revised title', votes: 2 }], thumbnails: [{ timestamp: 15, votes: 3 }] };
        xhr.onload();
        pump();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(items.length, 4, 'Consecutive ad slots must still be removed');
    assert.equal(tile.tileRenderer.metadata.tileMetadataRenderer.title.simpleText, 'Revised title');
    assert.equal(lockup.lockupViewModel.metadata.lockupMetadataViewModel.title.content, 'Revised title');
    assert.match(tile.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url, /videoID=synthetic-tile&time=15$/);
    assert.match(lockup.lockupViewModel.contentImage.thumbnailViewModel.image.sources[0].url, /videoID=synthetic-lockup&time=15$/);
    deArrowify(items); assert.equal(requests.length, 2, 'Fresh cached branding must not start another request');
    enabled = false; deArrowify(items);
    assert.equal(requests.length, 2, 'Disabled DeArrow must not issue requests');
    enabled = true; now += 300001; deArrowify(items);
    pump();
    assert.equal(requests.length, 3, 'Expired entries must be requested again, serially');
    navigation();
    assert.ok(requests.slice(2).every(xhr => xhr.aborted), 'Navigation must abort all pending branding requests');
    pump(); assert.equal(timers.size, 0, 'Navigation must settle queued promises and deadlines');
    await new Promise(resolve => setImmediate(resolve));
});

test('DeArrow bounds retained work and expires the entire queue before creating more XHRs', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/features/adblock.js'), 'utf8');
    const timers = new Map(), requests = []; let timerID = 0, navigation;
    const api = vm.runInNewContext(source.slice(source.indexOf('const brandingCache'), source.indexOf('function deArrowify(')) +
        '\n({getBranding, count:()=>brandingRequests.size});', {
        window:{addEventListener(type,fn){navigation=fn;}},
        setTimeout(fn,delay){timers.set(++timerID,{fn,delay});return timerID;},clearTimeout(id){timers.delete(id);},
        XMLHttpRequest:function(){this.open=()=>{};this.send=()=>requests.push(this);this.abort=()=>{this.aborted=true;this.onabort();};}
    });
    const promises = Array.from({length:400},(_,i)=>api.getBranding('synthetic-'+i));
    assert.equal(api.count(),32); assert.equal(requests.length,0);
    function run(delay){for(const [id,timer] of Array.from(timers))if(timer.delay===delay&&timers.delete(id))timer.fn();}
    run(0); assert.equal(requests.length,1);assert.equal(requests[0].timeout,10000);
    run(15000);run(0);
    assert.equal(api.count(),0);assert.equal(timers.size,0);assert.equal(requests.length,1);assert.ok(requests[0].aborted);
    assert.ok((await Promise.all(promises)).every(value=>value===null));
    const cancelled=[api.getBranding('next-A'),api.getBranding('next-B')];navigation();run(0);
    assert.ok((await Promise.all(cancelled)).every(value=>value===null));assert.equal(requests.length,1);assert.equal(timers.size,0);
});

test('Long-press queue actions honor the switch and do not embed menus or duplicate actions', () => {
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/features/adblock.js'),'utf8');
    let enabled=false;
    const start=source.indexOf('function queueCard('),end=source.indexOf('\nfunction ',source.indexOf('function addLongPress(')+1);
    const add=vm.runInNewContext(source.slice(start,end<0?undefined:end)+'\naddLongPress;',{
        configRead:()=>enabled,JSON:{parse(){throw Error('Unexpected deep copy');},stringify(){throw Error('Unexpected deep copy');}},
        MenuServiceItemRenderer:(text,serviceEndpoint)=>({menuServiceItemRenderer:{serviceEndpoint}}),restoreFeedbackMenuItems(){}
    });
    const items=[{tileRenderer:{style:'TILE_STYLE_YTLR_DEFAULT',contentId:'tile',metadata:{title:'Title'},onSelectCommand:{watchEndpoint:{videoId:'tile'}},
        onLongPressCommand:{showMenuCommand:{menu:{menuRenderer:{items:[]}}}}}},
        {lockupViewModel:{contentType:'LOCKUP_CONTENT_TYPE_VIDEO',contentId:'lockup',rendererContext:{commandContext:{onTap:{innertubeCommand:{watchEndpoint:{videoId:'lockup'}}},
            onLongPress:{innertubeCommand:{showMenuCommand:{menu:{menuRenderer:{items:[]}}}}}}}}}];
    add(items);
    assert.equal(items[0].tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items.length,0);
    enabled=true;add(items);add(items);
    const tileMenu=items[0].tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items;
    const lockupMenu=items[1].lockupViewModel.rendererContext.commandContext.onLongPress.innertubeCommand.showMenuCommand.menu.menuRenderer.items;
    assert.equal(tileMenu.length,1);assert.equal(lockupMenu.length,1);
    const tile=tileMenu[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.customAction.parameters.tileRenderer;
    const lockup=lockupMenu[0].menuServiceItemRenderer.serviceEndpoint.playlistEditEndpoint.customAction.parameters.lockupViewModel;
    assert.equal(tile.onLongPressCommand,undefined);assert.equal(tile.onSelectCommand.watchEndpoint.videoId,'tile');
    assert.equal(lockup.rendererContext.commandContext.onLongPress,undefined);
    assert.equal(lockup.rendererContext.commandContext.onTap.innertubeCommand.watchEndpoint.videoId,'lockup');
    assert.doesNotThrow(()=>JSON.stringify(items));
});

test('Disabled player patch does not scan, and unchanged constructors are inspected only once', () => {
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/ui/customUI.js'),'utf8').replace(/^import[^\n]*\n/gm,'');
    let enabled=false,scans=0;const pending=[];
    function method(){const fn=function(){};fn.toString=()=>{scans++;return 'function(){}';};return fn;}
    const methods=Object.fromEntries(Array.from({length:100},(_,i)=>[i,method()]));
    const context={window:{_yttv:methods},document:{readyState:'complete'},configRead:()=>enabled,setTimeout(fn){pending.push(fn);}};
    vm.createContext(context);vm.runInContext(source,context);assert.equal(scans,0);assert.equal(pending.length,0);
    enabled=true;vm.runInContext('applyPatches()',context);
    for(let i=0;i<10;i++)pending.shift()();
    assert.equal(scans,100);methods[0]=method();pending.shift()();assert.equal(scans,101);
});

test('Missing storyboard is watched only inside the player during a bounded seek attempt', () => {
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/ui/seekPreview.js'),'utf8');
    let key,observed=0,stopped=0,timeout;const player={};
    vm.runInNewContext(source,{window:{__legacyDirect:true},
        document:{readyState:'complete',querySelector:s=>s==='ytlr-player'?player:null,addEventListener(type,fn){key=fn;},removeEventListener(){}},
        MutationObserver:class{observe(target){assert.equal(target,player);observed++;}disconnect(){stopped++;}},
        setTimeout(fn,ms){assert.equal(ms,5000);timeout=fn;return 1;},clearTimeout(){}
    });
    assert.equal(observed,0);key({keyCode:40});assert.equal(observed,0);
    key({keyCode:39});key({keyCode:39});assert.equal(observed,1);timeout();assert.equal(stopped,1);
    key({keyCode:37});assert.equal(observed,2);
});

test('Playback JSON uses one serialization and preserves replacer, spacing, getters and toJSON', () => {
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/features/adblock.js'),'utf8');
    let calls=0,parsed=0,toJSON=0;
    const JSONShim={stringify(...args){calls++;return JSON.stringify(...args);},parse(...args){parsed++;return JSON.parse(...args);}};
    vm.runInNewContext(source.slice(source.indexOf('const origStringify ='),source.indexOf('window.JSON.stringify')),{JSON:JSONShim});
    const ready={playbackContext:{contentPlaybackContext:{isInlinePlaybackNoAd:true}}};
    assert.equal(JSONShim.stringify(ready),JSON.stringify(ready));assert.equal(calls,1);assert.equal(parsed,0);
    const request={playbackContext:{contentPlaybackContext:{isInlinePlaybackNoAd:false}},extra:{toJSON(){toJSON++;return 'custom';}},omit:'hidden'};
    calls=0;const text=JSONShim.stringify(request,(key,value)=>key==='omit'?undefined:value,2);
    assert.equal(calls,1);assert.equal(parsed,0);assert.equal(toJSON,1);assert.ok(text.includes('\n  '));
    assert.equal(JSON.parse(text).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,true);assert.equal(JSON.parse(text).omit,undefined);
    assert.equal(request.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,false);
    assert.equal(JSON.parse(JSONShim.stringify(request,['playbackContext','contentPlaybackContext','isInlinePlaybackNoAd'])).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,true);
    let getters=0;const accessor={get playbackContext(){getters++;return {contentPlaybackContext:{isInlinePlaybackNoAd:false}};}};
    JSONShim.stringify(accessor);assert.equal(getters,1);
    const custom={playbackContext:{contentPlaybackContext:{}},toJSON(){return {custom:true};}};
    assert.equal(JSONShim.stringify(custom),'{"custom":true}');
    const special=JSON.parse('{"playbackContext":{"contentPlaybackContext":{}},"__proto__":{"marker":true}}');
    assert.equal(JSONShim.stringify(special),JSON.stringify(special),'Preserve special own JSON keys without assigning them through prototype setters');
});

test('Setting batches apply custom entries once and delegate only native settings', () => {
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/resolveCommand.js'),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export default /gm,'').replace(/^export /gm,'');
    const values={first:[],second:[]},writes=[],forwarded=[];
    const window={_yttv:{app:{instance:{resolveCommand(cmd){forwarded.push(cmd);return 'native-result';}}}}};
    vm.runInNewContext(source+'\npatchResolveCommand();',{window,configRead:key=>values[key],configWrite(key,value){writes.push(key);values[key]=value;}});
    const native={clientSettingEnum:{item:'NATIVE_SETTING'},boolValue:true};
    const cmd={setClientSettingEndpoint:{settingDatas:[{clientSettingEnum:{item:'first'},arrayValue:'a'},{clientSettingEnum:{item:'second'},arrayValue:'b'},native]}};
    assert.equal(window._yttv.app.instance.resolveCommand(cmd),'native-result');
    assert.deepEqual(writes,['first','second']);assert.equal(values.first[0],'a');assert.equal(values.second[0],'b');
    assert.equal(forwarded.length,1);assert.equal(forwarded[0].setClientSettingEndpoint.settingDatas.length,1);assert.equal(forwarded[0].setClientSettingEndpoint.settingDatas[0],native);
    assert.equal(cmd.setClientSettingEndpoint.settingDatas.length,3,'Do not mutate the caller command');
});

test('Legacy byte-array set uses native copies while preserving generic compatibility', () => {
    const frame=vm.runInNewContext('({Uint8Array,Int8Array,Object})');
    const native=Uint8Array.prototype.set;
    let fast=0,compatible=0;
    Object.defineProperty(frame.Uint8Array.prototype,'set',{value:function(source,offset){compatible++;return native.call(this,source,offset);},configurable:false,writable:true,enumerable:true});
    const source=fs.readFileSync(path.resolve(__dirname,'../../mods/legacyDirectBootstrap.js'),'utf8')
        .replace(/^import[^\n]*\n/gm,'').split('// Keep YouTube')[0];
    let ready;
    vm.runInNewContext(source,{window:{addEventListener(type,fn){ready=fn;}},document:{readyState:'loading'},parent:{__legacyTLS:{},Object,Uint8Array:{prototype:{set:function(source,offset){fast++;return native.call(this,source,offset);}}}},
        Uint8Array:frame.Uint8Array,Object:frame.Object});
    const target=new frame.Uint8Array(5);
    target.set(new Uint8Array([1,2,3]),1);
    assert.deepEqual(Array.from(target),[0,1,2,3,0]);assert.equal(fast,1);assert.equal(compatible,0);
    target.set([7,8],0);assert.equal(compatible,1);
    target.set(new frame.Int8Array([9]),0);assert.equal(compatible,2);
    target.set(new Uint8Array([4]),'0');assert.equal(compatible,3);
    target.set(target.subarray(0,3),1);
    assert.deepEqual(Array.from(target),[4,4,8,2,0]);assert.equal(fast,2);
    assert.throws(()=>target.set(new Uint8Array(6)),{name:'RangeError'});
    assert.equal(Uint8Array.prototype.set,native,'The widget byte-array prototype stays unchanged');
    assert.equal(Object.getOwnPropertyDescriptor(frame.Uint8Array.prototype,'set').enumerable,true);
    assert.equal(Object.getOwnPropertyDescriptor(frame.Uint8Array.prototype,'set').configurable,false);
    const installed=frame.Uint8Array.prototype.set;ready();assert.equal(frame.Uint8Array.prototype.set,installed);
    frame.Uint8Array.prototype.set=function(source,offset){compatible++;return native.call(this,source,offset);};
    ready();const beforeFast=fast;target.set(new Uint8Array([3]),0);assert.equal(fast,beforeFast+1,'Reapply after deferred page scripts replace the method');
});

test('early module initialization handles fresh and malformed YouTube profiles', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/disableWhosWatching.js'), 'utf8').replace(/^import[^\n]*\n/, '');
    const context = { localStorage: {}, configRead: () => false, configChangeEmitter: { addEventListener() {} } };
    vm.runInNewContext(source, context);
    const key = 'yt.leanback.default::recurring_actions';
    context.localStorage[key] = JSON.stringify({ data: { data: { whos_watching_fullscreen_zero_accounts: { lastFired: 0 } } } });
    vm.runInNewContext(source, { ...context });
    assert.ok(JSON.parse(context.localStorage[key]).data.data.whos_watching_fullscreen_zero_accounts.lastFired > Date.now());
    for (const stored of ['{', 'null', '{}', '{"data":{}}', '{"data":{"data":{}}}']) {
        for (const enabled of [false, true]) {
            vm.runInNewContext(source, { ...context, localStorage: { [key]: stored }, configRead: () => enabled,
                setInterval() {}, clearInterval() {} });
        }
    }
});

test('memory log stays bounded and removes sensitive diagnostic values', () => {
    const log = Logger.create(3);
    log.record('error', 'Failed https://example.com/?token=synthetic-secret user@example.com');
    log.record('error', 'C:\\Users\\Synthetic\\test.js 10.0.0.8');
    log.record('error', 'Authorization: Bearer synthetic-secret');
    const result = JSON.stringify(log.read());
    assert.doesNotMatch(result, /synthetic-secret|user@example|Synthetic|10\.0\.0\.8/);
    assert.doesNotThrow(() => Logger.create(3, () => { throw new Error('diagnostic callback'); }).record('ready', 'ok'));
    log.record('ready', 'ok');
    assert.equal(log.read().length, 3);
    assert.equal(log.read()[0].n, 2);
});

test('local playback pings use current-account authorization only on YouTube HTTPS', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/legacyDirectBootstrap.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    function XHR() { this.headers = {}; this.listeners = {}; this.listenerCounts = {}; }
    XHR.prototype.open = function (method, url) { this.url = url; this.readyState = 1; };
    XHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
    XHR.prototype.send = function () { this.sent = true; };
    const log = Logger.create(20);
    const messages = [];
    const window = { __legacyLog: log, postMessage(...args) { messages.push(args); } };
    let parsed = 0;
    class ParsedURL extends URL { constructor(...args) { super(...args); parsed++; } }
    const document = { readyState: 'complete', createElement: () => new URL('https://example.test/') };
    Object.assign(window, { __legacyTLS: {}, document, Object, Uint8Array });
    vm.runInNewContext(source, { window, parent: window, document, XMLHttpRequest: XHR, URL: ParsedURL, Promise });
    window.postMessage('test', null);
    window.postMessage('test', { targetOrigin: '*', transfer: ['synthetic'] });
    assert.equal(messages[0][1], null);
    assert.equal(messages[1][1], '*');
    assert.equal(messages[1][2][0], 'synthetic');
    const application = window.yt.player.Application;
    application.create = function () { return 'created'; };
    let account = { token: 'synthetic-current-account' };
    assert.equal(application.create(null, null, null, () => account), 'created');
    XHR.prototype.addEventListener = function (name, listener) { this.listeners[name] = listener; this.listenerCounts[name] = (this.listenerCounts[name] || 0) + 1; };
    function request(url) {
        const xhr = new XHR(); xhr.open('GET', url); xhr.send(); return xhr;
    }
    const playback = request('///api/stats/watchtime?synthetic=1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(playback.url, 'https://www.youtube.com/api/stats/watchtime?synthetic=1');
    assert.equal(playback.headers.Authorization, 'Bearer synthetic-current-account');
    assert.equal(playback.sent, true);
    assert.equal(parsed, 1, 'Relative malformed API URLs retain the base-URL parser');
    playback.status = 204; playback.listeners.load();
    assert.ok(log.read().some(entry => entry.code === 'history.result' && entry.detail.includes('authorized=true')));
    assert.doesNotMatch(JSON.stringify(log.read()), /synthetic-current-account/);

    for (const url of ['https://www.youtube.com.example.com/api/stats/watchtime', 'http://www.youtube.com/api/stats/watchtime', 'https://www.youtube.com/api/stats/qoe']) {
        const other = request(url);
        assert.equal(other.sent, true);
        assert.equal(other.headers.Authorization, undefined);
    }
    const media = 'https://rr1---sn-example.googlevideo.com/videoplayback?escaped=a%2Fb&same=1&same=2';
    assert.equal(request(media).url, media, 'Native parsing preserves the media query');
    assert.equal(parsed, 1, 'Full HTTP(S) addresses bypass the slow URL polyfill');
    const existing = new XHR(); existing.open('GET', 'https://www.youtube.com/api/stats/playback');
    existing.setRequestHeader('Authorization', 'Bearer synthetic-original'); existing.send();
    assert.equal(existing.headers.Authorization, 'Bearer synthetic-original');
    assert.equal(existing.sent, true);

    account = { signedOut: true };
    const signedOut = request('https://www.youtube.com/api/stats/watchtime');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signedOut.sent, true);
    assert.equal(signedOut.headers.Authorization, undefined);

    let resolveToken;
    account = { pendingResult: new Promise(resolve => { resolveToken = resolve; }) };
    const aborted = request('https://www.youtube.com/api/stats/watchtime');
    aborted.readyState = 0;
    resolveToken({ token: 'synthetic-later' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted.sent, undefined);
    assert.equal(aborted.headers.Authorization, undefined);
    for (const result of [() => undefined, () => null, () => ({ pendingResult: Promise.resolve(undefined) }), () => ({ pendingResult: Promise.reject(new Error('unavailable')) })]) {
        account = result();
        const empty = request('https://www.youtube.com/api/stats/watchtime');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(empty.sent, true);
        assert.equal(empty.headers.Authorization, undefined);
    }
    account = { pendingResult: Promise.resolve({ token: 'synthetic-later' }) };
    const reopened = request('https://www.youtube.com/api/stats/watchtime');
    reopened.open('GET', 'https://example.com/other');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reopened.sent, undefined);
    assert.equal(reopened.headers.Authorization, undefined);
    assert.equal(reopened.listenerCounts.load, 1);
    assert.equal(reopened.listenerCounts.error, 1);
});

test('widget starts with mods and keeps baseline playback in diagnostics', () => {
    const requests = [];
    const elements = {};
    let panelWrites = 0;
    let navigation;
    const bootTimers = new Map();
    for (const id of ['player', 'setup', 'connect', 'baseline', 'options', 'status', 'feedback', 'feedback-text', 'busy-spinner']) {
        elements[id] = { style: {}, focus() {}, removeAttribute(name) { delete this[name]; } };
    }
    elements.log = { style: {}, set textContent(value) { panelWrites++; } };
    let frameHtml;
    elements.player.contentWindow = { document: { open() {}, write(html) { frameHtml = html; }, close() {} } };
    function XHR() { requests.push(this); }
    XHR.prototype.open = function (method, url) { this.url = url; };
    XHR.prototype.send = function () {};
    XHR.prototype.abort = function () { this.aborted = true; };
    const context = {
        window: {}, location: { href: 'file:///index.html' }, XMLHttpRequest: XHR, LegacyLogger: Logger,
        LegacyTLS: { create: () => ({ install() {} }) },
        document: { getElementById: id => elements[id], addEventListener() {} },
        setTimeout: (callback, delay) => { if (delay === 0) navigation = callback; if (delay === 35000) bootTimers.set(1, callback); return 1; },
        clearTimeout(id) { bootTimers.delete(id); }
    };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../widget/widget.js'), 'utf8'), context);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://www.youtube.com/tv');
    assert.equal(elements.options.style.display, 'none');
    requests[0].status = 200;
    requests[0].responseText = '<html><head></head><body></body></html>';
    requests[0].onload();
    assert.equal(elements.player.src, 'file:///player.html');
    elements.player.onload();
    assert.equal(elements.player.onload, null);
    context.window.__legacyLog.record('page.start', 'Frame only');
    assert.equal(bootTimers.size, 1, 'Frame startup must not disable the YouTube watchdog');
    context.window.__legacyReady({});
    assert.equal(bootTimers.size, 1, 'An unrelated frame must not disable the watchdog');
    context.window.__legacyReady(elements.player.contentWindow);
    assert.equal(bootTimers.size, 0);
    assert.match(frameHtml, /userScript\.js/);
    assert.match(frameHtml, /lazy-debug-watermark/);
    assert.equal(elements.setup.style.display, 'none');
    assert.equal(panelWrites, 0);
    assert.equal(elements.feedback.style.display, 'block');
    context.window.__legacyStatus('', elements.player.contentWindow);
    assert.equal(elements.feedback.style.display, 'none');
    context.window.__legacyCommand(406);
    assert.equal(elements.options.style.display, 'block');
    elements.baseline.onclick();
    requests[1].status = 200;
    requests[1].responseText = requests[0].responseText;
    requests[1].onload();
    elements.player.onload();
    assert.doesNotMatch(frameHtml, /userScript\.js/);
    bootTimers.get(1)();
    assert.equal(elements.setup.style.display, 'block');
    assert.match(elements.status.textContent, /did not start/);
    context.window.__legacyCommand(406);
    elements.connect.onclick();
    requests[2].onerror();
    assert.equal(elements.options.style.display, 'block');
    assert.equal(elements.setup.style.display, 'block');
    elements.connect.onclick();
    requests[3].status = 200; requests[3].responseText = requests[0].responseText;
    requests[3].onload(); elements.player.onload();
    context.window.__legacyFrameNavigation({});
    assert.equal(navigation, undefined);
    context.window.__legacyFrameNavigation(elements.player.contentWindow);
    assert.equal(elements.setup.style.display, 'block');
    navigation();
    assert.equal(requests.length, 5);
    assert.ok(context.window.__legacyLog.read().some(entry => entry.code === 'page.navigation'));
    navigation = undefined;
    context.window.__legacyFrameNavigation(elements.player.contentWindow);
    assert.equal(navigation, undefined);
});

test('SponsorBlock initializes in a local document and treats missing segments as normal', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/features/sponsorblock.js'), 'utf8').replace(/^import[^\n]*\n/gm, '');
    const listeners = {};
    const video = { duration: 10, currentTime: 0, paused: false, readyState: 4, playbackRate: 1, addEventListener() {}, removeEventListener() {} };
    const timers = [];
    const seeks = [];
    const player = { seekTo: (target, allowSeekAhead) => seeks.push([target, allowSeekAhead]) };
    const intervals = [];
    let mutations;
    function element() {
        return {
            style: { values: {}, setProperty(key, value) { this.values[key] = value; } },
            classList: { add() {}, contains: () => true }, children: [],
            appendChild(child) { this.children.push(child); }, remove() {},
            getBoundingClientRect: () => ({ height: 9, top: 0, bottom: 9 }),
            getAttribute: () => 'false'
        };
    }
    const slider = element();
    const container = element();
    const log = Logger.create(20);
    const requests = [];
    const location = { href: 'file:///player.html#/watch?v=abcdefghijk', hash: '#/watch?v=abcdefghijk' };
    const context = {
        window: { __legacyDirect: true, __legacyLog: log, addEventListener: (type, fn) => { listeners[type] = fn; } },
        document: {
            baseURI: 'https://www.youtube.com/tv', createElement: element,
            body: element(), addEventListener() {}, removeEventListener() {},
            querySelector: selector => ({ video, '.html5-video-player': player, 'div[idomkey="slider"]': slider, 'ytlr-progress-bar': slider, 'ytlr-redux-connect-ytlr-progress-bar': container })[selector] || null
        },
        location, URL, t: key => key, sha256: () => '1234', showToast() {}, configChangeEmitter:{addEventListener(){}},
        configRead: key => key === 'sponsorBlockManualSkips' ? [] : true,
        console: { info() {}, warn() {} }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
        setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
        MutationObserver: function (fn) { mutations = fn; this.observe = () => {}; this.disconnect = () => {}; },
        XMLHttpRequest: function () {
            this.open = (method, url) => { requests.push(url); };
            this.send = () => {
                this.status = requests.length === 2 ? 404 : 200;
                this.responseText = this.status === 404 ? '' : JSON.stringify([{ videoID: 'abcdefghijk', segments: [{ category: 'sponsor', segment: [1, 3], UUID: 'synthetic' }] }]);
                this.onload();
            };
        }
    };
    vm.runInNewContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(context.window.sponsorblock.segments.length, 1);
    assert.equal(context.window.sponsorblock.video, video);
    intervals[0]();
    const overlay = context.window.sponsorblock.segmentsoverlay;
    mutations([{ removedNodes: [] }]);
    assert.notEqual(overlay.style.values.display, 'none');
    assert.ok(container.children.includes(overlay));
    context.window.sponsorblock.scheduleSkip();
    video.currentTime = 1;
    timers.pop()();
    assert.deepEqual(seeks, [[3, true]]);
    assert.equal(video.currentTime, 1);
    listeners.hashchange();
    assert.equal(requests.length, 1);
    location.hash = '#/watch?v=lmnopqrstuv';
    listeners.hashchange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.ok(log.read().some(entry => entry.code === 'sponsor.empty'));
    assert.ok(!log.read().some(entry => entry.code === 'sponsor.error'));
});

test('proxy rewrites plain and escaped URLs and rejects other destinations', () => {
    const origin = 'http://localhost:8124';
    assert.equal(proxy.rewrite('https://www.youtube.com/tv', origin), origin + '/tv');
    assert.equal(proxy.rewrite('"//i.ytimg.com/image.jpg"', origin), '"' + origin + '/__proxy/https/i.ytimg.com/image.jpg"');
    const input = JSON.stringify({ url: 'https://r1.googlevideo.com/videoplayback?x=1' }).replace(/\//g, '\\/');
    assert.equal(JSON.parse(proxy.rewrite(input, origin)).url, origin + '/__proxy/https/r1.googlevideo.com/videoplayback?x=1');
    assert.equal(proxy.targetFor('/__proxy/https/i.ytimg.com/a?x=1').hostname, 'i.ytimg.com');
    assert.throws(() => proxy.targetFor('/__proxy/http/127.0.0.1/private'));
    assert.throws(() => proxy.targetFor('/__proxy/https/youtube.com.example.com/private'));
    assert.throws(() => proxy.targetFor('/__proxy/https/user:secret@youtube.com/private'));
    const html = '<html><head><script>boot()</script></head><body>content</body></html>';
    const modified = proxy.html(html, origin, true);
    assert.ok(modified.indexOf('frame.js') < modified.indexOf('boot()'));
    assert.match(modified, /<body><script src="\/__legacy\/userScript.js"/);
    assert.doesNotMatch(proxy.html(html, origin, false), /userScript\.js/);
});

test('historical service serves diagnostics and redacts incoming logs without disk writes', async t => {
    const server = createServer(path.resolve(__dirname, '../web'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    function request(route, body) {
        return new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: body ? 'POST' : 'GET' }, res => {
                let text = ''; res.setEncoding('utf8'); res.on('data', data => { text += data; });
                res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
            });
            req.on('error', reject); req.end(body);
        });
    }
    const health = await request('/__legacy/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.text).version, '0.1.0');
    const script = await request('/__legacy/logger.js');
    assert.equal(script.status, 200); assert.ok(script.text.length > 1000);
    await request('/__legacy/log', JSON.stringify({ code: 'page.error', detail: 'token=synthetic-secret' }));
    const logs = await request('/__legacy/logs');
    assert.equal(logs.headers['cache-control'], 'no-store');
    assert.match(logs.text, /page.error/); assert.doesNotMatch(logs.text, /synthetic-secret/);
    assert.equal((await request('/__proxy/http/127.0.0.1/private')).status, 403);
});


test('frame reserves diagnostic keys on every event and leaves green for settings', () => {
    const listeners = {}, commands = [];
    const document = { addEventListener(type, fn) { listeners[type] = fn; } };
    const window = { addEventListener() {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../web/frame.js'), 'utf8'), {
        window, document, parent: { __legacyLog: Logger.create(20), __legacyCommand: key => commands.push(key) }, LegacyLogger: Logger
    });
    for (const type of ['keydown', 'keypress', 'keyup']) {
        let blocked = false, prevented = false;
        listeners[type]({ type, keyCode: 49, preventDefault() { prevented = true; }, stopImmediatePropagation() { blocked = true; } });
        assert.equal(blocked, true); assert.equal(prevented, true);
        listeners[type]({ type, keyCode: 404, preventDefault() { assert.fail('green was reserved'); }, stopImmediatePropagation() { assert.fail('green was blocked'); } });
    }
    assert.deepEqual(commands, [49]);
});

test('loading feedback follows media events and visible spinners', () => {
    const events = {}, mediaEvents = {}, statuses = [], ticks = [];
    const spinner = { nodeType: 1, parentNode: null, getBoundingClientRect: () => ({ width: 50, height: 50 }) };
    let spinnerVisible = false;
    let removed = 0, now = 1000;
    const video = { currentTime: 0, readyState: 2, buffered: { length: 0 }, addEventListener: (type, fn) => {
        if (!mediaEvents[type]) mediaEvents[type] = [];
        mediaEvents[type].push(fn);
    }, removeEventListener(type, fn) { removed++; mediaEvents[type] = mediaEvents[type].filter(f => f !== fn); } };
    let currentVideo = video;
    const log = Logger.create(20);
    function fire(type) { mediaEvents[type].forEach(fn => fn()); }
    let readyCalls = 0;
    const window = { addEventListener: (type, fn) => { events[type] = fn; }, getComputedStyle: () => ({ display: spinnerVisible ? 'block' : 'none', visibility: 'visible', opacity: '1' }) };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../web/frame.js'), 'utf8'), {
        window, parent: { __legacyLog: log, __legacyStatus: text => statuses.push(text), __legacyReady: () => readyCalls++ }, LegacyLogger: Logger,
        Date: { now: () => now },
        document: { addEventListener() {}, querySelector: () => currentVideo, querySelectorAll: () => [spinner] },
        MutationObserver: function () { this.disconnect = () => {}; },
        setInterval: fn => ticks.push(fn), setTimeout() {}
    });
    events.DOMContentLoaded();
    assert.equal(readyCalls, 0); assert.equal(statuses.length, 0);
    window._yttv = {};
    ticks[0](); assert.equal(readyCalls, 0);
    window._yttv.app = { instance: { resolveCommand() {} } };
    ticks[0](); assert.equal(readyCalls, 1);
    assert.equal(statuses.at(-1), '');
    fire('loadstart');
    assert.equal(statuses.at(-1), 'Loading video…');
    fire('waiting');
    assert.equal(statuses.at(-1), 'Buffering…');
    fire('seeking');
    assert.equal(statuses.at(-1), 'Seeking…');
    fire('seeked');
    assert.equal(statuses.at(-1), '');
    spinnerVisible = true; ticks[0]();
    assert.equal(statuses.at(-1), 'Loading…');
    spinnerVisible = false; ticks[0]();
    assert.equal(statuses.at(-1), '');
    currentVideo = { ...video, currentTime: 12, paused: false, readyState: 4 };
    ticks[0]();
    assert.ok(removed >= 10, 'Replacing video must detach listeners from the previous element');
    fire('stalled'); ticks[0]();
    assert.equal(statuses.at(-1), '', 'Network stalls with buffered playback must not show Buffering');
    currentVideo.readyState = 2;
    fire('waiting');
    assert.equal(statuses.at(-1), 'Buffering…');
    assert.ok(log.read().some(entry => entry.code === 'video.waiting' && /time=12\.0/.test(entry.detail)));
    now += 1500; ticks[0]();
    assert.ok(log.read().some(entry => entry.code === 'video.loop-delay' && /lateMs=1000/.test(entry.detail)));
    currentVideo.readyState = 4; currentVideo.currentTime++;
    ticks[0](); assert.equal(statuses.at(-1), '', 'Recovered playback clears stale buffering feedback');
    assert.equal(readyCalls, 1);
});

test('Stall diagnostics distinguish track buffers, bound followups and detach on video replacement', () => {
    const events = {}, ticks = [], log = Logger.create(100);
    let diagnosticsEnabled = true;
    let now = 1000, ranges = { lab: '0.000-30.000', lvb: '0.000-9.000,12.000-20.000', private: 'not for logging' };
    function media() {
        const listeners = {};
        return { currentTime: 10, playbackRate: 1, readyState: 2, networkState: 2, buffered: { length: 0 },
            paused: false, seeking: false, error: { code: 3 },
            getVideoPlaybackQuality: () => ({ totalVideoFrames: 120, droppedVideoFrames: 2 }),
            addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
            removeEventListener(type, fn) { listeners[type] = listeners[type].filter(f => f !== fn); },
            fire(type) { (listeners[type] || []).slice().forEach(fn => fn()); }
        };
    }
    let video = media();
    const window = { addEventListener: (type, fn) => { events[type] = fn; } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../web/frame.js'), 'utf8'), {
        window, parent: { __legacyLog: log, __legacyStatus() {}, __legacyTLS: { diagnosticsEnabled: () => diagnosticsEnabled, summary: () => ({ active: 2, queued: 1, errors: 4, completed: 7, bytes: 1024 }) } },
        LegacyLogger: Logger, Date: { now: () => now },
        document: { addEventListener() {}, querySelector: selector => selector === 'video' ? video : { getVideoStats: () => ranges }, querySelectorAll: () => [] },
        setInterval: fn => ticks.push(fn), setTimeout() {}
    });
    events.DOMContentLoaded();
    video.fire('waiting'); video.fire('stalled');
    const tracks = () => log.read().filter(e => e.code === 'video.stall-tracks');
    assert.equal(tracks().length, 1, 'Adjacent media events share one track snapshot');
    assert.match(tracks()[0].detail, /audioAhead=20\.0; videoAhead=0\.0/);
    assert.match(tracks()[0].detail, /mediaError=3; trackErrors=unknown; decoded=120; dropped=2/);
    assert.match(log.read().find(e => e.code === 'video.stall-network').detail, /transportErrors=4/);
    ranges = { lab: 'unavailable', lvb: '0.0-25.0' };
    video.fire('playing');
    for (let i = 0; i < 7; i++) { now += 1000; ticks[0](); }
    assert.equal(tracks().length, 6, 'Exactly five followups, including after playback resumes');
    assert.match(tracks().at(-1).detail, /audioAhead=unknown; videoAhead=15\.0/);
    const old = video;
    video.fire('waiting'); video = media(); ticks[0]();
    const count = tracks().length;
    old.fire('stalled'); now += 1000; ticks[0]();
    assert.equal(tracks().length, count, 'Replacing video cancels old followups and event listeners');
    ranges = null; video.fire('stalled');
    assert.match(tracks().at(-1).detail, /audioAhead=unknown; videoAhead=unknown/);
    assert.doesNotMatch(JSON.stringify(log.read()), /not for logging/);
    diagnosticsEnabled = false;
    const before = log.read().length;
    video.fire('waiting'); video.fire('seeking'); now += 1000; ticks[0](); ticks[1]();
    assert.equal(log.read().length, before, 'Disabled diagnostics must skip track snapshots, media samples and timer reports');
    video.fire('error');
    assert.equal(log.read().at(-1).code, 'video.error', 'Basic media errors remain available');
});

test('spatial key handler uses frame mode when parent has no navigation API', () => {
    const acorn = require('acorn');
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/spatial-navigation-polyfill.js'), 'utf8');
    let callback;
    function visit(node) {
        if (!node || !node.type) return;
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'addEventListener' && node.arguments[0].value === 'keydown') callback = node.arguments[1];
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && value.type) visit(value);
        }
    }
    visit(acorn.parse(source, { ecmaVersion: 'latest' }));
    let direction;
    const handler = vm.runInNewContext('(' + source.slice(callback.start, callback.end) + ')', {
        parent: {}, window: { __spatialNavigation__: { keyMode: 'ARROW' } }, document: { activeElement: { nodeName: 'DIV' } },
        ARROW_KEY_CODE: { 39: 'right' }, TAB_KEY_CODE: 9, Map, navigate: dir => { direction = dir; }
    });
    handler({ keyCode: 13 });
    handler({ keyCode: 39, preventDefault() {} });
    assert.equal(direction, 'right');
});


test('numeric seeking uses the legacy player once per key press', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../mods/ui/ui.js'), 'utf8');
    const start = source.indexOf('var eventHandler = ') + 'var eventHandler = '.length;
    const callback = require('acorn').parseExpressionAt(source, start, { ecmaVersion: 'latest' });
    const seeks = [], video = { duration: 100, currentTime: 50 };
    const window = { __legacyDirect: true };
    const handler = vm.runInNewContext('(' + source.slice(callback.start, callback.end) + ')', {
        window, keys: { 51: 3 }, configRead: () => false, console: { info() {} },
        document: { getElementById() {}, querySelector: selector => selector === 'video' ? video : { seekTo: time => seeks.push(time) } }
    });
    for (const type of ['keydown', 'keypress', 'keyup']) handler({ type, keyCode: 51 });
    assert.deepEqual(seeks, [30]);
    assert.equal(video.currentTime, 50);
    window.__legacyDirect = false;
    handler({ type: 'keydown', keyCode: 51 });
    assert.equal(video.currentTime, 30);
});
