import sha256 from '../tiny-sha256.js';
import { configRead, configChangeEmitter } from '../config.js';
import { showToast } from '../ui/ytUI.js';
import { t } from 'i18next';

// Copied from https://github.com/ajayyy/SponsorBlock/blob/da1a535de784540ee10166a75a3eb8537073838c/src/config.ts#L113-L134
const barTypes = {
  sponsor: {
    color: '#00d400',
    opacity: '0.7',
    name: t('sponsorblock.segments.sponsor') || 'sponsored segment'
  },
  intro: {
    color: '#00ffff',
    opacity: '0.7',
    name: t('sponsorblock.segments.intro') || 'intro'
  },
  outro: {
    color: '#0202ed',
    opacity: '0.7',
    name: t('sponsorblock.segments.outro') || 'outro'
  },
  interaction: {
    color: '#cc00ff',
    opacity: '0.7',
    name: t('sponsorblock.segments.interaction') || 'interaction reminder'
  },
  selfpromo: {
    color: '#ffff00',
    opacity: '0.7',
    name: t('sponsorblock.segments.selfpromo') || 'self-promotion'
  },
  preview: {
    color: '#008fd6',
    opacity: '0.7',
    name: t('sponsorblock.segments.preview') || 'recap or preview'
  },
  filler: {
    color: "#7300FF",
    opacity: "0.9",
    name: t('sponsorblock.segments.filler') || 'tangents'
  },
  music_offtopic: {
    color: '#ff9900',
    opacity: '0.7',
    name: t('sponsorblock.segments.music_offtopic') || 'non-music part'
  },
  poi_highlight: {
    color: '#9b044c',
    opacity: '0.7',
    name: t('sponsorblock.segments.poi_highlight') || 'highlight'
  }
};

const sponsorblockAPI = 'https://sponsor.ajay.app/api';

class SponsorBlockHandler {
  video = null;
  active = true;
  availability = 'checking';
  segmentRequest = null;

  attachVideoTimeout = null;
  nextSkipTimeout = null;
  nextSkipSegment = null;
  nextSkipRate = 0;
  nextSkipAt = 0;
  sliderInterval = null;
  buildOverlayTimeout = null;
  positionOverlayHandler = null;

  observer = null;
  scheduleSkipHandler = null;
  videoReplacementHandler = null;
  durationChangeHandler = null;
  segments = null;
  skippableCategories = [];
  manualSkippableCategories = [];
  skippedCategories = new Map();
  pendingAutoSkip = null;
  manualButton = null;
  manualKeyHandler = null;

  constructor(videoID) {
    this.videoID = videoID;
  }

