import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { playSound, updateSettings } from '../controller';
import type { LinkQuality } from '../lib/media';
import { SOUND_LIST } from '../lib/soundboard';
import { VOICE_EFFECTS } from '../lib/voicefx';
import { useApp } from '../store';
import { cx, Switch, useNow } from './ui';

/** Efeito na minha voz: um botão por efeito. */
export function VoiceEffectPicker() {
  const effect = useApp((s) => s.settings.voiceEffect);
  return (
    <div className="fx-chips" role="radiogroup" aria-label="Efeito de voz">
      {VOICE_EFFECTS.map((e) => (
        <button
          key={e.id}
          type="button"
          role="radio"
          aria-checked={effect === e.id}
          className={cx('chip', effect === e.id && 'is-on')}
          onClick={() => updateSettings({ voiceEffect: e.id })}
        >
          <span aria-hidden="true">{e.emoji}</span> {e.label}
        </button>
      ))}
    </div>
  );
}

/** Botão "Sons e efeitos" da barra da chamada: soundboard e efeito de voz. */
export function SoundButton() {
  const [open, setOpen] = useState(false);
  const effect = useApp((s) => s.settings.voiceEffect);
  return (
    <div className="ctrl-wrap">
      <button
        type="button"
        className={cx('ctrl', (open || effect !== 'none') && 'is-on')}
        data-tip={effect !== 'none' ? `Sons e efeitos (efeito: ${VOICE_EFFECTS.find((e) => e.id === effect)?.label})` : 'Sons e efeitos'}
        aria-label="Sons e efeitos"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles />
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
  const cooldown = useApp((s) => s.soundCooldown);
  const others = useApp((s) => s.settings.soundboardOthers);
  const now = useNow(250);
  const waiting = cooldown > now;
  return (
    <div className="sound-panel" role="dialog" aria-label="Sons e efeitos">
      <h4>Soundboard</h4>
      <div className="sound-grid">
        {SOUND_LIST.map((sound) => (
          <button key={sound.id} type="button" className="sound-btn" disabled={waiting} onClick={() => playSound(sound.id)}>
            <span className="sound-btn__emoji" aria-hidden="true">
              {sound.emoji}
            </span>
            {sound.label}
          </button>
        ))}
      </div>
      <p className="sound-panel__hint">{waiting ? 'Espere um instante para o próximo som…' : 'Todo mundo da chamada ouve. Um som a cada 2 segundos.'}</p>
      <Switch label="Ouvir os sons dos outros" checked={others} onChange={(soundboardOthers) => updateSettings({ soundboardOthers })} />
      <h4>Efeito na sua voz</h4>
      <VoiceEffectPicker />
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
