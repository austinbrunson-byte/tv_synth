# tv_synth

A browser-based **TV sound-effects synth**. Play an octave of notes and shape
the voice with "TV production" parameters instead of normal synth knobs.

Open `index.html` in any modern browser — no build step, no dependencies.

## Playing

- Click the keys, or use your computer keyboard: `A W S E D F T G Y H U J K`
  (one octave, C4→C5).

## Parameters

Each knob (drag up/down, scroll, or arrow keys) maps to real synthesis:

| Knob | What it does |
|------|--------------|
| **Drama** | Cinematic weight: sub-octave, dissonant beating, filter snap, long reverb tail. |
| **Intrigue** | Mystery: detuned fifth overtone, pitch vibrato, resonant filter. |
| **Coming Up Next** | The brassy "next week on…" stinger: bright, punchy, fast attack. |
| **Vibe** | Warmth: low = cold/tense/bright, high = warm/mellow/dark. |
| **Budget** | Production value: low = cheap lo-fi square, high = lush detuned supersaw. |
| **Volume** | Master output level. |

Sequencing comes later — for now it's a live instrument.

## Files

- `index.html` — markup and the NTSC-test-pattern logo
- `styles.css` — white background, black text
- `synth.js` — Web Audio engine and UI
