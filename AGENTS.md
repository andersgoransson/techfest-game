# AGENTS.md

Guidance for AI agents working in this repository. This is a **browser-based arcade game**. Testing is done by driving the running game in a real browser with **agent-browser**, not just unit tests.

## Project overview

- A browser-based arcade game that runs entirely client-side.
- Rendering target: HTML5 `<canvas>` (game loop via `requestAnimationFrame`).
- No server round-trips during gameplay — everything runs in the browser.
- Keep the playable build launchable from a single static entry point (`index.html`).

## Repository layout

> The repo is currently a clean slate. Follow this layout as files are added; update this section if the structure diverges.

```
index.html          # Entry point — loads the game
src/
  main.js           # Bootstraps the canvas + game loop
  game/             # Core loop, state machine, scenes (menu / play / game-over)
  entities/         # Player, enemies, projectiles, pickups
  systems/          # Input, collision, physics, spawning, scoring
  render/           # Canvas draw routines, sprite/atlas handling
  audio/            # SFX / music playback
  ui/               # HUD, menus, overlays
assets/             # Sprites, audio, fonts (committed or referenced)
tests/              # agent-browser scenarios + any unit tests
```

## Setup & running

```bash
# Install deps (once a package.json exists)
npm install

# Run the dev server — serves index.html on a local port
npm run dev            # e.g. http://localhost:5173

# Production build
npm run build

# Preview a production build
npm run preview
```

If there is no build tooling yet, the game must still be launchable by serving the directory statically (`npx serve .`) and opening `index.html`. Never rely on `file://` — canvas, audio, and module imports need an HTTP origin.

## Testing with agent-browser

**agent-browser is the primary test harness.** It launches the game in a real browser, drives input, and inspects on-screen state — the only way to verify a canvas game actually plays. Unit tests cover pure logic (collision math, scoring, RNG); agent-browser covers everything that touches the DOM, canvas, input, or the game loop.

### Workflow (every gameplay change)

1. Start the dev server (`npm run dev`) and note the URL.
2. Launch the game in agent-browser at that URL.
3. Wait for the canvas to be ready before asserting (see readiness hook below).
4. Drive input (keyboard/pointer), advance frames, and observe.
5. Assert against **observable state**, then screenshot on failure.

### What to test

- **Boot**: canvas mounts, first frame renders, no console errors.
- **Input → action**: each control produces the expected movement/fire/pause.
- **Core loop**: spawn → collide → score → lose-life → game-over transition.
- **Scene transitions**: menu → play → pause → game-over → restart.
- **Determinism**: with a seeded RNG, the same inputs produce the same outcome.
- **No leaks/regressions**: frame rate holds; no runaway `setInterval`/listeners after restart.

### Make the game observable to the harness

Canvas pixels are opaque to automation. Expose a small, test-only inspection surface so agent-browser can assert on real state instead of guessing from screenshots:

```js
// Enabled only in dev/test builds — never ship this in production.
if (import.meta.env?.DEV || window.__TEST__) {
  window.__game = {
    get state()  { return game.currentState; },   // 'menu' | 'playing' | 'paused' | 'gameover'
    get score()  { return game.score; },
    get lives()  { return game.lives; },
    get frame()  { return game.frameCount; },
    get entities(){ return game.entities.map(e => ({ type: e.type, x: e.x, y: e.y })); },
    ready:        false,   // flipped true after first successful render
  };
}
```

The harness then waits on `window.__game?.ready === true` before acting, reads `window.__game.state`/`.score`, and dispatches input via keyboard/pointer events. Prefer polling these fields over pixel-matching; use screenshots for debugging failures, not as the assertion.

### Determinism for tests

- Route all randomness through one seedable PRNG; expose a seed override for tests.
- Never call `Math.random()` in gameplay code — it makes runs unreproducible.
- Advance time via the game loop's own step, not wall-clock sleeps, so tests aren't flaky under load.

## Roled development loop (planner → coder ↔ tester)

Development is split across three subagents (defined in `.claude/agents/`) so implementation and verification stay separate and iterate to a working result:

| Role | Agent | Owns | Never does |
|------|-------|------|-----------|
| **Planner** | `game-planner` | Turns a request into a spec with observable acceptance criteria | Write code |
| **Coder** | `game-coder` | Implements the smallest change satisfying the criteria | Declare it done |
| **Tester** | `game-tester` | Drives the game in a real browser (agent-browser) and asserts on game state | Fix the code |

### The loop

```
request → game-planner ──spec──▶ game-coder ──handoff──▶ game-tester
                                     ▲                        │
                                     └────── FAIL (repro) ────┘
                                              PASS → done
```

1. **Planner** produces a numbered acceptance-criteria list, each verifiable via `window.__game` or a visible UI change.
2. **Coder** implements against those criteria, keeps the `window.__game` hook intact, runs `npm run build`, and hands off with: what changed, which criteria it addresses, and how to exercise it.
3. **Tester** launches the game, waits for `window.__game.ready`, drives the specified inputs, and asserts on observable state. Verdict is **PASS** (done) or **FAIL** with an exact repro (start state → inputs → expected vs. observed) back to the coder.
4. Coder ↔ tester repeat until PASS. The tester's repro steps are authoritative — the coder fixes the cause, not the symptom.

### Orchestrating from the main thread

Spawn the coder and tester and relay handoffs between them. Keep the loop tight — one acceptance-criteria set per round:

```
1. Delegate the request to game-planner → get the spec.
2. Send the spec to game-coder → get the change + handoff.
3. Send the handoff to game-tester → get PASS or FAIL(repro).
4. If FAIL, relay the repro to game-coder and go to step 3. If PASS, done.
```

Run planner once per feature; run coder↔tester as many rounds as needed. Because roles are separate agents, the tester never sees the coder's reasoning — only the running game — so a PASS means the build genuinely plays, not that the author convinced themselves.

## Conventions

- **Game loop**: fixed-timestep update + variable-timestep render. Don't tie game logic to frame rate; use accumulated `dt`.
- **Input**: centralize in one input system; entities read intent, never raw key events.
- **State**: an explicit scene/state machine (`menu`/`playing`/`paused`/`gameover`) — no ad-hoc boolean flags scattered across files.
- **No blocking calls** in the loop (no sync XHR, no long loops); keep per-frame work bounded.
- **Assets**: reference by path from `assets/`; preload before `playing` state; don't fetch mid-gameplay.
- **Cleanup**: every scene tears down its listeners, timers, and audio on exit so restart is leak-free.

## Before you finish a change

- [ ] `npm run build` succeeds with no errors.
- [ ] Lint/format passes (`npm run lint` if configured).
- [ ] Unit tests pass (`npm test`) for any pure logic touched.
- [ ] agent-browser scenario for the affected flow passes end-to-end.
- [ ] No new console errors/warnings during a full menu → play → game-over run.
- [ ] Restart works cleanly (no duplicated listeners, timers, or audio).
- [ ] The test-only `window.__game` hook is gated out of production builds.

## Gotchas

- Serve over HTTP — `file://` breaks ES modules, audio autoplay, and canvas image loading.
- Browser audio needs a user gesture; start audio on the first input, not on load.
- Screenshots of `<canvas>` can be blank if captured before the first paint — wait for `ready`.
- Don't assert on exact pixel colors; assert on game state and use screenshots only to diagnose.
