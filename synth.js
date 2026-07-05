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
let keepAlive = null;   // silent <audio> element that opens the OS audio session

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

  // Some browsers/OSes keep Web Audio silent until a *media element* has opened
  // the output session (the classic "no sound until I play a video in another
  // tab"). Play a silent looping clip alongside, which opens that session for us.
  keepAlive = new Audio(makeSilentWavUrl());
  keepAlive.loop = true;
  keepAlive.preload = 'auto';

  applyGlobalParams();
}

// A short silent mono WAV as an object URL, for the keep-alive element.
function makeSilentWavUrl() {
  const sr = 8000, n = sr * 0.25;           // 0.25s of silence
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true); // samples already zero (silent)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Make sure the context is running and the OS audio session is open. Safe to
// call on every interaction.
function ensurePlaying() {
  if (!ac) initAudio();
  if (ac.state === 'suspended') ac.resume();
  if (keepAlive) { const p = keepAlive.play(); if (p) p.catch(() => {}); }
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
  ensurePlaying();
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
// A style-driven step sequencer. Each track picks a pad style, a bass pattern,
// an arp/comp pattern, timbres, an optional swing/meter, and an optional melody
// line — so the twelve songs are genuinely different pieces, not one loop
// transposed. Scheduled with a look-ahead clock; only one track plays at a time.
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

// The original ambient TV bumper (all defaults).
const BED = {
  bpm: 96,
  prog: [chord(60, 'maj7'), chord(57, 'min7'), chord(65, 'maj7'), chord(55, 'dom7')],
};

// Twelve songs — Human Music 1..12. Each combines a progression with a distinct
// groove/instrumentation. Fields left out fall back to the defaults in playTrack.
const SONGS = [
  // 1 — the classic friendly bumper.
  { bpm: 96, prog: [chord(60,'maj7'), chord(57,'min7'), chord(65,'maj7'), chord(55,'dom7')] },
  // 2 — swung lounge: walking bass, off-beat comp.
  { bpm: 100, swing: 0.45, pad: 'stab', padWave: 'sine', bass: 'walk',
    arp: 'offbeat', arpWave: 'sine',
    prog: [chord(57,'min7'), chord(53,'maj7'), chord(60,'maj7'), chord(55,'dom7')] },
  // 3 — a gentle waltz in 3/4.
  { bpm: 132, beatsPerBar: 3, pad: 'waltz', bass: 'waltz', arp: 'up', arpGain: 0.038,
    prog: [chord(60,'maj'), chord(55,'maj'), chord(57,'min7'), chord(53,'maj7')] },
  // 4 — driving news theme: pulsing bass, busy 16th line, no pad.
  { bpm: 120, pad: 'none', bass: 'pulse8', arp: 'sixteenth', arpWave: 'square',
    arpGain: 0.03, arpCut: 4200,
    prog: [chord(62,'maj'), chord(57,'maj'), chord(59,'min7'), chord(55,'maj7')] },
  // 5 — a slow ballad with a melody over sparse pads.
  { bpm: 72, padWave: 'sine', arp: 'none', melWave: 'triangle', melGain: 0.1,
    mel: [[0,72,6],[8,69,6],[16,76,6],[24,72,6],[32,74,6],[40,69,6],[48,74,6],[56,70,10]],
    prog: [chord(53,'maj7'), chord(60,'maj'), chord(50,'min7'), chord(58,'maj7')] },
  // 6 — chiptune bounce: all square waves, hopping bass.
  { bpm: 128, pad: 'offstab', padWave: 'square', padGain: 0.03, bass: 'octaves',
    bassWave: 'square', arp: 'up', arpWave: 'square', arpGain: 0.035, arpCut: 5000,
    prog: [chord(52,'min7'), chord(60,'maj'), chord(55,'maj7'), chord(62,'dom7')] },
  // 7 — mysterious: low sine pad, descending arp.
  { bpm: 88, swing: 0.15, padWave: 'sine', padOct: -12, padCut: 1400, arp: 'down',
    arpWave: 'sine', arpGain: 0.04, arpCut: 2600,
    prog: [chord(55,'maj'), chord(62,'maj'), chord(52,'min7'), chord(60,'maj7')] },
  // 8 — bright pop: quarter bass, up-down arp.
  { bpm: 112, pad: 'stab', bass: 'quarters', arp: 'updown',
    prog: [chord(60,'maj'), chord(53,'maj7'), chord(55,'dom7'), chord(53,'maj7')] },
  // 9 — lo-fi half-time: swung, off-beat keys.
  { bpm: 76, swing: 0.3, bass: 'root13', arp: 'offbeat', arpWave: 'sine',
    arpGain: 0.05, arpCut: 2400,
    prog: [chord(57,'min7'), chord(50,'min7'), chord(55,'dom7'), chord(60,'maj7')] },
  // 10 — a crisp march: stabbed chords on every beat.
  { bpm: 104, pad: 'stab', padWave: 'sawtooth', padGain: 0.035, bass: 'quarters',
    arp: 'chords', arpGain: 0.03,
    prog: [chord(52,'maj'), chord(59,'maj'), chord(61,'min7'), chord(57,'maj7')] },
  // 11 — jazzy swing: comping stabs, walking bass, up-down line.
  { bpm: 108, swing: 0.55, pad: 'stab', padWave: 'sine', bass: 'walk', arp: 'updown',
    arpGain: 0.04,
    prog: [chord(58,'maj7'), chord(53,'maj'), chord(55,'min7'), chord(51,'maj7')] },
  // 12 — an anthem: big pad, octave bass, a triumphant melody.
  { bpm: 90, padGain: 0.06, bass: 'octaves', arp: 'up', arpGain: 0.04,
    melWave: 'square', melGain: 0.085,
    mel: [[0,67,8],[8,72,8],[16,71,8],[24,74,8],[32,72,8],[40,69,4],[44,72,4],[48,74,8],[56,79,8]],
    prog: [chord(60,'maj'), chord(64,'min7'), chord(53,'maj7'), chord(55,'dom7')] },
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

// --- Pattern generators (all read the current track's config) ---------------
function padPattern(chd, beat, spb, t, s16) {
  const style = curCfg.pad;
  if (style === 'none') return;
  const wave = curCfg.padWave || 'triangle';
  const cut = curCfg.padCut || 2200;
  const g = curCfg.padGain != null ? curCfg.padGain : 0.05;
  const oct = curCfg.padOct || 0;
  const play = (dur, gain) => chd.forEach(m =>
    songVoice(midiToFreq(m + oct), t, dur, gain, wave, { attack: 0.05, cutoff: cut }));
  if (style === 'stab') { if (beat % 4 === 0) play(s16 * 2, g * 1.1); }
  else if (style === 'offstab') { if (beat % 4 === 2) play(s16 * 1.6, g * 1.1); }
  else if (style === 'waltz') { if (beat === 4 || beat === 8) play(s16 * 2.5, g * 1.1); }
  else if (beat === 0) play(s16 * (spb - 1), g); // 'sustain'
}

function bassPattern(chd, beat, spb, t, s16) {
  const style = curCfg.bass;
  if (style === 'none') return;
  const wave = curCfg.bassWave || 'sine';
  const root = chd[0] - 12;
  const hit = (m, dur, gain) =>
    songVoice(midiToFreq(m), t, dur, gain, wave, { attack: 0.008, cutoff: 800 });
  switch (style) {
    case 'quarters': if (beat % 4 === 0) hit(root, s16 * 3.2, 0.13); break;
    case 'octaves':
      if (beat % 4 === 0) hit(root, s16 * 3.2, 0.13);
      else if (beat % 4 === 2) hit(root + 12, s16 * 1.8, 0.09);
      break;
    case 'pulse8': if (beat % 2 === 0) hit(root, s16 * 1.5, 0.11); break;
    case 'walk':
      if (beat % 4 === 0) {
        const tones = [chd[0], chd[1], chd[2], chd[0] + 12];
        hit(tones[Math.floor(beat / 4) % tones.length] - 12, s16 * 3.2, 0.12);
      }
      break;
    case 'waltz': if (beat === 0) hit(root, s16 * 3, 0.14); break;
    default: // 'root13'
      if (beat === 0) hit(root, s16 * 7, 0.14);
      if (beat === Math.floor(spb / 2)) hit(root, s16 * 7, 0.11);
  }
}

function arpPattern(chd, beat, spb, t, s16, lstep) {
  const style = curCfg.arp;
  if (style === 'none') return;
  const wave = curCfg.arpWave || 'triangle';
  const oct = curCfg.arpOct != null ? curCfg.arpOct : 12;
  const g = curCfg.arpGain != null ? curCfg.arpGain : 0.045;
  const cut = curCfg.arpCut || 3500;
  const L = chd.length;
  const hit = (m, dur) =>
    songVoice(midiToFreq(m + oct), t, dur, g, wave, { attack: 0.005, cutoff: cut });
  switch (style) {
    case 'down': if (beat % 2 === 0) hit(chd[(L - 1 - ((beat / 2) % L))], s16 * 1.6); break;
    case 'updown':
      if (beat % 2 === 0) {
        const seq = [0, 1, 2, 3, 2, 1];
        hit(chd[seq[Math.floor(lstep / 2) % seq.length] % L], s16 * 1.6);
      }
      break;
    case 'offbeat': if (beat % 4 === 2) hit(chd[(beat / 2) % L], s16 * 1.4); break;
    case 'sixteenth': hit(chd[lstep % L], s16 * 1.1); break;
    case 'chords': if (beat % 4 === 0) chd.forEach(m => hit(m, s16 * 1.8)); break;
    default: if (beat % 2 === 0) hit(chd[(beat / 2) % L], s16 * 1.6); // 'up'
  }
}

function scheduleStep(step, time) {
  const s16 = curCfg.sixteenth;
  const spb = curCfg.stepsPerBar;
  const loopSteps = curCfg.prog.length * spb;
  const lstep = ((step % loopSteps) + loopSteps) % loopSteps;
  const chd = curCfg.prog[Math.floor(lstep / spb)];
  const beat = lstep % spb;

  // Swing: nudge the off-beat eighths later.
  let t = time;
  if (curCfg.swing && beat % 4 === 2) t += curCfg.swing * s16;

  padPattern(chd, beat, spb, t, s16);
  bassPattern(chd, beat, spb, t, s16);
  arpPattern(chd, beat, spb, t, s16, lstep);

  if (curCfg.mel) {
    for (const m of curCfg.mel) {
      if (m[0] === lstep) {
        songVoice(midiToFreq(m[1]), t, s16 * m[2] * 0.9,
                  curCfg.melGain || 0.09, curCfg.melWave || 'triangle',
                  { attack: 0.006, cutoff: 3600 });
      }
    }
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
  ensurePlaying();
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  curCfg = Object.assign({ beatsPerBar: 4, pad: 'sustain', bass: 'root13', arp: 'up' }, cfg);
  curCfg.sixteenth = 60 / curCfg.bpm / 4;
  curCfg.stepsPerBar = curCfg.beatsPerBar * 4;
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
  ensurePlaying();
  // iOS/Safari won't produce sound until a source has actually run inside a
  // gesture — kick a one-sample silent buffer to fully unlock output.
  try {
    const s = ac.createBufferSource();
    s.buffer = ac.createBuffer(1, 1, ac.sampleRate);
    s.connect(ac.destination);
    s.start(0);
  } catch (e) {}
}
// Not { once:true }: some browsers reject the first play() promise, so keep
// re-asserting on every early interaction until the session truly opens.
['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
  window.addEventListener(evt, unlockAudio));
// Re-open the context if the tab was backgrounded and suspended.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ac && ac.state === 'suspended') ensurePlaying();
});

// ============================================================
// FOURTH OF JULY — a blank page of fireworks
// ============================================================
function buildFireworks() {
  const overlay = document.getElementById('fireworks');
  const canvas = document.getElementById('fireworksCanvas');
  const openBtn = document.getElementById('fireworksOpen');
  const backBtn = document.getElementById('fireworksBack');
  const ctx = canvas.getContext('2d');

  let raf = null, W = 0, H = 0, dpr = 1;
  let rockets = [], sparks = [], sinceLaunch = 0;
  const COLORS = ['#ff3b3b', '#ffffff', '#4d7bff', '#ffd23f', '#ff7ac2'];
  const GRAV = 0.06;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function launch() {
    const x = W * (0.12 + Math.random() * 0.76);
    const targetY = H * (0.12 + Math.random() * 0.4);
    rockets.push({
      x, y: H + 4, targetY,
      vx: (Math.random() - 0.5) * 1.4,
      vy: -Math.sqrt(2 * GRAV * (H - targetY)),
      color: COLORS[(Math.random() * COLORS.length) | 0],
    });
  }

  function explode(x, y, color) {
    const n = 55 + (Math.random() * 45 | 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = Math.random() * 3.6 + 0.4;
      sparks.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        color: Math.random() < 0.2 ? '#ffffff' : color,
        life: 1, decay: 0.008 + Math.random() * 0.013,
      });
    }
  }

  function frame() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(5,6,15,0.25)';          // fade for trails
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';     // additive glow

    if (++sinceLaunch > 20) {
      launch(); sinceLaunch = 0;
      if (Math.random() < 0.45) launch();
    }

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.x += r.vx; r.y += r.vy; r.vy += GRAV;
      ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2); ctx.fill();
      if (r.vy >= 0 || r.y <= r.targetY) { explode(r.x, r.y, r.color); rockets.splice(i, 1); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx; s.y += s.vy; s.vy += GRAV * 0.5; s.vx *= 0.99; s.vy *= 0.99;
      s.life -= s.decay;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.x, s.y, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  function open() {
    overlay.hidden = false;
    resize();
    rockets = []; sparks = []; sinceLaunch = 100;
    for (let i = 0; i < 3; i++) launch();
    window.addEventListener('resize', resize);
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function close() {
    overlay.hidden = true;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    rockets = []; sparks = [];
    window.removeEventListener('resize', resize);
  }

  openBtn.addEventListener('click', open);
  backBtn.addEventListener('click', close);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });
}

// ---- Boot ------------------------------------------------------------------
buildKnobs();
buildKeyboard();
buildOutputToggle();
buildMusicToggle();
buildHumanMusic();
buildFireworks();
