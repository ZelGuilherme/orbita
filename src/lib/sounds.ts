/** Efeitos sonoros sintetizados na hora (sem arquivos de áudio). */

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundsEnabled(value: boolean) {
  enabled = value;
}

type Note = [frequency: number, start: number, duration: number];

function play(notes: Note[], type: OscillatorType = 'sine', volume = 0.05) {
  if (!enabled) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [frequency, start, duration] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(volume, t0 + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + duration + 0.03);
    }
  } catch {
    /* sem áudio disponível */
  }
}

export const sfx = {
  join: () => play([[587.33, 0, 0.12], [880, 0.09, 0.2]]),
  leave: () => play([[880, 0, 0.12], [587.33, 0.09, 0.2]]),
  memberJoin: () => play([[659.25, 0, 0.1], [987.77, 0.08, 0.16]], 'sine', 0.035),
  memberLeave: () => play([[987.77, 0, 0.1], [659.25, 0.08, 0.16]], 'sine', 0.035),
  mute: () => play([[440, 0, 0.08]], 'triangle', 0.04),
  unmute: () => play([[660, 0, 0.08]], 'triangle', 0.04),
  message: () => play([[1046.5, 0, 0.07], [1318.5, 0.06, 0.1]], 'sine', 0.03),
  mention: () => play([[784, 0, 0.09], [1046.5, 0.08, 0.09], [1318.5, 0.16, 0.16]], 'sine', 0.05),
  live: () => play([[523.25, 0, 0.1], [659.25, 0.08, 0.1], [783.99, 0.16, 0.2]], 'triangle', 0.045),
  /** "Chamar atenção": um zumbido tremido. */
  nudge: () =>
    play(
      [
        [196, 0, 0.07],
        [233, 0.07, 0.07],
        [196, 0.14, 0.07],
        [233, 0.21, 0.07],
        [196, 0.28, 0.1],
      ],
      'square',
      0.03,
    ),
  fx: () => play([[1318.5, 0, 0.06], [1760, 0.05, 0.12]], 'sine', 0.022),
  pttOn: () => play([[880, 0, 0.04]], 'sine', 0.02),
  pttOff: () => play([[660, 0, 0.04]], 'sine', 0.016),
};
