// ============================================================
// TV SYNTH — broadcast sound effects generator
//
// The knobs are NOT synth parameters. Each one is a *cue* — the thing a
// TV show reaches for at that moment — and it moves a whole bundle of
// synthesis at once. A single key press is a little broadcast sting whose
// character is the blend of all the cues.
//
//   DRAMA          the soap-opera "dun dun DUNNN": a minor stab, low brass
//                  swell, a sub boom that drops in like an impact, and a
//                  long tail of reverb.
//   INTRIGUE       detective-show unease: sparse metallic bell + a tritone
//                  that shouldn't be there, wavering vibrato, cold resonance.
//   COMING UP NEXT the promo stinger: an upward pitch riser, a noise whoosh,
//                  a bright brass octave stacked on top, hard fast attack.
//   VIBE           the mood dial: cold/tense/thin at the bottom, warm mellow
//                  lounge-bumper at the top — and it decides whether the
//                  stacked harmony leans minor (tense) or major (easy).
//   BUDGET         production value: public-access cheap square + grit + mono
//                  at the bottom, lush wide detuned strings + polish at the top.
//   VOLUME         master output.
// ============================================================

const PARAMS = [
  { id: 'drama',   label: 'Drama',           default: 30 },
  { id: 'intrigue',label: 'Intrigue',        default: 20 },
  { id: 'next',    label: 'Coming Up Next',  default: 25 },
  { id: 'vibe',    label: 'Vibe',            default: 55 },
  { id: 'budget',  label: 'Budget',          default: 70 },
  { id: 'volume',  label: 'Volume',          default: 75 },
];

const state = {};
PARAMS.forEach(p => (state[p.id] = p.default));
state.output = 'hdmi'; // 'hdmi' (clean, compressed) | 'rca' (light bitcrush)

// ---- Audio graph -----------------------------------------------------------
//   dryBus -> budgetDrive -> crush -> outTone -> preMaster
//   preMaster -> comp -> master -> speakers
//   preMaster -> reverb -> reverbGain -> comp   (wet folds into the comp too)
let ac = null;
let master = null;      // master gain (volume)
let dryBus = null;      // voices sum here
let budgetDrive = null; // waveshaper — grit for low BUDGET
let crush = null;       // waveshaper — RCA bitcrush (bypassed for HDMI)
let outTone = null;     // lowpass — RCA analog bandwidth rolloff
let preMaster = null;   // sum feeding comp + reverb
let comp = null;        // output compressor (hard for HDMI, soft for RCA)
let reverb = null;      // convolver tail
let reverbGain = null;  // wet amount
let musicBus = null;    // background music sum
let duckGain = null;    // ducks the music when the synth plays

function initAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();

  master = ac.createGain();
  master.connect(ac.destination);

  dryBus = ac.createGain();
  budgetDrive = ac.createWaveShaper();
  budgetDrive.oversample = '2x';
  crush = ac.createWaveShaper();
  outTone = ac.createBiquadFilter();
  outTone.type = 'lowpass';
  preMaster = ac.createGain();
  comp = ac.createDynamicsCompressor();

  dryBus.connect(budgetDrive);
  budgetDrive.connect(crush);
  crush.connect(outTone);
  outTone.connect(preMaster);
  preMaster.connect(comp);
  comp.connect(master);

  reverb = ac.createConvolver();
  reverb.buffer = makeImpulse(3.2, 2.4);
  reverbGain = ac.createGain();
  preMaster.connect(reverb);
  reverb.connect(reverbGain);
  reverbGain.connect(comp);

  // Background music bed: its own bus, ducked when the synth plays.
  musicBus = ac.createGain();
  musicBus.gain.value = 0.5;
  duckGain = ac.createGain();
  duckGain.gain.value = 1;
  musicBus.connect(duckGain);
  duckGain.connect(comp); // shares the output compressor with the synth

  applyGlobalParams();
}

// Amplitude-quantizing curve = genuine (light) bit-crush. `levels` lower = crunchier.
function makeCrushCurve(levels) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

