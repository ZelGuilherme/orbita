// Portão de ruído + detector de voz do Órbita. Roda na thread de áudio (AudioWorklet).
//
// Mede o nível de cada bloco de 128 amostras na mesma escala do medidor das configurações
// (0..1, de -60 dB a -10 dB). Acima do limiar, e com cara de voz, a pessoa "está falando".
// Com o portão ligado, o som só passa enquanto ela fala (e um pouco depois, para não cortar
// o fim das palavras). A abertura é rápida e o fechamento é suave, sem estalos.
//
// Sons curtos (tecla, palma, batida na mesa) não abrem o portão: o áudio sai com 40 ms de
// atraso, e nesse tempo o worklet confere se o som é voz de verdade:
//   - duração: a voz fica acima do limiar por dezenas de milissegundos seguidos; um estalo
//     some em poucos milissegundos;
//   - timbre: a voz concentra a energia nos médios (≈ 250–3500 Hz); tecla e palma têm muito
//     agudo (acima de ≈ 5 kHz).
// Como o áudio está atrasado, quando o portão decide abrir, o começo da palavra ainda não saiu.
//
// Sensibilidade automática: o worklet acompanha o ruído de fundo (o nível nos momentos sem fala)
// e põe o limiar uma margem acima dele. O ruído desce rápido e sobe devagar; enquanto a pessoa
// fala, ele quase não sobe (a voz não pode virar "ruído").

const HOLD_SECONDS = 0.32;
const OPEN_SECONDS = 0.003;
const CLOSE_SECONDS = 0.07;
const REPORT_SECONDS = 0.05;
// atraso para decidir (e janela de confirmação da voz)
const LOOKAHEAD_SECONDS = 0.04;
// fração dos blocos da janela que precisam ter cara de voz para abrir
const OPEN_FRACTION = 0.85;
// estalo começa no pico e despenca; voz se mantém: queda máxima desde o pico da janela (0.3 = 15 dB)
const MAX_DECAY = 0.3;
// fração da janela com voz que, com o portão já aberto, renova a espera
const KEEP_FRACTION = 0.5;
// fração mínima da energia nos médios (voz) em relação aos médios + agudos
const VOICE_BAND_RATIO = 0.55;
// sensibilidade automática (escala 0..1 = 50 dB; 0.1 = 5 dB)
const FLOOR_DOWN_SECONDS = 0.4;
const FLOOR_UP_SECONDS = 4;
const FLOOR_UP_SPEAKING_SECONDS = 40;
const AUTO_MARGIN = 0.2;
const AUTO_MIN = 0.22;
const AUTO_MAX = 0.7;

/** Filtro biquad (RBJ) simples, amostra a amostra. */
function biquad(type, freq, q) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'bandpass') {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  } else {
    // passa-altas
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  const f = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  return f;
}

