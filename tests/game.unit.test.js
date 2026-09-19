// Pure-logic unit tests (node --test). Cover deterministic gameplay math;
// browser/canvas/input behavior is covered by the agent-browser scenarios.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  STATES,
  TUNABLES,
  PILLAR_KEYS,
  PILLAR_CALLOUTS,
  FIXED_DT,
  HEIGHT,
} from '../src/game/game.js';

// A tiny fake input matching the input-system interface.
function fakeInput(held = [], presses = []) {
  const down = new Set(held);
  const pressed = new Set(presses);
  return {
    isDown: (a) => down.has(a),
    consumePress: (a) => (pressed.has(a) ? (pressed.delete(a), true) : false),
    endFrame: () => pressed.clear(),
    set: (a, v) => (v ? down.add(a) : down.delete(a)),
    press: (a) => pressed.add(a),
  };
}

// Place a threat at a position above the player so a fired bullet will hit it.
function placeThreatAbovePlayer(game, pillar = 'costOptimization') {
  game.threats.push({
    type: 'idleGpu',
    name: 'Idle GPU cluster',
    pillar,
    x: game.player.x,
    y: game.player.y - 40,
    w: 30,
    h: 22,
  });
}

// Place a threat already past the breach line (bottom edge > HEIGHT).
function placeBreach(game, pillar = 'costOptimization') {
  game.threats.push({
    type: 'idleGpu',
    name: 'Idle GPU cluster',
    pillar,
    x: 240,
    y: HEIGHT + 1, // bottom edge = HEIGHT + 1 + 11 > HEIGHT
    w: 30,
    h: 22,
  });
}

// ── Slice 1 tests (unchanged) ──────────────────────────────────────────────

test('starts in MENU with all six pillars at 0 and cloudHealth === START_HEALTH', () => {
  const { game } = createGame({ seed: 1 });
  assert.equal(game.state, STATES.MENU);
  assert.deepEqual([...Object.keys(game.pillars)].sort(), [...PILLAR_KEYS].sort());
  for (const k of PILLAR_KEYS) assert.equal(game.pillars[k], 0);
  assert.equal(game.cloudHealth, TUNABLES.START_HEALTH);
  assert.equal(game.score, 0);
});

test('fire/start press transitions MENU -> PLAYING', () => {
  const { game, update } = createGame({ seed: 1 });
  update(1 / 60, fakeInput([], ['fire']));
  assert.equal(game.state, STATES.PLAYING);
  assert.ok(game.player, 'player entity spawned');
});

test('pause toggles PLAYING <-> PAUSED and freezes updates', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  update(1 / 60, fakeInput([], ['pause']));
  assert.equal(game.state, STATES.PAUSED);
  update(1 / 60, fakeInput(['left']));
  const p = game.player.x;
  update(1 / 60, fakeInput(['left']));
  assert.equal(game.player.x, p, 'player does not move while paused');
  update(1 / 60, fakeInput([], ['pause']));
  assert.equal(game.state, STATES.PLAYING);
});

test('holding left moves the player left; clamped to bounds', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  const x0 = game.player.x;
  for (let i = 0; i < 10; i++) update(1 / 60, fakeInput(['left']));
  assert.ok(game.player.x < x0, 'moved left');
  for (let i = 0; i < 600; i++) update(1 / 60, fakeInput(['left']));
  assert.ok(game.player.x >= game.player.w / 2, 'clamped at left wall');
});

test("a hit fills exactly the threat's own pillar by FILL_GAIN; others unchanged", () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.threats.length = 0;
  game._spawnTimer = 999; // prevent natural spawns interfering
  const target = {
    type: 'idleGpu', name: 'Idle GPU cluster', pillar: 'costOptimization',
    x: game.player.x, y: game.player.y - 40, w: 30, h: 22,
  };
  game.threats.push(target);
  const before = { ...game.pillars };
  for (let i = 0; i < 30; i++) update(1 / 60, fakeInput(['fire']));

  assert.equal(
    game.pillars.costOptimization,
    Math.min(100, before.costOptimization + TUNABLES.FILL_GAIN),
  );
  for (const k of PILLAR_KEYS) {
    if (k === 'costOptimization') continue;
    assert.equal(game.pillars[k], before[k], `${k} unchanged`);
  }
  assert.ok(!game.threats.includes(target), 'hit threat removed');
  assert.equal(game.lastFiling.pillar, 'costOptimization');
  assert.ok(game.lastFiling.text.includes('→'), 'filing tag uses arrow form');
  assert.ok(game.lastFiling.text.includes('Cost Optimization'), 'filing names destination pillar');
});

