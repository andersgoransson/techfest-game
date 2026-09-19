# Game Specification — "Well-Architected Defender" (v1)

Status: **first spec / draft**. This is the foundational design. Feature-sized changes after v1 go through `game-planner` → `game-coder` ↔ `game-tester`.

---

## 1. Vision

An **old-school arcade defense game** — fast, loud, energizing — that secretly teaches non-engineers how a cloud architecture stays healthy. You defend **The Cloud** from incoming **threats** (overspend, vulnerabilities, capacity crunches, outages…). You **blast whatever's coming at you** — no cloud knowledge required. When you hit a threat, the game **automatically files it into the pillar it belongs to**, filling that pillar up. Max out all six pillars → your architecture is "Well-Architected" → you win the round.

**Zero prior knowledge to play.** The player never has to know which pillar a threat maps to. They just shoot; the game does the sorting *and shows it happening* — the neutralized threat visibly flies into its pillar with a plain-language tag ("Idle GPU cluster → Cost Optimization ✓"). The learning is passive and cumulative: after a few rounds the player has *watched* dozens of problems get filed, and has absorbed "a cost spike is a Cost Optimization thing; a breach is a Security thing" without ever choosing a category or reading a whitepaper.

### Design pillars (the *game's* pillars, not AWS's)
- **Arcade-first.** Short rounds (60–120s), escalating waves, instant restart, chunky feedback (screen shake, pops, combo chimes). Reads in the first 5 seconds.
- **No knowledge gate.** You shoot threats; the game sorts them into pillars for you. Playing is pure reflex — the education rides along for free.
- **Learn by watching.** Every neutralized threat is labeled in plain language and shown filing into its pillar. No jargon without a one-line human translation.
- **Fair & readable.** Threats are color- and icon-coded to their pillar (a passive hint, never something the player must act on). A newcomer can play; a repeat player starts to predict where each threat will land.

---

## 2. The six pillars (scoring backbone)

Straight from the AWS Well-Architected Framework. Each has a **meter (0–100)**, a color, and a one-line plain-language meaning shown in the UI.

| # | Pillar | Plain-language framing (shown to player) | Color |
|---|--------|------------------------------------------|-------|
| 1 | **Operational Excellence** | "Run it smoothly and learn from every incident." | teal |
| 2 | **Security** | "Keep the bad actors and leaks out." | red |
| 3 | **Reliability** | "Stay up when things go wrong." | blue |
| 4 | **Performance Efficiency** | "Stay fast as demand grows." | violet |
| 5 | **Cost Optimization** | "Don't pay for what you don't use." | green |
| 6 | **Sustainability** | "Waste less; run leaner." | lime |

Pillar meters are the score. Total score is derived from them (§5), so the player literally scores by "filling up the Well-Architected pillars," exactly as requested.

---

## 3. Core loop (arcade mechanic)

Reuses the scaffold's bones (player console at the bottom, descending entities, fixed-timestep loop) reframed as a **defense shooter** — pure Missile-Command energy, with automatic pillar-filing behind the scenes.

1. **Threats descend** from the top toward **The Cloud** (a health bar / structure at the bottom). Each threat carries a plain-language name and a pillar color/icon (e.g. "💸 Idle GPU cluster", "🔓 Public S3 bucket", "📈 Traffic surge"). The color is a *hint*, never a required input.
2. The player controls a **defense turret** at the bottom. They **aim and fire** (← → to move, Space to shoot). That's the whole control set — **no category to choose, no pillar to select.**
3. **On hit** → the threat is neutralized with a **pop + chime**, and it **automatically flies into its correct pillar**, filling that pillar's meter a bit. A brief plain-language tag shows the filing: *"Idle GPU cluster → Cost Optimization ✓ (right-sized it!)"*. This is the teaching moment — the player *sees* the problem sorted, they don't have to know the answer.
4. **The pillars are the score** (§5). Every hit moves a threat into a pillar, so shooting = scoring = learning, all in one action.
5. **Filling a pillar** (meter reaches the threshold) → **fun call-out** (§5.1): a big celebratory banner + chime, e.g. *"💰 COST OPTIMIZED! Your wallet thanks you."* Energizing payoff that also reinforces what that pillar means.
6. **Threats that reach The Cloud** drain **Cloud Health** and knock down the meter of their pillar (the discipline you let slip). Health hits 0 → **game over**.
7. **Waves escalate**: faster descent and more simultaneous threats, so the player's reflexes are tested — never their knowledge.
8. **Win condition**: all six pillar meters reach the **well-architected threshold** (v1: 80) before Cloud Health is depleted → **"WELL-ARCHITECTED!"** victory.

### Feel / juice (v1-lite, expand later)
- **Threat-to-pillar flight**: on hit, the neutralized threat visibly arcs to its pillar meter — the core "aha" animation.
- Combo multiplier for consecutive hits.
- Short screen shake + particle pop on neutralize.
- Per-pillar fill call-out banner + chime (§5.1).
- Distinct SFX per pillar (audio starts on first input — browser gesture rule).

