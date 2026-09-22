// Canvas draw routines. Pure rendering — reads game state, never mutates it.
//
// Composites the logical play field (game.width × game.height) into a 16:9 TV
// canvas: a top HUD bar, the play field (drawn 1:1 via a translate so all field
// draw code stays in game coordinates), and a right-hand bank of six *standing
// pillars* that fill bottom-up as you score.
//
// All feedback effects (particle bursts, floating text, pillar pulses, screen
// shake, breach flash) are render-local state, driven by *observing deltas* in
// the game state between frames — the renderer never writes back to `game`.
// Randomness here is cosmetic only (never gameplay), so Math.random is fine.

import { PILLAR_KEYS, PILLAR_NAMES, STATES, TUNABLES } from '../game/game.js';
import * as leaderboard from '../leaderboard.js';

// Medal colors for the top three leaderboard ranks.
const MEDAL = ['#ffd54a', '#cfd8e6', '#e39a5a'];

// Per-pillar identity: base color + a per-pillar glyph (reused from the callouts).
const PILLAR_COLORS = {
  operationalExcellence: '#2dd4bf',
  security: '#ff5d73',
  reliability: '#5b8dff',
  performanceEfficiency: '#a78bfa',
  costOptimization: '#4ade80',
  sustainability: '#a3e635',
};
const PILLAR_GLYPH = {
  operationalExcellence: '🎛️',
  security: '🛡️',
  reliability: '🧯',
  performanceEfficiency: '⚡',
  costOptimization: '💰',
  sustainability: '🌱',
};
// Compact labels drawn vertically up each standing pillar.
const PILLAR_SHORT = {
  operationalExcellence: 'OPS EXCELLENCE',
  security: 'SECURITY',
  reliability: 'RELIABILITY',
  performanceEfficiency: 'PERFORMANCE',
  costOptimization: 'COST',
  sustainability: 'SUSTAINABILITY',
};