  requestSegments(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.segmentRequest = xhr;
      xhr.open('GET', url);
      // A blocked endpoint must not leave the availability indicator checking indefinitely.
      xhr.timeout = 10000;
      xhr.onloadend = () => { this.segmentRequest = null; };
      xhr.onabort = () => resolve([]);
      xhr.onload = () => {
        if (xhr.status === 404) { resolve([]); return; }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('SponsorBlock HTTP=' + xhr.status));
          return;
        }
        try { resolve(JSON.parse(xhr.responseText)); } catch (err) { reject(err); }
      };
      xhr.onerror = () => reject(new Error('SponsorBlock network error'));
      xhr.ontimeout = () => reject(new Error('SponsorBlock timeout'));
      xhr.send();
    });
  }

  async init() {
    const videoHash = sha256(this.videoID).substring(0, 4);
    const categories = [
      'sponsor',
      'intro',
      'outro',
      'interaction',
      'selfpromo',
      'preview',
      'filler',
      'music_offtopic',
      'poi_highlight'
    ];
    let results;
    const url = `${sponsorblockAPI}/skipSegments/${videoHash}?categories=${encodeURIComponent(JSON.stringify(categories))}`;
    try {
      results = await this.requestSegments(url);
      if (!this.active) return;
      if (!Array.isArray(results) || !results.every(item => item && typeof item.videoID === 'string' && item.videoID.length && Array.isArray(item.segments) &&
          item.segments.every(segment => segment && typeof segment.UUID === 'string' && segment.UUID.length && typeof segment.category === 'string' && segment.category.length &&
            Array.isArray(segment.segment) && segment.segment.length === 2 && segment.segment.every(Number.isFinite) &&
            segment.segment[0] >= 0 && (segment.segment[1] > segment.segment[0] ||
              (segment.category === 'poi_highlight' && segment.segment[1] === segment.segment[0]))))) {
        throw new Error('Invalid SponsorBlock response');
      }
      this.availability = 'available';
    } catch (err) {
      this.availability = 'unavailable';
      throw err;
    }

    if (!this.active) return;

    const result = results.find((v) => v.videoID === this.videoID);
    console.info(this.videoID, 'Got it:', result);

    if (!result || !result.segments || !result.segments.length) {
      console.info(this.videoID, 'No segments found.');
      if (window.__legacyLog) window.__legacyLog.record('sponsor.empty', 'No segments');
      return;
    }

    this.segments = result.segments.slice().sort((a, b) => a.segment[0] - b.segment[0]);
    if (window.__legacyLog) window.__legacyLog.record('sponsor.loaded', 'segments=' + this.segments.length);
    this.manualSkippableCategories = configRead('sponsorBlockManualSkips');
    this.skippableCategories = this.getSkippableCategories();

    this.scheduleSkipHandler = event => this.scheduleSkip(event);
    this.positionOverlayHandler = () => this.positionOverlay();
    window.addEventListener('resize', this.positionOverlayHandler);
    this.durationChangeHandler = () => this.buildOverlay();

    this.videoReplacementHandler = event => {
      if (this.active && this.matchesPlayback() && event.target !== this.video && event.target === document.querySelector('video')) {
        this.attachVideo();
        if (event.type === 'playing') this.scheduleSkip(event);
      }
    };
    ['loadedmetadata', 'playing'].forEach(type => document.addEventListener(type, this.videoReplacementHandler, true));

    this.attachVideo();
    this.installManualSkip();
    this.buildOverlay();
  }

  getSkippableCategories() {
    const skippableCategories = [];
    if (configRead('enableSponsorBlockSponsor')) {
      skippableCategories.push('sponsor');
    }
    if (configRead('enableSponsorBlockIntro')) {
      skippableCategories.push('intro');
    }
    if (configRead('enableSponsorBlockOutro')) {
      skippableCategories.push('outro');
    }
    if (configRead('enableSponsorBlockInteraction')) {
      skippableCategories.push('interaction');
    }
    if (configRead('enableSponsorBlockSelfPromo')) {
      skippableCategories.push('selfpromo');
    }
    if (configRead('enableSponsorBlockPreview')) {
      skippableCategories.push('preview');
    }
    if (configRead('enableSponsorBlockFiller')) {
      skippableCategories.push('filler');
    }
    if (configRead('enableSponsorBlockMusicOfftopic')) {
      skippableCategories.push('music_offtopic');
    }
    return skippableCategories;
  }

  matchesPlayback() {
    const route = new URL(location.hash.substring(1), document.baseURI);
    const routeID = route.pathname === '/watch' ? route.searchParams.get('v') : null;
    if (routeID !== this.videoID && !(window.isPipPlaying && !routeID)) return false;
    const player = document.querySelector('.html5-video-player');
    const playingID = player?.getVideoData?.()?.video_id;
    return !playingID || playingID === this.videoID;
  }

  cancelSkip() {
    clearTimeout(this.nextSkipTimeout);
    this.nextSkipTimeout = null;
    this.nextSkipSegment = null;
  }

  attachVideo() {
    clearTimeout(this.attachVideoTimeout);
    this.attachVideoTimeout = null;

    const nextVideo = document.querySelector('video');
    if (!nextVideo) {
      console.info(this.videoID, 'No video yet...');
      this.attachVideoTimeout = setTimeout(() => this.attachVideo(), 100);
      return;
    }
    if (nextVideo === this.video) return;
    if (this.video) {
      ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach(type => {
        this.video.removeEventListener(type, this.scheduleSkipHandler);
      });
      this.video.removeEventListener('durationchange', this.durationChangeHandler);
      this.cancelSkip();
    }
    this.video = nextVideo;

    console.info(this.videoID, 'Video found, binding...');

    ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach(type => {
      this.video.addEventListener(type, this.scheduleSkipHandler);
    });
    this.video.addEventListener('durationchange', this.durationChangeHandler);
  }

  buildOverlay() {
    if (!this.active || this.buildOverlayTimeout) return;
    if (this.segmentsoverlay) {
      console.info('Overlay already built');
      return;
    }

    if (!this.video || !this.video.duration) {
      console.info('No video duration yet');
      return;
    }

    const videoDuration = this.video.duration;
    const slider = document.querySelector('div[idomkey="slider"]');
    if (!slider) {
      this.buildOverlayTimeout = setTimeout(() => {
        this.buildOverlayTimeout = null;
        this.buildOverlay();
      }, 500);
      return;
    }

    this.segmentsoverlay = document.createElement('div');

    this.segmentsoverlay.classList.add('ytLrProgressBarSlider', 'ytLrProgressBarSliderRectangularProgressBar');
    this.segmentsoverlay.style.setProperty('z-index', '10', 'important');
    this.segmentsoverlay.style.setProperty('background-color', 'rgba(0, 0, 0, 0)', 'important');
    this.segmentsoverlay.style.setProperty('width', '72rem', 'important');
    this.segmentsoverlay.style.setProperty('left', '4rem', 'important');
    const sliderRect = slider.getBoundingClientRect();
    if (!slider.classList.contains('ytLrProgressBarSlider')) {
      for (let i = 0; i < slider.classList.length; i++) {
        this.segmentsoverlay.classList.add(slider.classList[i]);
      }
      this.segmentsoverlay.style.setProperty('height', `${sliderRect.height}px`, 'important');
      this.segmentsoverlay.style.setProperty('bottom', `${sliderRect.bottom - sliderRect.top}px`, 'important');      
    }
    this.segments.forEach((segment) => {
      const [start, end] = segment.segment;
      const barType = barTypes[segment.category] || {
        color: 'blue',
        opacity: 0.7
      };

      const leftPercent = videoDuration ? (100.0 * start) / videoDuration : 0;
      const widthPercent = videoDuration ? (100.0 * (end - start)) / videoDuration : 0;

      const elm = document.createElement('div');
      elm.style.setProperty('background-color', barType.color, 'important');
      elm.style.setProperty('opacity', barType.opacity, 'important');
      elm.style.setProperty('height', '100%', 'important');
      elm.style.setProperty('width', `${segment.category === 'poi_highlight' ? 1 : widthPercent}%`, 'important');
      elm.style.setProperty('left', `${leftPercent}%`, 'important');
      elm.style.setProperty('position', 'absolute', 'important');
      console.info('Generated element', elm, 'from', segment);
      this.segmentsoverlay.appendChild(elm);
    });

    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.removedNodes) {
          for (const node of m.removedNodes) {
            if (node === this.segmentsoverlay) {
              console.info('bringing back segments overlay');
              this.slider.appendChild(this.segmentsoverlay);
            }
          }
        }

      });
      this.positionOverlay();
    });

    this.sliderInterval = setInterval(() => {
      this.slider = document.querySelector('ytlr-redux-connect-ytlr-progress-bar');
      if (this.slider) {
        clearInterval(this.sliderInterval);
        this.sliderInterval = null;
        this.observer.observe(this.slider, {
          childList: true,
          subtree: true
        });
        this.slider.appendChild(this.segmentsoverlay);
        this.positionOverlay();
      }
    }, 500);
  }

  positionOverlay() {
    if (!this.active || !this.segmentsoverlay) return;
    const slider = document.querySelector('div[idomkey="slider"]');
    if (slider && !document.querySelector('div[idomkey="Metadata-Section"]')) {
      const top = `${slider.getBoundingClientRect().top}px`;
      if (this.segmentsoverlay.style.top !== top) this.segmentsoverlay.style.setProperty('top', top, 'important');
    }
  }

  scheduleSkip(event) {
    this.updateManualSkip();

    if (!this.active) {
      this.cancelSkip();
      return;
    }
    const pending = this.pendingAutoSkip;
    if (pending && event?.type === 'seeked' && pending.landing === null) pending.landing = this.video.currentTime;
    if (pending && pending.landing !== null && !this.video.seeking &&
        (this.video.currentTime >= pending.end || this.video.currentTime < pending.landing - 0.25)) {
      this.pendingAutoSkip = null;
    }

    if (this.video.paused || this.video.seeking || this.video.readyState < 3 || this.video.playbackRate <= 0) {
      this.cancelSkip();
      return;
    }

    // Sometimes timeupdate event (that calls scheduleSkip) gets fired right before
    // already scheduled skip routine below. Let's just look back a little bit
    // and, in worst case, perform a skip at negative interval (immediately)...
    const nextSegments = this.segments.filter(
      (seg) =>
        (!this.pendingAutoSkip || this.pendingAutoSkip.uuid !== seg.UUID) &&
        seg.segment[1] > this.video.currentTime &&
        this.skippableCategories.includes(seg.category) &&
        !this.manualSkippableCategories.includes(seg.category)
    );

    if (!nextSegments.length) {
      this.cancelSkip();
      return;
    }

    const [segment] = nextSegments;
    const [start, end] = segment.segment;
    const delay = Math.max(0, (start - this.video.currentTime) * 1000 / this.video.playbackRate);
    const due = Date.now() + delay;
    // Keep the same timer while media and wall clocks advance together.
    if (event?.type === 'timeupdate' && this.nextSkipTimeout !== null &&
        this.nextSkipSegment === segment && this.nextSkipRate === this.video.playbackRate && Math.abs(this.nextSkipAt - due) <= 250) return;
    this.cancelSkip();
    this.nextSkipSegment = segment;
    this.nextSkipRate = this.video.playbackRate;
    this.nextSkipAt = due;

    this.nextSkipTimeout = setTimeout(() => {
      this.nextSkipTimeout = null;
      if (!this.active || !configRead('enableSponsorBlock') || !this.matchesPlayback() || this.video.paused || this.video.seeking || this.video.readyState < 3 || this.video.playbackRate <= 0) {
        return;
      }
      // Buffering and delayed callbacks can separate wall time from media time.
      if (this.video.currentTime < start || this.video.currentTime >= end) {
        this.scheduleSkip();
        return;
      }
      if (!this.skippableCategories.includes(segment.category)) {
        console.info(
          this.videoID,
          'Segment',
          segment.category,
          'is not skippable, ignoring...'
        );
        return;
      }

      const skipName = barTypes[segment.category]?.name || segment.category;
      console.info(this.videoID, 'Skipping', segment);
      if (!this.manualSkippableCategories.includes(segment.category)) {
        const wasSkippedBefore = this.skippedCategories.get(segment.UUID)
        if (wasSkippedBefore) {
          wasSkippedBefore.count++;
          wasSkippedBefore.lastSkipped = Date.now();
          this.skippedCategories.set(segment.UUID, wasSkippedBefore);

          if (wasSkippedBefore.lastSkipped - wasSkippedBefore.firstSkipped < 1000) {
            if (!wasSkippedBefore.hasShownToast) {
              if (configRead('enableSponsorBlockToasts')) {
                showToast('SponsorBlock', t('sponsorblock.toasts.notSkipping', { segment: skipName, count: wasSkippedBefore.count }));
              }
              wasSkippedBefore.hasShownToast = true;
              this.skippedCategories.set(segment.UUID, wasSkippedBefore);
            }
            return;
          }
        } else {
          this.skippedCategories.set(segment.UUID, {
            count: 1,
            firstSkipped: Date.now(),
            lastSkipped: Date.now(),
            hasShownToast: false
          });
        }
        if (configRead('enableSponsorBlockToasts')) {
          showToast('SponsorBlock', t('sponsorblock.toasts.skipping', { segment: skipName }));
        }
        if (window.__legacyLog) window.__legacyLog.record('sponsor.skip-request', segment.category + '; target=' + end);
        const target = this.video.duration - end < 1 ? end - 1 : end;
        this.pendingAutoSkip = { uuid: segment.UUID, end, landing: null };
        if (window.__legacyDirect) {
          document.querySelector('.html5-video-player').seekTo(target, true);
        } else this.video.currentTime = target;
        this.scheduleSkip();
      }
    }, delay);
  }

  currentManualSegment() {
    if (!this.active || !configRead('enableSponsorBlock') || !this.video || this.video.seeking) return null;
    return (this.segments || []).find(seg => this.skippableCategories.includes(seg.category) &&
      this.manualSkippableCategories.includes(seg.category) &&
      seg.segment[0] <= this.video.currentTime && seg.segment[1] > this.video.currentTime);
  }

  installManualSkip() {
    this.manualButton = document.createElement('button');
    this.manualButton.style.cssText = 'display:none;position:fixed;right:4rem;bottom:10rem;z-index:10000;background:#222;color:white;border:2px solid #ffd600;padding:0.7rem;font-size:1.2rem';
    const skip = () => {
      const segment = this.currentManualSegment();
      if (!segment) return;
      const target = this.video.duration - segment.segment[1] < 1 ? segment.segment[1] - 1 : segment.segment[1];
      if (window.__legacyDirect) document.querySelector('.html5-video-player').seekTo(target, true);
      else this.video.currentTime = target;
      this.manualButton.style.display = 'none';
    };
    this.manualButton.onclick = skip;
    this.manualKeyHandler = event => {
      if ((event.keyCode === 405 || event.keyCode === 51) && this.currentManualSegment() &&
          !document.querySelector('div[idomkey="Metadata-Section"]')) {
        event.preventDefault(); event.stopImmediatePropagation(); skip();
      }
    };
    document.addEventListener('keydown', this.manualKeyHandler, true);
    document.body.appendChild(this.manualButton);
    this.updateManualSkip();
  }

  updateManualSkip() {
    if (!this.manualButton) return;
    const segment = this.currentManualSegment();
    const display = segment ? 'block' : 'none';
    if (this.manualButton.style.display !== display) this.manualButton.style.display = display;
    if (segment) {
      const text = t('settings.options.sponsorblock.manualKey') + ': ' + t('sponsorblock.toasts.skip', { segment: t(`sponsorblock.segments.${segment.category}`) });
      if (this.manualButton.textContent !== text) this.manualButton.textContent = text;
    }
  }

  destroy() {
    if (this.videoReplacementHandler) {
      ['loadedmetadata', 'playing'].forEach(type => document.removeEventListener(type, this.videoReplacementHandler, true));
      this.videoReplacementHandler = null;
    }
    console.info(this.videoID, 'Destroying');

    this.active = false;
    if (this.manualKeyHandler) document.removeEventListener('keydown', this.manualKeyHandler, true);
    if (this.manualButton) { this.manualButton.remove(); this.manualButton = null; }
    if (this.segmentRequest) {
      this.segmentRequest.abort();
      this.segmentRequest = null;
    }

    if (this.nextSkipTimeout) {
      clearTimeout(this.nextSkipTimeout);
      this.nextSkipTimeout = null;
    }

    clearTimeout(this.buildOverlayTimeout);
    this.buildOverlayTimeout = null;
    if (this.positionOverlayHandler) window.removeEventListener('resize', this.positionOverlayHandler);
    if (this.attachVideoTimeout) {
      clearTimeout(this.attachVideoTimeout);
      this.attachVideoTimeout = null;
    }

    if (this.sliderInterval) {
      clearInterval(this.sliderInterval);
      this.sliderInterval = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.segmentsoverlay) {
      this.segmentsoverlay.remove();
      this.segmentsoverlay = null;
    }

    if (this.video) {
      ['play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'ratechange', 'timeupdate'].forEach(type => {
        this.video.removeEventListener(type, this.scheduleSkipHandler);
      });
      this.video.removeEventListener(
        'durationchange',
        this.durationChangeHandler
      );
    }

    this.skippedCategories.clear();
  }
}

