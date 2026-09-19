// Core game: explicit state machine + fixed-timestep update, variable-timestep
// render. Gameplay logic never depends on frame rate (accumulated dt).
//
// "Well-Architected Defender" (Slice 2): stakes & payoff layer.
// Breach damage, combo multiplier, gameover/victory states, per-pillar
// call-outs, wave escalation, and restart hygiene.

import { createRng } from '../rng.js';

export const STATES = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
  VICTORY: 'victory',
};

// Owned here so game-logic time (frame * FIXED_DT) is deterministic and
// never tied to wall-clock jitter. main.js imports this instead of
// re-declaring its own copy.
export const FIXED_DT = 1 / 60; // seconds per logic tick

// Logical play-field size (exported so tests/renderer read one source of truth).
// Landscape-friendly: the renderer composites this field into a 16:9 TV canvas
// alongside the standing-pillar bank.
export const WIDTH = 820;
export const HEIGHT = 600;
const PLAYER_SPEED = 440;   // px/sec — tuned for the wider field
const BULLET_SPEED = 640;   // px/sec
const FIRE_COOLDOWN = 0.22; // sec
const BASE_THREAT_SPEED = 90;    // px/sec descent at round start
const BASE_SPAWN_INTERVAL = 0.9; // sec between spawns at round start

// Single tunables object. All escalation caps live here — no inline magic numbers.
export const TUNABLES = {
  FILL_GAIN: 8,             // meter added to a threat's pillar on hit (capped at 100)
  START_HEALTH: 100,        // initial cloud health
  BREACH_LOSS: 6,           // pillar loss when a threat breaches (floored at 0)
  CLOUD_DAMAGE: 10,         // cloud health lost per breach
  WIN_THRESHOLD: 80,        // per-pillar well-architected line
  MIN_SPAWN_INTERVAL: 0.3,  // fastest spawn interval (sec) — escalation cap
  MAX_THREAT_SPEED: 240,    // fastest threat descent (px/s) — escalation cap
  SPAWN_RAMP: 0.04,         // interval reduction per second of game-logic time
  SPEED_RAMP: 5,            // px/s speed increase per second of game-logic time
};

// The six Well-Architected pillars — canonical key order for legend + HUD.
export const PILLAR_KEYS = [
  'operationalExcellence',
  'security',
  'reliability',
  'performanceEfficiency',
  'costOptimization',
  'sustainability',
];

// Plain-language display names shown in the legend, HUD, and filing tag.
export const PILLAR_NAMES = {
  operationalExcellence: 'Operational Excellence',
  security: 'Security',
  reliability: 'Reliability',
  performanceEfficiency: 'Performance Efficiency',
  costOptimization: 'Cost Optimization',
  sustainability: 'Sustainability',
};

// Celebratory call-out fired the first time each pillar crosses WIN_THRESHOLD.
// Copy from §5.1 of the spec — tunable table kept here, not in render.
export const PILLAR_CALLOUTS = {
  operationalExcellence: '🎛️ SMOOTH OPERATOR! Nothing slips past.',
  security: '🛡️ LOCKED DOWN! The hackers went home.',
  reliability: '🧯 ROCK SOLID! Stays up when it counts.',
  performanceEfficiency: '⚡ BLAZING FAST! Zoom zoom.',
  costOptimization: '💰 COST OPTIMIZED! Your wallet thanks you.',
  sustainability: '🌱 GREEN MACHINE! Lean and clean.',
};
const VICTORY_CALLOUT = '🏆 WELL-ARCHITECTED! Your cloud is bulletproof.';

// Threat catalog — each maps to exactly one pillar. The game knows the mapping;
// the player never has to. ~2 per pillar with plain-language labels.
export const THREAT_CATALOG = [
  { type: 'idleGpu',        name: 'Idle GPU cluster',     pillar: 'costOptimization' },
  { type: 'overProvDb',     name: 'Over-provisioned DB',  pillar: 'costOptimization' },
  { type: 'publicBucket',   name: 'Public S3 bucket',     pillar: 'security' },
  { type: 'leakedKey',      name: 'Leaked API key',       pillar: 'security' },
  { type: 'trafficSurge',   name: 'Traffic surge',        pillar: 'performanceEfficiency' },
  { type: 'slowQuery',      name: 'Slow query storm',     pillar: 'performanceEfficiency' },
  { type: 'azOutage',       name: 'AZ outage',            pillar: 'reliability' },
  { type: 'cascade',        name: 'Cascading failure',    pillar: 'reliability' },
  { type: 'alertBlindness', name: 'Alert blindness',      pillar: 'operationalExcellence' },
  { type: 'configDrift',    name: 'Config drift',         pillar: 'operationalExcellence' },
  { type: 'zombie',         name: 'Zombie resources',     pillar: 'sustainability' },
  { type: 'inefficient',    name: 'Inefficient workload', pillar: 'sustainability' },
];