test('score equals sum(pillars) × combo every frame (no lag)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.threats.length = 0;
  game._spawnTimer = 999;
  game.threats.push({
    type: 'publicBucket', name: 'Public S3 bucket', pillar: 'security',
    x: game.player.x, y: game.player.y - 40, w: 30, h: 22,
  });
  for (let i = 0; i < 30; i++) {
    update(1 / 60, fakeInput(['fire']));
    const sum = PILLAR_KEYS.reduce((s, k) => s + game.pillars[k], 0);
    assert.equal(game.score, sum * game.combo);
  }
});

test('deterministic threat pillar spawn order under fixed seed', () => {
  const spawnOrder = () => {
    const { game, update, start } = createGame({ seed: 999 });
    start();
    const seen = [];
    for (let i = 0; i < 600 && seen.length < 5; i++) {
      update(1 / 60, fakeInput());
      while (seen.length < game.threats.length) {
        seen.push(game.threats[seen.length].pillar);
      }
    }
    return seen;
  };
  assert.deepEqual(spawnOrder(), spawnOrder(), 'same seed => same pillar spawn order');
});

test('run is deterministic for a fixed seed and identical inputs', () => {
  const play = () => {
    const { game, update, start } = createGame({ seed: 999 });
    start();
    for (let i = 0; i < 300; i++) {
      const held = i % 2 ? ['right', 'fire'] : ['left', 'fire'];
      update(1 / 60, fakeInput(held));
    }
    return { pillars: { ...game.pillars }, cloudHealth: game.cloudHealth, threats: game.threats.length };
  };
  assert.deepEqual(play(), play(), 'same seed + inputs => same outcome');
});

// ── Slice 2 tests ──────────────────────────────────────────────────────────

// AC-1, AC-2 ── breach damage
test('breach decreases cloudHealth by CLOUD_DAMAGE and pillar by BREACH_LOSS', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeBreach(game, 'costOptimization');
  const prevHealth = game.cloudHealth;
  const prevPillar = game.pillars.costOptimization;
  update(FIXED_DT, fakeInput());
  assert.equal(game.cloudHealth, Math.max(0, prevHealth - TUNABLES.CLOUD_DAMAGE), 'cloudHealth reduced');
  assert.equal(
    game.pillars.costOptimization,
    Math.max(0, prevPillar - TUNABLES.BREACH_LOSS),
    'pillar reduced',
  );
});

test('breach damage applies only to the breaching threat pillar — no other pillar changes', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeBreach(game, 'security');
  const before = { ...game.pillars };
  update(FIXED_DT, fakeInput());
  for (const k of PILLAR_KEYS) {
    if (k === 'security') continue;
    assert.equal(game.pillars[k], before[k], `${k} unchanged`);
  }
});

test('cloudHealth is floored at 0 (AC-2)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.cloudHealth = 5; // less than CLOUD_DAMAGE (10)
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeBreach(game, 'costOptimization');
  update(FIXED_DT, fakeInput());
  assert.equal(game.cloudHealth, 0, 'cloudHealth floored at 0');
});

// AC-3, AC-4 ── combo multiplier
test('combo starts at 1, increments on consecutive hits, resets to 1 on breach', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  assert.equal(game.combo, 1, 'combo starts at 1');

  // First hit → combo 2
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'costOptimization');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));
  assert.equal(game.combo, 2, 'after first hit combo === 2');

  // Second consecutive hit → combo 3
  game.threats.length = 0;
  game.bullets.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'security');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));
  assert.equal(game.combo, 3, 'after second consecutive hit combo === 3');

  // Breach → combo resets to 1
  game.threats.length = 0;
  game.bullets.length = 0;
  game._spawnTimer = 999;
  placeBreach(game, 'reliability');
  update(FIXED_DT, fakeInput());
  assert.equal(game.combo, 1, 'breach resets combo to 1');
});

// AC-5 ── score invariant is already covered by the generic score test above.