function run(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

class OrbitaGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.threshold = 0.32;
    this.manual = 0.32;
    this.auto = false;
    this.floor = 0.1;
    this.gate = false;
    this.open = false;
    this.quiet = 0;
    this.gain = 1;
    this.level = 0;
    this.sinceReport = 0;
    this.openCoef = Math.exp(-1 / (sampleRate * OPEN_SECONDS));
    this.closeCoef = Math.exp(-1 / (sampleRate * CLOSE_SECONDS));
    // linha de atraso (o áudio sai 40 ms depois de entrar)
    this.delay = new Float32Array(Math.max(128, Math.round(sampleRate * LOOKAHEAD_SECONDS)));
    this.pos = 0;
    // janela de confirmação: um bit por bloco (tem cara de voz ou não)
    this.window = new Uint8Array(Math.max(1, Math.round((sampleRate * LOOKAHEAD_SECONDS) / 128)));
    this.levels = new Float32Array(this.window.length);
    this.windowPos = 0;
    this.windowCount = 0;
    this.voiceBand = biquad('bandpass', 950, 0.45);
    this.highBand = biquad('highpass', 5000, 0.7);
    const configure = (data) => {
      if (!data) return;
      if (typeof data.threshold === 'number') this.manual = data.threshold;
      if (typeof data.auto === 'boolean') this.auto = data.auto;
      if (typeof data.gate === 'boolean') this.gate = data.gate;
      if (!this.auto) this.threshold = this.manual;
    };
    // as opções de partida vêm na criação (sem esperar mensagem); as mudanças, por mensagem
    configure(options && options.processorOptions);
    this.port.onmessage = (event) => configure(event.data);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length;
    const source = input && input.length ? input[0] : null;

    let sum = 0;
    let voiceEnergy = 0;
    let highEnergy = 0;
    if (source) {
      for (let i = 0; i < source.length; i++) {
        const x = source[i];
        sum += x * x;
        const v = run(this.voiceBand, x);
        const h = run(this.highBand, x);
        voiceEnergy += v * v;
        highEnergy += h * h;
      }
    }
    const rms = source ? Math.sqrt(sum / source.length) : 0;
    const level = Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-8) + 60) / 50));
    // medidor: sobe na hora, desce devagar
    this.level = level > this.level ? level : this.level * 0.9 + level * 0.1;

    if (this.auto) {
      const seconds = level < this.floor ? FLOOR_DOWN_SECONDS : this.open ? FLOOR_UP_SPEAKING_SECONDS : FLOOR_UP_SECONDS;
      const k = 1 - Math.exp(-frames / (sampleRate * seconds));
      this.floor += (level - this.floor) * k;
      this.threshold = Math.max(AUTO_MIN, Math.min(AUTO_MAX, this.floor + AUTO_MARGIN));
    }

    // este bloco tem cara de voz? (alto o bastante e com a energia nos médios)
    const ratio = voiceEnergy / (voiceEnergy + highEnergy + 1e-12);
    const voiced = level > this.threshold && ratio > VOICE_BAND_RATIO ? 1 : 0;
    this.windowCount += voiced - this.window[this.windowPos];
    this.window[this.windowPos] = voiced;
    this.levels[this.windowPos] = level;
    this.windowPos = (this.windowPos + 1) % this.window.length;
    let peak = 0;
    for (let i = 0; i < this.levels.length; i++) if (this.levels[i] > peak) peak = this.levels[i];
    const sustained = peak - level < MAX_DECAY;

    if (this.open) {
      // estalos soltos não seguram o portão aberto: só voz sustentada renova a espera
      if (voiced && sustained && this.windowCount >= this.window.length * KEEP_FRACTION) this.quiet = 0;
      else {
        this.quiet += frames;
        if (this.quiet > sampleRate * HOLD_SECONDS) {
          this.open = false;
          this.port.postMessage({ speaking: false });
        }
      }
    } else if (sustained && this.windowCount >= Math.ceil(this.window.length * OPEN_FRACTION)) {
      this.open = true;
      this.quiet = 0;
      this.port.postMessage({ speaking: true });
    }

    const target = !this.gate || this.open ? 1 : 0;
    const coef = target > this.gain ? this.openCoef : this.closeCoef;
    const delay = this.delay;
    const out0 = output[0];
    let gain = this.gain;
    let pos = this.pos;
    for (let i = 0; i < frames; i++) {
      const delayed = delay[pos];
      delay[pos] = source ? source[i] : 0;
      pos = (pos + 1) % delay.length;
      gain = target + (gain - target) * coef;
      out0[i] = delayed * gain;
    }
    this.pos = pos;
    this.gain = gain;
    for (let c = 1; c < output.length; c++) output[c].set(out0);

    this.sinceReport += frames;
    if (this.sinceReport >= sampleRate * REPORT_SECONDS) {
      this.sinceReport = 0;
      this.port.postMessage({ level: this.level, threshold: this.threshold });
    }
    return true;
  }
}

registerProcessor('orbita-gate', OrbitaGate);