// Exponentially-decaying noise impulse response for the reverb tail.
function makeImpulse(seconds, decay) {
  const rate = ac.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ac.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// Soft-clip curve. `amount` 0 = clean, higher = more crunch (cheap gear).
function makeDriveCurve(amount) {
  const k = amount * 40;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
  }
  return curve;
}

const n01 = v => v / 100;

// Global (non-per-note) parameter application.
function applyGlobalParams() {
  if (!ac) return;
  const t = ac.currentTime;
  master.gain.setTargetAtTime(n01(state.volume) * 0.85, t, 0.02);

  // Cheap productions distort. Only the bottom half of BUDGET adds grit, so
  // normal/high budget stays clean.
  const budget = n01(state.budget);
  const grit = Math.max(0, 0.5 - budget) * 1.7; // 0 at budget>=0.5
  budgetDrive.curve = makeDriveCurve(grit);
  preMaster.gain.setTargetAtTime(0.72 - grit * 0.12, t, 0.02);

  // Big rooms cost money and drama loves a tail — but keep notes clear by default.
  const wet = n01(state.drama) * 0.4 + budget * 0.08;
  reverbGain.gain.setTargetAtTime(wet, t, 0.02);

  // OUTPUT: HDMI = clean full-band + firm compression (loud, clear, controlled).
  //         RCA  = light bit-crush + rolled-off bandwidth + gentle compression.
  if (state.output === 'rca') {
    crush.curve = makeCrushCurve(24);           // light quantization
    outTone.frequency.setTargetAtTime(7000, t, 0.03);
    comp.threshold.setTargetAtTime(-14, t, 0.02);
    comp.ratio.setTargetAtTime(2.5, t, 0.02);
    comp.attack.setTargetAtTime(0.02, t, 0.02);
    comp.release.setTargetAtTime(0.25, t, 0.02);
  } else {
    crush.curve = null;                          // bypass — pristine
    outTone.frequency.setTargetAtTime(18000, t, 0.03);
    comp.threshold.setTargetAtTime(-26, t, 0.02);
    comp.ratio.setTargetAtTime(6, t, 0.02);
    comp.attack.setTargetAtTime(0.003, t, 0.02);
    comp.release.setTargetAtTime(0.12, t, 0.02);
  }
}

// ---- Notes -----------------------------------------------------------------
const BASE_MIDI = 60; // C4
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

const activeVoices = {}; // midi -> voice

