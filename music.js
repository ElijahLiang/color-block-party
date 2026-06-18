/**
 * music.js — Web Audio analyzer + visual driver.
 * Ports the Processing MusicAnalyzer/VisualDriver into the browser:
 *   - chorusLevel (0..1)     · vocal-vs-backing detection
 *   - beat / beatPulse       · bass-spike detector with cooldown
 *   - bandVal[8], bandExcess · perceptual 8-band split for visuals
 *   - gain, timeScale        · smoothed drivers for the poster
 *
 * Exposes window.MUSIC = { state, update, loadFile, useMicrophone, ... }.
 */
(function () {
  const FFT_SIZE = 4096;             // → 2048 bins (~10.7Hz each) so semitones
                                     //   are actually resolvable down to ~180Hz;
                                     //   1024 was far too coarse for chroma.
  const VOCAL_LO_HZ = 500;
  const VOCAL_HI_HZ = 4000;

  const SMOOTH_SLOW = 0.06;
  const SMOOTH_FAST = 0.35;
  const SMOOTH_BAND = 0.12;

  const CHORUS_SCORE_GATE = 0.55;
  const CHORUS_RATIO_GATE = 1.15;
  const CHORUS_HOLD_FRAMES = 36;
  const CHORUS_RISE = 0.09;
  const CHORUS_FALL = 0.04;

  const BEAT_RATIO = 1.5;
  const BEAT_COOLDOWN_FRM = 11;
  const BEAT_MIN_BASS = 0.025;

  // ── kick drum: sub-bass onset via spectral flux ──
  // The byte spectrum pins loud bass at 255 (maxDecibels = -30dB), flattening
  // the very transient we need, and a sustained bassline keeps band energy high
  // so level-vs-average ratio gates never trip. Detection therefore runs on the
  // float (dB) spectrum: per-bin positive rises (spectral flux) stay near zero
  // for sustained bass and spike only on attacks, judged against an adaptive
  // mean + K·std threshold so it self-calibrates to any mix level / frame rate.
  const KICK_HI_HZ = 160;           // sub-bass + kick fundamental band
  const KICK_FLUX_HIST = 48;        // flux samples kept (~0.8s at 60fps)
  const KICK_FLUX_STD_K = 2.0;      // fire above mean + K·std of recent flux
  const KICK_FLUX_FLOOR = 0.004;    // absolute flux floor (linear magnitude)
  const KICK_MIN_ENERGY = 0.04;     // band must be audible (byte scale, 0..1)
  const KICK_COOLDOWN_MS = 120;     // refractory period (time-based, not frames)

  const NUM_BANDS = 8;
  const EPS = 1e-4;

  // ── chroma / pitch detection ──
  const NUM_PITCH_CLASSES = 12;
  const NOTE_MIDI_LO = 48;          // C3 ≈ 130Hz
  const NOTE_MIDI_HI = 96;          // C7 ≈ 2093Hz
  const NOTE_COUNT = NOTE_MIDI_HI - NOTE_MIDI_LO + 1;
  const A4_HZ = 440;
  const NOTE_ONSET_RATIO = 1.55;
  const NOTE_ONSET_MIN = 0.06;
  const NOTE_COOLDOWN_FRM = 16;
  const NOTE_SMOOTH = 0.10;

  // ── monophonic pitch (YIN) — true fundamental, for the staff readout ──
  // FFT-bin chroma can't resolve real pitch; YIN on the time-domain signal can
  // (for one dominant note at a time, i.e. a melody/voice/instrument line).
  const PITCH_WIN = 1536;           // analysis window (samples)
  const PITCH_TAU_MAX = 700;        // lowest f0 ≈ sampleRate / 700 ≈ 63Hz
  const PITCH_STRIDE = 2;           // decimate inner loop for speed
  const PITCH_THRESHOLD = 0.14;     // YIN absolute threshold

  // ── chord recognition (template match on the chroma) ──
  // When the music is polyphonic, YIN can't lock a single pitch, so we instead
  // estimate the triad whose tones capture the most chroma energy.
  const CHORD_TEMPLATES = [
    { q: "maj", iv: [0, 4, 7] },
    { q: "min", iv: [0, 3, 7] },
  ];
  const CHORD_SCORE_GATE = 0.58;    // fraction of chroma SALIENCE inside the triad
  const CHORD_HOLD_BONUS = 0.85;    // hysteresis: the current chord re-qualifies
                                    // at gate×this, so the readout doesn't flicker

  const state = {
    ready: false,
    sourceName: "",
    ctx: null,
    analyser: null,
    source: null,
    audio: null,
    objectUrl: null,
    stream: null,
    spectrum: null,
    timeBuf: null,
    bins: 0,
    freqPerBin: 0,

    vocalStart: 0, vocalEnd: 0,
    bandEdge: new Int32Array(NUM_BANDS + 1),
    bandVal: new Float32Array(NUM_BANDS),
    bandAvg: new Float32Array(NUM_BANDS),
    bandExcess: new Float32Array(NUM_BANDS),

    noteBins: new Int32Array(NOTE_COUNT),
    noteMidis: new Int32Array(NOTE_COUNT),
    noteEnergy: new Float32Array(NUM_PITCH_CLASSES),
    noteAvg: new Float32Array(NUM_PITCH_CLASSES),
    noteOnset: new Uint8Array(NUM_PITCH_CLASSES),
    noteOnsetEnergy: new Float32Array(NUM_PITCH_CLASSES),
    noteOctaveHint: new Int8Array(NUM_PITCH_CLASSES),
    noteCooldown: new Uint8Array(NUM_PITCH_CLASSES),

    level: 0, levelSmooth: 0, levelAvg: 0,
    vocalEnergy: 0, vocalAvg: 0,
    backingEnergy: 0, backingAvg: 0,
    bassEnergy: 0, bassAvg: 0,
    vocalRatio: 0,

    chorusScore: 0, chorusLevel: 0, chorusHoldFrames: 0,
    beat: false, beatPulse: 0, beatCooldown: 0,
    kick: false, kickPulse: 0, kickEnergy: 0, kickAvg: 0,
    kickEnd: 0, kickSpec: null, kickMagPrev: null,
    kickFluxHist: new Float32Array(KICK_FLUX_HIST),
    kickFluxIdx: 0, kickFluxCount: 0, lastKickMs: -1e9,

    pitchHz: 0, pitchMidi: 0, pitchClarity: 0,
    yinBuf: new Float32Array(PITCH_TAU_MAX),

    chromaSmooth: new Float32Array(NUM_PITCH_CLASSES),
    chromaSal: new Float32Array(NUM_PITCH_CLASSES),
    chord: { root: -1, quality: "", score: 0 },

    ended: false,

    gain: 0,
    timeScale: 1, timeTarget: 1,
  };

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, v | 0)); }

  function ensureCtx() {
    if (state.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio not supported");
    state.ctx = new Ctx();
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = FFT_SIZE;
    state.analyser.smoothingTimeConstant = 0.4;  // less damping → transients survive for kick detection
    state.bins = state.analyser.frequencyBinCount;
    state.spectrum = new Uint8Array(state.bins);
    state.timeBuf = new Uint8Array(FFT_SIZE);
    state.freqPerBin = state.ctx.sampleRate / FFT_SIZE;
    initBins();
  }

  function initBins() {
    const half = state.bins;
    state.vocalStart = clampInt(Math.floor(VOCAL_LO_HZ / state.freqPerBin), 1, half - 2);
    state.vocalEnd = clampInt(Math.floor(VOCAL_HI_HZ / state.freqPerBin), state.vocalStart + 1, half);
    for (let i = 0; i <= NUM_BANDS; i++) {
      state.bandEdge[i] = Math.floor(Math.pow(i / NUM_BANDS, 2) * half);
    }
    for (let i = 1; i <= NUM_BANDS; i++) {
      if (state.bandEdge[i] <= state.bandEdge[i - 1]) {
        state.bandEdge[i] = state.bandEdge[i - 1] + 1;
      }
    }

    // Precompute MIDI → FFT bin index for the note range
    for (let i = 0; i < NOTE_COUNT; i++) {
      const midi = NOTE_MIDI_LO + i;
      const f = A4_HZ * Math.pow(2, (midi - 69) / 12);
      state.noteMidis[i] = midi;
      state.noteBins[i] = Math.round(f / state.freqPerBin);
    }

    state.kickEnd = Math.min(half, Math.max(2, Math.floor(KICK_HI_HZ / state.freqPerBin) + 1));
    state.kickSpec = new Float32Array(half);
    state.kickMagPrev = new Float32Array(state.kickEnd);
  }

  async function resume() {
    if (state.ctx && state.ctx.state === "suspended") {
      try { await state.ctx.resume(); } catch (e) {}
    }
  }

  function detach() {
    if (state.source) { try { state.source.disconnect(); } catch (e) {} state.source = null; }
    if (state.audio) {
      try { state.audio.pause(); state.audio.removeAttribute("src"); state.audio.load(); state.audio.remove(); } catch (e) {}
      state.audio = null;
    }
    if (state.objectUrl) { try { URL.revokeObjectURL(state.objectUrl); } catch (e) {} state.objectUrl = null; }
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    state.ready = false;
    state.ended = false;
    state.sourceName = "";
    // Fresh source → fresh kick calibration.
    state.kickFluxCount = 0;
    state.kickFluxIdx = 0;
    state.lastKickMs = -1e9;
    if (state.kickMagPrev) state.kickMagPrev.fill(0);
  }

  // Resolve as soon as the element is playable. Safari never advances a DETACHED
  // <audio>'s readyState (so `canplay` never fires and loading hangs forever),
  // hence the caller attaches it to the DOM first. We also accept the earliest of
  // several readiness events and fall back to a timeout — anything but hanging.
  function waitUntilPlayable(audio) {
    return new Promise((resolve, reject) => {
      let done = false;
      const events = ["loadeddata", "canplay", "canplaythrough"];
      const cleanup = () => {
        events.forEach((e) => audio.removeEventListener(e, finish));
        audio.removeEventListener("error", fail);
        clearTimeout(timer);
      };
      const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
      const fail = () => { if (done) return; done = true; cleanup(); reject(new Error("audio load failed")); };
      if (audio.readyState >= 2) { resolve(); return; }   // HAVE_CURRENT_DATA
      events.forEach((e) => audio.addEventListener(e, finish, { once: true }));
      audio.addEventListener("error", fail, { once: true });
      const timer = setTimeout(() => { audio.error ? fail() : finish(); }, 8000);
    });
  }

  async function loadFile(file) {
    ensureCtx();
    await resume();
    detach();
    const url = URL.createObjectURL(file);
    state.objectUrl = url;
    const audio = new Audio();
    audio.loop = false;  // let the song end so the Mondrian composition completes
    audio.preload = "auto";
    // Hidden, but ATTACHED to the document: Safari won't load (or fire canplay on)
    // a detached media element, which is what left the UI stuck on "loading…".
    audio.style.display = "none";
    document.body.appendChild(audio);
    audio.src = url;
    audio.load();
    try {
      await waitUntilPlayable(audio);
    } catch (e) {
      try { audio.remove(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
      if (state.objectUrl === url) state.objectUrl = null;
      throw e;
    }
    audio.addEventListener("ended", () => { state.ended = true; }, { once: true });
    const src = state.ctx.createMediaElementSource(audio);
    src.connect(state.analyser);
    state.analyser.connect(state.ctx.destination);
    state.audio = audio;
    state.source = src;
    state.sourceName = file.name;
    state.ended = false;
    state.ready = true;
    try { await audio.play(); } catch (e) {}
  }

  async function useMicrophone() {
    ensureCtx();
    await resume();
    detach();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = state.ctx.createMediaStreamSource(stream);
    src.connect(state.analyser);
    // mic is intentionally NOT routed to destination (avoid feedback)
    state.source = src;
    state.stream = stream;
    state.sourceName = "microphone";
    state.ended = false;
    state.ready = true;
  }

  function togglePlay() {
    if (!state.audio) return;
    if (state.audio.paused) state.audio.play(); else state.audio.pause();
  }

  function isPlaying() {
    return !!(state.audio && !state.audio.paused) || !!state.stream;
  }

  function update() {
    state.beat = false;
    state.kick = false;
    state.noteOnset.fill(0);
    state.beatPulse = Math.max(0, state.beatPulse - 0.06);
    state.kickPulse = Math.max(0, state.kickPulse - 0.08);

    if (!state.ready) {
      state.chorusLevel = lerp(state.chorusLevel, 0, 0.03);
      state.gain = lerp(state.gain, 0, 0.03);
      state.levelSmooth = lerp(state.levelSmooth, 0, 0.04);
      state.timeScale = lerp(state.timeScale, 1, 0.04);
      return;
    }

    state.analyser.getByteFrequencyData(state.spectrum);
    state.analyser.getByteTimeDomainData(state.timeBuf);

    // RMS amplitude from time domain
    let sumSq = 0;
    for (let i = 0; i < state.timeBuf.length; i++) {
      const v = (state.timeBuf[i] - 128) / 128;
      sumSq += v * v;
    }
    state.level = Math.sqrt(sumSq / state.timeBuf.length);
    state.levelAvg = lerp(state.levelAvg, state.level, SMOOTH_SLOW);
    state.levelSmooth = lerp(state.levelSmooth, state.level, SMOOTH_FAST);

    sweep();
    updateChorus();
    updateBeat();
    updateKick();
    detectPitch();
    detectChord();
    updateDrivers();
  }

  // Chord recognition: smooth + normalize the chroma, then pick the major/minor
  // triad whose three tones hold the most energy. Fills in when YIN can't lock a
  // single melodic pitch (i.e. during chords / polyphonic passages).
  function detectChord() {
    const cs = state.chromaSmooth;
    let maxE = 1e-6;
    for (let pc = 0; pc < 12; pc++) if (state.noteEnergy[pc] > maxE) maxE = state.noteEnergy[pc];
    let sum = 0;
    for (let pc = 0; pc < 12; pc++) {
      const v = state.noteEnergy[pc] / maxE;
      cs[pc] += (v - cs[pc]) * 0.25;
      sum += cs[pc];
    }
    if (state.level < 0.02 || sum < EPS) { state.chord.root = -1; state.chord.score = 0; return; }

    // The raw chroma is FLAT: byte-spectrum saturation plus peak-across-octaves
    // folding give every pitch class a high floor, so a triad's 3-of-12 share
    // of the TOTAL tops out around 0.37 — the old 0.5 gate could never pass and
    // the readout sat dead at "—". Score the SALIENCE above the chroma mean
    // instead: a flat chroma has ~zero salience everywhere (no chord claimed),
    // while a real triad pops its three tones above the mean and wins clearly.
    const mean = sum / 12;
    const sal = state.chromaSal;
    let salSum = 0;
    for (let pc = 0; pc < 12; pc++) {
      sal[pc] = Math.max(0, cs[pc] - mean);
      salSum += sal[pc];
    }
    if (salSum < 0.05) { state.chord.root = -1; state.chord.score = 0; return; }

    let bestScore = -1, bestRoot = -1, bestQ = "";
    for (let r = 0; r < 12; r++) {
      for (let t = 0; t < CHORD_TEMPLATES.length; t++) {
        const iv = CHORD_TEMPLATES[t].iv;
        let inSum = 0;
        for (let k = 0; k < iv.length; k++) inSum += sal[(r + iv[k]) % 12];
        const score = inSum / salSum;
        if (score > bestScore) { bestScore = score; bestRoot = r; bestQ = CHORD_TEMPLATES[t].q; }
      }
    }
    state.chord.score = bestScore;
    // Hysteresis: the chord we're already showing re-qualifies at a lower gate,
    // so brief dips don't flicker the readout between a chord and "—".
    const holding = state.chord.root === bestRoot && state.chord.quality === bestQ;
    const gate = holding ? CHORD_SCORE_GATE * CHORD_HOLD_BONUS : CHORD_SCORE_GATE;
    if (bestScore > gate) {
      state.chord.root = bestRoot;
      state.chord.quality = bestQ;
    } else {
      state.chord.root = -1;
    }
  }

  // YIN monophonic pitch detection on the time-domain buffer. Sets pitchHz /
  // pitchMidi / pitchClarity (clarity≈1 means a confident single pitch). Only
  // runs when there's enough signal; otherwise clarity decays to 0.
  function detectPitch() {
    if (state.level < 0.015) { state.pitchClarity = 0; return; }
    const buf = state.timeBuf;
    const n = Math.min(PITCH_WIN, buf.length - PITCH_TAU_MAX - 1);
    if (n < 256) { state.pitchClarity = 0; return; }
    const d = state.yinBuf;
    const tauMax = PITCH_TAU_MAX;

    // Difference function (decimated by PITCH_STRIDE for speed).
    for (let tau = 1; tau < tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < n; i += PITCH_STRIDE) {
        const a = buf[i] - 128;
        const b = buf[i + tau] - 128;
        const diff = a - b;
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    // Cumulative mean normalized difference.
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau < tauMax; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    // First dip below the absolute threshold (refined to its local minimum).
    let tauEst = -1;
    for (let tau = 2; tau < tauMax - 1; tau++) {
      if (d[tau] < PITCH_THRESHOLD) {
        while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst === -1) { state.pitchClarity = 0; return; }

    // Parabolic interpolation around the dip for sub-sample accuracy.
    let betterTau = tauEst;
    if (tauEst > 0 && tauEst < tauMax - 1) {
      const s0 = d[tauEst - 1], s1 = d[tauEst], s2 = d[tauEst + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) betterTau = tauEst + (s2 - s0) / denom;
    }

    const f0 = state.ctx.sampleRate / betterTau;
    if (f0 < 55 || f0 > 1800) { state.pitchClarity = 0; return; }
    state.pitchHz = f0;
    state.pitchMidi = 69 + 12 * Math.log2(f0 / A4_HZ);
    state.pitchClarity = 1 - d[tauEst];
  }

  // Sub-bass onset detector — spectral flux on the float spectrum, adaptive
  // threshold. See the kick constants at the top for why not the byte data.
  function updateKick() {
    state.analyser.getFloatFrequencyData(state.kickSpec);
    const end = state.kickEnd;

    // Per-bin positive rises in linear magnitude = the attack of a hit.
    let flux = 0;
    for (let i = 0; i < end; i++) {
      const db = state.kickSpec[i];
      const mag = isFinite(db) ? Math.pow(10, Math.min(0, db) / 20) : 0;
      const rise = mag - state.kickMagPrev[i];
      if (rise > 0) flux += rise;
      state.kickMagPrev[i] = mag;
    }

    // Band energy on the byte scale — kept for the visuals (kick block size)
    // and as an audibility gate against firing on noise in near-silence.
    const spec = state.spectrum;
    let e = 0;
    for (let i = 0; i < end; i++) e += spec[i];
    e = e / Math.max(1, end) / 255;
    state.kickEnergy = e;
    state.kickAvg = lerp(state.kickAvg, e, 0.05);

    // Adaptive threshold from the recent flux distribution (computed before
    // the current sample is recorded, so a spike is judged against the past).
    const hist = state.kickFluxHist;
    const n = state.kickFluxCount;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += hist[i];
    if (n > 0) mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) { const d = hist[i] - mean; varSum += d * d; }
    const std = n > 0 ? Math.sqrt(varSum / n) : 0;

    hist[state.kickFluxIdx] = flux;
    state.kickFluxIdx = (state.kickFluxIdx + 1) % hist.length;
    if (state.kickFluxCount < hist.length) state.kickFluxCount++;

    const now = performance.now();
    if (n >= 12 &&
        now - state.lastKickMs >= KICK_COOLDOWN_MS &&
        flux > mean + KICK_FLUX_STD_K * std &&
        flux > KICK_FLUX_FLOOR &&
        e > KICK_MIN_ENERGY) {
      state.kick = true;
      state.kickPulse = 1;
      state.lastKickMs = now;
    }
  }

  // Single pass over the half-spectrum: bass / vocal / treble + 8 perceptual bands.
  function sweep() {
    const spec = state.spectrum;
    const half = state.bins;
    const vS = state.vocalStart, vE = state.vocalEnd;

    let bass = 0, vocal = 0, treble = 0;
    for (let i = 0; i < vS; i++) bass += spec[i];
    for (let i = vS; i < vE; i++) vocal += spec[i];
    for (let i = vE; i < half; i++) treble += spec[i];

    // Normalize by slice width × 255 → roughly 0..1
    bass = bass / Math.max(1, vS) / 255;
    vocal = vocal / Math.max(1, vE - vS) / 255;
    treble = treble / Math.max(1, half - vE) / 255;

    state.bassEnergy = bass;
    state.vocalEnergy = vocal;
    state.backingEnergy = (bass + treble) * 0.5;

    state.bassAvg = lerp(state.bassAvg, state.bassEnergy, SMOOTH_SLOW);
    state.vocalAvg = lerp(state.vocalAvg, state.vocalEnergy, SMOOTH_SLOW);
    state.backingAvg = lerp(state.backingAvg, state.backingEnergy, SMOOTH_SLOW);

    state.vocalRatio = state.vocalEnergy / Math.max(state.backingAvg, EPS);

    for (let b = 0; b < NUM_BANDS; b++) {
      const s = state.bandEdge[b], e = state.bandEdge[b + 1];
      let sum = 0;
      for (let i = s; i < e; i++) sum += spec[i];
      const v = sum / ((e - s) * 255);
      state.bandVal[b] = v;
      state.bandAvg[b] = lerp(state.bandAvg[b], v, SMOOTH_BAND);
      state.bandExcess[b] = Math.max(0, v - state.bandAvg[b]);
    }

    chroma();
  }

  // Per-pitch-class peak amplitude across octaves + onset gate.
  function chroma() {
    const spec = state.spectrum;
    const noteBins = state.noteBins;
    const noteMidis = state.noteMidis;
    const half = state.bins;

    state.noteEnergy.fill(0);
    // octave hint defaults to mid (5) for any pitch class that didn't peak
    state.noteOctaveHint.fill(5);

    for (let i = 0; i < NOTE_COUNT; i++) {
      const bin = noteBins[i];
      if (bin >= half) break;
      // peak amplitude in a small window around the target bin (covers slight detuning)
      const lo = bin > 0 ? bin - 1 : 0;
      const hi = bin < half - 1 ? bin + 1 : half - 1;
      let peak = 0;
      for (let b = lo; b <= hi; b++) if (spec[b] > peak) peak = spec[b];
      const v = peak / 255;
      const pc = ((noteMidis[i] % 12) + 12) % 12;
      if (v > state.noteEnergy[pc]) {
        state.noteEnergy[pc] = v;
        state.noteOctaveHint[pc] = (noteMidis[i] / 12) | 0;
      }
    }

    for (let pc = 0; pc < NUM_PITCH_CLASSES; pc++) {
      state.noteOnset[pc] = 0;
      state.noteAvg[pc] = lerp(state.noteAvg[pc], state.noteEnergy[pc], NOTE_SMOOTH);
      if (state.noteCooldown[pc] > 0) state.noteCooldown[pc]--;
      if (state.noteCooldown[pc] === 0 &&
          state.noteEnergy[pc] > state.noteAvg[pc] * NOTE_ONSET_RATIO + NOTE_ONSET_MIN &&
          state.noteEnergy[pc] > 0.10) {
        state.noteOnset[pc] = 1;
        state.noteOnsetEnergy[pc] = state.noteEnergy[pc];
        state.noteCooldown[pc] = NOTE_COOLDOWN_FRM;
      }
    }
  }

  function updateChorus() {
    const vBoost = clamp(state.vocalEnergy / Math.max(state.vocalAvg, EPS) - 1, 0, 2);
    const vol = clamp(state.levelSmooth / Math.max(state.levelAvg, EPS), 0, 2);
    const ratio = clamp(state.vocalRatio - 1, 0, 1);
    state.chorusScore = 0.5 * vBoost + 0.3 * vol + 0.2 * ratio;

    if (state.chorusScore > CHORUS_SCORE_GATE && state.vocalRatio > CHORUS_RATIO_GATE) {
      state.chorusHoldFrames = CHORUS_HOLD_FRAMES;
    }
    if (state.chorusHoldFrames > 0) {
      state.chorusHoldFrames--;
      state.chorusLevel = lerp(state.chorusLevel, 1, CHORUS_RISE);
    } else {
      state.chorusLevel = lerp(state.chorusLevel, 0, CHORUS_FALL);
    }
  }

  function updateBeat() {
    if (state.beatCooldown > 0) state.beatCooldown--;
    if (state.bassEnergy > state.bassAvg * BEAT_RATIO &&
        state.beatCooldown === 0 &&
        state.bassEnergy > BEAT_MIN_BASS) {
      state.beat = true;
      state.beatPulse = 1;
      state.beatCooldown = BEAT_COOLDOWN_FRM;
    }
  }

  function updateDrivers() {
    const c = state.chorusLevel;
    if (c < 0.2) {
      state.gain = lerp(state.gain, 0, 0.025);
    } else {
      const boost = clamp(state.levelSmooth * 4, 0, 0.25) * c;
      state.gain = clamp(state.gain + (boost - 0.01) * 0.012, 0, 1);
    }
    state.timeTarget = c > 0.4 ? 1 + c * 0.35 : 1;
    state.timeScale = lerp(state.timeScale, state.timeTarget, 0.04);
  }

  window.MUSIC = { state, update, loadFile, useMicrophone, togglePlay, resume, isPlaying };
})();


/**
 * Music insertion only.
 * The standalone poster takes a SINGLE input: an inserted audio file — chosen
 * with the file picker or dropped onto the page. There is no microphone and no
 * transport control; loading a file analyses and plays it, which drives the
 * poster. The analyzer above is unchanged.
 */
(function () {
  function $(id) { return document.getElementById(id); }

  function setStatus(text) {
    const el = $("audio-status");
    if (el) el.textContent = text;
  }

  function setVjSongName(name) {
    const el = $("vj-song-name");
    if (!el) return;
    if (name) {
      // 去掉扩展名显示
      el.textContent = name.replace(/\.[^/.]+$/, "");
      el.classList.add("visible");
    } else {
      el.textContent = "";
      el.classList.remove("visible");
    }
  }

  async function insert(file) {
    if (!file || !file.type.startsWith("audio/")) {
      setStatus("请插入音频文件");
      return;
    }
    setStatus("loading…");
    try {
      await window.MUSIC.loadFile(file);   // loadFile resumes the context + plays
      setStatus(file.name);
      setVjSongName(file.name);
    } catch (e) {
      console.warn(e);
      setStatus("file failed");
      setVjSongName(null);
    }
  }

  function bind() {
    const fileInput = $("audio-file");
    if (fileInput) {
      fileInput.addEventListener("change", (event) => {
        const file = event.target.files && event.target.files[0];
        if (file) insert(file);
      });
    }

    // Drop an audio file anywhere on the page to insert it.
    window.addEventListener("dragover", (event) => {
      if (!event.dataTransfer) return;
      const hasFile = Array.from(event.dataTransfer.items || []).some((it) => it.kind === "file");
      if (!hasFile) return;
      event.preventDefault();
      document.body.classList.add("dragover");
    });
    window.addEventListener("dragleave", () => document.body.classList.remove("dragover"));
    window.addEventListener("drop", (event) => {
      event.preventDefault();
      document.body.classList.remove("dragover");
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      insert(file);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();
