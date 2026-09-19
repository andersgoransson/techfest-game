// Bootstraps canvas + input + game loop, and exposes the dev/test hook.
// Fixed-timestep update accumulator; variable-timestep render.

import { createGame, TUNABLES, FIXED_DT } from './game/game.js';
import { createInput } from './input.js';
import { createRenderer } from './render/render.js';

const MAX_FRAME = 0.25; // clamp huge gaps (tab was backgrounded)

function boot() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  canvas.focus();

  const seed = Number(new URLSearchParams(location.search).get('seed')) || 12345;
  const { game, update, start, togglePause, snapshot } = createGame({ seed });
  const input = createInput(canvas);
  const render = createRenderer(ctx, game);

  let last = performance.now();
  let acc = 0;
  let rafId = 0;
  let ready = false;

  function frame(now) {
    let delta = (now - last) / 1000;
    last = now;
    if (delta > MAX_FRAME) delta = MAX_FRAME;
    acc += delta;

    while (acc >= FIXED_DT) {
      update(FIXED_DT, input);
      acc -= FIXED_DT;
    }
    input.endFrame();
    render();

    if (!ready) { ready = true; if (window.__game) window.__game.ready = true; }
    rafId = requestAnimationFrame(frame);
  }

  function destroy() {
    cancelAnimationFrame(rafId);
    input.destroy();
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
      // Test affordances — drive transitions without simulating key holds.
      // No selectedPillar / selectPillar: filing is automatic on hit.
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