// AC-6 ── gameover when cloudHealth reaches 0
test('cloudHealth reaching 0 transitions state to gameover in same update (AC-6)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.cloudHealth = TUNABLES.CLOUD_DAMAGE; // exactly one breach away from 0
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeBreach(game, 'costOptimization');
  update(FIXED_DT, fakeInput());
  assert.equal(game.cloudHealth, 0, 'cloudHealth hit 0');
  assert.equal(game.state, STATES.GAMEOVER, 'state is gameover in same update');
});

// AC-8 ── STATES includes victory
test('STATES includes victory (AC-8)', () => {
  assert.equal(STATES.VICTORY, 'victory');
});

// AC-9 ── victory when all pillars >= WIN_THRESHOLD
test('all six pillars >= WIN_THRESHOLD transitions state to victory (AC-9)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  // Five pillars already at threshold; the sixth (sustainability) just below.
  for (const k of PILLAR_KEYS.slice(0, 5)) game.pillars[k] = TUNABLES.WIN_THRESHOLD;
  game.pillars['sustainability'] = TUNABLES.WIN_THRESHOLD - 1;
  game.threats.length = 0;
  game._spawnTimer = 999;
  // Hitting the sustainability threat pushes it over WIN_THRESHOLD.
  placeThreatAbovePlayer(game, 'sustainability');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));
  assert.equal(game.state, STATES.VICTORY, 'state transitions to victory');
});

// AC-11 ── final score on victory = sum(pillars) * combo
test('final score on victory equals sum(pillars) * combo (AC-11)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  // Five pillars at threshold; sustainability just below.
  for (const k of PILLAR_KEYS.slice(0, 5)) game.pillars[k] = TUNABLES.WIN_THRESHOLD;
  game.pillars['sustainability'] = TUNABLES.WIN_THRESHOLD - 1;
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'sustainability');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));
  assert.equal(game.state, STATES.VICTORY, 'state is victory');
  const sum = PILLAR_KEYS.reduce((s, k) => s + game.pillars[k], 0);
  assert.equal(game.score, sum * game.combo, 'score = sum * combo at victory');
});

// AC-12, AC-13, AC-14 ── filledPillars & lastCallout
test('filledPillars is empty at round start; pillar key added on first crossing (AC-12)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  assert.deepEqual(game.filledPillars, [], 'empty at round start');

  game.pillars.costOptimization = TUNABLES.WIN_THRESHOLD - 1;
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'costOptimization');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));

  assert.ok(game.filledPillars.includes('costOptimization'), 'pillar key added on crossing');
});

test('lastCallout set with pillar, text, and frame on first crossing (AC-13)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.pillars.costOptimization = TUNABLES.WIN_THRESHOLD - 1;
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'costOptimization');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));

  assert.ok(game.lastCallout, 'lastCallout is set');
  assert.equal(game.lastCallout.pillar, 'costOptimization');
  assert.ok(
    game.lastCallout.text.includes('COST OPTIMIZED'),
    'text contains celebratory phrase',
  );
  assert.equal(typeof game.lastCallout.frame, 'number', 'frame is a number');
  assert.ok(game.lastCallout.frame > 0, 'frame > 0');
});

test('filledPillars stickiness: re-crossing after dip does NOT re-fire lastCallout (AC-14)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.pillars.costOptimization = TUNABLES.WIN_THRESHOLD - 1;
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'costOptimization');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));

  assert.ok(game.filledPillars.includes('costOptimization'));
  const firstCalloutFrame = game.lastCallout.frame;

  // Manually dip the pillar below the threshold.
  game.pillars.costOptimization = TUNABLES.WIN_THRESHOLD - 1;

  // Re-cross via another hit.
  game.threats.length = 0;
  game.bullets.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, 'costOptimization');
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));

  // No duplicate in filledPillars.
  assert.equal(
    game.filledPillars.filter((k) => k === 'costOptimization').length,
    1,
    'no duplicate in filledPillars',
  );
  // lastCallout.frame unchanged (callout not re-fired).
  assert.equal(game.lastCallout.frame, firstCalloutFrame, 'lastCallout not re-fired');
});