---

## 4. Threat catalog (v1 starter set)

Each threat maps to exactly one pillar. The game knows the mapping; the **player never has to**. Plain-language names + the visible filing animation do the teaching. (Expandable — v1 ships ~2 per pillar.)

| Threat (shown) | Pillar | The lesson |
|----------------|--------|------------|
| 💸 Idle GPU cluster | Cost Optimization | Turn off / right-size what you don't use |
| 💸 Over-provisioned DB | Cost Optimization | Match capacity to demand |
| 🔓 Public S3 bucket | Security | Lock down access by default |
| 🔓 Leaked API key | Security | Rotate & protect secrets |
| 📈 Traffic surge | Performance Efficiency | Scale to meet demand |
| 🐌 Slow query storm | Performance Efficiency | Optimize the hot path |
| 💥 AZ outage | Reliability | Design for failure / redundancy |
| ⛓️ Cascading failure | Reliability | Contain blast radius |
| 🌫️ Alert blindness | Operational Excellence | Observe, alarm, and learn |
| 🔥 Config drift | Operational Excellence | Automate & standardize |
| 🗑️ Zombie resources | Sustainability | Reclaim waste |
| 🏭 Inefficient workload | Sustainability | Run leaner |

---

**The pillars ARE the score.** There is no separate point counter you chase — you fill pillars, and filled pillars are the win. The HUD number is just a readout of how full they are.

- Each pillar meter is `0–100`.
- **Hit a threat** → the threat files into its pillar: `+FILL_GAIN` to that pillar (v1: `+8`, capped at 100). Because filing is automatic, *every* hit scores — the player can't "miss the category."
- **Threat reaches The Cloud** → `-BREACH_LOSS` to that pillar (v1: `-6`, floored at 0) **and** `-CLOUD_DAMAGE` to Cloud Health (v1: `-10`).
- **Combo**: N consecutive hits (no breach in between) multiplies the *display* score (not the meter fill) — pure arcade dopamine.
- **Total score** (shown in HUD): `sum(pillarMeters) × comboMultiplier`, so filling pillars *is* the score.
- **Well-Architected threshold**: all six meters ≥ `80` → win.

Tunables (single config object): `FILL_GAIN`, `BREACH_LOSS`, `CLOUD_DAMAGE`, `WIN_THRESHOLD`, `START_HEALTH`, wave pacing.

### 5.1 Pillar-filled call-outs (fun payoff)

The moment a pillar's meter first crosses `WIN_THRESHOLD`, fire a **celebratory call-out**: a big banner + chime + screen pop, held ~1.5s (non-blocking — the game keeps running). It fires **once per pillar per round** (re-crossing after a dip doesn't re-trigger). Each call-out doubles as a plain-language reminder of what that pillar means.

| Pillar | Call-out (v1) |
|--------|---------------|
| Cost Optimization | "💰 COST OPTIMIZED! Your wallet thanks you." |
| Security | "🛡️ LOCKED DOWN! The hackers went home." |
| Reliability | "🧯 ROCK SOLID! Stays up when it counts." |
| Performance Efficiency | "⚡ BLAZING FAST! Zoom zoom." |
| Operational Excellence | "🎛️ SMOOTH OPERATOR! Nothing slips past." |
| Sustainability | "🌱 GREEN MACHINE! Lean and clean." |

And when the **final** pillar crosses (all six filled): the **"WELL-ARCHITECTED!"** victory call-out (§6, `victory` state).

Copy is a tunable table so it's easy to punch up during iteration. Keep it short, upbeat, and jargon-free — the call-out is the reward *and* the lesson.

---

## 6. States & flow

Reuses the existing state machine, extended:

```
menu → playing ⇄ paused → (gameover | victory) → menu/playing
```

- `menu` — title, "Press Space to start", a one-screen legend of the 6 pillars (the teaching primer).
- `playing` — the loop above.
- `paused` — freezes; P toggles.
- `gameover` — Cloud Health hit 0; shows final pillar meters + weakest pillar callout ("Your Security was neglected"). Space to retry.
- `victory` — all pillars ≥ threshold; "WELL-ARCHITECTED!" + score. Space to replay (next difficulty).

---

## 7. Controls (v1)

Deliberately tiny — three actions, no menus, no category keys. Anyone can start playing in seconds.

| Input | Action |
|-------|--------|
| ← → / A D | Move the defense turret (aim) |
| Space | Fire / start / retry |
| P | Pause |

No pillar-selection keys: pillar filing is automatic on hit. This is what makes the game playable with zero cloud knowledge.

---

## 8. Observable state contract (`window.__game`)

For the roled loop, the dev/test hook (see AGENTS.md) must expose these fields so `game-tester` can assert without reading pixels:

