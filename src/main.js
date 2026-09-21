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

const MAX_FRAME = 0.25; // clamp huge gaps (tab was backgrounded)

function boot() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  canvas.focus();

  const seed = Number(new URLSearchParams(location.search).get('seed')) || 12345;
  const { game, update, start, togglePause, snapshot } = createGame({ seed });
  const input = createInput(canvas);

  // App phase: 'play' (menu/playing/paused/finished game core) → 'name' (email
  // entry) → 'result' (placement reveal) → back to 'play'.
  const app = { phase: 'play', name: '', finalScore: 0, result: null };
  const render = createRenderer(ctx, game, app);

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

      if (!ready) { ready = true; if (window.__game) window.__game.ready = true; }
    } catch (err) {
      console.error('Game loop error (recovered):', err);
    } finally {
      rafId = requestAnimationFrame(frame);
    }
  }

  function destroy() {
    cancelAnimationFrame(rafId);
    input.destroy();
    window.removeEventListener('keydown', onFinishKey);
    if (window.__game) window.__game.ready = false;
  }

  // --- Dev/test inspection hook (see AGENTS.md) ---
  // Gated to dev/test only; a production build strips this via import.meta.env.DEV.
  const DEV = (import.meta && import.meta.env && import.meta.env.DEV) || window.__TEST__;
  if (DEV) {
    window.__game = {
      ready: false,
      // Tunables exposed for tester convenience.
      START_HEALTH: TUNABLES.START_HEALTH,
      WIN_THRESHOLD: TUNABLES.WIN_THRESHOLD,
      get state()        { return game.state; },
      get score()        { return game.score; },
      get pillars()      { return { ...game.pillars }; },
      get cloudHealth()  { return game.cloudHealth; },
      get combo()        { return game.combo; },
      get frame()        { return game.frame; },
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
    };
  }

  rafId = requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