// AC-16 ── final pillar callout text contains "WELL-ARCHITECTED"
test('final pillar crossing: lastCallout.text contains WELL-ARCHITECTED (AC-16)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  // Fill five pillars directly (below threshold so they haven't fired callouts).
  for (const k of PILLAR_KEYS.slice(0, 5)) {
    game.pillars[k] = TUNABLES.WIN_THRESHOLD - 1;
    // Manually fire each callout so the set is at 5 (simulate prior crossings).
    game._filledPillarsSet.add(k);
    game.filledPillars.push(k);
    game.pillars[k] = TUNABLES.WIN_THRESHOLD; // actually cross the line
  }
  // The 6th pillar is not yet in the set.
  const lastKey = PILLAR_KEYS[5]; // 'sustainability'
  game.pillars[lastKey] = TUNABLES.WIN_THRESHOLD - 1;
  game.threats.length = 0;
  game._spawnTimer = 999;
  placeThreatAbovePlayer(game, lastKey);
  for (let i = 0; i < 30; i++) update(FIXED_DT, fakeInput(['fire']));

  assert.ok(game.lastCallout, 'lastCallout set');
  assert.ok(
    game.lastCallout.text.includes('WELL-ARCHITECTED'),
    'final callout text contains WELL-ARCHITECTED',
  );
  assert.equal(game.state, STATES.VICTORY, 'state transitions to victory on final pillar');
});

// AC-17, AC-18 ── wave escalation
test('effective spawn interval decreases over the round (AC-17)', () => {
  // At frame 1 vs a much later frame, effectiveSpawnInterval should be smaller.
  // We verify this by inspecting the _spawnTimer reset values after spawns.
  // Simplest approach: run two fresh games for very different numbers of frames
  // and compare the _spawnTimer after the first spawn resets in each.
  function spawnIntervalAt(frames) {
    const { game, update, start } = createGame({ seed: 42 });
    start();
    // Advance to near the target frame without spawning (high spawnTimer).
    game._spawnTimer = 999;
    game.frame = frames - 1; // next update will be frame `frames`
    // Run one tick to trigger a spawn reset — set _spawnTimer to 0 just before.
    game._spawnTimer = 0;
    update(FIXED_DT, fakeInput());
    return game._spawnTimer; // will be the new effectiveSpawnInterval
  }
  const early = spawnIntervalAt(1);
  const late  = spawnIntervalAt(600);
  assert.ok(late < early, `spawn interval decreases over time (${late} < ${early})`);
});

test('effective threat speed increases over the round (AC-18)', () => {
  // Two threats placed at y=0; compare how far they travel in 1 tick at frame 1 vs frame 600.
  function travelInOneTick(startFrame) {
    const { game, update, start } = createGame({ seed: 42 });
    start();
    game.threats.length = 0;
    game._spawnTimer = 999;
    game.frame = startFrame - 1;
    game.threats.push({ type: 'idleGpu', name: 'test', pillar: 'costOptimization',
                        x: 100, y: 0, w: 30, h: 22 });
    update(FIXED_DT, fakeInput());
    return game.threats.length > 0 ? game.threats[0].y : null;
  }
  const earlyY  = travelInOneTick(1);
  const lateY   = travelInOneTick(600);
  assert.ok(
    lateY > earlyY,
    `threat descends faster later in the round (${lateY} > ${earlyY})`,
  );
});

// AC-19 ── escalation resets on restart
test('escalation resets on restart: spawn timer is near base (not capped at min) after restart (AC-19)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  // Advance 600 frames (spawnTimer high to suppress spawning) to build up escalation.
  game._spawnTimer = 999;
  for (let i = 0; i < 600; i++) update(FIXED_DT, fakeInput());

  // Restart from gameover state.
  game.state = STATES.GAMEOVER;
  update(FIXED_DT, fakeInput([], ['fire']));
  // resetRun() is called inside start() which is called from within update().
  // game.frame is reset to 0 by resetRun (frame++ already fired for the gameover tick).
  assert.equal(game.state, STATES.PLAYING, 'restarted from gameover');
  assert.equal(game.frame, 0, 'frame is 0 right after resetRun inside the gameover-branch update');

  // Run one playing tick so the spawn fires and _spawnTimer is set to effectiveSpawnInterval.
  game._spawnTimer = 0; // force a spawn on the very next tick
  update(FIXED_DT, fakeInput());
  // frame=1, gameTime=1*FIXED_DT ≈ 0.017s → effectiveInterval ≈ 0.9 - 0.04*0.017 ≈ 0.899
  // That is far above MIN_SPAWN_INTERVAL (0.3), confirming the ramp reset to zero.
  assert.ok(
    game._spawnTimer > TUNABLES.MIN_SPAWN_INTERVAL * 1.5,
    `spawn timer after restart (${game._spawnTimer.toFixed(4)}) should be near base, far above min cap`,
  );
});

