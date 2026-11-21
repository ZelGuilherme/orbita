import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AppWindow, Camera, Crown, Download, Radio, Rocket, Settings, Shield, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import { createRoom, joinRoom, updateProfile } from '../controller';
import { PLANET_COLORS, REPO_URL } from '../lib/config';
import { imageToAvatar } from '../lib/images';
import { errorMessage } from '../lib/util';
import { appLikelyInstalled, canInstall, isStandalone, onInstallChange, openInApp, promptInstall } from '../lib/install';
import { planetBackground, sanitizeName } from '../lib/util';
import { setApp, toast, useApp } from '../store';
import { FixedRoomsList, LobbyList } from './Lobby';
import { OrbitLogo } from './OrbitLogo';
import { Planet } from './Planet';
import { cx } from './ui';

/** Seletor de cor livre que não manda uma atualização a cada pixel arrastado. */
export function ColorInput({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef(0);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="color"
      className="color-input"
      aria-label={label}
      title={label}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onChange(next), 120);
      }}
    />
  );
}

export function Swatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const custom = !PLANET_COLORS.includes(value);
  return (
    <div className="swatches" role="radiogroup" aria-label="Cor do planeta">
      {PLANET_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={`Cor ${color}`}
          className={cx('swatch', color === value && 'is-on')}
          style={{ background: planetBackground(color) }}
          onClick={() => onChange(color)}
        />
      ))}
      <label className={cx('swatch swatch--custom', custom && 'is-on')} title="Escolher qualquer cor" style={custom ? { background: planetBackground(value) } : undefined}>
        <ColorInput value={value} onChange={onChange} label="Escolher qualquer cor" />
      </label>
    </div>
  );
}

/** Adicionar, trocar e remover a foto do perfil (fica salva neste navegador e no app). */
export function AvatarButtons() {
  const avatar = useApp((s) => s.profile.avatar);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File) => {
    try {
      updateProfile({ avatar: await imageToAvatar(file) });
    } catch (err) {
      toast(`Não consegui usar essa foto: ${errorMessage(err)}`, 'error');
    }
  };
  return (
    <span className="avatar-buttons">
      <button type="button" className="link-btn" onClick={() => input.current?.click()}>
        <Camera size={14} /> {avatar ? 'Trocar foto' : 'Adicionar foto'}
      </button>
      {avatar && (
        <button type="button" className="link-btn link-btn--danger" onClick={() => updateProfile({ avatar: undefined })}>
          <Trash2 size={14} /> Remover
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pick(file);
          e.target.value = '';
        }}
      />
    </span>
  );
}

