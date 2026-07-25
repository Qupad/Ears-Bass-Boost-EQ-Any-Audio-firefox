// Ears page-world engine: hosts the Web Audio graph in the page's own realm.
//
// This runs as a `world: "MAIN"` content script rather than in the isolated
// content-script sandbox, for one decisive reason: players like Yandex Music
// play through a *detached* `new Audio()` element that is never inserted into
// the document. Such an element is invisible to querySelectorAll, invisible
// to a MutationObserver, and its events cannot bubble to `document` because
// it is not in the tree. The only way to find it is to hook
// HTMLMediaElement.prototype.play, which requires being in the page's realm.
//
//   media sources -> biquad[0..n] -> gain -> analyser -> destination
//
// It has no access to the `browser` API, so it talks to eq-content.js over
// window.postMessage; that script relays to the background.

(function () {
  'use strict';

  if (window.__earsPage) {
    return;
  }

  const SILENCE_PROBE_MS = 1500;
  const SILENCE_PROBES_BEFORE_BYPASS = 4;

  const state = {
    context: null,
    filterNodes: [],
    gainNode: null,
    analyser: null,
    sources: new WeakMap(),
    unattachable: new WeakSet(),
    corsRepaired: new WeakSet(),
    attached: [],
    enabled: false,
    observer: null,
    filters: [],
    gain: 1,
    silenceTimer: null,
    silentProbes: 0,
    notice: null
  };

  window.__earsPage = state;

  // Keep native references: the CORS repair path calls play()/load() itself,
  // and the page is free to replace these afterwards.
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativeLoad = HTMLMediaElement.prototype.load;
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;

  function notify(reason) {
    state.notice = reason;
    window.postMessage({ source: 'ears-page', notice: reason }, '*');
  }

  function isMediaElement(node) {
    const tag = node && node.tagName;
    return tag === 'AUDIO' || tag === 'VIDEO';
  }

  // --- graph -------------------------------------------------------------

  function buildFilterNodes(context, filters) {
    return filters.map((filter) => {
      const node = context.createBiquadFilter();
      node.type = filter.type;
      node.frequency.value = filter.frequency;
      node.gain.value = filter.gain;
      node.Q.value = filter.q;
      return node;
    });
  }

  function applyFilterValues(nodes, filters) {
    for (let i = 0; i < nodes.length; i += 1) {
      const filter = filters[i];
      if (!filter) {
        continue;
      }
      const node = nodes[i];
      node.type = filter.type;
      node.frequency.value = filter.frequency;
      node.gain.value = filter.gain;
      node.Q.value = filter.q;
    }
  }

  function ensureGraph(filters) {
    if (!state.context) {
      state.context = new NativeAudioContext();
      state.gainNode = state.context.createGain();
      state.analyser = state.context.createAnalyser();
      state.analyser.fftSize = 512;
      state.analyser.smoothingTimeConstant = 0.7;
    }

    if (filters.length && state.filterNodes.length !== filters.length) {
      state.filterNodes.forEach((node) => node.disconnect());
      state.filterNodes = buildFilterNodes(state.context, filters);

      let previous = null;
      for (const node of state.filterNodes) {
        if (previous) {
          previous.connect(node);
        }
        previous = node;
      }
      if (previous) {
        previous.connect(state.gainNode);
      }
      state.gainNode.connect(state.analyser);
      state.analyser.connect(state.context.destination);
    }

    return state.context;
  }

  // Sends a source either through the filter chain or straight to the speakers.
  function routeSource(source) {
    source.disconnect();
    if (state.enabled && state.filterNodes.length) {
      source.connect(state.filterNodes[0]);
    } else {
      source.connect(state.context.destination);
    }
  }

  function rerouteAll() {
    for (const entry of state.attached) {
      routeSource(entry.source);
    }
  }

  // --- cross-origin media ------------------------------------------------

  function isCrossOriginMedia(element) {
    const src = element.currentSrc || element.src;
    // blob:/data:/mediasource: (MSE, as used by YouTube) are same-origin.
    if (!src || /^(blob|data|mediasource):/i.test(src)) {
      return false;
    }
    try {
      return new URL(src, location.href).origin !== location.origin;
    } catch (error) {
      return false;
    }
  }

  // A MediaElementAudioSourceNode fed by CORS-cross-origin media outputs
  // silence, and without a crossorigin attribute the resource counts as
  // cross-origin no matter what headers come back -- so the element has to
  // re-request it. The background adds the matching response header.
  function repairCrossOrigin(element) {
    if (state.corsRepaired.has(element) || element.crossOrigin === 'anonymous') {
      return;
    }

    // Nothing loaded yet: opt in now and no reload is ever needed. Once set,
    // the attribute also carries over to every later src on this element.
    if (!element.currentSrc && !element.src) {
      element.crossOrigin = 'anonymous';
      return;
    }

    if (!isCrossOriginMedia(element)) {
      return;
    }

    state.corsRepaired.add(element);

    const time = element.currentTime;
    const wasPlaying = !element.paused;

    const resume = () => {
      element.removeEventListener('loadedmetadata', resume);
      try {
        if (time > 0) {
          element.currentTime = time;
        }
      } catch (error) {
        // Live streams are not always seekable.
      }
      if (wasPlaying) {
        nativePlay.call(element).catch(() => {});
      }
    };

    // Some CDNs reject requests that carry an Origin header. If this one
    // does, put the element back exactly as it was.
    const revert = () => {
      element.removeEventListener('error', revert);
      element.removeEventListener('loadedmetadata', resume);
      element.removeAttribute('crossorigin');
      element.addEventListener('loadedmetadata', resume, { once: true });
      nativeLoad.call(element);
      notify('cross-origin-blocked');
    };

    element.addEventListener('loadedmetadata', resume);
    element.addEventListener('error', revert, { once: true });
    element.crossOrigin = 'anonymous';
    nativeLoad.call(element);
  }

  // --- media discovery ---------------------------------------------------

  function attachElement(element) {
    if (state.unattachable.has(element)) {
      return;
    }

    // Already wired, but a newly loaded track may need the CORS opt-in.
    if (state.sources.has(element)) {
      repairCrossOrigin(element);
      return;
    }

    const context = ensureGraph(state.filters);

    let source;
    try {
      source = context.createMediaElementSource(element);
    } catch (error) {
      // Most often InvalidStateError: the page already built its own
      // MediaElementAudioSourceNode for this element and we cannot take it.
      state.unattachable.add(element);
      if (!state.notice) {
        notify('already-claimed');
      }
      return;
    }

    state.sources.set(element, source);
    state.attached.push({ element, source });
    routeSource(source);
    repairCrossOrigin(element);
    scheduleSilenceProbe();
  }

  function collectMedia(root, found) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    for (const element of root.querySelectorAll('audio, video')) {
      found.push(element);
    }

    // Media inside web components is invisible to a light-DOM query.
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collectMedia(element.shadowRoot, found);
      }
    }
  }

  function scanForMedia() {
    const found = [];
    collectMedia(document, found);
    found.forEach(attachElement);
    return state.attached.length;
  }

  function onNodeAdded(node) {
    if (isMediaElement(node)) {
      attachElement(node);
      return;
    }
    if (node && typeof node.querySelectorAll === 'function') {
      node.querySelectorAll('audio, video').forEach(attachElement);
    }
  }

  function startObserving() {
    if (state.observer || !document.documentElement) {
      return;
    }
    state.observer = new MutationObserver((records) => {
      if (!state.enabled) {
        return;
      }
      for (const record of records) {
        record.addedNodes.forEach(onNodeAdded);
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopObserving() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  // The whole reason this script lives in the page realm: catch media that
  // never enters the DOM. Every player has to call play() eventually.
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      if (state.enabled) {
        attachElement(this);
      }
    } catch (error) {
      // Never let a failure in the hook break the page's own playback.
    }
    return nativePlay.apply(this, args);
  };

  // --- cross-origin silence detection ------------------------------------

  function isAudiblyPlaying() {
    return state.attached.some(
      ({ element }) =>
        !element.paused &&
        !element.ended &&
        element.readyState >= 2 &&
        !element.muted &&
        element.volume > 0
    );
  }

  function analyserPeak() {
    const samples = new Float32Array(state.analyser.fftSize);
    state.analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peak) {
        peak = value;
      }
    }
    return peak;
  }

  // If the graph stays at digital silence while something is audibly playing,
  // fall back to untouched playback rather than leaving the user a dead tab.
  function runSilenceProbe() {
    state.silenceTimer = null;

    if (!state.enabled || !state.analyser || state.gain <= 0) {
      return;
    }

    if (!isAudiblyPlaying()) {
      scheduleSilenceProbe();
      return;
    }

    if (analyserPeak() !== 0) {
      state.silentProbes = 0;
      return;
    }

    state.silentProbes += 1;
    if (state.silentProbes < SILENCE_PROBES_BEFORE_BYPASS) {
      scheduleSilenceProbe();
      return;
    }

    state.enabled = false;
    rerouteAll();
    notify('cross-origin-silent');
  }

  function scheduleSilenceProbe() {
    if (state.silenceTimer) {
      return;
    }
    state.silenceTimer = setTimeout(runSilenceProbe, SILENCE_PROBE_MS);
  }

  // --- commands ----------------------------------------------------------

  async function enable(filters, gain) {
    state.filters = Array.isArray(filters) ? filters : [];
    state.gain = Number.isFinite(gain) ? gain : 1;
    state.notice = null;
    state.silentProbes = 0;

    const context = ensureGraph(state.filters);
    applyFilterValues(state.filterNodes, state.filters);
    state.gainNode.gain.value = state.gain;

    state.enabled = true;
    startObserving();
    const mediaCount = scanForMedia();
    rerouteAll();

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch (error) {
        // Autoplay policy can refuse until the user interacts; harmless here
        // because playback itself is what resumes the context.
      }
    }

    scheduleSilenceProbe();

    return {
      ok: true,
      // The play() hook stays armed, so media that starts later is caught.
      reason: mediaCount === 0 ? state.notice || 'no-media' : state.notice,
      mediaCount,
      sampleRate: context.sampleRate
    };
  }

  function disable() {
    state.enabled = false;
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
    state.silentProbes = 0;
    stopObserving();
    if (state.context) {
      rerouteAll();
    }
    return { ok: true };
  }

  function updateFilters(filters, gain) {
    state.filters = Array.isArray(filters) ? filters : state.filters;
    state.gain = Number.isFinite(gain) ? gain : state.gain;

    if (!state.context) {
      return { ok: true };
    }

    ensureGraph(state.filters);
    applyFilterValues(state.filterNodes, state.filters);
    state.gainNode.gain.value = state.gain;

    // A probe skipped because the gain was muted should resume once it is not.
    if (state.enabled) {
      state.silentProbes = 0;
      scheduleSilenceProbe();
    }

    return { ok: true };
  }

  function getFFT() {
    if (!state.enabled || !state.analyser) {
      return { fft: [] };
    }
    const values = new Float32Array(state.analyser.frequencyBinCount);
    state.analyser.getFloatFrequencyData(values);
    return { fft: Array.from(values) };
  }

  // --- bridge to the isolated content script -----------------------------

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.source !== 'ears-content') {
      return;
    }

    let result;
    try {
      switch (data.command) {
        case 'enable':
          result = await enable(data.filters, data.gain);
          break;
        case 'disable':
          result = disable();
          break;
        case 'updateFilters':
          result = updateFilters(data.filters, data.gain);
          break;
        case 'getFFT':
          result = getFFT();
          break;
        default:
          result = { ok: false };
      }
    } catch (error) {
      result = { ok: false, reason: 'audio-unavailable' };
    }

    window.postMessage({ source: 'ears-page', id: data.id, result }, '*');
  });
})();
