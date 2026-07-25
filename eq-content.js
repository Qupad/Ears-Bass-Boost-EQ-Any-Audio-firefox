// Ears content script: bridge between the background and the page-world engine.
//
// The audio graph itself lives in eq-page.js, which runs in the page's own
// realm because that is the only place HTMLMediaElement.prototype.play can be
// hooked -- players that use a detached `new Audio()` are otherwise
// undiscoverable. That script has no access to the `browser` API, so every
// message is relayed through here over window.postMessage.

(function () {
  'use strict';

  const PAGE_TIMEOUT_MS = 4000;

  // Content scripts from the same extension share a sandbox per document, so
  // repeated scripting.executeScript() injections must not re-register.
  if (window.__earsBridge) {
    return;
  }
  window.__earsBridge = true;

  let sequence = 0;
  const pending = new Map();

  function callPage(command, payload) {
    return new Promise((resolve) => {
      sequence += 1;
      const id = sequence;
      pending.set(id, resolve);

      window.postMessage({ source: 'ears-content', id, command, ...payload }, '*');

      // The page engine may be absent in a frame that refused injection.
      setTimeout(() => {
        if (pending.delete(id)) {
          resolve(null);
        }
      }, PAGE_TIMEOUT_MS);
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.source !== 'ears-page') {
      return;
    }

    if (data.notice) {
      browser.runtime.sendMessage({ type: 'earsNotice', reason: data.notice }).catch(() => {});
      return;
    }

    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve(data.result);
    }
  });

  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'ears-content') {
      return false;
    }

    switch (message.command) {
      case 'enable':
        return callPage('enable', { filters: message.filters, gain: message.gain }).then(
          (result) => result || { ok: false, reason: 'audio-unavailable', mediaCount: 0 }
        );
      case 'disable':
        return callPage('disable', {}).then((result) => result || { ok: true });
      case 'updateFilters':
        return callPage('updateFilters', {
          filters: message.filters,
          gain: message.gain
        }).then((result) => result || { ok: true });
      case 'getFFT':
        return callPage('getFFT', {}).then((result) => result || { fft: [] });
      default:
        return false;
    }
  });
})();
