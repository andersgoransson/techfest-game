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
function hexToRgb(hex) {
  const h = hex.replace('#', '');
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

export function createRenderer(ctx, game) {
  const canvas = ctx.canvas;
  const CW = canvas.width;   // 1280
  const CH = canvas.height;  // 720

  // ── layout ──────────────────────────────────────────────────────────────
  const HUD_H = 84;
  const FW = game.width;     // logical field width  (820)
  const FH = game.height;    // logical field height (600)
  const FX = 42;             // field origin on canvas
  const FY = HUD_H + 16;     // 100
  const SIDE = 34;
  const PANEL_W = CW - FX - FW - 36 - SIDE; // gap 36 between field and panel
  const PANEL_X = CW - SIDE - PANEL_W;
  const PANEL_Y = FY;
  const PANEL_H = FH;

  // ── render-local effect state ─────────────────────────────────────────────
  const particles = []; // {x,y,vx,vy,life,max,color,size,grav,glow}
  const floaters = [];  // {x,y,vy,life,max,text,color,size}
  const pulses = {};     // pillar key -> remaining pulse time (sec)
  for (const k of PILLAR_KEYS) pulses[k] = 0;
  let shake = 0;         // remaining shake time (sec)
  let flash = null;      // {color, t, max}
  const stars = makeStars(90);

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
      for (const k of PILLAR_KEYS) pulses[k] = 0;
      shake = 0;
      flash = null;
      prevCloud = game.cloudHealth;
      prevCombo = game.combo;
    }

    if (game.state === STATES.PLAYING) {
      // New filing → burst + floater + pillar pulse.
      const f = game.lastFiling;
      if (f && f.frame !== prevFilingFrame) {
        prevFilingFrame = f.frame;
        const color = PILLAR_COLORS[f.pillar] || '#8be9fd';
        if (typeof f.x === 'number') {
          const p = toCanvas(f.x, f.y);
          burst(p.x, p.y, color, 16, { speed: 200, life: 0.55 });
          addFloater(p.x, p.y - 10, `+${TUNABLES.FILL_GAIN}`, lighten(color, 0.3), 22);
        }
        const idx = PILLAR_KEYS.indexOf(f.pillar);
        if (idx >= 0) {
          pulses[f.pillar] = 0.5;
          const pr = pillarRect(idx);
          burst(pr.x + pr.w / 2, pr.bottom, color, 8, { speed: 120, lift: 60, life: 0.5 });
        }
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
    for (const k of PILLAR_KEYS) if (pulses[k] > 0) pulses[k] = Math.max(0, pulses[k] - dt);
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

    // Danger zone gradient near the breach line.
    const dz = ctx.createLinearGradient(0, FY + FH - 70, 0, FY + FH);
    dz.addColorStop(0, 'rgba(255,93,115,0)');
    dz.addColorStop(1, 'rgba(255,93,115,0.14)');
    ctx.fillStyle = dz;
    ctx.fillRect(FX, FY + FH - 70, FW, 70);
    ctx.strokeStyle = 'rgba(255,93,115,0.5)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(FX, FY + FH - 3);
    ctx.lineTo(FX + FW, FY + FH - 3);
    ctx.stroke();
    ctx.setLineDash([]);

    // Entities (only when a run is active — menu shows the legend instead).
    if (playing) {
      for (const e of game.threats) drawThreat(e);
      for (const b of game.bullets) drawBullet(b);
      if (game.player) drawPlayer(game.player);
    }

    // Particles live in canvas space; draw them clipped to the field.
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
    const bob = Math.sin(clock * 4 + e.x * 0.05) * 2;
    const c = toCanvas(e.x, e.y + bob);
    const color = PILLAR_COLORS[e.pillar] || '#ff5d73';
    const vw = e.w + 14, vh = e.h + 10; // visual chip larger than the hitbox
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

    // Title.
    glowText('WELL-ARCHITECTED', SIDE, 34, '#cdd6ff', 20, 'left', '800', 14);
    text('D E F E N D E R', SIDE, 58, '#6f7bb0', 14, 'left', '700');

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

    // Cloud health bar (right side).
    const bw = 240, bh = 16;
    const bx = CW - SIDE - bw, by = 34;
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
    if (game.state === STATES.PLAYING && game.lastFiling && game.frame - game.lastFiling.frame < 100) {
      const a = 1 - (game.frame - game.lastFiling.frame) / 100;
      ctx.globalAlpha = Math.max(0, a);
      const y = FY + FH - 40;
      ctx.fillStyle = 'rgba(6,9,18,0.6)';
      roundRect(FX + FW / 2 - 190, y - 22, 380, 32, 10); ctx.fill();
      text(game.lastFiling.text, FX + FW / 2, y, '#e6e8f0', 16, 'center', '700');
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

  // ── main entry ─────────────────────────────────────────────────────────────
  return function render() {
    const now = performance.now();
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.1) dt = 0.1; // clamp big gaps (tab backgrounded)

    if (game.combo !== prevCombo && game.combo > prevCombo) comboChangedAt = clock;

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
    drawHud();

    drawFilingTag();
    drawCallout();

    if (game.state === STATES.MENU) drawMenu();
    else if (game.state === STATES.PAUSED) {
      ctx.fillStyle = 'rgba(4,6,13,0.55)';
      ctx.fillRect(0, 0, CW, CH);
      glowText('PAUSED', CW / 2, CH / 2, '#e6e8f0', 48, 'center', '900', 24);
      text('Press  P  to resume', CW / 2, CH / 2 + 40, '#9aa4d8', 18);
    }
    else if (game.state === STATES.GAMEOVER) drawGameOver();
    else if (game.state === STATES.VICTORY) drawVictory();

    ctx.restore();
  };
}