// When this global variable was declared using let and two consecutive hashchange
// events were fired (due to bubbling? not sure...) the second call handled below
// would not see the value change from first call, and that would cause multiple
// SponsorBlockHandler initializations... This has been noticed on Chromium 38.
// This either reveals some bug in chromium/webpack/babel scope handling, or
// shows my lack of understanding of javascript. (or both)
window.sponsorblock = null;
let lastWatchID = null;

function handleVideoChange() {
    // srcdoc has an about: URL; the document base points to YouTube.
    const newURL = new URL(location.hash.substring(1), document.baseURI);
    // A hack, but it works, so...
    const routeID = newURL.pathname === '/watch' ? newURL.searchParams.get('v') : null;
    if (routeID) lastWatchID = routeID;
    else if (!window.isPipPlaying) lastWatchID = null;
    const pipID = window.isPipPlaying && document.querySelector('.html5-video-player')?.getVideoData?.()?.video_id;
    const videoID = routeID || (pipID === lastWatchID ? lastWatchID : null);
    const enabled = configRead('enableSponsorBlock');
    const needsReload =
      ((!videoID || !enabled) && window.sponsorblock) ||
      (videoID && enabled && (!window.sponsorblock || window.sponsorblock.videoID != videoID));

    console.info(
      'hashchange',
      videoID,
      window.sponsorblock,
      window.sponsorblock ? window.sponsorblock.videoID : null,
      needsReload
    );

    if (needsReload) {
      if (window.sponsorblock) {
        try {
          window.sponsorblock.destroy();
        } catch (err) {
          console.warn('window.sponsorblock.destroy() failed!', err);
        }
        window.sponsorblock = null;
      }

      if (videoID && configRead('enableSponsorBlock')) {
        window.sponsorblock = new SponsorBlockHandler(videoID);
        window.sponsorblock.init().catch((err) => {
          console.warn('SponsorBlock initialization failed:', err);
          if (window.__legacyLog) window.__legacyLog.record('sponsor.error', err.message);
        });
      } else {
        console.info('SponsorBlock disabled, not loading');
      }
    }
}
window.addEventListener('hashchange', handleVideoChange, false);
configChangeEmitter.addEventListener('configChange', event => {
    const key = event.detail.key;
    if (key === 'enableSponsorBlock') { handleVideoChange(); return; }
    const handler = window.sponsorblock;
    if (!handler?.active || !handler.segments || !(key.startsWith('enableSponsorBlock') || key === 'sponsorBlockManualSkips')) return;
    handler.skippableCategories = handler.getSkippableCategories();
    handler.manualSkippableCategories = configRead('sponsorBlockManualSkips');
    const pending = handler.pendingAutoSkip;
    if (pending) {
      const segment = handler.segments.find(segment => segment.UUID === pending.uuid);
      if (!segment || !handler.skippableCategories.includes(segment.category) || handler.manualSkippableCategories.includes(segment.category)) handler.pendingAutoSkip = null;
    }
    if (handler.video) handler.scheduleSkip();
});
handleVideoChange();
