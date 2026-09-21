// Audio observer for Well-Architected Defender.
// Pure observer — reads game state deltas, triggers Web Audio API synthesis.
// Never writes back to game. All synthesis is oscillators/noise (no asset files).
//
// Modelled on render.js detectEvents(): keeps its own prev-frame vars and is
// called once per rendered frame from main.js AFTER render().

import { STATES } from '../game/game.js';

export function createAudio(game) {
  // ── AudioContext (lazy — created inside the first trusted gesture so browsers
  //    never log "AudioContext was not allowed to start", AC-18) ─────────────
  // Before any gesture: ctx === null → contextState returns 'suspended' (AC-1).
  let ctx = null;

  // ── One-time first-gesture handler ────────────────────────────────────────
  // Attached to 'window' with capture so a real key press or a real pointer-down
  // (including clicking the mute button) always reaches this handler first.
  function onGesture() {
    removeGestureListeners();
    if (ctx) {
      // Already created (shouldn't happen, but be safe).
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Creating inside a trusted gesture starts the context 'running' directly
      // on most browsers. Call resume() anyway in case it started 'suspended'.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) {
      // Web Audio not available — all synthesis calls will be no-ops.
    }
  }
  function removeGestureListeners() {
    window.removeEventListener('keydown', onGesture, true);
    window.removeEventListener('pointerdown', onGesture, true);
  }
  window.addEventListener('keydown', onGesture, true);
  window.addEventListener('pointerdown', onGesture, true);

  // ── Mute + SFX log ────────────────────────────────────────────────────────
  let muted = false;
  const sfxLog = [];
  const MAX_LOG = 64;

  // Push to the log regardless of mute state (AC-14).
  function logSfx(name) {
    sfxLog.push({ name, frame: game.frame });
    if (sfxLog.length > MAX_LOG) sfxLog.shift();
  }

  // Log the event, then play only if unmuted and context is running.
  function play(name) {
    logSfx(name);
    if (muted || !ctx || ctx.state !== 'running') return;
    try {
      sfxFns[name]?.();
    } catch (_) {
      // Synthesis errors are non-fatal.
    }
  }

  // ── Bullet tracking (detect new bullet objects each frame) ────────────────
  // game.bullets holds live bullet objects. A bullet object is created in fire()
  // and removed when dead or off-screen. Tracking by object reference with a
  // WeakSet gives one 'shoot' event per unique bullet spawned, naturally
  // respecting paused state (fire() never runs while paused).
  let seenBullets = new WeakSet();

  // ── Prev-frame state ──────────────────────────────────────────────────────
  let prevFilingFrame   = -1;
  let prevCalloutFrame  = -1;
  let prevCloud         = game.cloudHealth;
  let prevCombo         = game.combo;
  let prevState         = game.state;

  // ── SFX synthesis ─────────────────────────────────────────────────────────
  // Every function is self-contained: all nodes connect → destination, schedule
  // their own .stop(), and hold no persistent references (no leaks).

  function playShoot() {
    const t = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.07);
    gain.gain.setValueAtTime(0.14, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  function playFiling() {
    const t = ctx.currentTime;
    // Noise burst (impact punch).
    const bufSamples = Math.ceil(ctx.sampleRate * 0.1);
    const buf  = ctx.createBuffer(1, bufSamples, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSamples; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSamples * 0.25));
    }
    const ns     = ctx.createBufferSource();
    ns.buffer = buf;
    const bpf    = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 900;
    bpf.Q.value = 1.8;
    const nGain  = ctx.createGain();
    ns.connect(bpf);
    bpf.connect(nGain);
    nGain.connect(ctx.destination);
    nGain.gain.setValueAtTime(0.38, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    ns.start(t);
    ns.stop(t + 0.15);
    // Descending tone on top.
    const osc  = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.connect(oGain);
    oGain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.18);
    oGain.gain.setValueAtTime(0.22, t);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  function playCallout() {
    // Rising three-note arpeggio (C5 – E5 – G5).
    const t     = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const s    = t + i * 0.09;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(0.22, s + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.28);
      osc.start(s);
      osc.stop(s + 0.3);
    });
  }

  function playBreach() {
    // Low-frequency boom.
    const t          = ctx.currentTime;
    const bufSamples = Math.ceil(ctx.sampleRate * 0.35);
    const buf  = ctx.createBuffer(1, bufSamples, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSamples; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSamples * 0.3));
    }
    const ns   = ctx.createBufferSource();
    ns.buffer = buf;
    const lpf  = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 220;
    const gain = ctx.createGain();
    ns.connect(lpf);
    lpf.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.8, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    ns.start(t);
    ns.stop(t + 0.4);
  }

  function playGameover() {
    // Descending minor four-note phrase (G4 F4 Eb4 C4).
    const t     = ctx.currentTime;
    const notes = [392, 349.23, 311.13, 261.63];
    notes.forEach((freq, i) => {
      const s    = t + i * 0.2;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.16, s);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.32);
      osc.start(s);
      osc.stop(s + 0.35);
    });
  }

  function playVictory() {
    // Rising fanfare (C5 E5 G5 C6).
    const t     = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const s    = t + i * 0.13;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(0.26, s + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.44);
      osc.start(s);
      osc.stop(s + 0.46);
    });
  }

  function playCombo() {
    // Quick ascending blip.
    const t    = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(1100, t + 0.06);
    gain.gain.setValueAtTime(0.11, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  const sfxFns = {
    shoot:    playShoot,
    filing:   playFiling,
    callout:  playCallout,
    breach:   playBreach,
    gameover: playGameover,
    victory:  playVictory,
    combo:    playCombo,
  };

  // ── Background music scheduler ────────────────────────────────────────────
  // Lookahead scheduler: setInterval every 25ms, schedules notes up to 100ms
  // ahead of ctx.currentTime. All note data is fixed (no Math.random for
  // note selection). Math.random is only used to fill noise buffers (cosmetic).

  const STEP_TIME       = 0.1;  // 150 BPM, 16th-note = 60/(150*4) = 0.1s
  const LOOKAHEAD       = 0.1;  // seconds ahead to schedule
  const SCHEDULE_INTERVAL_MS = 25; // ms between scheduler ticks

  // Musical data: D minor, 16-step loop.
  // Lead: square osc, gain 0.10, even steps, dur 0.07s.
  const LEAD_STEPS  = [0, 2, 4, 6, 8, 10, 12, 14];
  const LEAD_FREQS  = [293.66, 349.23, 392.00, 349.23, 329.63, 293.66, 261.63, 293.66];
  // Bass: square osc, gain 0.08, quarter steps, dur 0.18s.
  const BASS_STEPS  = [0, 4, 8, 12];
  const BASS_FREQS  = [146.83, 174.61, 146.83, 196.00];
  // Hi-hat: noise bandpass ~7kHz, gain 0.05, dur 0.018s, even steps.
  const HIHAT_STEPS = [0, 2, 4, 6, 8, 10, 12, 14];
  // Kick: noise lowpass ~90Hz, gain 0.35, dur 0.09s, steps 0 and 8.
  const KICK_STEPS  = [0, 8];

  // Master music gain (all music voices → musicGain → destination).
  const MUSIC_GAIN_NORMAL = 0.55;
  let musicGainNode = null; // created lazily when ctx exists

  // Scheduler state.
  let schedulerInterval = null; // setInterval handle; non-null iff scheduler running
  let nextNoteTime      = 0;    // absolute ctx time for the next step
  let currentStep       = 0;    // 0–15
  let musicState        = 'stopped'; // 'stopped' | 'playing' | 'paused'

  function ensureMusicGain() {
    if (!ctx || musicGainNode) return;
    musicGainNode = ctx.createGain();
    musicGainNode.gain.value = muted ? 0 : MUSIC_GAIN_NORMAL;
    musicGainNode.connect(ctx.destination);
  }

  function applyMuteToMusic() {
    if (!musicGainNode) return;
    musicGainNode.gain.value = muted ? 0 : MUSIC_GAIN_NORMAL;
  }

  function scheduleStep(step, time) {
    if (!ctx || !musicGainNode) return;

    // Lead voice.
    const leadIdx = LEAD_STEPS.indexOf(step);
    if (leadIdx !== -1) {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.connect(g);
      g.connect(musicGainNode);
      osc.type = 'square';
      osc.frequency.value = LEAD_FREQS[leadIdx];
      g.gain.setValueAtTime(0.10, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.07);
      osc.start(time);
      osc.stop(time + 0.07);
    }

    // Bass voice.
    const bassIdx = BASS_STEPS.indexOf(step);
    if (bassIdx !== -1) {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.connect(g);
      g.connect(musicGainNode);
      osc.type = 'square';
      osc.frequency.value = BASS_FREQS[bassIdx];
      g.gain.setValueAtTime(0.08, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
      osc.start(time);
      osc.stop(time + 0.18);
    }

    // Hi-hat voice (noise burst, Math.random is fine for buffer fill).
    if (HIHAT_STEPS.includes(step)) {
      const bufSamples = Math.ceil(ctx.sampleRate * 0.018);
      const buf  = ctx.createBuffer(1, bufSamples, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSamples; i++) data[i] = Math.random() * 2 - 1;
      const ns  = ctx.createBufferSource();
      ns.buffer = buf;
      const bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.value = 7000;
      bpf.Q.value = 3;
      const g = ctx.createGain();
      ns.connect(bpf);
      bpf.connect(g);
      g.connect(musicGainNode);
      g.gain.setValueAtTime(0.05, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.018);
      ns.start(time);
      ns.stop(time + 0.018);
    }

    // Kick voice (noise burst, Math.random is fine for buffer fill).
    if (KICK_STEPS.includes(step)) {
      const bufSamples = Math.ceil(ctx.sampleRate * 0.09);
      const buf  = ctx.createBuffer(1, bufSamples, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSamples; i++) data[i] = Math.random() * 2 - 1;
      const ns  = ctx.createBufferSource();
      ns.buffer = buf;
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 90;
      const g = ctx.createGain();
      ns.connect(lpf);
      lpf.connect(g);
      g.connect(musicGainNode);
      g.gain.setValueAtTime(0.35, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
      ns.start(time);
      ns.stop(time + 0.09);
    }
  }

  function runScheduler() {
    if (!ctx) return;
    const lookAheadEnd = ctx.currentTime + LOOKAHEAD;
    while (nextNoteTime < lookAheadEnd) {
      scheduleStep(currentStep, nextNoteTime);
      currentStep = (currentStep + 1) % 16;
      nextNoteTime += STEP_TIME;
    }
  }

  // musicStart(): called on fresh PLAYING entry (non-resume).
  function musicStart() {
    // Defensive: only start if context is running.
    if (!ctx || ctx.state !== 'running') {
      musicState = 'stopped';
      return;
    }
    // Double-start guard: clear any existing interval before starting a new one.
    if (schedulerInterval !== null) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    ensureMusicGain();
    currentStep  = 0;
    nextNoteTime = ctx.currentTime;
    schedulerInterval = setInterval(runScheduler, SCHEDULE_INTERVAL_MS);
    musicState = 'playing';
  }

  // musicPause(): called on PLAYING→PAUSED.
  function musicPause() {
    if (schedulerInterval !== null) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    musicState = 'paused';
  }

  // musicResume(): called on PAUSED→PLAYING.
  function musicResume() {
    if (!ctx || ctx.state !== 'running') return;
    // Double-start guard.
    if (schedulerInterval !== null) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    ensureMusicGain();
    // Reset nextNoteTime to now so there's no gap after pause.
    nextNoteTime = ctx.currentTime;
    schedulerInterval = setInterval(runScheduler, SCHEDULE_INTERVAL_MS);
    musicState = 'playing';
  }

  // musicStop(): called on →GAMEOVER, →VICTORY, →MENU, destroy().
  function musicStop() {
    if (schedulerInterval !== null) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    musicState = 'stopped';
  }

  // ── Main observer (call once per rendered frame, after render()) ──────────
  function observe() {
    const stateChanged = prevState !== game.state;

    // ── Music state machine ──────────────────────────────────────────────────
    if (stateChanged) {
      // Fresh start / restart: any → PLAYING where prev was not PAUSED.
      if (game.state === STATES.PLAYING && prevState !== STATES.PAUSED) {
        musicStart();
      }
      // PLAYING → PAUSED.
      else if (prevState === STATES.PLAYING && game.state === STATES.PAUSED) {
        musicPause();
      }
      // PAUSED → PLAYING (resume).
      else if (prevState === STATES.PAUSED && game.state === STATES.PLAYING) {
        musicResume();
      }
      // → terminal / menu states.
      else if (
        game.state === STATES.GAMEOVER ||
        game.state === STATES.VICTORY  ||
        game.state === STATES.MENU
      ) {
        musicStop();
      }
    }

    // Reset on any (re)entry to a fresh run — same guard as render.js detectEvents().
    if (
      stateChanged &&
      game.state === STATES.PLAYING &&
      prevState !== STATES.PAUSED
    ) {
      prevFilingFrame  = -1;
      prevCalloutFrame = -1;
      prevCloud  = game.cloudHealth;
      prevCombo  = game.combo;
      // Replace the WeakSet so old bullet refs are no longer tracked.
      seenBullets = new WeakSet();
    }

    if (game.state === STATES.PLAYING) {
      // 'shoot' — detect new bullet objects (fire() only runs while PLAYING).
      for (const b of game.bullets) {
        if (!seenBullets.has(b)) {
          seenBullets.add(b);
          play('shoot');
        }
      }

      // 'filing' — lastFiling.frame changed.
      const f = game.lastFiling;
      if (f && f.frame !== prevFilingFrame) {
        prevFilingFrame = f.frame;
        play('filing');
      }

      // 'callout' — lastCallout.frame changed.
      const c = game.lastCallout;
      if (c && c.frame !== prevCalloutFrame) {
        prevCalloutFrame = c.frame;
        play('callout');
      }

      // 'breach' — cloudHealth dropped vs prev (one entry per frame even if multiple).
      if (game.cloudHealth < prevCloud) {
        play('breach');
      }

      // 'combo' — combo increased vs prev.
      if (game.combo > prevCombo) {
        play('combo');
      }
    }

    // 'gameover' / 'victory' — once on the transition frame, no re-fire.
    if (game.state === STATES.GAMEOVER && prevState !== STATES.GAMEOVER) {
      play('gameover');
    }
    if (game.state === STATES.VICTORY && prevState !== STATES.VICTORY) {
      play('victory');
    }

    prevCloud  = game.cloudHealth;
    prevCombo  = game.combo;
    prevState  = game.state;
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    musicStop(); // stop scheduler before closing context
    removeGestureListeners();
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }
    musicGainNode = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    observe,
    destroy,
    toggleMute() {
      muted = !muted;
      applyMuteToMusic();
    },
    get muted()         { return muted; },
    set muted(v)        { muted = !!v; applyMuteToMusic(); },
    get contextState()  { return ctx ? ctx.state : 'suspended'; },
    get sfxLog()        { return sfxLog; },
    clearSfxLog()       { sfxLog.length = 0; },
    // Music observability (consumed by the DEV hook in main.js).
    get musicPlaying()  { return schedulerInterval !== null; },
    get musicState()    { return musicState; },
  };
}