function freshPillars() {
  const p = {};
  for (const k of PILLAR_KEYS) p[k] = 0;
  return p;
}

export function createGame({ seed = 12345 } = {}) {
  const rng = createRng(seed);

  const game = {
    width: WIDTH,
    height: HEIGHT,
    state: STATES.MENU,
    score: 0,              // derived: sum(pillars) × combo
    pillars: freshPillars(),
    cloudHealth: TUNABLES.START_HEALTH,
    combo: 1,              // consecutive-hit multiplier
    frame: 0,
    player: null,
    bullets: [],
    threats: [],
    lastFiling: null,      // { threat, pillar, text, frame } | null — most recent hit
    lastCallout: null,     // { pillar, text, frame } | null — most recent pillar fill
    filledPillars: [],     // array of pillar keys that have crossed WIN_THRESHOLD this round
    _filledPillarsSet: new Set(), // sticky set backing filledPillars (never shrinks in a round)
    _fireTimer: 0,
    _spawnTimer: 0,
    seed,
  };

  // score is a pure readout — recompute whenever pillars or combo change.
  function recomputeScore() {
    let sum = 0;
    for (const k of PILLAR_KEYS) sum += game.pillars[k];
    game.score = sum * game.combo;
  }

  function resetRun() {
    rng.reseed(seed);
    game.pillars = freshPillars();
    game.cloudHealth = TUNABLES.START_HEALTH;
    game.combo = 1;
    game.frame = 0;
    game.bullets = [];
    game.threats = [];
    game.lastFiling = null;
    game.lastCallout = null;
    game.filledPillars = [];
    game._filledPillarsSet = new Set();
    game._fireTimer = 0;
    game._spawnTimer = 0;
    game.player = { x: WIDTH / 2, y: HEIGHT - 48, w: 34, h: 20 };
    recomputeScore();
  }

  function spawnThreat() {
    const spec = THREAT_CATALOG[rng.int(0, THREAT_CATALOG.length - 1)];
    const w = 30, h = 22;
    game.threats.push({
      type: spec.type,
      name: spec.name,
      pillar: spec.pillar,
      x: rng.range(w, WIDTH - w),
      y: -h,
      w,
      h,
    });
  }

  function fire() {
    const p = game.player;
    game.bullets.push({ x: p.x, y: p.y - p.h, w: 4, h: 12 });
    game._fireTimer = FIRE_COOLDOWN;
  }

  function overlaps(a, b) {
    return Math.abs(a.x - b.x) * 2 < a.w + b.w &&
           Math.abs(a.y - b.y) * 2 < a.h + b.h;
  }

  // --- state transitions ---
  function start() {
    if (
      game.state === STATES.MENU ||
      game.state === STATES.GAMEOVER ||
      game.state === STATES.VICTORY
    ) {
      resetRun();
      game.state = STATES.PLAYING;
    }
  }

  function togglePause() {
    if (game.state === STATES.PLAYING)  game.state = STATES.PAUSED;
    else if (game.state === STATES.PAUSED) game.state = STATES.PLAYING;
  }

  // --- per-tick update (fixed dt in seconds) ---
  function update(dt, input) {
    game.frame++;

    // Global-ish controls available across states.
    if (input.consumePress('pause')) togglePause();

    // Accept start/fire in menu, gameover, or victory to restart.
    if (
      game.state === STATES.MENU ||
      game.state === STATES.GAMEOVER ||
      game.state === STATES.VICTORY
    ) {
      if (input.consumePress('fire') || input.consumePress('start')) start();
      recomputeScore();
      return;
    }
    if (game.state !== STATES.PLAYING) { recomputeScore(); return; } // paused: freeze

    // --- Move player ---
    const p = game.player;
    if (input.isDown('left'))  p.x -= PLAYER_SPEED * dt;
    if (input.isDown('right')) p.x += PLAYER_SPEED * dt;
    p.x = Math.max(p.w / 2, Math.min(WIDTH - p.w / 2, p.x));

    // --- Fire ---
    game._fireTimer -= dt;
    if (input.isDown('fire') && game._fireTimer <= 0) fire();

    // --- Move bullets (remove those that exit the top) ---
    for (const b of game.bullets) b.y -= BULLET_SPEED * dt;
    game.bullets = game.bullets.filter((b) => b.y + b.h > 0);

    // --- Escalated spawn interval and threat speed (game-logic time only) ---
    const gameTime = game.frame * FIXED_DT;
    const effectiveSpawnInterval = Math.max(
      TUNABLES.MIN_SPAWN_INTERVAL,
      BASE_SPAWN_INTERVAL - TUNABLES.SPAWN_RAMP * gameTime,
    );
    const effectiveThreatSpeed = Math.min(
      TUNABLES.MAX_THREAT_SPEED,
      BASE_THREAT_SPEED + TUNABLES.SPEED_RAMP * gameTime,
    );

    // --- Spawn + move threats ---
    game._spawnTimer -= dt;
    if (game._spawnTimer <= 0) {
      spawnThreat();
      game._spawnTimer = effectiveSpawnInterval;
    }
    for (const e of game.threats) e.y += effectiveThreatSpeed * dt;

    // --- Phase 1: Bullet ↔ threat collisions (BEFORE breach processing so combo
    //     increments happen before any breach reset in the same tick). ---
    for (const e of game.threats) {
      for (const b of game.bullets) {
        if (!b.dead && !e.dead && overlaps(b, e)) {
          b.dead = true;
          e.dead = true;

          // Auto-file the threat into its own pillar — no category gate.
          game.pillars[e.pillar] = Math.min(100, game.pillars[e.pillar] + TUNABLES.FILL_GAIN);
          game.combo += 1;

          game.lastFiling = {
            threat: e.name,
            pillar: e.pillar,
            text: `${e.name} → ${PILLAR_NAMES[e.pillar]}`,
            frame: game.frame,
            x: e.x, // hit location (play-field coords) — lets the renderer place effects
            y: e.y,
          };

          // Per-pillar call-out: fires at most once per round (sticky set).
          if (
            game.pillars[e.pillar] >= TUNABLES.WIN_THRESHOLD &&
            !game._filledPillarsSet.has(e.pillar)
          ) {
            game._filledPillarsSet.add(e.pillar);
            game.filledPillars.push(e.pillar);
            const allFilled = game._filledPillarsSet.size === PILLAR_KEYS.length;
            const calloutText = allFilled ? VICTORY_CALLOUT : PILLAR_CALLOUTS[e.pillar];
            game.lastCallout = { pillar: e.pillar, text: calloutText, frame: game.frame };
          }
        }
      }
    }

    // --- Phase 2: Victory check (before breach so victory takes precedence when
    //     both happen in the same tick). ---
    if (game.state === STATES.PLAYING) {
      let allFilled = true;
      for (const k of PILLAR_KEYS) {
        if (game.pillars[k] < TUNABLES.WIN_THRESHOLD) { allFilled = false; break; }
      }
      if (allFilled) game.state = STATES.VICTORY;
    }

    // --- Phase 3: Breach processing — threats whose bottom edge passed HEIGHT. ---
    let breachOccurred = false;
    for (const e of game.threats) {
      if (!e.dead && e.y + e.h / 2 > HEIGHT) {
        e.dead = true;
        game.pillars[e.pillar] = Math.max(0, game.pillars[e.pillar] - TUNABLES.BREACH_LOSS);
        game.cloudHealth -= TUNABLES.CLOUD_DAMAGE;
        breachOccurred = true;
      }
    }
    if (breachOccurred) game.combo = 1;
    game.cloudHealth = Math.max(0, game.cloudHealth); // AC-2: floor at 0

    // --- Phase 4: Gameover check (skipped if state already flipped to VICTORY). ---
    if (game.state === STATES.PLAYING && game.cloudHealth <= 0) {
      game.state = STATES.GAMEOVER;
    }

    game.bullets = game.bullets.filter((b) => !b.dead);
    game.threats = game.threats.filter((e) => !e.dead);

    recomputeScore();
  }

  return {
    game,
    update,
    start,
    togglePause,
    // Snapshot for the dev/test inspection hook — plain data only.
    snapshot: () => ({
      state: game.state,
      score: game.score,
      pillars: { ...game.pillars },
      cloudHealth: game.cloudHealth,
      combo: game.combo,
      frame: game.frame,
      lastFiling: game.lastFiling ? { ...game.lastFiling } : null,
      lastCallout: game.lastCallout ? { ...game.lastCallout } : null,
      filledPillars: [...game.filledPillars],
      threats: game.threats.map((e) => ({ type: e.type, pillar: e.pillar, x: e.x, y: e.y })),
      entities: [
        ...(game.player ? [{ type: 'player', x: game.player.x, y: game.player.y }] : []),
        ...game.bullets.map((b) => ({ type: 'bullet', x: b.x, y: b.y })),
        ...game.threats.map((e) => ({ type: 'threat', x: e.x, y: e.y })),
      ],
    }),
  };
}
