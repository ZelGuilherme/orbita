/**
 * Muda o tom da voz (grossa ou fina) sem mudar a velocidade.
 *
 * Duas leituras de uma linha de atraso que "escorregam" na velocidade da mudança de tom,
 * defasadas em meia janela e misturadas em sin²/cos² (soma sempre 1): quando uma recomeça,
 * a outra está no meio e cobre a emenda. Atraso de ~40 ms.
 */
class OrbitaPitch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.ratio = Number(opts.ratio) || 1;
    this.window = Math.round(sampleRate * 0.04);
    this.buffer = new Float32Array(16384);
    this.write = 0;
    this.phase = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.ratio === 'number') this.ratio = e.data.ratio;
    };
  }

  read(delay) {
    const size = this.buffer.length;
    let pos = this.write - delay;
    while (pos < 0) pos += size;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = this.buffer[i % size];
    const b = this.buffer[(i + 1) % size];
    return a + (b - a) * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    const size = this.buffer.length;
    const win = this.window;
    const step = (1 - this.ratio) / win;
    for (let i = 0; i < output.length; i++) {
      this.buffer[this.write] = input ? input[i] : 0;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
      const p2 = (this.phase + 0.5) % 1;
      const g1 = Math.sin(Math.PI * this.phase) ** 2;
      const g2 = 1 - g1;
      output[i] = this.read(this.phase * win + 1) * g1 + this.read(p2 * win + 1) * g2;
      this.write = (this.write + 1) % size;
    }
    return true;
  }
}

registerProcessor('orbita-pitch', OrbitaPitch);