function buildVoice(midi) {
  const drama    = n01(state.drama);
  const intrigue = n01(state.intrigue);
  const next     = n01(state.next);
  const vibe     = n01(state.vibe);
  const budget   = n01(state.budget);

  const t = ac.currentTime;
  const rootFreq = midiToFreq(midi);
  const semi = s => rootFreq * Math.pow(2, s / 12);

  const oscs = [];
  const cleanup = []; // extra nodes to stop on release (LFOs, noise)

  // Amp envelope target — one shared VCA all layers pass through.
  const voiceGain = ac.createGain();
  voiceGain.gain.value = 0;

  // Filter shared by the tonal layers. VIBE = warmth (dark), NEXT = brightness,
  // INTRIGUE + DRAMA add resonance/edge.
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  const baseCut = 350 + (1 - vibe) * 5200 + next * 4500;
  const openCut = baseCut + 1800 + drama * 6000 + next * 6000;
  filter.frequency.value = baseCut;
  filter.Q.value = 0.7 + intrigue * 5 + drama * 2;
  filter.connect(voiceGain);

  // --- helper: one oscillator layer -------------------------------------
  // glide: [startRatio, glideTime] for a pitch riser/fall. pan: -1..1.
  const layer = (type, freq, gain, opts = {}) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = freq * (opts.glide ? opts.glide[0] : 1);
    if (opts.detune) o.detune.value = opts.detune;
    if (opts.glide) o.frequency.linearRampToValueAtTime(freq, t + opts.glide[1]);

    let node = o;
    if (opts.pan) {
      const p = ac.createStereoPanner();
      p.pan.value = opts.pan;
      o.connect(p);
      node = p;
    }
    const g = ac.createGain();
    g.gain.value = gain;
    node.connect(g);
    g.connect(opts.dry ? dryBus : filter);
    o.start(t);
    oscs.push(o);
    return o;
  };

  // Riser applied to the "up front" tonal layers (the promo push).
  const riser = next > 0.05 ? [Math.pow(2, -(0.3 + next * 0.9)), 0.02 + next * 0.12] : null;

  // ---------------------------------------------------------------------
  // ROOT — timbre set by BUDGET (cheap square <-> lush saw) and NEXT (brass).
  // ---------------------------------------------------------------------
  const rootType = budget < 0.33 ? 'square' : (next > 0.45 ? 'sawtooth' : 'triangle');
  // Cheap gear drifts out of tune.
  const detuneCheap = (1 - budget) * (Math.random() * 24 - 12);
  // The played note always leads — everything else is subordinate to it.
  layer(rootType, rootFreq, 0.6, { detune: detuneCheap, glide: riser });

  // BUDGET width — extra detuned voices panned L/R = expensive stereo strings.
  if (budget > 0.28) {
    const spread = 6 + budget * 18;
    layer('sawtooth', rootFreq, 0.14 * budget, { detune: +spread, pan: -0.6, glide: riser });
    layer('sawtooth', rootFreq, 0.14 * budget, { detune: -spread, pan: +0.6, glide: riser });
  }

  // ---------------------------------------------------------------------
  // DRAMA — the sting. A consonant triad (minor unless VIBE warms it to major)
  // plus a sub "boom". Quiet at low DRAMA so a note stays a note; big when cranked.
  // ---------------------------------------------------------------------
  if (drama > 0.1) {
    const third = vibe > 0.55 ? 4 : 3;           // VIBE decides major/minor color
    layer('sawtooth', semi(third), 0.16 * drama, { glide: riser });
    layer('sawtooth', semi(7),     0.16 * drama, { glide: riser });
    // Impact boom: sine that pitch-drops fast into a steady sub.
    const boom = ac.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(rootFreq, t);
    boom.frequency.exponentialRampToValueAtTime(rootFreq / 2, t + 0.12);
    const bg = ac.createGain();
    bg.gain.value = 0.3 * drama;
    boom.connect(bg); bg.connect(voiceGain);
    boom.start(t);
    oscs.push(boom);
  }

  // ---------------------------------------------------------------------
  // COMING UP NEXT — a bright octave on top + a noise whoosh transient.
  // ---------------------------------------------------------------------
  if (next > 0.12) {
    layer('sawtooth', semi(12), 0.14 * next, { glide: riser });
    if (next > 0.6) layer('square', semi(19), 0.08 * next, { glide: riser });

    // Whoosh: short bandpassed noise sweeping upward, straight to the dry bus.
    const dur = 0.25 + next * 0.25;
    const nb = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = nb;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(4000 + next * 4000, t + dur);
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.1 * next, t + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noise.connect(bp); bp.connect(ng); ng.connect(dryBus);
    noise.start(t);
    cleanup.push({ stop: at => { try { noise.stop(at); } catch (e) {} } });
  }

  // ---------------------------------------------------------------------
  // INTRIGUE — unease. A high, quiet shimmer plus a faint tritone that only
  // creeps in when you push it. Kept low so it colors rather than clashes.
  // ---------------------------------------------------------------------
  if (intrigue > 0.12) {
    layer('sine', semi(19), 0.07 * intrigue);              // airy fifth-above-octave
    if (intrigue > 0.35) layer('triangle', semi(6), 0.05 * intrigue, { detune: +4 }); // faint tritone
  }

  voiceGain.connect(dryBus);

  // --- Wavering vibrato (INTRIGUE) --------------------------------------
  if (intrigue > 0.1) {
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 2.5 + intrigue * 4.5;
    const lg = ac.createGain();
    lg.gain.value = intrigue * 9; // cents
    lfo.connect(lg);
    oscs.forEach(o => { if (o.detune) lg.connect(o.detune); });
    lfo.start(t);
    cleanup.push({ stop: at => { try { lfo.stop(at); } catch (e) {} } });
  }

  // --- Suspense tremolo (INTRIGUE shimmer, calmed by NEXT punch) ---------
  const tremDepth = Math.max(0, intrigue * 0.12 - next * 0.06);
  if (tremDepth > 0.005) {
    const trem = ac.createOscillator();
    trem.frequency.value = 4 + intrigue * 3;
    const tg = ac.createGain();
    tg.gain.value = tremDepth;
    trem.connect(tg);
    tg.connect(voiceGain.gain); // sums with the amp envelope
    trem.start(t);
    cleanup.push({ stop: at => { try { trem.stop(at); } catch (e) {} } });
  }

  // --- Amp + filter envelopes -------------------------------------------
  // Snappy by default so notes are responsive; DRAMA adds an orchestral swell
  // and a long tail, NEXT keeps the attack instant and punchy.
  const attack  = 0.004 + (1 - next) * (0.012 + drama * 0.28);
  const peak    = 0.34;
  const sustain = peak * (0.45 + next * 0.3);
  const decayTo = attack + 0.1 + next * 0.2;
  const release = 0.16 + drama * 1.8 + budget * 0.3;

  voiceGain.gain.setValueAtTime(0, t);
  voiceGain.gain.linearRampToValueAtTime(peak, t + attack);
  voiceGain.gain.linearRampToValueAtTime(sustain, t + decayTo);

  filter.frequency.setValueAtTime(baseCut, t);
  filter.frequency.linearRampToValueAtTime(openCut, t + attack + 0.005);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(220, baseCut), t + decayTo + 0.35);

  return { voiceGain, oscs, cleanup, release };
}

