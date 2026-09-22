// Pure-logic unit tests for the gun-overheating mechanic (node --test).
// Heat math lives in game.js and is fully deterministic (dt-based), so it can
// be verified headlessly here; the green→red HUD bar is covered by the
// agent-browser scenarios. Each tick clears threats and defers spawning so a
// stray breach can never flip the state out of PLAYING and perturb the run —
// this isolates the heat subsystem under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, STATES, TUNABLES, FIXED_DT } from '../src/game/game.js';

function fakeInput(held = []) {
  const down = new Set(held);
  return {
    isDown: (a) => down.has(a),
    consumePress: () => false,
    endFrame: () => {},
    set: (a, v) => (v ? down.add(a) : down.delete(a)),
  };
}

// Advance one tick with threats/spawning neutralized so only heat logic runs.
function tick(game, update, input) {
  game.threats.length = 0;
  game._spawnTimer = 999;
  update(FIXED_DT, input);
}

// Hold fire until overheated (or bail after `maxFrames`). Returns frames taken.
function fireUntilOverheat(game, update, input, maxFrames = 60 * 8) {
  let frames = 0;
  while (!game._overheated && frames < maxFrames) {
    tick(game, update, input);
    frames++;
  }
  return frames;
}

test('overheat: fresh run has zero heat, not overheated, and exposes tunables (AC-1, AC-13)', () => {
  const { game, start, snapshot } = createGame({ seed: 1 });
  start();
  assert.equal(game.state, STATES.PLAYING);
  assert.equal(game._heat, 0);
  assert.equal(game._overheated, false);
  // Tunable contract the hook re-exports.
  assert.equal(TUNABLES.HEAT_MAX, 1.0);
  assert.equal(TUNABLES.HEAT_PER_SHOT, 0.07);
  assert.equal(TUNABLES.HEAT_COOL_RATE, 0.5);
  // snapshot() surfaces the observable fields.
  const s = snapshot();
  assert.equal(s.heat, 0);
  assert.equal(s.overheated, false);
});

test('overheat: holding fire raises heat monotonically and never cools while held (AC-2, AC-5)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  const input = fakeInput(['fire']);
  let prev = game._heat;
  let rose = false;
  for (let i = 0; i < 30; i++) {
    tick(game, update, input);
    assert.ok(game._heat >= prev - 1e-9, `heat must not drop while firing (was ${prev}, now ${game._heat})`);
    if (game._heat > prev) rose = true;
    prev = game._heat;
  }
  assert.ok(rose, 'heat should rise while fire is held');
  assert.ok(game._heat > 0);
});

test('overheat: continuous fire overheats within 4s and locks firing (AC-3, AC-4)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  const input = fakeInput(['fire']);
  const frames = fireUntilOverheat(game, update, input);
  assert.ok(game._overheated, 'should be overheated');
  assert.equal(game._heat, TUNABLES.HEAT_MAX);
  const seconds = frames * FIXED_DT;
  assert.ok(seconds <= 4.0, `overheat must occur within 4s of game time (took ${seconds.toFixed(2)}s)`);

  // While overheated with fire still held: no NEW bullets, heat pinned at max.
  const before = game.bullets.length;
  for (let i = 0; i < 60; i++) tick(game, update, input);
  assert.ok(game.bullets.length <= before, 'no new bullets may spawn while overheated');
  assert.equal(game._heat, TUNABLES.HEAT_MAX, 'heat stays at max while fire held during lockout');
  assert.equal(game._overheated, true);
});

test('overheat: releasing fire cools max→zero in exactly 2s; lockout clears only at zero (AC-6, AC-7, AC-8)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  fireUntilOverheat(game, update, start && fakeInput(['fire']));
  assert.equal(game._overheated, true);
  assert.equal(game._heat, TUNABLES.HEAT_MAX);

  const idle = fakeInput([]);
  // After 1.0s (60 ticks) heat should be ~0.5, and still locked out.
  for (let i = 0; i < 60; i++) tick(game, update, idle);
  assert.ok(Math.abs(game._heat - 0.5) <= 0.02, `heat ~0.5 after 1s, got ${game._heat}`);
  assert.equal(game._overheated, true, 'lockout persists while heat > 0');

  // After a further 1.0s (total 2.0s) heat has effectively reached zero.
  for (let i = 0; i < 60; i++) tick(game, update, idle);
  assert.ok(game._heat <= 0.005, `heat ~0 after 2s, got ${game._heat}`);
  // The lockout flag clears once heat is floored to exactly 0. Float dust
  // (~1e-15 at the 2.0s mark) drains to 0 within one more 60Hz tick (~17ms) —
  // imperceptible, and the gun stays unusable for the full 2 seconds as required.
  let extra = 0;
  while (game._overheated && extra < 5) { tick(game, update, idle); extra++; }
  assert.equal(game._overheated, false, 'lockout clears just after 2s, once heat hits 0');
  assert.equal(game._heat, 0);
  assert.ok(extra <= 2, `lockout should clear within ~2 ticks of the 2s mark, took ${extra}`);

  // Firing resumes: holding fire again raises heat within one cooldown (~14 frames).
  const fire = fakeInput(['fire']);
  let f = 0;
  while (game._heat === 0 && f < 20) { tick(game, update, fire); f++; }
  assert.ok(game._heat > 0, 'gun fires again after lockout clears');
});

test('overheat: never a frame where cleared-but-hot (AC-7 invariant)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  fireUntilOverheat(game, update, fakeInput(['fire']));
  const idle = fakeInput([]);
  for (let i = 0; i < 140; i++) {
    tick(game, update, idle);
    if (!game._overheated) assert.ok(game._heat <= 0.01, `overheated cleared while heat=${game._heat}`);
  }
  assert.equal(game._overheated, false);
});

test('overheat: restart clears heat and overheated (AC-9)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  fireUntilOverheat(game, update, fakeInput(['fire']));
  assert.equal(game._overheated, true);
  // A run ends, then the player restarts.
  game.state = STATES.GAMEOVER;
  start();
  assert.equal(game.state, STATES.PLAYING);
  assert.equal(game._heat, 0, 'resetRun zeroes heat');
  assert.equal(game._overheated, false, 'resetRun clears overheated');
});
