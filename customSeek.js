// ==UserScript==
// @name         YouTube Custom Seek + Frame Step
// @namespace    joel.yt.custom-seek
// @version      1.0.0
// @description  Custom arrow-key seek intervals and true frame-by-frame stepping on YouTube videos and Shorts
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ───────────────────────── CONFIG — edit these ─────────────────────────
  const SEEK_SMALL = 3; // seconds for ← / →
  const SEEK_LARGE = 10; // seconds for Shift+← / Shift+→
  const FRAME_BACK_KEY = ',';
  const FRAME_FWD_KEY = '.';
  const FALLBACK_FPS = 30; // used until real fps has been measured
  // ────────────────────────────────────────────────────────────────────────

  const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

  // fps cache: video element -> { src, fps, sampling }
  const fpsCache = new WeakMap();

  // ── active video ──────────────────────────────────────────────────────
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
           r.bottom > 0 && r.top < innerHeight;
  }

  function getVideo() {
    const vids = [...document.querySelectorAll('video')]
      .filter(v => v.currentSrc && isVisible(v));
    if (!vids.length) return null;
    // Prefer the one that's actually playing (matters on Shorts, where
    // neighboring shorts' <video> elements exist in the DOM).
    return vids.find(v => !v.paused) ||
           vids.sort((a, b) =>
             b.getBoundingClientRect().width * b.getBoundingClientRect().height -
             a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  }

  // ── fps detection ─────────────────────────────────────────────────────
  function snapFps(raw) {
    let best = raw, bestDiff = Infinity;
    for (const f of COMMON_FPS) {
      const d = Math.abs(f - raw);
      if (d < bestDiff) { bestDiff = d; best = f; }
    }
    // within 5% of a standard rate → snap, else trust the measurement
    return bestDiff / best < 0.05 ? best : raw;
  }

  function sampleFps(video) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
    const entry = fpsCache.get(video);
    if (entry && entry.src === video.currentSrc && (entry.fps || entry.sampling)) return;

    const state = { src: video.currentSrc, fps: null, sampling: true };
    fpsCache.set(video, state);

    const deltas = [];
    let last = null;
    const cb = (_now, meta) => {
      if (video.currentSrc !== state.src) { state.sampling = false; return; }
      if (last !== null) {
        const d = meta.mediaTime - last;
        if (d > 0.001) deltas.push(d);
      }
      last = meta.mediaTime;
      if (deltas.length >= 12) {
        // mediaTime deltas are exact multiples of the frame duration;
        // dropped frames only make deltas LARGER, so min = one frame.
        state.fps = snapFps(1 / Math.min(...deltas));
        state.sampling = false;
      } else {
        video.requestVideoFrameCallback(cb);
      }
    };
    video.requestVideoFrameCallback(cb);
  }

  function getFps(video) {
    const entry = fpsCache.get(video);
    if (entry && entry.src === video.currentSrc && entry.fps) return entry.fps;
    sampleFps(video); // will be ready for later presses
    return FALLBACK_FPS;
  }

  // Start sampling as soon as any video plays, so fps is known
  // before the first frame-step.
  document.addEventListener('playing', e => {
    if (e.target instanceof HTMLVideoElement) sampleFps(e.target);
  }, true);

  // ── OSD toast ─────────────────────────────────────────────────────────
  let toastEl = null, toastTimer = null;
  function toast(video, text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', zIndex: 2147483647, padding: '6px 14px',
        background: 'rgba(0,0,0,0.75)', color: '#fff',
        font: '500 14px/1.4 Roboto, Arial, sans-serif',
        borderRadius: '4px', pointerEvents: 'none',
        transition: 'opacity 0.25s', opacity: '0',
      });
      document.documentElement.appendChild(toastEl);
    }
    const r = video.getBoundingClientRect();
    toastEl.textContent = text;
    toastEl.style.left = `${r.left + r.width / 2}px`;
    toastEl.style.top = `${r.top + 24}px`;
    toastEl.style.transform = 'translateX(-50%)';
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 800);
  }

  // ── actions ───────────────────────────────────────────────────────────
  function seek(video, seconds) {
    const max = video.duration || Infinity;
    video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), max);
    toast(video, `${seconds > 0 ? '+' : ''}${seconds}s`);
  }

  function frameStep(video, dir) {
    if (!video.paused) video.pause();
    const fps = getFps(video);
    const frameDur = 1 / fps;
    const max = video.duration || Infinity;
    video.currentTime = Math.min(Math.max(video.currentTime + dir * frameDur, 0), max);
    const label = fps === FALLBACK_FPS && !(fpsCache.get(video) || {}).fps
      ? `~1 frame (fps pending)` : `1 frame (${fps}fps)`;
    toast(video, `${dir > 0 ? '▸' : '◂'} ${label}`);
  }

  function togglePlay(video) {
    if (video.paused) {
      video.play();
      toast(video, '▶ play');
    } else {
      video.pause();
      toast(video, '⏸ pause');
    }
  }


  // ── key handling ──────────────────────────────────────────────────────
  function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
           t.isContentEditable;
  }

  window.addEventListener('keydown', e => {
    if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) return;

    let action = null;
    if (e.key === 'ArrowLeft') action = v => seek(v, -(e.shiftKey ? SEEK_LARGE : SEEK_SMALL));
    if (e.key === 'ArrowRight') action = v => seek(v, (e.shiftKey ? SEEK_LARGE : SEEK_SMALL));
    if (e.key === FRAME_BACK_KEY && !e.shiftKey) action = v => frameStep(v, -1);
    if (e.key === FRAME_FWD_KEY && !e.shiftKey) action = v => frameStep(v, +1);
    if (e.code === 'Space' && !e.shiftKey) action = v => togglePlay(v);
    if (!action) return;

    const video = getVideo();
    if (!video) return;

    // Fire before YouTube's own handlers and suppress them.
    e.preventDefault();
    e.stopImmediatePropagation();
    action(video);
  }, true);
})();