function noteOn(midi) {
  initAudio();
  if (ac.state === 'suspended') ac.resume();
  if (activeVoices[midi]) return;
  applyGlobalParams();
  activeVoices[midi] = buildVoice(midi);
  updateDuck();
  highlightKey(midi, true);
}

function noteOff(midi) {
  const v = activeVoices[midi];
  if (!v) return;
  delete activeVoices[midi];
  const t = ac.currentTime;
  v.voiceGain.gain.cancelScheduledValues(t);
  v.voiceGain.gain.setValueAtTime(Math.max(0.0001, v.voiceGain.gain.value), t);
  v.voiceGain.gain.linearRampToValueAtTime(0, t + v.release);
  const stopAt = t + v.release + 0.05;
  v.oscs.forEach(o => { try { o.stop(stopAt); } catch (e) {} });
  v.cleanup.forEach(c => c.stop(stopAt));
  updateDuck();
  highlightKey(midi, false);
}

// Duck the music bed down while any synth voice is sounding; recover after.
function updateDuck() {
  if (!ac || !duckGain) return;
  const playing = Object.keys(activeVoices).length > 0;
  if (playing) {
    duckGain.gain.setTargetAtTime(0.25, ac.currentTime, 0.03);  // fast dip
  } else {
    duckGain.gain.setTargetAtTime(1.0, ac.currentTime, 0.18);   // slow recover
  }
}

// ============================================================
// MUSIC — the ambient bed + HUMAN MUSIC (12 little songs)
//
// Every track is the same friendly arrangement — a soft pad, a light bass, and
// a gentle arpeggio over a 4-chord loop — differing by key, chord colors, and
// tempo. Scheduled with a look-ahead clock. Only one track plays at a time.
// ============================================================
let musicTimer = null;
let musicStep = 0;        // sixteenth-note counter
let nextStepTime = 0;
let curCfg = null;        // config of the track currently playing
let currentTrackId = null;// 'bed' | 'hm0'..'hm11' | null

// Chord = intervals over a root midi note.
const CH = {
  maj:  [0, 4, 7, 12],
  min:  [0, 3, 7, 12],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
};
const chord = (root, q) => CH[q].map(i => root + i);

// The original ambient TV bumper.
const BED = {
  bpm: 96, pad: 'triangle',
  prog: [chord(60, 'maj7'), chord(57, 'min7'), chord(65, 'maj7'), chord(55, 'dom7')],
};