export function Landing() {
  const profile = useApp((s) => s.profile);
  const inviteCode = useApp((s) => s.inviteCode);
  const error = useApp((s) => s.landingError);
  const [tab, setTab] = useState<'create' | 'join'>(inviteCode ? 'join' : 'create');
  const [name, setName] = useState(profile.name);
  const [roomName, setRoomName] = useState(() => `Órbita de ${profile.name.split(' ')[0]}`);
  const [code, setCode] = useState(inviteCode ?? '');
  const [fixed, setFixed] = useState(false);
  const secure = window.isSecureContext;
  const installable = useSyncExternalStore(onInstallChange, canInstall, () => false);
  const standalone = isStandalone();
  const installed = !standalone && appLikelyInstalled();

  // o perfil é o mesmo no navegador e no app instalado: se mudou lá, atualiza aqui
  useEffect(() => setName(profile.name), [profile.name]);

  useEffect(() => {
    if (inviteCode) {
      setTab('join');
      setCode(inviteCode);
    }
  }, [inviteCode]);

  const commitName = () => {
    const clean = sanitizeName(name);
    setName(clean);
    if (clean !== profile.name) updateProfile({ name: clean });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    commitName();
    if (tab === 'create') void createRoom(roomName, fixed);
    else joinRoom(code);
  };

  return (
    <div className="landing starfield">
      <div className="landing__glow" aria-hidden="true" />
      <main className="landing__main">
        <section className="landing__hero">
          <OrbitLogo size={340} animated className="landing__logo" />
          <h1 className="landing__title">Órbita</h1>
          <p className="landing__tagline">
            Chat, voz, vídeo e lives direto entre amigos. <strong>Sem servidor no meio:</strong> tudo viaja peer-to-peer.
            Quem abre a sala vira o centro da órbita.
          </p>
          <ul className="landing__features">
            <li>
              <Crown size={18} />
              <b>Host no centro</b>
              <span>Quem cria a sala comanda — e passa a coroa se sair.</span>
            </li>
            <li>
              <Radio size={18} />
              <b>Lives</b>
              <span>Compartilhe a tela com áudio, até 1080p a 60 fps.</span>
            </li>
            <li>
              <Shield size={18} />
              <b>P2P e criptografado</b>
              <span>WebRTC de ponta a ponta. Nada fica salvo em servidor.</span>
            </li>
            <li>
              <Sparkles size={18} />
              <b>Sem cadastro</b>
              <span>Escolha um nome, uma cor de planeta e pronto.</span>
            </li>
          </ul>
        </section>

        <form className="landing__card" onSubmit={submit}>
          {inviteCode && (
            <div className="invite-banner">
              <OrbitLogo size={36} />
              <span>
                Você foi convidado para a órbita <code className="code-pill">{inviteCode}</code>
              </span>
            </div>
          )}
          {!secure && (
            <p className="form-error">
              <TriangleAlert size={16} /> Abra pelo endereço HTTPS (ou localhost): sem isso o navegador bloqueia microfone, câmera e
              tela.
            </p>
          )}

          <div className="profile-picker">
            <div className="avatar-edit">
              <Planet name={name || '?'} color={profile.color} avatar={profile.avatar} planet={profile.planet} size={68} />
              <button type="button" className="link-btn" onClick={() => setApp({ modal: { kind: 'settings', tab: 'planeta' } })}>
                <Sparkles size={14} /> Personalizar
              </button>
            </div>
            <div className="profile-picker__fields">
              <label className="field">
                <span>Seu perfil</span>
                <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={commitName} aria-label="Seu nome" required />
              </label>
              <Swatches value={profile.color} onChange={(color) => updateProfile({ color })} />
            </div>
          </div>

          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'create'} className={cx('tab', tab === 'create' && 'is-on')} onClick={() => setTab('create')}>
              Criar órbita
            </button>
            <button type="button" role="tab" aria-selected={tab === 'join'} className={cx('tab', tab === 'join' && 'is-on')} onClick={() => setTab('join')}>
              Entrar
            </button>
          </div>

          {tab === 'create' ? (
            <>
              <label className="field">
                <span>Nome da sala</span>
                <input value={roomName} maxLength={40} onChange={(e) => setRoomName(e.target.value)} />
              </label>
              <label className="check-row">
                <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
                <span>
                  <b>Órbita fixa</b> · o mesmo link sempre; quem já entrou pode reabrir quando estiver vazia (histórico e configurações ficam guardados no navegador de cada um)
                </span>
              </label>
            </>
          ) : (
            <label className="field">
              <span>Código ou link do convite</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ex.: k3x9p2m ou https://…#/sala/k3x9p2m"
                autoFocus={!!inviteCode}
                required
              />
            </label>
          )}

          {error && (
            <p className="form-error" role="alert">
              <TriangleAlert size={16} /> {error}
            </p>
          )}

          <button className="btn btn--primary btn--lg" type="submit">
            {tab === 'create' ? (
              <>
                <Crown size={18} /> Criar e virar host
              </>
            ) : (
              <>
                <Rocket size={18} /> Entrar na órbita
              </>
            )}
          </button>
          <p className="landing__hint">
            {tab === 'create'
              ? 'A sala existe enquanto houver alguém nela. Se você sair, a coroa passa para o próximo.'
              : 'Peça o link pro host. A conexão é direta entre vocês.'}
          </p>
          <div className="landing__footer">
            <button type="button" className="link-btn" onClick={() => setApp({ modal: { kind: 'settings', tab: 'voz' } })}>
              <Settings size={14} /> Configurações
            </button>
            {installable && (
              <button type="button" className="link-btn" onClick={() => void promptInstall()}>
                <Download size={14} /> Instalar o app
              </button>
            )}
            {installed && (
              <button type="button" className="link-btn" onClick={() => void openInApp(null)}>
                <AppWindow size={14} /> Abrir no app
              </button>
            )}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              Código aberto no GitHub
            </a>
          </div>
        </form>
        <FixedRoomsList />
        <LobbyList />
      </main>
    </div>
  );
}