// AC-20, AC-21 ── restart from gameover and victory
test('Space from gameover -> playing within one update (AC-20)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  game.state = STATES.GAMEOVER;
  update(FIXED_DT, fakeInput([], ['fire']));
  assert.equal(game.state, STATES.PLAYING, 'gameover -> playing on fire press');
});

test('Space from victory -> playing within one update (AC-21)', () => {
  const { game, update } = createGame({ seed: 1 });
  game.state = STATES.VICTORY;
  // Need player initialized — call start first for a clean slate, then force victory.
  const { start } = createGame({ seed: 1 });
  // Fresh game, set state to victory manually.
  const g2 = createGame({ seed: 1 });
  g2.game.state = STATES.VICTORY;
  g2.update(FIXED_DT, fakeInput([], ['fire']));
  assert.equal(g2.game.state, STATES.PLAYING, 'victory -> playing on fire press');
});

// AC-22 ── after restart: pillars 0, cloudHealth START_HEALTH, filledPillars empty,
//          lastCallout null, combo 1
test('after restart: all state resets correctly (AC-22)', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  // Dirty the state.
  game.combo = 5;
  game.cloudHealth = 20;
  for (const k of PILLAR_KEYS) game.pillars[k] = 50;
  game._filledPillarsSet.add('security');
  game.filledPillars.push('security');
  game.lastCallout = { pillar: 'security', text: 'test', frame: 10 };
  game.state = STATES.GAMEOVER;

  update(FIXED_DT, fakeInput([], ['fire']));
  assert.equal(game.state, STATES.PLAYING);
  assert.equal(game.combo, 1, 'combo reset to 1');
  assert.equal(game.cloudHealth, TUNABLES.START_HEALTH, 'cloudHealth reset');
  for (const k of PILLAR_KEYS) assert.equal(game.pillars[k], 0, `${k} reset to 0`);
  assert.deepEqual(game.filledPillars, [], 'filledPillars empty');
  assert.equal(game.lastCallout, null, 'lastCallout null');
});

// Victory takes precedence over gameover in same tick
test('victory takes precedence over gameover when both happen in same tick', () => {
  const { game, update, start } = createGame({ seed: 1 });
  start();
  // Five pillars at threshold; sustainability just below.
  for (const k of PILLAR_KEYS.slice(0, 5)) game.pillars[k] = TUNABLES.WIN_THRESHOLD;
  game.pillars['sustainability'] = TUNABLES.WIN_THRESHOLD - 1; // one hit away
  // cloudHealth at exactly CLOUD_DAMAGE — one breach would trigger gameover.
  game.cloudHealth = TUNABLES.CLOUD_DAMAGE;
  game.threats.length = 0;
  game.bullets.length = 0;
  game._spawnTimer = 999;

  // Pre-place a bullet overlapping the hit threat so the hit fires this tick
  // (no need to wait for bullet travel across multiple frames).
  const hitY = 300;
  game.threats.push({ type: 'zombie', name: 'Zombie resources', pillar: 'sustainability',
                      x: 200, y: hitY, w: 30, h: 22 });
  game.bullets.push({ x: 200, y: hitY, w: 4, h: 12 });

  // Also place a breach threat — same tick will drain cloudHealth to 0.
  game.threats.push({ type: 'idleGpu', name: 'Idle GPU cluster', pillar: 'costOptimization',
                      x: 100, y: HEIGHT + 1, w: 30, h: 22 });

  // Single tick: hit fills last pillar → victory (Phase 2); breach drops health to 0
  // but gameover check (Phase 4) is skipped because state is already VICTORY.
  update(FIXED_DT, fakeInput());
  assert.equal(game.state, STATES.VICTORY, 'victory takes precedence over gameover');
});