// Twelve simple songs — Human Music 1..12. Each is a 4-chord loop.
const SONGS = [
  { bpm: 96,  pad: 'triangle', prog: [chord(60,'maj7'), chord(57,'min7'), chord(65,'maj7'), chord(55,'dom7')] }, // C  Am F  G
  { bpm: 104, pad: 'sine',     prog: [chord(57,'min7'), chord(53,'maj7'), chord(60,'maj7'), chord(55,'dom7')] }, // Am F  C  G
  { bpm: 88,  pad: 'triangle', prog: [chord(60,'maj'),  chord(55,'maj'),  chord(57,'min7'), chord(53,'maj7')] }, // C  G  Am F
  { bpm: 108, pad: 'sine',     prog: [chord(62,'maj'),  chord(57,'maj'),  chord(59,'min7'), chord(55,'maj7')] }, // D  A  Bm G
  { bpm: 84,  pad: 'triangle', prog: [chord(53,'maj7'), chord(60,'maj'),  chord(50,'min7'), chord(58,'maj7')] }, // F  C  Dm Bb
  { bpm: 100, pad: 'sine',     prog: [chord(52,'min7'), chord(60,'maj'),  chord(55,'maj7'), chord(62,'dom7')] }, // Em C  G  D
  { bpm: 92,  pad: 'triangle', prog: [chord(55,'maj'),  chord(62,'maj'),  chord(52,'min7'), chord(60,'maj7')] }, // G  D  Em C
  { bpm: 80,  pad: 'sine',     prog: [chord(60,'maj'),  chord(53,'maj7'), chord(55,'dom7'), chord(53,'maj7')] }, // C  F  G  F
  { bpm: 112, pad: 'triangle', prog: [chord(57,'min7'), chord(50,'min7'), chord(55,'dom7'), chord(60,'maj7')] }, // Am Dm G  C
  { bpm: 98,  pad: 'sine',     prog: [chord(52,'maj'),  chord(59,'maj'),  chord(61,'min7'), chord(57,'maj7')] }, // E  B  C#m A
  { bpm: 90,  pad: 'triangle', prog: [chord(58,'maj7'), chord(53,'maj'),  chord(55,'min7'), chord(51,'maj7')] }, // Bb F  Gm Eb
  { bpm: 106, pad: 'sine',     prog: [chord(60,'maj'),  chord(64,'min7'), chord(53,'maj7'), chord(55,'dom7')] }, // C  Em F  G
];

function songVoice(freq, time, dur, gain, type, opts = {}) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const f = ac.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = opts.cutoff || 3000;
  const g = ac.createGain();
  const atk = opts.attack != null ? opts.attack : 0.02;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.linearRampToValueAtTime(gain, time + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  o.connect(f); f.connect(g); g.connect(musicBus);
  o.start(time);
  o.stop(time + dur + 0.05);
}

function scheduleStep(step, time) {
  const sixteenth = curCfg.sixteenth;
  const prog = curCfg.prog;
  const padType = curCfg.pad || 'triangle';
  const chd = prog[Math.floor(step / 16) % prog.length];
  const beat = step % 16;

  if (beat === 0) {
    // Pad: whole-bar soft chord.
    chd.forEach(m =>
      songVoice(midiToFreq(m), time, sixteenth * 15, 0.05, padType,
                { attack: 0.08, cutoff: 2200 }));
    // Bass root.
    songVoice(midiToFreq(chd[0] - 12), time, sixteenth * 7, 0.14, 'sine',
              { attack: 0.01, cutoff: 800 });
  }
  if (beat === 8) {
    songVoice(midiToFreq(chd[0] - 12), time, sixteenth * 7, 0.11, 'sine',
              { attack: 0.01, cutoff: 800 });
  }
  // Gentle arpeggio on the off-eighths.
  if (beat % 2 === 0) {
    const n = chd[(beat / 2) % chd.length] + 12;
    songVoice(midiToFreq(n), time, sixteenth * 1.6, 0.045, 'triangle',
              { attack: 0.005, cutoff: 3500 });
  }
}

function musicLoop() {
  while (nextStepTime < ac.currentTime + 0.12) {
    scheduleStep(musicStep, nextStepTime);
    nextStepTime += curCfg.sixteenth;
    musicStep++;
  }
}

// Start a track, replacing whatever was playing (only one at a time).
function playTrack(cfg, id) {
  initAudio();
  if (ac.state === 'suspended') ac.resume();
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  curCfg = Object.assign({ sixteenth: 60 / cfg.bpm / 4 }, cfg);
  currentTrackId = id;
  musicStep = 0;
  nextStepTime = ac.currentTime + 0.1;
  musicLoop();
  musicTimer = setInterval(musicLoop, 25);
  refreshMusicUI();
}

