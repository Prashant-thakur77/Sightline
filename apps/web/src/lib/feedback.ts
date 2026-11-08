'use client';

/**
 * Short, synthesized earcons and vibration patterns. Optional, quiet, and never the only signal:
 * every cue has a spoken or visible counterpart.
 */
export type Cue = 'listening' | 'thinking' | 'done' | 'attention' | 'capture' | 'tick' | 'error' | 'paid';

let ctx: AudioContext | null = null;
let enabled = true;
let hapticsEnabled = true;

export function setFeedback(opts: { sounds?: boolean; haptics?: boolean }) {
  if (opts.sounds !== undefined) enabled = opts.sounds;
  if (opts.haptics !== undefined) hapticsEnabled = opts.haptics;
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, start: number, dur: number, gain = 0.08, type: OscillatorType = 'sine') {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + start;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function click(start = 0) {
  const a = audio();
  if (!a) return;
  const len = Math.floor(a.sampleRate * 0.03);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = 0.25;
  src.buffer = buf;
  src.connect(g).connect(a.destination);
  src.start(a.currentTime + start);
}

const VIBRATION: Record<Cue, number[]> = {
  listening: [20],
  thinking: [],
  done: [15, 60, 15],
  attention: [40, 80, 40, 80, 40],
  capture: [60],
  tick: [8],
  error: [120, 60, 120],
  paid: [20, 50, 20, 50, 60],
};

export function cue(name: Cue): void {
  if (hapticsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator && VIBRATION[name].length) {
    try {
      navigator.vibrate(VIBRATION[name]);
    } catch {
      /* not allowed before a user gesture */
    }
  }
  if (!enabled) return;
  switch (name) {
    case 'listening':
      tone(660, 0, 0.09);
      tone(880, 0.08, 0.12);
      break;
    case 'thinking':
      tone(520, 0, 0.06, 0.04, 'triangle');
      break;
    case 'done':
      tone(880, 0, 0.09);
      tone(660, 0.09, 0.14);
      break;
    case 'attention':
      tone(740, 0, 0.07);
      tone(740, 0.12, 0.07);
      tone(980, 0.24, 0.14);
      break;
    case 'capture':
      click(0);
      tone(1200, 0.02, 0.05, 0.05, 'square');
      break;
    case 'tick':
      tone(1400, 0, 0.025, 0.03, 'square');
      break;
    case 'error':
      tone(330, 0, 0.14, 0.07, 'triangle');
      tone(262, 0.14, 0.2, 0.07, 'triangle');
      break;
    case 'paid':
      tone(523, 0, 0.1);
      tone(659, 0.1, 0.1);
      tone(784, 0.2, 0.22);
      break;
  }
}