```js
window.__game = {
  ready,                 // true after first render
  state,                 // 'menu'|'playing'|'paused'|'gameover'|'victory'
  score,                 // derived total (§5)
  cloudHealth,           // 0..START_HEALTH
  combo,                 // current consecutive-hit count
  pillars: {             // the six meters, 0..100 — these ARE the score
    operationalExcellence, security, reliability,
    performanceEfficiency, costOptimization, sustainability,
  },
  filledPillars,         // array of pillar keys that have crossed WIN_THRESHOLD
  lastCallout,           // { pillar, text, frame } | null — most recent fill call-out
  threats,               // [{ type, pillar, x, y }]  (pillar is where a hit WILL file it)
  frame,
  // test affordances (no pillar selection — filing is automatic):
  start(), togglePause(),
  snapshot(), _teardown(),
};
```

---

## 9. Acceptance criteria (v1)

Each is observable via `window.__game` or a visible UI change — phrased for `game-tester` to turn into agent-browser assertions.

### Boot & menu
1. On load, canvas renders and `window.__game.ready === true`; no console errors.
2. In `menu`, all six `pillars.*` values are `0` and `cloudHealth === START_HEALTH`.
3. The menu displays a legend naming all six pillars (visible text).

### Start & core loop
4. Pressing Space in `menu` sets `state === 'playing'` within 500ms.
5. Within 5s of `playing`, at least one entry exists in `window.__game.threats`, each carrying a `pillar` (the pillar a hit will file it into).
6. The only gameplay controls are move (← →) and fire (Space) — there is **no** pillar-selection input, and `window.__game` exposes no `selectedPillar`/`selectPillar`.

### Auto-filing mechanic (the teaching core)
7. Hitting a threat removes it and **increases exactly one pillar's meter** — the pillar that matches that threat's `pillar` tag — with no other meter changing. (The player made no category choice; the game filed it.)
8. Firing requires no correct-category input: any hit on any threat always fills that threat's own pillar (there is no "wrong pillar" outcome and no mismatch penalty).
9. On a hit, `lastCallout` is not set unless a pillar crossed the threshold, but a visible plain-language filing tag names the threat and its destination pillar (e.g. "Idle GPU cluster → Cost Optimization").
10. `score` equals `sum(pillar meters) × combo multiplier` at all times (recompute-and-compare) — i.e. the pillars are the score.

### Pillar-filled call-out
11. The first time a pillar's meter crosses `WIN_THRESHOLD`, `window.__game.lastCallout` is set to `{ pillar, text, frame }` for that pillar and a celebratory banner is visible on screen.
12. The call-out for a given pillar fires **at most once per round** — dipping below and re-crossing the threshold does not re-trigger it (`filledPillars` membership is sticky within a round).

### Breach & fail
13. A threat reaching The Cloud decreases `cloudHealth` and decreases its own pillar's meter (floored at 0).
14. When `cloudHealth` reaches 0, `state` becomes `gameover` within 500ms.
15. `gameover` screen names the weakest pillar (visible text).

### Win
16. When all six `pillars.*` ≥ `WIN_THRESHOLD` (80), `state` becomes `victory` within 500ms and the "WELL-ARCHITECTED!" call-out is visible.

### Pause & restart hygiene
17. In `playing`, pressing P sets `state === 'paused'` and pillar meters + threats stop changing across ≥30 frames.
18. From `gameover` or `victory`, pressing Space resets all pillars to 0, `cloudHealth` to `START_HEALTH`, and `filledPillars` to empty, then returns to `playing`.
19. After a restart, no duplicated RAF loops, input listeners, or timers (frame count advances by exactly one loop; no leaks).

### Determinism
20. With a fixed `?seed=N`, an identical input sequence yields identical final `pillars`, `cloudHealth`, and threat spawn order.

---

## 10. In scope for v1

- Six pillar meters + derived score (pillars *are* the score), automatic pillar filing on hit, breach damage.
- ~2 threats per pillar from §4 with plain-language labels + the threat→pillar filing tag/animation.
- Per-pillar fun call-out on fill (§5.1) + the "WELL-ARCHITECTED!" victory call-out.
- menu (with legend) / playing / paused / gameover / victory.
- Escalating wave pacing (spawn rate + speed ramp).
- The `window.__game` contract in §8 and passing criteria in §9.

## 11. Out of scope for v1 (later iterations)

- Free-aim/lane targeting polish, particle systems, screen shake tuning.
- Per-pillar unique visuals beyond color/icon; sprite art.
- Persistent high scores / leaderboard.
- Multiple difficulty tiers beyond a single ramp.
- Sound design beyond basic per-pillar SFX.
- Deeper educational layer (post-round "what you learned" recap, tooltips per threat).
- Mobile/touch controls.

## 12. Open questions (resolve during iteration)

- Exact tuning of `FILL_GAIN` / `BREACH_LOSS` / wave ramp for a satisfying 60–120s round.
- Threat→pillar flight animation: does it read clearly at high threat counts, or does it need to be simplified/skipped when many threats resolve at once?
- Call-out timing: 1.5s hold — long enough to register, short enough not to feel like it interrupts the arcade flow? Tune during coder↔tester.

**Resolved in this revision:** pillar selection is removed entirely — filing is automatic, so there's no "too many defenses under time pressure" problem and no cloud knowledge required to play.