function stopTrack() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  curCfg = null;
  currentTrackId = null;
  refreshMusicUI();
}

// Bed toggle wrappers.
function startMusic() { playTrack(BED, 'bed'); }
function stopMusic() { if (currentTrackId === 'bed') stopTrack(); }

// ============================================================
// UI
// ============================================================

function buildKnobs() {
  const wrap = document.getElementById('params');
  PARAMS.forEach(p => {
    const knob = document.createElement('div');
    knob.className = 'knob';
    knob.innerHTML =
      `<div class="dial" tabindex="0" role="slider" aria-label="${p.label}"
            aria-valuemin="0" aria-valuemax="100"></div>
       <div class="label">${p.label}</div>
       <div class="value">${p.default}</div>`;
    const dial = knob.querySelector('.dial');
    const valEl = knob.querySelector('.value');

    const render = () => {
      const val = state[p.id];
      const angle = -135 + (val / 100) * 270;
      dial.style.setProperty('--angle', angle + 'deg');
      valEl.textContent = Math.round(val);
      dial.setAttribute('aria-valuenow', Math.round(val));
      applyGlobalParams(); // volume / drama / budget are global; harmless for the rest
    };
    render();

    let dragging = false, startY = 0, startVal = 0;
    const onMove = e => {
      if (!dragging) return;
      const y = (e.touches ? e.touches[0].clientY : e.clientY);
      const dv = (startY - y) * 0.6;
      state[p.id] = Math.max(0, Math.min(100, startVal + dv));
      render();
      if (e.cancelable) e.preventDefault();
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    const onDown = e => {
      dragging = true;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      startVal = state[p.id];
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      e.preventDefault();
    };
    dial.addEventListener('mousedown', onDown);
    dial.addEventListener('touchstart', onDown, { passive: false });

    dial.addEventListener('wheel', e => {
      e.preventDefault();
      state[p.id] = Math.max(0, Math.min(100, state[p.id] - Math.sign(e.deltaY) * 3));
      render();
    }, { passive: false });
    dial.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { state[p.id] = Math.min(100, state[p.id] + 2); render(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { state[p.id] = Math.max(0, state[p.id] - 2); render(); }
    });

    wrap.appendChild(knob);
  });
}

// ---- Keyboard --------------------------------------------------------------
const KEYS = [
  { note: 'C',  black: false, kb: 'a' },
  { note: 'C#', black: true,  kb: 'w' },
  { note: 'D',  black: false, kb: 's' },
  { note: 'D#', black: true,  kb: 'e' },
  { note: 'E',  black: false, kb: 'd' },
  { note: 'F',  black: false, kb: 'f' },
  { note: 'F#', black: true,  kb: 't' },
  { note: 'G',  black: false, kb: 'g' },
  { note: 'G#', black: true,  kb: 'y' },
  { note: 'A',  black: false, kb: 'h' },
  { note: 'A#', black: true,  kb: 'u' },
  { note: 'B',  black: false, kb: 'j' },
  { note: 'C',  black: false, kb: 'k' },
];

const keyEls = {};
const kbToMidi = {};

function buildKeyboard() {
  const kb = document.getElementById('keyboard');
  const whiteIndex = [];
  let w = 0;
  KEYS.forEach((k, i) => { if (!k.black) { whiteIndex[i] = w; w++; } });
  const whiteCount = w;

  KEYS.forEach((k, i) => {
    const midi = BASE_MIDI + i;
    kbToMidi[k.kb] = midi;

    const el = document.createElement('div');
    el.className = 'key ' + (k.black ? 'black' : 'white');
    el.innerHTML = `<span class="kb">${k.kb.toUpperCase()}</span>`;

    if (k.black) {
      const leftWhite = whiteIndex[i - 1];
      el.style.left = ((leftWhite + 1) / whiteCount) * 100 + '%';
    }

    const down = e => { e.preventDefault(); noteOn(midi); };
    const up = e => { e.preventDefault(); noteOff(midi); };
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', () => noteOff(midi));
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });

    keyEls[midi] = el;
    kb.appendChild(el);
  });
}

