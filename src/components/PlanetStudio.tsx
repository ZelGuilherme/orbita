import { lazy, Suspense, useState, type ReactNode } from 'react';
import { CircleDot, Globe, Moon, RotateCcw, Rocket, Sparkles } from 'lucide-react';
import { updateProfile } from '../controller';
import { DEFAULT_PLANET, ORNAMENTS, PLANET_TEXTURES, TEXTURE_PARTS, photoMixOf, type Level, type Ornament, type PlanetStyle, type TexPart } from '../lib/planet';
import { autoPartColors } from '../lib/texturePalette';
import { hasWebGL } from '../lib/webgl';
import { getApp, useApp } from '../store';
import { AvatarButtons, ColorInput, Swatches } from './Landing';
import { Planet } from './Planet';
import { cx, Switch } from './ui';

const PlanetPreview3D = lazy(() => import('./PlanetPreview3D'));

type StudioTab = 'surface' | 'rings' | 'moons' | 'glow' | 'ornaments';

const TABS: Array<{ id: StudioTab; label: string; icon: ReactNode }> = [
  { id: 'surface', label: 'Superfície', icon: <Globe size={15} /> },
  { id: 'rings', label: 'Anéis', icon: <CircleDot size={15} /> },
  { id: 'moons', label: 'Luas', icon: <Moon size={15} /> },
  { id: 'glow', label: 'Brilho', icon: <Sparkles size={15} /> },
  { id: 'ornaments', label: 'Enfeites', icon: <Rocket size={15} /> },
];

function Segmented<T extends string | number>({ value, options, onPick, label }: { value: T; options: Array<[T, string]>; onPick: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={cx(value === v && 'is-on')} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="studio-row">
      <span className="studio-row__label">{label}</span>
      <div className="studio-row__control">{children}</div>
      {hint && <span className="studio-row__hint">{hint}</span>}
    </div>
  );
}

/** Cor de uma parte da textura: a escolhida ou a automática (que combina com a cor do planeta). */
function PartColor({ label, value, auto, onChange, onReset }: { label: string; value: string; auto: boolean; onChange: (c: string) => void; onReset: () => void }) {
  return (
    <div className="part-color">
      <label className="part-color__swatch" style={{ background: value }} title={`Escolher a cor: ${label}`}>
        <ColorInput value={value} onChange={onChange} label={`Cor: ${label}`} />
      </label>
      <span className="part-color__label">{label}</span>
      {auto ? (
        <span className="part-color__auto">automática</span>
      ) : (
        <button type="button" className="part-color__reset" onClick={onReset} title="Voltar para a cor automática">
          <RotateCcw size={12} /> automática
        </button>
      )}
    </div>
  );
}

/**
 * Editor do planeta: prévia 3D grande (sempre à vista) e as opções em abas.
 * Cada mudança vale na hora: vai para o perfil e para todo mundo da sala.
 */
