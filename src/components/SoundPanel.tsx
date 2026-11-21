import { useState } from 'react';
import { WandSparkles } from 'lucide-react';
import { updateSettings } from '../controller';
import type { LinkQuality } from '../lib/media';
import { VOICE_EFFECTS } from '../lib/voicefx';
import { useApp } from '../store';
import { cx } from './ui';

/** Efeito na minha voz: um botão por efeito. */
export function VoiceEffectPicker() {
  const effect = useApp((s) => s.settings.voiceEffect);
  return (
    <div className="fx-cards" role="radiogroup" aria-label="Efeito de voz">
      {VOICE_EFFECTS.map((e) => (
        <button
          key={e.id}
          type="button"
          role="radio"
          aria-checked={effect === e.id}
          aria-label={e.label}
          className={cx('fx-card', effect === e.id && 'is-on')}
          onClick={() => updateSettings({ voiceEffect: e.id })}
        >
          <span className="fx-card__icon" aria-hidden="true">
            {e.emoji}
          </span>
          <span className="fx-card__label">{e.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Botão "Efeitos de voz" da barra da chamada. */
export function SoundButton() {
  const [open, setOpen] = useState(false);
  const effect = useApp((s) => s.settings.voiceEffect);
  return (
    <div className="ctrl-wrap">
      <button
        type="button"
        className={cx('ctrl', (open || effect !== 'none') && 'is-on')}
        data-tip={effect !== 'none' ? `Efeitos de voz (agora: ${VOICE_EFFECTS.find((e) => e.id === effect)?.label})` : 'Efeitos de voz'}
        aria-label="Efeitos de voz"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <WandSparkles />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <SoundPanel />
        </>
      )}
    </div>
  );
}

function SoundPanel() {
  return (
    <div className="sound-panel" role="dialog" aria-label="Efeitos de voz">
      <h4>Efeito na sua voz</h4>
      <VoiceEffectPicker />
      <p className="sound-panel__hint">Muda só o que os outros ouvem. Para se ouvir: Configurações › Voz e vídeo › Testar microfone.</p>
    </div>
  );
}

/** 1 a 4 barras: como está a conexão de voz com essa pessoa. */
export function qualityLevel(q: LinkQuality): number {
  const rtt = q.rtt ?? 0;
  if (rtt < 150 && q.loss < 2) return 4;
  if (rtt < 300 && q.loss < 5) return 3;
  if (rtt < 500 && q.loss < 12) return 2;
  return 1;
}

export function SignalBars({ memberId }: { memberId: string }) {
  const q = useApp((s) => s.quality[memberId]);
  if (!q) return null;
  const level = qualityLevel(q);
  const text = `Ping ${q.rtt == null ? '—' : `${q.rtt} ms`} · perda ${q.loss.toLocaleString('pt-BR')}%`;
  return (
    <span className={cx('signal', `signal--${level}`)} title={text} aria-label={`Conexão: ${text}`} role="img">
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={cx(i <= level && 'is-lit')} />
      ))}
    </span>
  );
}