function highlightKey(midi, on) {
  const el = keyEls[midi];
  if (el) el.classList.toggle('active', on);
}

const heldKeys = {};
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  const midi = kbToMidi[e.key.toLowerCase()];
  if (midi !== undefined && !heldKeys[e.key]) {
    heldKeys[e.key] = true;
    noteOn(midi);
  }
});
window.addEventListener('keyup', e => {
  const midi = kbToMidi[e.key.toLowerCase()];
  if (midi !== undefined) {
    heldKeys[e.key] = false;
    noteOff(midi);
  }
});

// ---- Output toggle ---------------------------------------------------------
function buildOutputToggle() {
  const wrap = document.getElementById('outputToggle');
  const opts = wrap.querySelectorAll('.opt');
  const setOut = out => {
    state.output = out;
    opts.forEach(o => o.classList.toggle('is-on', o.dataset.out === out));
    wrap.setAttribute('aria-checked', out === 'hdmi');
    applyGlobalParams();
  };
  opts.forEach(o => o.addEventListener('click', () => setOut(o.dataset.out)));
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOut(state.output === 'hdmi' ? 'rca' : 'hdmi');
    }
  });
}

// ---- Music UI (bed toggle + Human Music grid) ------------------------------
// One source of truth: refreshMusicUI() paints both from currentTrackId.
let bedToggleEl = null;
let songBtns = [];

function refreshMusicUI() {
  if (bedToggleEl) {
    const on = currentTrackId === 'bed';
    bedToggleEl.querySelectorAll('.opt').forEach(o =>
      o.classList.toggle('is-on', (o.dataset.music === 'on') === on));
    bedToggleEl.setAttribute('aria-checked', on);
  }
  songBtns.forEach((btn, i) =>
    btn.classList.toggle('is-on', currentTrackId === 'hm' + i));
}

function buildMusicToggle() {
  bedToggleEl = document.getElementById('musicToggle');
  const opts = bedToggleEl.querySelectorAll('.opt');
  const setMusic = on => { if (on) startMusic(); else stopMusic(); };
  opts.forEach(o => o.addEventListener('click', () => setMusic(o.dataset.music === 'on')));
  bedToggleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setMusic(currentTrackId !== 'bed');
    }
  });
  refreshMusicUI();
}

// ---- Human Music: 12 playable songs ----------------------------------------
function buildHumanMusic() {
  const grid = document.getElementById('humanMusic');
  songBtns = [];
  SONGS.forEach((song, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hm-btn';
    btn.innerHTML = `<span class="hm-num">${i + 1}</span>
                     <span class="hm-name">Human Music ${i + 1}</span>`;
    btn.setAttribute('aria-label', `Human Music ${i + 1}`);
    btn.addEventListener('click', () => {
      if (currentTrackId === 'hm' + i) stopTrack();
      else playTrack(song, 'hm' + i);
    });
    songBtns.push(btn);
    grid.appendChild(btn);
  });

  const stop = document.getElementById('humanMusicStop');
  if (stop) stop.addEventListener('click', () => stopTrack());
}

// ---- Audio unlock ----------------------------------------------------------
// Browsers start an AudioContext "suspended" until a user gesture. noteOn/
// startMusic already resume it, but this guarantees the context is created and
// running on the very first interaction anywhere on the page (belt-and-braces
// against autoplay policy = "loads but no sound").
function unlockAudio() {
  initAudio();
  if (ac.state === 'suspended') ac.resume();
  // iOS/Safari won't produce sound until a source has actually run inside a
  // gesture — kick a one-sample silent buffer to fully unlock output.
  try {
    const s = ac.createBufferSource();
    s.buffer = ac.createBuffer(1, 1, ac.sampleRate);
    s.connect(ac.destination);
    s.start(0);
  } catch (e) {}
}
['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
  window.addEventListener(evt, unlockAudio, { once: true }));

// ---- Boot ------------------------------------------------------------------
buildKnobs();
buildKeyboard();
buildOutputToggle();
buildMusicToggle();
buildHumanMusic();