export function PlanetStudio() {
  const profile = useApp((s) => s.profile);
  const look = profile.planet ?? DEFAULT_PLANET;
  const [tab, setTab] = useState<StudioTab>('surface');
  // sempre sobre a versão mais recente: o seletor de cor salva com atraso e não pode desfazer outra mudança
  const latest = () => getApp().profile.planet ?? DEFAULT_PLANET;
  const set = (patch: Partial<PlanetStyle>) => updateProfile({ planet: { ...latest(), ...patch } });
  const levels = (labels: [string, string, string], value: Level, onPick: (l: Level) => void, label: string) => (
    <Segmented<Level> value={value} label={label} options={[1, 2, 3].map((l) => [l as Level, labels[l - 1]])} onPick={onPick} />
  );
  const parts = TEXTURE_PARTS[look.texture];
  const auto = autoPartColors(look.texture, profile.color, look.color2);
  const setPart = (id: TexPart, color: string | null) => {
    const texColors = { ...latest().texColors };
    if (color) texColors[id] = color;
    else delete texColors[id];
    set({ texColors });
  };
  const mix = photoMixOf(look);

  return (
    <div className="studio">
      <div className="studio__preview">
        {hasWebGL() ? (
          <Suspense fallback={<div className="studio__preview-box" />}>
            <PlanetPreview3D color={profile.color} look={look} photo={profile.avatar} seedId={profile.id} size={216} />
          </Suspense>
        ) : (
          <div className="studio__preview-box">
            <Planet name={profile.name} color={profile.color} avatar={profile.avatar} planet={look} size={120} />
          </div>
        )}
        <span className="studio__caption">Assim seu planeta aparece na órbita. Arraste para virar.</span>
        {/* a foto vai embrulhada no planeta: adicionar, trocar e remover ficam aqui */}
        <AvatarButtons />
      </div>

      <div className="studio__panel">
        <div className="studio__tabs" role="tablist" aria-label="Partes do planeta">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx('studio__tab', tab === t.id && 'is-on')} onClick={() => setTab(t.id)}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="studio__body" role="tabpanel">
          {tab === 'surface' && (
            <>
              <Row label="Cor do planeta">
                <Swatches value={profile.color} onChange={(color) => updateProfile({ color })} />
              </Row>
              <Row label="Textura">
                <div className="texture-grid">
                  {PLANET_TEXTURES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={cx('texture-tile', look.texture === t.id && 'is-on')}
                      aria-pressed={look.texture === t.id}
                      onClick={() => set({ texture: t.id })}
                    >
                      <Planet
                        name={profile.name}
                        color={profile.color}
                        planet={{ ...look, texture: t.id, rings: 0, moons: 0, glow: false, ornaments: [], texColors: t.id === look.texture ? look.texColors : {} }}
                        size={40}
                        text=" "
                      />
                      <small>{t.label}</small>
                    </button>
                  ))}
                </div>
              </Row>
              {look.texture === 'none' ? (
                <Row label="Segunda cor">
                  <div className="studio-inline">
                    <Segmented<'one' | 'two'>
                      value={look.color2 ? 'two' : 'one'}
                      label="Segunda cor"
                      options={[
                        ['one', 'Uma cor'],
                        ['two', 'Degradê'],
                      ]}
                      onPick={(v) => set({ color2: v === 'two' ? (look.color2 ?? '#22d3ee') : null })}
                    />
                    {look.color2 && <ColorInput value={look.color2} onChange={(color2) => set({ color2 })} label="Segunda cor" />}
                  </div>
                </Row>
              ) : (
                <Row label="Cores da textura" hint="Automática combina com a cor do planeta. Clique no círculo para escolher.">
                  <div className="part-colors">
                    {parts.map((p) => (
                      <PartColor
                        key={p.id}
                        label={p.label}
                        value={look.texColors[p.id] ?? auto[p.id] ?? profile.color}
                        auto={!look.texColors[p.id]}
                        onChange={(c) => setPart(p.id, c)}
                        onReset={() => setPart(p.id, null)}
                      />
                    ))}
                  </div>
                </Row>
              )}
              {profile.avatar && (
                <Row label={`Visibilidade da foto: ${Math.round(mix * 100)}%`} hint="0% = só a textura · 100% = só a foto.">
                  <div className="studio-inline">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(mix * 100)}
                      aria-label="Visibilidade da foto"
                      onChange={(e) => set({ photoMix: Number(e.target.value) / 100 })}
                    />
                    {look.photoMix !== null && (
                      <button type="button" className="part-color__reset" onClick={() => set({ photoMix: null })}>
                        <RotateCcw size={12} /> automática
                      </button>
                    )}
                  </div>
                </Row>
              )}
            </>
          )}

          {tab === 'rings' && (
            <>
              <Row label="Quantos anéis">
                <Segmented<PlanetStyle['rings']>
                  value={look.rings}
                  label="Quantos anéis"
                  options={[
                    [0, 'Nenhum'],
                    [1, '1'],
                    [2, '2'],
                  ]}
                  onPick={(rings) => set({ rings })}
                />
              </Row>
              {look.rings > 0 && (
                <>
                  <Row label="Cor dos anéis">
                    <ColorInput value={look.ringColor} onChange={(ringColor) => set({ ringColor })} label="Cor dos anéis" />
                  </Row>
                  <Row label={`Inclinação: ${look.ringTilt}°`}>
                    <input type="range" min={-40} max={40} value={look.ringTilt} aria-label="Inclinação dos anéis" onChange={(e) => set({ ringTilt: Number(e.target.value) })} />
                  </Row>
                  <Row label="Largura">{levels(['Fino', 'Normal', 'Largo'], look.ringWidth, (ringWidth) => set({ ringWidth }), 'Largura dos anéis')}</Row>
                  <Row label="Desenho">
                    <Segmented<'plain' | 'bands'>
                      value={look.ringBands ? 'bands' : 'plain'}
                      label="Desenho dos anéis"
                      options={[
                        ['plain', 'Liso'],
                        ['bands', 'Com faixas'],
                      ]}
                      onPick={(v) => set({ ringBands: v === 'bands' })}
                    />
                  </Row>
                </>
              )}
            </>
          )}

          {tab === 'moons' && (
            <>
              <Row label="Quantas luas">
                <Segmented<PlanetStyle['moons']>
                  value={look.moons}
                  label="Quantas luas"
                  options={[
                    [0, 'Nenhuma'],
                    [1, '1'],
                    [2, '2'],
                    [3, '3'],
                  ]}
                  onPick={(moons) => set({ moons })}
                />
              </Row>
              {look.moons > 0 && (
                <>
                  <Row label="Cor das luas">
                    <ColorInput value={look.moonColor} onChange={(moonColor) => set({ moonColor })} label="Cor das luas" />
                  </Row>
                  <Row label="Tamanho">{levels(['Pequenas', 'Médias', 'Grandes'], look.moonSize, (moonSize) => set({ moonSize }), 'Tamanho das luas')}</Row>
                  <Row label="Velocidade">{levels(['Devagar', 'Normal', 'Rápido'], look.moonSpeed, (moonSpeed) => set({ moonSpeed }), 'Velocidade das luas')}</Row>
                </>
              )}
            </>
          )}

          {tab === 'glow' && (
            <>
              <Switch label="Atmosfera brilhante" hint="Uma borda de luz em volta do planeta." checked={look.glow} onChange={(glow) => set({ glow })} />
              {look.glow && (
                <Row label="Cor do brilho">
                  <ColorInput value={look.glowColor} onChange={(glowColor) => set({ glowColor })} label="Cor do brilho" />
                </Row>
              )}
            </>
          )}

          {tab === 'ornaments' && (
            <Row label="Coisas em órbita do seu planeta" hint="Pode escolher vários.">
              <div className="studio-inline studio-inline--wrap">
                {ORNAMENTS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={cx('chip', look.ornaments.includes(o.id) && 'is-on')}
                    aria-pressed={look.ornaments.includes(o.id)}
                    onClick={() =>
                      set({ ornaments: latest().ornaments.includes(o.id) ? latest().ornaments.filter((x: Ornament) => x !== o.id) : [...latest().ornaments, o.id] })
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </Row>
          )}
        </div>
      </div>
    </div>
  );
}
