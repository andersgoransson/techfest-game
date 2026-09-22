// Bootstraps canvas + input + game loop, and exposes the dev/test hook.
// Fixed-timestep update accumulator; variable-timestep render.
//
// Also owns the app-level "finish flow" that sits on top of the game state
// machine: when a run ends, the player types their LEGO email, the score is
// saved to the local leaderboard, and their placement is revealed (explosion +
// focus on their row). The game core (game.js) stays pure and unaware of this.

import { createGame, STATES, TUNABLES, FIXED_DT } from './game/game.js';
import { createInput } from './input.js';
import { createRenderer } from './render/render.js';
import * as leaderboard from './leaderboard.js';
import { createAudio } from './audio/audio.js';

const MAX_FRAME = 0.25; // clamp huge gaps (tab was backgrounded)

function boot() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  canvas.focus();

  // --- Info panel (DOM overlay, always present) ---
  const infoBtn       = document.getElementById('info-btn');
  const infoBackdrop  = document.getElementById('info-panel-backdrop');
  const infoPanel     = document.getElementById('info-panel');
  const infoPanelClose = document.getElementById('info-panel-close');
  let isPanelOpen = false;

  function openInfoPanel() {
    isPanelOpen = true;
    infoBackdrop.classList.add('open');
    infoPanel.setAttribute('aria-hidden', 'false');
    infoPanelClose.focus();
  }
  function closeInfoPanel() {
    isPanelOpen = false;
    infoBackdrop.classList.remove('open');
    infoPanel.setAttribute('aria-hidden', 'true');
    canvas.focus();
  }

  infoBtn.addEventListener('click', openInfoPanel);
  infoPanelClose.addEventListener('click', closeInfoPanel);

  // Escape closes the panel; stopPropagation so onFinishKey on window does NOT
  // also fire (e.g. Escape=skipName during 'name' phase).
  function onInfoEscape(e) {
    if (isPanelOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeInfoPanel();
    }
  }
  document.addEventListener('keydown', onInfoEscape);

  const seed = Number(new URLSearchParams(location.search).get('seed')) || 12345;
  const { game, update, start, togglePause, snapshot } = createGame({ seed });
  const input = createInput(canvas);

  // App phase: 'play' (menu/playing/paused/finished game core) → 'name' (email
  // entry) → 'result' (placement reveal) → back to 'play'.
  const app = { phase: 'play', name: '', finalScore: 0, result: null };
  const render = createRenderer(ctx, game, app);

  // Audio observer — pure SFX, no asset files.
  const audioObserver = createAudio(game);

  // --- Mute button wiring ---
  const muteBtn = document.getElementById('mute-btn');
  function updateMuteBtn() {
    const isMuted = audioObserver.muted;
    muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    muteBtn.setAttribute('aria-pressed', String(isMuted));
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute sound' : 'Mute sound');
  }
  updateMuteBtn();
  muteBtn.addEventListener('click', () => {
    audioObserver.toggleMute();
    updateMuteBtn();
  });

  // M key toggles mute from anywhere (separate from info-panel Escape handler).
  function onMuteKey(e) {
    if (e.code === 'KeyM') {
      audioObserver.toggleMute();
      updateMuteBtn();
    }
  }
  window.addEventListener('keydown', onMuteKey);

  let last = performance.now();
  let acc = 0;
  let rafId = 0;
  let ready = false;

  // --- finish flow transitions ---
  function submitName(str) {
    if (typeof str === 'string') app.name = str;
    const local = leaderboard.normalizeName(app.name);
    if (!local) return false; // need at least one valid character
    const res = leaderboard.add(local, app.finalScore);
    app.result = { name: res.entry.name, score: res.entry.score, rank: res.rank, index: res.index };
    app.phase = 'result';
    return true;
  }
  function skipName() {
    app.result = null;
    app.phase = 'result';
  }
  function playAgain() {
    if (app.phase !== 'result') return;
    app.phase = 'play';
    app.name = '';
    app.result = null;
    start();          // reset the run (menu/gameover/victory → playing)
    canvas.focus();
  }

  // Keyboard for the finish flow only. Gameplay keys stay on the canvas input.
  function onFinishKey(e) {
    if (app.phase === 'name') {
      if (e.key === 'Enter') { e.preventDefault(); submitName(); }
      else if (e.key === 'Escape') { e.preventDefault(); skipName(); }
      else if (e.key === 'Backspace') { e.preventDefault(); app.name = app.name.slice(0, -1); }
      else if (e.key.length === 1 && /[a-zA-Z0-9._+\-@]/.test(e.key)) {
        e.preventDefault();
        if (app.name.length < 40) app.name += e.key;
      }
    } else if (app.phase === 'result') {
      if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); playAgain(); }
    }
  }
  window.addEventListener('keydown', onFinishKey);

  function frame(now) {
    // Never let a single update/render exception halt the loop — a thrown error
    // here would otherwise skip the reschedule below and freeze the game on a
    // half-drawn (blank) frame. Log it and keep animating.
    try {
      let delta = (now - last) / 1000;
      last = now;
      if (delta > MAX_FRAME) delta = MAX_FRAME;

      if (app.phase === 'play') {
        acc += delta;
        while (acc >= FIXED_DT) {
          update(FIXED_DT, input);
          acc -= FIXED_DT;
        }
        // A run just ended → enter the name-entry flow (freezes the scene).
        if (game.state === STATES.GAMEOVER || game.state === STATES.VICTORY) {
          app.phase = 'name';
          app.finalScore = game.score;
          app.name = '';
          app.result = null;
        }
      } else {
        acc = 0; // don't build a backlog while the overlay is up
      }
      input.endFrame();
      render();
      audioObserver.observe();

      if (!ready) { ready = true; if (window.__game) window.__game.ready = true; }
    } catch (err) {
      console.error('Game loop error (recovered):', err);
    } finally {
      rafId = requestAnimationFrame(frame);
    }
  }

  // Close panel when clicking the backdrop outside the panel box.
  infoBackdrop.addEventListener('click', (e) => {
    if (e.target === infoBackdrop) closeInfoPanel();
  });

  function destroy() {
    cancelAnimationFrame(rafId);
    input.destroy();
    audioObserver.destroy();
    window.removeEventListener('keydown', onFinishKey);
    window.removeEventListener('keydown', onMuteKey);
    document.removeEventListener('keydown', onInfoEscape);
    if (window.__game) window.__game.ready = false;
  }

  // --- Dev/test inspection hook (see AGENTS.md) ---
  // Gated to dev/test only; a production build strips this via import.meta.env.DEV.
  const DEV = (import.meta && import.meta.env && import.meta.env.DEV) || window.__TEST__;
  if (DEV) {
    // Stable audio sub-hook delegating to the audio observer.
    const audioHook = {
      get contextState()  { return audioObserver.contextState; },
      get muted()         { return audioObserver.muted; },
      set muted(v)        { audioObserver.muted = v; updateMuteBtn(); },
      get sfxLog()        { return audioObserver.sfxLog; },
      clearSfxLog()       { audioObserver.clearSfxLog(); },
      _teardown()         { audioObserver.destroy(); },
      // Music observability (AC-1 through AC-14).
      get musicPlaying()  { return audioObserver.musicPlaying; },
      get musicState()    { return audioObserver.musicState; },
    };

    window.__game = {
      ready: false,
      // Tunables exposed for tester convenience.
      START_HEALTH: TUNABLES.START_HEALTH,
      WIN_THRESHOLD: TUNABLES.WIN_THRESHOLD,
      HEAT_MAX: TUNABLES.HEAT_MAX,
      HEAT_PER_SHOT: TUNABLES.HEAT_PER_SHOT,
      HEAT_COOL_RATE: TUNABLES.HEAT_COOL_RATE,
      get state()        { return game.state; },
      get score()        { return game.score; },
      get pillars()      { return { ...game.pillars }; },
      get cloudHealth()  { return game.cloudHealth; },
      get combo()        { return game.combo; },
      get frame()        { return game.frame; },
      get heat()         { return game._heat; },
      get overheated()   { return game._overheated; },
      get threats()      { return snapshot().threats; },
      get lastFiling()   { return game.lastFiling  ? { ...game.lastFiling }  : null; },
      get lastCallout()  { return game.lastCallout ? { ...game.lastCallout } : null; },
      get filledPillars(){ return [...game.filledPillars]; },
      snapshot,
      // Finish-flow observability + affordances (drive without key timing).
      get phase()        { return app.phase; },
      get finalScore()   { return app.finalScore; },
      get result()       { return app.result ? { ...app.result } : null; },
      get leaderboard()  { return leaderboard.all(); },
      submitName,
      skipName,
      playAgain,
      clearLeaderboard: () => leaderboard.clear(),
      // Test affordances — drive transitions without simulating key holds.
      start,
      togglePause,
      _teardown: destroy,
      // Audio sub-hook (gated identically — absent in production builds).
      audio: audioHook,
    };
  }

  rafId = requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