// ── color helpers ───────────────────────────────────────────────────────────
// Parse either '#rrggbb' or 'rgb(r,g,b)' / 'rgba(...)' so results of mix()/lighten()
// (which return rgb() strings) can be fed back into these helpers without producing NaN.
function hexToRgb(color) {
  if (typeof color === 'string' && color[0] !== '#') {
    const m = color.match(/-?\d+\.?\d*/g);
    if (m && m.length >= 3) return { r: +m[0], g: +m[1], b: +m[2] };
  }
  const h = String(color).replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
function withAlpha(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
function lighten(hex, amt) {
  const c = hexToRgb(hex);
  const f = (v) => Math.round(v + (255 - v) * amt);
  return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
}
function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const f = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${f(a.r, b.r)},${f(a.g, b.g)},${f(a.b, b.b)})`;
}

export function createRenderer(ctx, game, app = { phase: 'play' }) {
  const canvas = ctx.canvas;
  const CW = canvas.width;   // 1280
  const CH = canvas.height;  // 720

  // ── layout: three columns — leaderboard · play field · pillar bank ─────────
  const HUD_H = 84;
  const FW = game.width;     // logical field width  (580)
  const FH = game.height;    // logical field height (600)
  const FY = HUD_H + 16;     // 100
  const MARGIN = 22;
  const GAP = 22;
  const LB_W = 300;          // left leaderboard panel width
  const LB_X = MARGIN;
  const LB_Y = FY;
  const LB_H = FH;
  const PANEL_W = 300;       // right pillar bank width
  const PANEL_X = CW - MARGIN - PANEL_W;
  const PANEL_Y = FY;
  const PANEL_H = FH;
  // Center the play field in the slot between the two side panels.
  const SLOT_X = MARGIN + LB_W + GAP;
  const SLOT_W = PANEL_X - GAP - SLOT_X;
  const FX = SLOT_X + Math.max(0, (SLOT_W - FW) / 2);

  // ── render-local effect state ─────────────────────────────────────────────
  const particles = []; // {x,y,vx,vy,life,max,color,size,grav,glow}
  const floaters = [];  // {x,y,vy,life,max,text,color,size}
  const shockwaves = []; // {x,y,life,max,maxR,color,width} — expanding rings
  const flyers = [];     // {x0,y0,x,y,px,py,tx,ty,life,max,color,pillar} — comet to a pillar
  const badges = [];     // {x,y,life,max,name,glyph,gain,color,combo} — "pillar protected" popup
  const pulses = {};     // pillar key -> remaining pulse time (sec)
  for (const k of PILLAR_KEYS) pulses[k] = 0;
  let shake = 0;         // remaining shake time (sec)
  let flash = null;      // {color, t, max}
  let cloudHit = 0;      // remaining "cloud took a hit" flash (sec)
  const stars = makeStars(90);
  const lerp = (a, b, t) => a + (b - a) * t;

  // Leaderboard focus animation + result-phase timing.
  let lbScroll = 0;        // current scroll (px) of the leaderboard list
  let prevPhase = app.phase;
  let resultStart = 0;     // clock time when the result reveal began
  let caretClock = 0;      // blink timer for the name-entry caret

  // Deltas we watch to trigger effects.
  let prevFilingFrame = -1;
  let prevCalloutFrame = -1;
  let prevCloud = game.cloudHealth;
  let prevCombo = game.combo;
  let prevState = game.state;

  let lastT = performance.now();
  let clock = 0; // accumulated seconds, for idle animation

  function makeStars(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        x: Math.random() * FW,
        y: Math.random() * FH,
        z: 0.3 + Math.random() * 1.7, // depth → speed + size
      });
    }
    return out;
  }

  // ── low-level draw helpers (canvas-space unless noted) ─────────────────────
  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function text(str, x, y, color, size, align = 'center', weight = '600') {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
  }

  function glowText(str, x, y, color, size, align = 'center', weight = '700', blur = 18) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    text(str, x, y, color, size, align, weight);
    ctx.restore();
  }

  // ── effect spawners ────────────────────────────────────────────────────────
  function burst(x, y, color, count, opts = {}) {
    const speed = opts.speed ?? 220;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.25 + Math.random() * 0.85);
      particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - (opts.lift ?? 0),
        life: 0,
        max: opts.life ?? (0.45 + Math.random() * 0.5),
        color: Math.random() < 0.35 ? '#ffffff' : color,
        size: opts.size ?? (2 + Math.random() * 3),
        grav: opts.grav ?? 260,
        glow: opts.glow ?? true,
      });
    }
  }

  function ring(x, y, color, count = 26) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const s = 260 + Math.random() * 60;
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 0.6, color, size: 3, grav: 0, glow: true,
      });
    }
  }

  function addFloater(x, y, str, color, size = 22) {
    floaters.push({ x, y, vy: -46, life: 0, max: 1.1, text: str, color, size });
  }

  function shockwave(x, y, color, maxR = 90, max = 0.5, width = 5) {
    shockwaves.push({ x, y, life: 0, max, maxR, color, width });
  }

  // A comet that streaks from a hit point to the pillar it protected, then bursts
  // on arrival — a clear visual link between "threat destroyed" and "pillar filled".
  function flyToPillar(x, y, tx, ty, color, pillar) {
    flyers.push({ x0: x, y0: y, x, y, px: x, py: y, tx, ty, life: 0, max: 0.5, color, pillar });
  }

  function addBadge(x, y, name, glyph, gain, color, combo) {
    badges.push({ x, y, life: 0, max: 1.5, name, glyph, gain, color, combo });
  }

  // ── coordinate map: play field → canvas ─────────────────────────────────────
  const toCanvas = (px, py) => ({ x: FX + px, y: FY + py });

  // Geometry of a standing pillar column (i = 0..5).
  function pillarRect(i) {
    const colGap = 12;
    const colW = (PANEL_W - colGap * (PILLAR_KEYS.length + 1)) / PILLAR_KEYS.length;
    const x = PANEL_X + colGap + i * (colW + colGap);
    const top = PANEL_Y + 52;     // room for % + glyph above
    const bottom = PANEL_Y + PANEL_H - 34; // room for the ground line below
    return { x, w: colW, top, bottom, h: bottom - top };
  }

  // ── per-frame effect detection + integration ────────────────────────────────
  function detectEvents() {
    // Reset effects on any (re)entry to a fresh run so restart is clean.
    if (prevState !== game.state && (game.state === STATES.PLAYING) && prevState !== STATES.PAUSED) {
      particles.length = 0;
      floaters.length = 0;
      shockwaves.length = 0;
      flyers.length = 0;
      badges.length = 0;
      for (const k of PILLAR_KEYS) pulses[k] = 0;
      shake = 0;
      cloudHit = 0;
      flash = null;
      prevCloud = game.cloudHealth;
      prevCombo = game.combo;
    }

    if (game.state === STATES.PLAYING) {
      // New filing → big layered explosion + protected-pillar badge + comet to pillar.
      const f = game.lastFiling;
      if (f && f.frame !== prevFilingFrame) {
        prevFilingFrame = f.frame;
        const color = PILLAR_COLORS[f.pillar] || '#8be9fd';
        const idx = PILLAR_KEYS.indexOf(f.pillar);
        if (typeof f.x === 'number') {
          const p = toCanvas(f.x, f.y);
          // Layered blast: colored debris + a bright white core + radial sparks.
          burst(p.x, p.y, color, 30, { speed: 320, life: 0.65, grav: 220, size: 3 });
          burst(p.x, p.y, '#ffffff', 12, { speed: 220, life: 0.4, grav: 120, size: 2.5 });
          ring(p.x, p.y, lighten(color, 0.3), 22);
          // Expanding shockwaves.
          shockwave(p.x, p.y, '#ffffff', 64, 0.35, 4);
          shockwave(p.x, p.y, color, 108, 0.55, 6);
          // A prominent "which pillar you protected" badge that pops at the hit.
          const bx = Math.max(FX + 90, Math.min(FX + FW - 90, p.x));
          addBadge(bx, p.y - 8, PILLAR_NAMES[f.pillar], PILLAR_GLYPH[f.pillar],
            `+${TUNABLES.FILL_GAIN}`, color, game.combo);
          // Comet linking the kill to its pillar column.
          if (idx >= 0) {
            const pr = pillarRect(idx);
            const val = Math.max(0, Math.min(100, game.pillars[f.pillar]));
            flyToPillar(p.x, p.y, pr.x + pr.w / 2, pr.bottom - pr.h * (val / 100), color, f.pillar);
          }
        }
        if (idx >= 0) pulses[f.pillar] = Math.max(pulses[f.pillar], 0.4);
      }

      // New callout → big celebration on that pillar.
      const c = game.lastCallout;
      if (c && c.frame !== prevCalloutFrame) {
        prevCalloutFrame = c.frame;
        const color = PILLAR_COLORS[c.pillar] || '#ffe066';
        const idx = PILLAR_KEYS.indexOf(c.pillar);
        if (idx >= 0) {
          const pr = pillarRect(idx);
          ring(pr.x + pr.w / 2, pr.top - 6, lighten(color, 0.2), 30);
          burst(pr.x + pr.w / 2, pr.top - 6, '#ffe066', 24, { speed: 300, life: 0.9, grav: 120 });
          pulses[c.pillar] = 1.0;
        }
        flash = { color: 'rgba(255,224,102,0.16)', t: 0, max: 0.4 };
      }

      // Breach → cloud health dropped: shake + red flash + debris at the field floor.
      if (game.cloudHealth < prevCloud) {
        shake = Math.max(shake, 0.4);
        cloudHit = 0.5;
        flash = { color: 'rgba(255,70,90,0.28)', t: 0, max: 0.45 };
        for (let i = 0; i < 3; i++) {
          burst(FX + FW * Math.random(), FY + FH - 6, '#ff5d73', 10, { speed: 260, lift: 120, life: 0.7 });
        }
      }

      // Combo climbed → a small spark near the player.
      if (game.combo > prevCombo && game.player) {
        const p = toCanvas(game.player.x, game.player.y);
        burst(p.x, p.y, '#8be9fd', 6, { speed: 140, life: 0.4 });
      }
    }

    prevCloud = game.cloudHealth;
    prevCombo = game.combo;
    prevState = game.state;
  }

  function integrate(dt) {
    // Stars drift down (parallax by depth); only animate in play/pause.
    for (const s of stars) {
      s.y += (12 + s.z * 26) * dt;
      if (s.y > FH) { s.y -= FH; s.x = Math.random() * FW; }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life += dt;
      if (f.life >= f.max) { floaters.splice(i, 1); continue; }
      f.y += f.vy * dt;
      f.vy *= 0.94;
    }
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const s = shockwaves[i];
      s.life += dt;
      if (s.life >= s.max) shockwaves.splice(i, 1);
    }
    for (let i = flyers.length - 1; i >= 0; i--) {
      const f = flyers[i];
      f.life += dt;
      const t = Math.min(1, f.life / f.max);
      const e = t * t * (3 - 2 * t); // smoothstep
      f.px = f.x; f.py = f.y;
      f.x = lerp(f.x0, f.tx, e);
      f.y = lerp(f.y0, f.ty, e) - Math.sin(Math.PI * t) * 46; // lob upward
      if (f.life >= f.max) {
        // Arrival: burst + shockwave on the pillar it protected, and pulse it hard.
        burst(f.tx, f.ty, f.color, 16, { speed: 180, life: 0.5, grav: 60 });
        shockwave(f.tx, f.ty, lighten(f.color, 0.3), 46, 0.4, 4);
        if (f.pillar) pulses[f.pillar] = Math.max(pulses[f.pillar] || 0, 0.6);
        flyers.splice(i, 1);
      }
    }
    for (let i = badges.length - 1; i >= 0; i--) {
      badges[i].life += dt;
      if (badges[i].life >= badges[i].max) badges.splice(i, 1);
    }
    for (const k of PILLAR_KEYS) if (pulses[k] > 0) pulses[k] = Math.max(0, pulses[k] - dt);
    if (cloudHit > 0) cloudHit = Math.max(0, cloudHit - dt);
    if (shake > 0) shake = Math.max(0, shake - dt);
    if (flash) { flash.t += dt; if (flash.t >= flash.max) flash = null; }
    clock += dt;
  }

  // ── scene pieces ─────────────────────────────────────────────────────────
  function drawBackground() {
    // Canvas-wide deep-space gradient.
    const bg = ctx.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, '#0a0e1f');
    bg.addColorStop(0.5, '#080a16');
    bg.addColorStop(1, '#05060d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CW, CH);
  }

  function drawField(playing) {
    ctx.save();
    // Clip everything to the field so stars/particles never bleed into the panel.
    roundRect(FX, FY, FW, FH, 16);
    ctx.save();
    ctx.clip();

    // Field gradient.
    const g = ctx.createLinearGradient(FX, FY, FX, FY + FH);
    g.addColorStop(0, '#0d1226');
    g.addColorStop(1, '#0a0f20');
    ctx.fillStyle = g;
    ctx.fillRect(FX, FY, FW, FH);

    // Faint grid.
    ctx.strokeStyle = 'rgba(90,141,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= FW; gx += 48) { ctx.moveTo(FX + gx, FY); ctx.lineTo(FX + gx, FY + FH); }
    for (let gy = 0; gy <= FH; gy += 48) { ctx.moveTo(FX, FY + gy); ctx.lineTo(FX + FW, FY + gy); }
    ctx.stroke();

    // Starfield.
    for (const s of stars) {
      ctx.globalAlpha = 0.25 + s.z * 0.35;
      ctx.fillStyle = s.z > 1.2 ? '#bcd0ff' : '#8fa2d8';
      ctx.fillRect(FX + s.x, FY + s.y, s.z, s.z);
    }
    ctx.globalAlpha = 1;

    // Danger zone gradient near the breach line, intensifying as the cloud weakens.
    const frac = Math.max(0, Math.min(1, game.cloudHealth / TUNABLES.START_HEALTH));
    const dz = ctx.createLinearGradient(0, FY + FH - 90, 0, FY + FH);
    dz.addColorStop(0, 'rgba(255,93,115,0)');
    dz.addColorStop(1, `rgba(255,93,115,${0.10 + (1 - frac) * 0.22})`);
    ctx.fillStyle = dz;
    ctx.fillRect(FX, FY + FH - 90, FW, 90);

    // The cloud the player is defending — sits along the field floor, below the ship.
    drawCloud(frac);

    // Entities (only when a run is active — menu shows the legend instead).
    if (playing) {
      for (const e of game.threats) drawThreat(e);
      for (const b of game.bullets) drawBullet(b);
      if (game.player) drawPlayer(game.player);
    }

    // Particles + shockwaves live in canvas space; draw them clipped to the field.
    drawShockwaves();
    drawParticles();

    ctx.restore(); // end clip

    // Field frame + soft glow (drawn unclipped so the glow shows).
    ctx.save();
    ctx.shadowColor = 'rgba(80,120,255,0.35)';
    ctx.shadowBlur = 26;
    roundRect(FX, FY, FW, FH, 16);
    ctx.strokeStyle = 'rgba(120,150,255,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Floating score text above the frame region.
    drawFloaters();

    ctx.restore();
  }

  // The defended cloud: a soft puffy bank spanning the field floor, just below the
  // ship. `frac` is cloudHealth/START_HEALTH — it tints from healthy blue-white
  // toward red as health drops, and flashes white when it takes a breach hit.
  function drawCloud(frac) {
    const pad = 18;
    const cx0 = FX + pad, cx1 = FX + FW - pad;
    const width = cx1 - cx0;
    const bob = Math.sin(clock * 1.1) * 2;
    const crestY = FY + FH - 34 + bob; // baseline of the puffs — just below the ship
    const baseY = FY + FH + 6;         // dips just past the field floor (clipped away)

    // Varied flattened "puffs" tile exactly across the width; a fixed puff height
    // keeps the bank low so it reads as ground the ship hovers over, not a wall.
    const pattern = [1, 1.5, 1.15, 1.75, 1.25, 1.6, 1.05, 1.45, 1.2, 1.55, 1.1];
    const sum = pattern.reduce((s, v) => s + v, 0);
    const unit = width / (2 * sum);
    const puffH = 26;

    ctx.beginPath();
    ctx.moveTo(cx0, baseY);
    ctx.lineTo(cx0, crestY);
    let x = cx0;
    for (const p of pattern) {
      const rx = p * unit;
      // Bigger puffs stand a touch taller for an organic silhouette.
      ctx.ellipse(x + rx, crestY, rx, puffH * (0.7 + 0.3 * (p / 1.75)), 0, Math.PI, 0, false);
      x += 2 * rx;
    }
    ctx.lineTo(cx1, baseY);
    ctx.closePath();
    const maxR = puffH;

    // Health tint (+ white flash on a hit).
    const healthy = '#e6edff', danger = '#ff6b7d';
    let top = mix(danger, healthy, frac);
    let bot = mix('#b23a49', '#9fb4e8', frac);
    if (cloudHit > 0) {
      const w = cloudHit / 0.5;
      top = mix(top, '#ffffff', w * 0.7);
      bot = mix(bot, '#ffd0d6', w * 0.7);
    }

    ctx.save();
    ctx.shadowColor = frac > 0.4 ? 'rgba(150,180,255,0.5)' : 'rgba(255,90,110,0.6)';
    ctx.shadowBlur = 22 + (cloudHit > 0 ? 26 : 0);
    const g = ctx.createLinearGradient(0, crestY - maxR, 0, baseY);
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // Soft crest highlight for a rounded, lit look.
    ctx.save();
    ctx.clip(); // clip to the cloud path still on the context
    const hl = ctx.createLinearGradient(0, crestY - maxR, 0, crestY + 10);
    hl.addColorStop(0, 'rgba(255,255,255,0.55)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(cx0, crestY - maxR, width, maxR + 12);
    ctx.restore();

    // "CLOUD" label riding on the bank.
    ctx.globalAlpha = 0.5;
    text('☁ YOUR CLOUD', FX + FW / 2, FY + FH - 12, 'rgba(20,30,60,0.9)', 12, 'center', '800');
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    for (const p of particles) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, a);
      if (p.glow) { ctx.shadowColor = p.color; ctx.shadowBlur = 10; }
      ctx.fillStyle = p.color;
      const s = p.size * (0.6 + a * 0.6);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  function drawShockwaves() {
    ctx.save();
    for (const s of shockwaves) {
      const t = s.life / s.max;
      const r = s.maxR * (t * t * (3 - 2 * t)); // ease-out radius
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * (1 - t) + 0.5;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Comets streaking from a kill to the pillar it protected (drawn unclipped so
  // they cross from the play field into the pillar bank).
  function drawFlyers() {
    ctx.save();
    for (const f of flyers) {
      const t = Math.min(1, f.life / f.max);
      ctx.globalAlpha = Math.max(0, 1 - t * 0.3);
      // Trail.
      ctx.strokeStyle = withAlpha(f.color, 0.6);
      ctx.lineWidth = 3;
      ctx.shadowColor = f.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(f.px, f.py);
      ctx.lineTo(f.x, f.y);
      ctx.stroke();
      // Head.
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(f.x, f.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // The "pillar protected" popup that blooms at each kill: glyph + pillar name + gain.
  function drawBadges() {
    for (const b of badges) {
      const t = b.life / b.max;
      // Pop in (0–0.16), settle, then float up + fade (0.7–1.0).
      let scale = t < 0.16 ? 0.5 + 0.75 * (t / 0.16)
        : t < 0.28 ? 1.25 - 0.25 * ((t - 0.16) / 0.12) : 1.0;
      const alpha = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
      const yOff = -34 * t;

      ctx.save();
      ctx.translate(b.x, b.y + yOff);
      ctx.scale(scale, scale);
      ctx.globalAlpha = alpha;

      const label = b.name.toUpperCase();
      ctx.font = '800 17px system-ui, -apple-system, "Segoe UI", sans-serif';
      const tw = ctx.measureText(label).width;
      const pw = tw + 92, ph = 40;

      // Pill.
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 22;
      ctx.fillStyle = 'rgba(8,11,22,0.92)';
      roundRect(-pw / 2, -ph / 2, pw, ph, 20); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = b.color;
      roundRect(-pw / 2, -ph / 2, pw, ph, 20); ctx.stroke();

      // Glyph chip (left).
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(b.glyph, -pw / 2 + 22, 6);
      // Pillar name (center-left).
      ctx.textAlign = 'left';
      ctx.fillStyle = lighten(b.color, 0.35);
      ctx.fillText(label, -pw / 2 + 40, 6);
      // Gain (right).
      ctx.textAlign = 'right';
      ctx.font = '900 18px system-ui, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(b.gain, pw / 2 - 16, 6);

      // "PROTECTED" caption above the pill.
      ctx.textAlign = 'center';
      ctx.font = '800 10px system-ui, sans-serif';
      ctx.fillStyle = b.color;
      ctx.fillText(b.combo > 1 ? `PROTECTED · COMBO ×${b.combo}` : 'PROTECTED', 0, -ph / 2 - 6);

      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    for (const f of floaters) {
      const a = 1 - f.life / f.max;
      ctx.globalAlpha = Math.max(0, a);
      glowText(f.text, f.x, f.y, f.color, f.size, 'center', '800', 12);
      ctx.globalAlpha = 1;
    }
  }

  function drawPlayer(pl) {
    const c = toCanvas(pl.x, pl.y);
    const w = pl.w, h = pl.h;
    ctx.save();
    ctx.translate(c.x, c.y);

    // Engine glow (flickers).
    const flick = 0.6 + Math.random() * 0.4;
    ctx.save();
    ctx.shadowColor = '#7dffb2';
    ctx.shadowBlur = 22 * flick;
    ctx.fillStyle = withAlpha('#7dffb2', 0.9);
    ctx.beginPath();
    ctx.moveTo(-6, h / 2);
    ctx.lineTo(0, h / 2 + 10 * flick);
    ctx.lineTo(6, h / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Hull.
    const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    grad.addColorStop(0, '#eafff4');
    grad.addColorStop(1, '#39d98a');
    ctx.save();
    ctx.shadowColor = '#7dffb2';
    ctx.shadowBlur = 14;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, -h / 2 - 4);      // nose
    ctx.lineTo(w / 2, h / 2);       // right wing
    ctx.lineTo(w / 6, h / 2 - 4);
    ctx.lineTo(-w / 6, h / 2 - 4);
    ctx.lineTo(-w / 2, h / 2);      // left wing
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Cockpit.
    ctx.fillStyle = withAlpha('#0a0f20', 0.85);
    ctx.beginPath();
    ctx.ellipse(0, -2, 3.5, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBullet(b) {
    const c = toCanvas(b.x, b.y);
    ctx.save();
    // Trail.
    const tg = ctx.createLinearGradient(0, c.y - 4, 0, c.y + 16);
    tg.addColorStop(0, 'rgba(139,233,253,0.9)');
    tg.addColorStop(1, 'rgba(139,233,253,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(c.x - 1.5, c.y - 4, 3, 20);
    // Bolt core.
    ctx.shadowColor = '#8be9fd';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#eafcff';
    roundRect(c.x - b.w / 2, c.y - b.h / 2, b.w, b.h, 2);
    ctx.fill();
    ctx.restore();
  }

  function drawThreat(e) {
    const bob = Math.sin(clock * 4 + e.x * 0.05) * 1; // subtle — kept ≤ the hitbox margin
    const c = toCanvas(e.x, e.y + bob);
    const color = PILLAR_COLORS[e.pillar] || '#ff5d73';
    // Solid body === hitbox (game.js spawn w/h): what you see is what you hit.
    const vw = e.w, vh = e.h;
    ctx.save();
    ctx.translate(c.x, c.y);

    // Drop shadow.
    ctx.shadowColor = withAlpha(color, 0.8);
    ctx.shadowBlur = 16;
    // Chip body.
    const g = ctx.createLinearGradient(0, -vh / 2, 0, vh / 2);
    g.addColorStop(0, lighten(color, 0.28));
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    roundRect(-vw / 2, -vh / 2, vw, vh, 8);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Gloss highlight.
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(-vw / 2 + 3, -vh / 2 + 3, vw - 6, vh / 2 - 3, 6);
    ctx.fill();

    // Border.
    ctx.strokeStyle = withAlpha(lighten(color, 0.5), 0.9);
    ctx.lineWidth = 1.5;
    roundRect(-vw / 2, -vh / 2, vw, vh, 8);
    ctx.stroke();

    // Glyph.
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PILLAR_GLYPH[e.pillar] || '⚠️', 0, 1);
    ctx.restore();
  }

  // ── gun-heat bar (rendered inside the HUD top strip) ─────────────────────
  // Only visible during PLAYING and PAUSED states.
  function drawHeatBar() {
    if (game.state !== STATES.PLAYING && game.state !== STATES.PAUSED) return;

    const barW = 140, barH = 10;
    const bx = 720, by = 38;

    // Label.
    text('GUN HEAT', bx, 30, '#7a84b8', 12, 'left', '700');

    // Background track (8% white, matching the cloud-health bar style).
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(bx, by, barW, barH, 5); ctx.fill();

    const heatFrac = Math.max(0, Math.min(1, game._heat / TUNABLES.HEAT_MAX));

    if (heatFrac > 0) {
      // Color: green → yellow → red as heat rises; full red with glow while overheated.
      let fillColor;
      if (game._overheated) {
        // Pulse the glow while the gun is locked out.
        fillColor = '#ff5d73';
        ctx.save();
        ctx.shadowColor = '#ff5d73';
        ctx.shadowBlur = 20 + 8 * Math.sin(clock * 14);
        ctx.fillStyle = fillColor;
        roundRect(bx, by, barW * heatFrac, barH, 5); ctx.fill();
        ctx.restore();
      } else {
        fillColor = heatFrac < 0.5
          ? mix('#4ade80', '#ffd166', heatFrac / 0.5)
          : mix('#ffd166', '#ff5d73', (heatFrac - 0.5) / 0.5);
        ctx.save();
        ctx.shadowColor = fillColor;
        ctx.shadowBlur = 8;
        ctx.fillStyle = fillColor;
        roundRect(bx, by, barW * heatFrac, barH, 5); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ── HUD (top bar) ──────────────────────────────────────────────────────────
  function drawHud() {
    // Bar background.
    const g = ctx.createLinearGradient(0, 0, 0, HUD_H);
    g.addColorStop(0, 'rgba(20,26,48,0.95)');
    g.addColorStop(1, 'rgba(12,15,30,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, HUD_H);
    ctx.strokeStyle = 'rgba(120,150,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, HUD_H); ctx.lineTo(CW, HUD_H); ctx.stroke();

    // Title (aligned to the left column / leaderboard).
    glowText('WELL-ARCHITECTED', MARGIN, 34, '#cdd6ff', 20, 'left', '800', 14);
    text('D E F E N D E R', MARGIN, 58, '#6f7bb0', 14, 'left', '700');

    // Score (center-left of the bar).
    const sx = 360;
    text('SCORE', sx, 30, '#7a84b8', 12, 'left', '700');
    glowText(String(game.score), sx, 62, '#ffffff', 30, 'left', '800', 14);

    // Combo.
    if (game.combo > 1) {
      const pop = 1 + Math.min(0.4, Math.max(0, prevComboPop()));
      ctx.save();
      const cx = 560;
      ctx.translate(cx, 44);
      ctx.scale(pop, pop);
      glowText(`🔥 ×${game.combo}`, 0, 8, '#ffd166', 24, 'left', '800', 16);
      ctx.restore();
    }

    drawHeatBar();

    // Cloud health bar (right side, above the pillar bank).
    const bw = 240, bh = 16;
    const bx = CW - MARGIN - bw, by = 34;
    text('☁ CLOUD HEALTH', bx, by - 6, '#7a84b8', 12, 'left', '700');
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(bx, by, bw, bh, 8); ctx.fill();
    const frac = Math.max(0, Math.min(1, game.cloudHealth / TUNABLES.START_HEALTH));
    const hue = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#ffd166' : '#ff5d73';
    if (frac > 0) {
      ctx.save();
      ctx.shadowColor = hue; ctx.shadowBlur = 12;
      const hg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      hg.addColorStop(0, withAlpha(hue, 0.7));
      hg.addColorStop(1, lighten(hue, 0.25));
      ctx.fillStyle = hg;
      roundRect(bx, by, bw * frac, bh, 8); ctx.fill();
      ctx.restore();
    }
    text(`${Math.max(0, game.cloudHealth)}`, bx + bw, by + bh + 16, hue, 16, 'right', '800');
  }

  // Combo pop is a tiny render-only easing based on how recently combo changed.
  let comboChangedAt = -10;
  function prevComboPop() { return Math.max(0, 0.4 - (clock - comboChangedAt)); }

  // ── standing pillars (right bank) ───────────────────────────────────────────
  function drawPillars() {
    // Panel backdrop.
    ctx.fillStyle = 'rgba(14,18,36,0.55)';
    roundRect(PANEL_X - 12, PANEL_Y - 40, PANEL_W + 24, PANEL_H + 52, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(120,150,255,0.18)';
    ctx.lineWidth = 1; ctx.stroke();

    text('WELL-ARCHITECTED PILLARS', PANEL_X + PANEL_W / 2, PANEL_Y - 18, '#9aa4d8', 13, 'center', '800');

    // Ground line under the columns.
    const groundY = pillarRect(0).bottom + 6;
    const gg = ctx.createLinearGradient(PANEL_X, groundY - 6, PANEL_X, groundY + 6);
    gg.addColorStop(0, 'rgba(120,150,255,0.35)');
    gg.addColorStop(1, 'rgba(120,150,255,0)');
    ctx.fillStyle = gg;
    ctx.fillRect(PANEL_X - 8, groundY, PANEL_W + 16, 8);

    PILLAR_KEYS.forEach((k, i) => {
      const pr = pillarRect(i);
      const color = PILLAR_COLORS[k];
      const val = Math.max(0, Math.min(100, game.pillars[k]));
      const filled = val >= TUNABLES.WIN_THRESHOLD;
      const pulse = pulses[k];

      // Column track.
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      roundRect(pr.x, pr.top, pr.w, pr.h, 8); ctx.fill();
      ctx.strokeStyle = withAlpha(color, 0.35);
      ctx.lineWidth = 1;
      roundRect(pr.x, pr.top, pr.w, pr.h, 8); ctx.stroke();

      // Threshold marker.
      const thY = pr.bottom - pr.h * (TUNABLES.WIN_THRESHOLD / 100);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pr.x, thY); ctx.lineTo(pr.x + pr.w, thY); ctx.stroke();
      ctx.setLineDash([]);

      // Fill from the bottom up.
      const fillH = pr.h * (val / 100);
      if (fillH > 0) {
        ctx.save();
        roundRect(pr.x, pr.top, pr.w, pr.h, 8); ctx.clip();
        const fg = ctx.createLinearGradient(0, pr.bottom - fillH, 0, pr.bottom);
        fg.addColorStop(0, lighten(color, 0.35));
        fg.addColorStop(1, color);
        ctx.shadowColor = color;
        ctx.shadowBlur = 14 + pulse * 30;
        ctx.fillStyle = fg;
        ctx.fillRect(pr.x, pr.bottom - fillH, pr.w, fillH);
        // Gloss stripe.
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(pr.x + 3, pr.bottom - fillH, pr.w * 0.32, fillH);
        // Rising crest highlight.
        ctx.fillStyle = withAlpha('#ffffff', 0.6 + pulse * 0.4);
        ctx.fillRect(pr.x, pr.bottom - fillH, pr.w, 2);
        ctx.restore();
      }

      // Filled aura + crown.
      if (filled) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 18 + pulse * 24;
        ctx.strokeStyle = lighten(color, 0.4);
        ctx.lineWidth = 2;
        roundRect(pr.x, pr.top, pr.w, pr.h, 8); ctx.stroke();
        ctx.restore();
        text('👑', pr.x + pr.w / 2, pr.top - 10, '#ffe066', 18, 'center', '700');
      }

      // Vertical label up the column.
      ctx.save();
      ctx.translate(pr.x + pr.w / 2, pr.top + pr.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.globalAlpha = 0.85;
      text(PILLAR_SHORT[k], 0, 4, filled ? '#0b0d17' : withAlpha('#ffffff', 0.55),
        Math.min(13, pr.w - 2), 'center', '800');
      ctx.restore();

      // Glyph + percent above the column.
      text(PILLAR_GLYPH[k], pr.x + pr.w / 2, pr.top - (filled ? 26 : 10), '#e6e8f0', 15, 'center', '700');
      text(`${Math.round(val)}`, pr.x + pr.w / 2, pr.bottom + 22, filled ? color : '#7a84b8', 13, 'center', '800');
    });
  }

  // ── overlays ─────────────────────────────────────────────────────────────
  function panel(cx, cy, w, h, alpha = 0.82) {
    ctx.fillStyle = `rgba(6,9,18,${alpha})`;
    roundRect(cx - w / 2, cy - h / 2, w, h, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(120,150,255,0.3)';
    ctx.lineWidth = 1.5; ctx.stroke();
  }

  function drawFilingTag() {
    const f = game.lastFiling;
    if (game.state === STATES.PLAYING && f && game.frame - f.frame < 110) {
      const age = game.frame - f.frame;
      const a = age < 8 ? age / 8 : 1 - (age - 8) / 102;
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      const color = PILLAR_COLORS[f.pillar] || '#8be9fd';
      const cx = FX + FW / 2, cy = FY + FH - 34;
      const label = (PILLAR_NAMES[f.pillar] || '').toUpperCase();
      ctx.font = '800 18px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const bw = tw + 150, bh = 40;

      // Bar with a colored accent + glow.
      ctx.save();
      ctx.shadowColor = color; ctx.shadowBlur = 20;
      ctx.fillStyle = 'rgba(6,9,18,0.85)';
      roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 20); ctx.fill();
      ctx.restore();
      ctx.lineWidth = 2; ctx.strokeStyle = color;
      roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 20); ctx.stroke();
      // Colored glyph disc.
      ctx.save();
      ctx.shadowColor = color; ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(cx - bw / 2 + 24, cy, 13, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      text(PILLAR_GLYPH[f.pillar] || '⚠️', cx - bw / 2 + 24, cy + 6, '#0b0d17', 15, 'center', '700');
      // "PROTECTED · <PILLAR>"
      ctx.textBaseline = 'alphabetic';
      text('PROTECTED', cx - bw / 2 + 46, cy - 2, '#8a93c8', 11, 'left', '800');
      text(label, cx - bw / 2 + 46, cy + 13, lighten(color, 0.35), 18, 'left', '800');
      ctx.globalAlpha = 1;
    }
  }

  function drawCallout() {
    if (game.state === STATES.PLAYING && game.lastCallout && game.frame - game.lastCallout.frame < 110) {
      const age = game.frame - game.lastCallout.frame;
      const a = age < 12 ? age / 12 : 1 - (age - 12) / 98;
      const cx = FX + FW / 2, cy = FY + 90;
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      panel(cx, cy, 560, 70, 0.8);
      glowText(game.lastCallout.text, cx, cy + 8, '#ffe066', 22, 'center', '800', 20);
      ctx.globalAlpha = 1;
    }
  }

  function weakestPillar() {
    let key = PILLAR_KEYS[0];
    for (const k of PILLAR_KEYS) if (game.pillars[k] < game.pillars[key]) key = k;
    return key;
  }

  function drawMenu() {
    ctx.fillStyle = 'rgba(4,6,13,0.72)';
    ctx.fillRect(0, 0, CW, CH);
    const cx = CW / 2, cy = CH / 2;
    glowText('WELL-ARCHITECTED DEFENDER', cx, cy - 190, '#eaf0ff', 46, 'center', '900', 28);
    text('Blast cloud threats — each one files into its Well-Architected pillar.', cx, cy - 150, '#aab3e0', 18);
    glowText('Press  SPACE  to start', cx, cy - 108, '#ffe066', 22, 'center', '800', 16);

    // Legend grid: 3 columns × 2 rows.
    const cols = 3, cellW = 300, cellH = 54;
    const gridW = cols * cellW;
    const startX = cx - gridW / 2 + 20;
    let startY = cy - 40;
    PILLAR_KEYS.forEach((k, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = startX + col * cellW, y = startY + row * (cellH + 14);
      ctx.save();
      ctx.shadowColor = PILLAR_COLORS[k]; ctx.shadowBlur = 14;
      ctx.fillStyle = PILLAR_COLORS[k];
      roundRect(x, y, 30, 30, 8); ctx.fill();
      ctx.restore();
      text(PILLAR_GLYPH[k], x + 15, y + 21, '#0b0d17', 16, 'center', '700');
      text(PILLAR_NAMES[k], x + 44, y + 21, '#e6e8f0', 18, 'left', '700');
    });

    text('←  →  /  A  D  ·  move        SPACE  ·  shoot        P  ·  pause',
      cx, cy + 150, '#8a93c8', 16);
  }

  function drawGameOver() {
    ctx.fillStyle = 'rgba(4,6,13,0.7)';
    ctx.fillRect(0, 0, CW, CH);
    const cx = CW / 2, cy = CH / 2;
    panel(cx, cy, 620, 240, 0.86);
    glowText('GAME OVER', cx, cy - 60, '#ff5d73', 52, 'center', '900', 30);
    text(`Weakest pillar: ${PILLAR_NAMES[weakestPillar()]}`, cx, cy - 6, '#ffb07a', 22);
    text(`Final Score  ${game.score}`, cx, cy + 40, '#e6e8f0', 24, 'center', '800');
    glowText('Press  SPACE  to retry', cx, cy + 86, '#ffe066', 20, 'center', '800', 14);
  }

  function drawVictory() {
    ctx.fillStyle = 'rgba(4,6,13,0.7)';
    ctx.fillRect(0, 0, CW, CH);
    const cx = CW / 2, cy = CH / 2;
    // Celebratory sparkle drift on the victory screen.
    if (Math.random() < 0.5) {
      burst(cx + (Math.random() - 0.5) * 620, cy - 120 + Math.random() * 240,
        ['#ffe066', '#4ade80', '#8be9fd', '#a78bfa'][Math.floor(Math.random() * 4)], 3,
        { speed: 90, grav: 40, life: 1.0 });
    }
    drawParticles();
    panel(cx, cy, 640, 250, 0.88);
    glowText('WELL-ARCHITECTED!', cx, cy - 58, '#ffe066', 50, 'center', '900', 34);
    text('Your cloud is bulletproof!', cx, cy - 4, '#e6e8f0', 24);
    text(`Final Score  ${game.score}`, cx, cy + 42, '#4ade80', 24, 'center', '800');
    glowText('Press  SPACE  to replay', cx, cy + 90, '#ffe066', 20, 'center', '800', 14);
  }

  // ── leaderboard (left column, drawn every frame in every state) ─────────────
  function fitText(str, size, weight, maxW) {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    if (ctx.measureText(str).width <= maxW) return str;
    let s = str;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  const ROW_H = 34;

  function drawLbRow(entry, i, x, y, w, hi) {
    const rank = i + 1;
    const accent = rank <= 3 ? MEDAL[rank - 1] : '#7f8cc4';
    const midY = y + ROW_H / 2 + 5;
    const pulse = hi ? 0.5 + 0.5 * Math.sin(clock * 6) : 0;

    ctx.fillStyle = hi ? withAlpha('#5b8dff', 0.22 + pulse * 0.22) : 'rgba(255,255,255,0.035)';
    roundRect(x + 2, y + 3, w - 4, ROW_H - 6, 8); ctx.fill();
    if (hi) {
      ctx.save();
      ctx.shadowColor = '#8be9fd'; ctx.shadowBlur = 12 + pulse * 14;
      ctx.strokeStyle = lighten('#5b8dff', 0.3); ctx.lineWidth = 2;
      roundRect(x + 2, y + 3, w - 4, ROW_H - 6, 8); ctx.stroke();
      ctx.restore();
    }
    // Rank medal dot for the top three.
    if (rank <= 3) {
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(x + 20, y + ROW_H / 2, 9, 0, Math.PI * 2); ctx.fill();
      text(String(rank), x + 20, midY - 1, '#0b0d17', 12, 'center', '900');
    } else {
      text(`${rank}`, x + 20, midY, hi ? '#cdd6ff' : '#7f8cc4', 14, 'center', '800');
    }
    // Name (truncated to fit) + score.
    const name = fitText(entry.name, 15, hi ? '800' : '600', w - 118);
    text(name, x + 40, midY, hi ? '#ffffff' : '#cdd6ff', 15, 'left', hi ? '800' : '600');
    text(String(entry.score), x + w - 14, midY, hi ? '#8be9fd' : accent, 15, 'right', '800');
    if (hi) text('YOU', x + w - 14, y - 1, '#8be9fd', 9, 'right', '900');
  }

  function drawLeaderboard() {
    const entries = leaderboard.all();
    const highlightIndex = (app.phase === 'result' && app.result) ? app.result.index : -1;

    // Panel backdrop.
    ctx.fillStyle = 'rgba(14,18,36,0.55)';
    roundRect(LB_X - 12, LB_Y - 40, LB_W + 24, LB_H + 52, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(120,150,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
    glowText('🏆 LEADERBOARD', LB_X + LB_W / 2, LB_Y - 16, '#ffe066', 15, 'center', '800', 10);

    const listX = LB_X, listY = LB_Y + 8, listW = LB_W, listH = LB_H - 16;

    // Scroll target: top of the list normally; during the result reveal (after the
    // explosion beat) animate to center the player's row.
    let target = 0;
    const focusing = highlightIndex >= 0 && (clock - resultStart) > 1.3;
    if (focusing) {
      const maxScroll = Math.max(0, entries.length * ROW_H - listH);
      target = Math.min(maxScroll, Math.max(0, highlightIndex * ROW_H - (listH / 2 - ROW_H / 2)));
    }
    lbScroll = lerp(lbScroll, target, 0.12);
    if (Math.abs(lbScroll - target) < 0.4) lbScroll = target;

    ctx.save();
    roundRect(listX, listY, listW, listH, 10); ctx.clip();
    if (entries.length === 0) {
      text('No scores yet.', listX + listW / 2, listY + 46, '#6f7bb0', 15, 'center', '700');
      text('Be the first on the board!', listX + listW / 2, listY + 70, '#8a93c8', 13, 'center', '600');
    }
    for (let i = 0; i < entries.length; i++) {
      const ry = listY + i * ROW_H - lbScroll;
      if (ry + ROW_H < listY || ry > listY + listH) continue; // cull offscreen
      drawLbRow(entries[i], i, listX, ry, listW, i === highlightIndex);
    }
    ctx.restore();
  }

  // ── game-over → name entry → reveal flow (driven by app.phase from main.js) ──
  function drawNameEntry() {
    ctx.fillStyle = 'rgba(4,6,13,0.8)';
    ctx.fillRect(0, 0, CW, CH);
    const cx = CW / 2, cy = CH / 2;
    const won = game.state === STATES.VICTORY;
    panel(cx, cy, 720, 300, 0.92);
    glowText(won ? 'VICTORY!' : 'GAME OVER', cx, cy - 96, won ? '#ffe066' : '#ff5d73', 46, 'center', '900', 26);
    text(`Final Score  ${app.finalScore != null ? app.finalScore : game.score}`, cx, cy - 52, '#e6e8f0', 22);
    text('Enter your LEGO email to save your score', cx, cy - 16, '#aab3e0', 18);

    // Input box.
    const bw = 540, bh = 52, bx = cx - bw / 2, by = cy + 4;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(bx, by, bw, bh, 10); ctx.fill();
    ctx.strokeStyle = '#5b8dff'; ctx.lineWidth = 2;
    roundRect(bx, by, bw, bh, 10); ctx.stroke();
    const shown = app.name || '';
    const placeholder = !shown;
    text(placeholder ? 'firstname.lastname@lego.com' : shown, bx + 18, by + bh / 2 + 7,
      placeholder ? '#5b6690' : '#ffffff', 22, 'left', '700');
    // Blinking caret after the typed text.
    if (!placeholder && Math.floor(caretClock * 2) % 2 === 0) {
      ctx.font = '700 22px system-ui, -apple-system, "Segoe UI", sans-serif';
      const tw = ctx.measureText(shown).width;
      ctx.fillStyle = '#8be9fd';
      ctx.fillRect(bx + 18 + tw + 2, by + 12, 2, bh - 24);
    }

    text('ENTER  to save     ·     ESC  to skip', cx, cy + 92, '#8a93c8', 15);
    text('we save the name before @lego.com so organizers can reach out to winners',
      cx, cy + 118, '#6f7bb0', 12);
  }

  function drawResult() {
    const el = clock - resultStart;
    const cx = FX + FW / 2, cy = FY + FH * 0.42;

    if (app.result) {
      const rank = app.result.rank;
      const rankColor = rank <= 3 ? MEDAL[rank - 1] : '#8be9fd';
      // Pop-in then gentle settle.
      const pop = el < 0.22 ? 0.4 + 2.7 * el : Math.max(1, 1.16 - (el - 0.22) * 0.8);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      glowText('YOU PLACED', 0, -40, '#e6e8f0', 26, 'center', '800', 16);
      glowText(`#${rank}`, 0, 44, rankColor, 88, 'center', '900', 36);
      ctx.restore();
      text(`${app.result.name}  ·  ${app.result.score}`, cx, cy + 96, lighten(rankColor, 0.2), 22, 'center', '800');
      // Celebratory sparkles during the first beat.
      if (el < 1.4 && Math.random() < 0.6) {
        burst(cx + (Math.random() - 0.5) * 340, cy + (Math.random() - 0.5) * 160,
          ['#ffe066', '#4ade80', '#8be9fd', '#a78bfa', rankColor][Math.floor(Math.random() * 5)],
          4, { speed: 160, grav: 90, life: 0.9 });
      }
    } else {
      glowText('SCORE NOT SAVED', cx, cy, '#9aa4d8', 32, 'center', '900', 16);
    }
    drawParticles();

    if (el > 2.4) {
      const a = 0.6 + 0.4 * Math.sin(clock * 4);
      ctx.globalAlpha = a;
      glowText('Press  SPACE  to play again', CW / 2, FY + FH - 24, '#ffe066', 22, 'center', '800', 14);
      ctx.globalAlpha = 1;
    }
  }

  // ── main entry ─────────────────────────────────────────────────────────────
  return function render() {
    const now = performance.now();
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.1) dt = 0.1; // clamp big gaps (tab backgrounded)

    if (game.combo !== prevCombo && game.combo > prevCombo) comboChangedAt = clock;
    caretClock += dt;

    // Entering the result reveal → set its clock and fire the placement explosion once.
    if (app.phase === 'result' && prevPhase !== 'result') {
      resultStart = clock;
      const cx = FX + FW / 2, cy = FY + FH * 0.42;
      const rc = app.result && app.result.rank <= 3 ? MEDAL[app.result.rank - 1] : '#8be9fd';
      burst(cx, cy, rc, 42, { speed: 380, life: 0.8, grav: 160, size: 3.5 });
      burst(cx, cy, '#ffffff', 18, { speed: 260, life: 0.45, grav: 80 });
      ring(cx, cy, lighten(rc, 0.3), 34);
      shockwave(cx, cy, '#ffffff', 120, 0.4, 5);
      shockwave(cx, cy, rc, 200, 0.65, 7);
    }
    prevPhase = app.phase;

    detectEvents();
    integrate(dt);

    drawBackground();

    // Screen shake — offset the whole scene.
    ctx.save();
    if (shake > 0) {
      const m = shake * 14;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }

    const playing = game.state === STATES.PLAYING || game.state === STATES.PAUSED;
    drawField(playing);
    drawPillars();
    drawFlyers();   // comets crossing from the field into the pillar bank
    drawHud();

    drawFilingTag();
    drawCallout();
    drawBadges();   // "pillar protected" popups, on top of everything in-field

    ctx.restore();  // end shake — overlays + leaderboard draw crisp (unshaken)

    // The leaderboard lives above the play/HUD layer but BELOW the full-screen
    // menu / game-over / victory / name overlays, so its left-column panel never
    // covers their centered text. The exception is the result reveal, where the
    // board is the focus (the player's row is highlighted + scrolled to), so
    // there it's drawn last, on top.
    const leaderboardOnTop = app.phase === 'result';
    if (!leaderboardOnTop) drawLeaderboard();

    // Finish flow (name entry / result reveal) takes precedence over the default
    // game-over/victory panels; those remain as a fallback if the flow isn't wired.
    if (app.phase === 'name') drawNameEntry();
    else if (app.phase === 'result') drawResult();
    else if (game.state === STATES.MENU) drawMenu();
    else if (game.state === STATES.PAUSED) {
      ctx.fillStyle = 'rgba(4,6,13,0.55)';
      ctx.fillRect(0, 0, CW, CH);
      glowText('PAUSED', CW / 2, CH / 2, '#e6e8f0', 48, 'center', '900', 24);
      text('Press  P  to resume', CW / 2, CH / 2 + 40, '#9aa4d8', 18);
    }
    else if (game.state === STATES.GAMEOVER) drawGameOver();
    else if (game.state === STATES.VICTORY) drawVictory();

    if (leaderboardOnTop) drawLeaderboard();
  };
}
