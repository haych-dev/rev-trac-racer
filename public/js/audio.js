/* Rev-Trac Racer — sound. Everything is synthesized with WebAudio: no assets.
 * Modes: 2 = sound effects + music, 1 = sound effects only, 0 = silent. */
(() => {
  'use strict';
  const RT = (window.RT = window.RT || {});

  let ac = null, sfxBus = null, musicBus = null, noiseBuf = null;
  let mode = 2;
  try {
    const saved = localStorage.getItem('rtr-sound');
    if (saved !== null && !Number.isNaN(Number(saved))) mode = Number(saved);
  } catch (e) { /* storage unavailable */ }

  function ensure() {
    if (ac) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ac = new AC(); } catch (e) { return false; }
    const master = ac.createGain();
    master.gain.value = 0.9;
    master.connect(ac.destination);
    sfxBus = ac.createGain(); sfxBus.connect(master);
    musicBus = ac.createGain(); musicBus.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    applyMode();
    return true;
  }

  function applyMode() {
    if (!ac) return;
    sfxBus.gain.value = mode >= 1 ? 1 : 0;
    musicBus.gain.value = mode >= 2 ? 0.85 : 0;
  }

  // Browsers only allow audio after a user gesture; call this from click/key handlers.
  function unlock() {
    if (ensure() && ac.state === 'suspended') ac.resume();
  }

  // ---- primitives ----------------------------------------------------------
  function tone(freq, dur, o = {}) {
    if (!ac) return;
    const t0 = o.at !== undefined ? o.at : ac.currentTime + (o.delay || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + dur);
    const vol = (o.vol === undefined ? 0.1 : o.vol) * (o.scale === undefined ? 1 : o.scale);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(o.bus || sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function noise(dur, o = {}) {
    if (!ac) return;
    const t0 = o.at !== undefined ? o.at : ac.currentTime + (o.delay || 0);
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = ac.createBiquadFilter();
    filt.type = o.ftype || 'lowpass';
    filt.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.to) filt.frequency.exponentialRampToValueAtTime(Math.max(30, o.to), t0 + dur);
    if (o.q) filt.Q.value = o.q;
    const g = ac.createGain();
    const vol = (o.vol === undefined ? 0.15 : o.vol) * (o.scale === undefined ? 1 : o.scale);
    g.gain.setValueAtTime(Math.max(0.0002, vol), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(o.bus || sfxBus);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.03);
  }

  const seq = (notes, step, o) => notes.forEach((f, i) => tone(f, o.dur || step, { ...o, delay: (o.delay || 0) + i * step }));

  // ---- sound effects -------------------------------------------------------
  const SFX = {
    click: (s) => tone(900, 0.03, { type: 'triangle', vol: 0.05, scale: s }),
    count: (s) => tone(440, 0.18, { vol: 0.11, scale: s }),
    go: (s) => { tone(880, 0.5, { vol: 0.12, scale: s }); tone(1320, 0.5, { type: 'triangle', vol: 0.08, scale: s }); },
    pickup: (s) => seq([700, 930, 1400], 0.06, { type: 'triangle', vol: 0.1, dur: 0.1, scale: s }),
    boost: (s) => { noise(0.55, { freq: 500, to: 4000, vol: 0.22, ftype: 'bandpass', scale: s }); tone(160, 0.5, { type: 'sawtooth', to: 520, vol: 0.07, scale: s }); },
    pad: (s) => { tone(330, 0.22, { type: 'sawtooth', to: 990, vol: 0.06, scale: s }); noise(0.2, { freq: 1500, to: 5000, vol: 0.09, ftype: 'bandpass', scale: s }); },
    mini1: (s) => tone(520, 0.15, { type: 'triangle', to: 900, vol: 0.1, scale: s }),
    mini2: (s) => { tone(620, 0.25, { type: 'triangle', to: 1500, vol: 0.12, scale: s }); noise(0.25, { freq: 2000, to: 6000, vol: 0.08, ftype: 'bandpass', scale: s }); },
    spin: (s) => { noise(0.45, { freq: 2500, to: 200, vol: 0.26, scale: s }); tone(300, 0.4, { type: 'sawtooth', to: 60, vol: 0.09, scale: s }); },
    bump: (s) => { noise(0.12, { freq: 900, to: 200, vol: 0.2, scale: s }); tone(110, 0.1, { to: 60, vol: 0.07, scale: s }); },
    lock: (s) => { tone(880, 0.06, { vol: 0.09, scale: s }); tone(440, 0.14, { vol: 0.09, delay: 0.06, scale: s }); noise(0.05, { freq: 4000, vol: 0.12, ftype: 'highpass', scale: s }); },
    shield: (s) => { tone(440, 0.3, { type: 'sine', to: 880, vol: 0.12, scale: s }); tone(660, 0.3, { type: 'sine', to: 1320, vol: 0.08, delay: 0.05, scale: s }); },
    oops: (s) => { tone(200, 0.5, { type: 'sawtooth', to: 50, vol: 0.13, scale: s }); noise(0.5, { freq: 300, to: 3000, vol: 0.13, scale: s }); },
    missile: (s) => { noise(0.6, { freq: 800, to: 3500, vol: 0.16, ftype: 'bandpass', scale: s }); tone(900, 0.5, { type: 'sawtooth', to: 200, vol: 0.05, scale: s }); },
    boom: (s) => { noise(0.7, { freq: 1800, to: 80, vol: 0.36, scale: s }); tone(120, 0.5, { type: 'sine', to: 35, vol: 0.28, scale: s }); },
    swap: (s) => { tone(300, 0.25, { type: 'sine', to: 1200, vol: 0.11, scale: s }); tone(1200, 0.25, { type: 'sine', to: 300, vol: 0.11, delay: 0.12, scale: s }); },
    freeze: (s) => { tone(1800, 0.5, { type: 'sine', to: 600, vol: 0.08, scale: s }); tone(2400, 0.4, { type: 'triangle', to: 900, vol: 0.05, delay: 0.05, scale: s }); noise(0.5, { freq: 6000, vol: 0.05, ftype: 'highpass', scale: s }); },
    bug: (s) => seq([330, 311, 294, 220], 0.09, { vol: 0.09, dur: 0.12, scale: s }),
    ink: (s) => { noise(0.3, { freq: 400, to: 150, vol: 0.22, scale: s }); tone(180, 0.25, { type: 'sine', to: 70, vol: 0.14, scale: s }); },
    giant: (s) => { tone(80, 0.6, { type: 'sawtooth', to: 160, vol: 0.13, scale: s }); tone(60, 0.6, { to: 120, vol: 0.07, scale: s }); },
    auto: (s) => seq([523, 659, 784, 1047], 0.07, { type: 'triangle', vol: 0.1, dur: 0.1, scale: s }),
    cab: (s) => tone(500, 0.1, { to: 250, vol: 0.08, scale: s }),
    oil: (s) => noise(0.4, { freq: 700, to: 300, vol: 0.14, ftype: 'bandpass', scale: s }),
    block: (s) => { tone(1200, 0.12, { type: 'triangle', vol: 0.1, scale: s }); tone(1600, 0.15, { type: 'triangle', vol: 0.08, delay: 0.05, scale: s }); },
    lap: (s) => { tone(880, 0.1, { type: 'triangle', vol: 0.1, scale: s }); tone(1175, 0.18, { type: 'triangle', vol: 0.1, delay: 0.1, scale: s }); },
    best: (s) => seq([880, 1175, 1568], 0.1, { type: 'triangle', vol: 0.11, dur: 0.2, scale: s }),
    final: (s) => { tone(784, 0.12, { vol: 0.1, scale: s }); tone(784, 0.12, { vol: 0.1, delay: 0.15, scale: s }); tone(1047, 0.35, { vol: 0.11, delay: 0.3, scale: s }); },
    finish: (s) => { seq([523, 659, 784, 1047], 0.12, { type: 'triangle', vol: 0.12, dur: 0.16, scale: s }); tone(1047, 0.5, { vol: 0.08, delay: 0.5, scale: s }); tone(784, 0.5, { type: 'triangle', vol: 0.08, delay: 0.5, scale: s }); },
    elim: (s) => { tone(400, 0.6, { type: 'sawtooth', to: 40, vol: 0.14, scale: s }); SFX.boom(s); },
    chaos: (s) => { for (let i = 0; i < 2; i++) { tone(520, 0.2, { type: 'sawtooth', vol: 0.1, delay: i * 0.46, scale: s }); tone(390, 0.2, { type: 'sawtooth', vol: 0.1, delay: i * 0.46 + 0.23, scale: s }); } },
    honk: (s, pitch = 1) => { tone(370 * pitch, 0.26, { vol: 0.09, scale: s }); tone(466 * pitch, 0.26, { vol: 0.09, scale: s }); },
    reset: (s) => tone(300, 0.15, { type: 'sine', to: 600, vol: 0.08, scale: s }),
    record: (s) => seq([659, 784, 988, 1319, 1568], 0.09, { type: 'triangle', vol: 0.12, dur: 0.2, scale: s }),
  };

  function sfx(name, scale = 1, extra) {
    if (mode < 1 || scale <= 0 || !SFX[name] || !ensure()) return;
    SFX[name](scale, extra);
  }

  // ---- engine + tyre squeal (continuous) -----------------------------------
  let eng = null;
  function engine(speed, on, skid) {
    if (!ac) return;
    if (!eng) {
      const o1 = ac.createOscillator(); o1.type = 'sawtooth';
      const o2 = ac.createOscillator(); o2.type = 'square';
      const filt = ac.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 600;
      const g = ac.createGain(); g.gain.value = 0;
      o1.connect(filt); o2.connect(filt); filt.connect(g); g.connect(sfxBus);
      o1.start(); o2.start();
      const sk = ac.createBufferSource(); sk.buffer = noiseBuf; sk.loop = true;
      const sf = ac.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 2300; sf.Q.value = 2.5;
      const sg = ac.createGain(); sg.gain.value = 0;
      sk.connect(sf); sf.connect(sg); sg.connect(sfxBus);
      sk.start();
      eng = { o1, o2, filt, g, sg };
    }
    const t = ac.currentTime;
    const f = 58 + speed * 0.4;
    eng.o1.frequency.setTargetAtTime(f, t, 0.05);
    eng.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    eng.filt.frequency.setTargetAtTime(450 + speed * 2.6, t, 0.05);
    eng.g.gain.setTargetAtTime(on ? 0.028 + Math.min(0.03, speed / 16000) : 0, t, 0.08);
    eng.sg.gain.setTargetAtTime(on ? Math.min(0.07, (skid || 0) * 0.07) : 0, t, 0.05);
  }

  // ---- music: a small looping chiptune, scheduled just ahead of the clock ----
  const STEP = 60 / 132 / 4;
  const CHORDS = [
    { root: 45, minor: true },  // A minor
    { root: 41, minor: false }, // F
    { root: 48, minor: false }, // C
    { root: 43, minor: false }, // G
  ];
  const ARP = [0, 2, 1, 3, 2, 4, 3, 5, 4, 2, 3, 1, 2, 0, 1, 2];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  let musicTimer = null, musicStep = 0, musicNext = 0;

  function scheduleStep(s, at) {
    const bar = Math.floor(s / 16) % 4, st = s % 16;
    const ch = CHORDS[bar];
    const bus = musicBus;
    if (st === 0 || st === 8 || (bar === 3 && st === 14)) tone(150, 0.13, { type: 'sine', to: 42, vol: 0.2, at, bus });
    if (st === 4 || st === 12) noise(0.1, { freq: 1900, vol: 0.085, ftype: 'bandpass', q: 0.8, at, bus });
    noise(0.03, { freq: 7500, vol: st % 2 === 0 ? 0.03 : 0.016, ftype: 'highpass', at, bus });
    if ([0, 3, 6, 8, 11, 14].includes(st)) {
      const oct = st === 3 || st === 11 ? 12 : 0;
      tone(hz(ch.root + oct), STEP * 1.7, { type: 'triangle', vol: 0.085, at, bus });
    }
    const tones = ch.minor ? [0, 3, 7, 12, 15, 19] : [0, 4, 7, 12, 16, 19];
    tone(hz(ch.root + 12 + tones[ARP[st]]), STEP * 0.9, { type: 'square', vol: 0.022, at, bus });
  }

  function music(on) {
    if (!on) {
      if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
      return;
    }
    if (musicTimer || !ensure()) return;
    musicStep = 0;
    musicNext = ac.currentTime + 0.08;
    musicTimer = setInterval(() => {
      if (mode < 2) { musicNext = ac.currentTime + 0.05; return; }
      while (musicNext < ac.currentTime + 0.18) {
        scheduleStep(musicStep, musicNext);
        musicNext += STEP;
        musicStep = (musicStep + 1) % 64;
      }
    }, 50);
  }

  function cycleMode() {
    mode = mode === 2 ? 1 : mode === 1 ? 0 : 2;
    try { localStorage.setItem('rtr-sound', String(mode)); } catch (e) { /* ignore */ }
    ensure();
    applyMode();
    return mode;
  }

  RT.Audio = {
    unlock, sfx, engine, music, cycleMode,
    get mode() { return mode; },
    icon: () => (mode === 2 ? '🔊' : mode === 1 ? '🔈' : '🔇'),
    label: () => (mode === 2 ? 'Sound + music' : mode === 1 ? 'Sound effects only' : 'Muted'),
  };
})();
