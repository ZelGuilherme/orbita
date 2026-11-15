// Portão de ruído + detector de voz do Órbita. Roda na thread de áudio (AudioWorklet).
//
// Mede o nível de cada bloco de 128 amostras na mesma escala do medidor das configurações
// (0..1, de -60 dB a -10 dB). Acima do limiar, a pessoa "está falando". Com o portão ligado,
// o som só passa enquanto ela fala (e um pouco depois, para não cortar o fim das palavras).
// A abertura é rápida e o fechamento é suave, sem estalos.

const HOLD_SECONDS = 0.32;
const OPEN_SECONDS = 0.003;
const CLOSE_SECONDS = 0.07;
const REPORT_SECONDS = 0.05;

class OrbitaGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = 0.32;
    this.gate = false;
    this.open = false;
    this.quiet = 0;
    this.gain = 1;
    this.level = 0;
    this.sinceReport = 0;
    this.openCoef = Math.exp(-1 / (sampleRate * OPEN_SECONDS));
    this.closeCoef = Math.exp(-1 / (sampleRate * CLOSE_SECONDS));
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (typeof data.threshold === 'number') this.threshold = data.threshold;
      if (typeof data.gate === 'boolean') this.gate = data.gate;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length;
    const source = input && input.length ? input[0] : null;

    let sum = 0;
    if (source) for (let i = 0; i < source.length; i++) sum += source[i] * source[i];
    const rms = source ? Math.sqrt(sum / source.length) : 0;
    const level = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-8) + 60) / 50));
    // medidor: sobe na hora, desce devagar
    this.level = level > this.level ? level : this.level * 0.9 + level * 0.1;

    if (level > this.threshold) {
      this.quiet = 0;
      if (!this.open) {
        this.open = true;
        this.port.postMessage({ speaking: true });
      }
    } else if (this.open) {
      this.quiet += frames;
      if (this.quiet > sampleRate * HOLD_SECONDS) {
        this.open = false;
        this.port.postMessage({ speaking: false });
      }
    }

    const target = !this.gate || this.open ? 1 : 0;
    const coef = target > this.gain ? this.openCoef : this.closeCoef;
    for (let c = 0; c < output.length; c++) {
      const out = output[c];
      const inp = input && input[c] ? input[c] : source;
      let gain = this.gain;
      for (let i = 0; i < frames; i++) {
        gain = target + (gain - target) * coef;
        out[i] = inp ? inp[i] * gain : 0;
      }
      if (c === output.length - 1) this.gain = gain;
    }

    this.sinceReport += frames;
    if (this.sinceReport >= sampleRate * REPORT_SECONDS) {
      this.sinceReport = 0;
      this.port.postMessage({ level: this.level });
    }
    return true;
  }
}

registerProcessor('orbita-gate', OrbitaGate);
