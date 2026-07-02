// SETTINGS — a right-side drawer opened from the MENU pill (spec §4). Quiet,
// restrained toggles and segmented controls; every change is reported up via
// onChange so App owns persistence (settings.ts) and the engine wiring. The
// component returns null when closed and dismisses on outside-click, Esc, or ×.
//
// Note: the exported component is SettingsPanel so it never collides with the
// `Settings` TYPE from ../settings.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Settings } from '../settings';
import { PROFILE } from '../profile';
import './Settings.css';

// Segmented option tables — typed via indexed access so each picker stays in
// lockstep with the Settings model (no stray strings).
const THEME_OPTS: { label: string; value: Settings['theme'] }[] = [
  { label: '☾', value: 'night' },
  { label: '☀', value: 'day' },
];
const WINDOW_OPTS: { label: string; value: number }[] = [
  { label: '1H', value: 1 },
  { label: '12H', value: 12 },
  { label: '24H', value: 24 },
  { label: '7D', value: 168 },
  { label: 'ALL', value: 1_000_000 },
];
const DENSITY_OPTS: { label: string; value: Settings['density'] }[] = [
  { label: 'Cozy', value: 'cozy' },
  { label: 'Balanced', value: 'balanced' },
  { label: 'Sparse', value: 'sparse' },
];
const AMBIENT_OPTS: { label: string; value: Settings['ambientFill'] }[] = [
  { label: 'All-time roster', value: 'roster' },
  { label: 'Placeholder set', value: 'placeholder' },
  { label: 'Off', value: 'off' },
];
const IDLE_OPTS: { label: string; value: Settings['autoFrameIdleSec'] }[] = [
  { label: 'Off', value: 0 },
  { label: '1 min', value: 60 },
  { label: '5 min', value: 300 },
];

// A quiet segmented control: one active pill, the rest muted mono labels.
function Segmented<T>(props: { value: T; options: { label: string; value: T }[]; onPick: (v: T) => void }) {
  return (
    <div className="set-seg" role="group">
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={String(o.value)}
            type="button"
            className={on ? 'on' : ''}
            aria-pressed={on}
            onClick={() => props.onPick(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// A restrained pill switch (no glow), the whole row is the hit target.
function Toggle(props: { label: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="set-toggle"
      role="switch"
      aria-checked={props.on}
      onClick={() => props.onToggle(!props.on)}
    >
      <span className="set-row-l">{props.label}</span>
      <span className={props.on ? 'set-sw on' : 'set-sw'}>
        <i />
      </span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-sec">
      <h3 className="set-h">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsPanel(props: {
  open: boolean;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  onEnterFrame: () => void;
}) {
  const { open, settings, onChange, onClose, onEnterFrame } = props;

  // Golden Hour is structurally silent without a configured location — the
  // toggle stays interactive (the engine gate makes it harmless) and the note
  // below it is the honest one-line explanation of what's missing.
  const hasLocation = PROFILE.lat !== null && PROFILE.lon !== null;

  // Esc closes; only listen while the drawer is open. (Hook runs every render —
  // the early return below is after this, per rules-of-hooks.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="set-scrim" onClick={onClose}>
      <aside
        className="set-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="set-top">
          <span className="set-title">SETTINGS</span>
          <button type="button" className="set-x" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="set-body">
          <Section title="APPEARANCE">
            <div className="set-row">
              <span className="set-row-l">Theme</span>
              <Segmented value={settings.theme} options={THEME_OPTS} onPick={(v) => onChange({ theme: v })} />
            </div>
            <Toggle
              label="Golden hour light"
              on={settings.solarLight}
              onToggle={(v) => onChange({ solarLight: v })}
            />
            <p className="set-note">
              {hasLocation
                ? 'Warms the gallery ink with the real sun — sunrise and sunset computed offline from this frame’s location.'
                : 'Needs a location: add ?lat=&lon= to the URL (or set VITE_LAT/VITE_LON). Until then this does nothing.'}
            </p>
            <button type="button" className="set-primary" onClick={onEnterFrame}>
              Enter frame mode ⤢
            </button>
          </Section>

          <Section title="WINDOW">
            <div className="set-field">
              <span className="set-row-l">Time window</span>
              <Segmented
                value={settings.windowHours}
                options={WINDOW_OPTS}
                onPick={(v) => onChange({ windowHours: v })}
              />
            </div>
          </Section>

          <Section title="MOTION & DENSITY">
            <Toggle
              label="Listening animation"
              on={settings.listeningAnim}
              onToggle={(v) => onChange({ listeningAnim: v })}
            />
            <Toggle
              label="Ambient motion"
              on={settings.ambientMotion}
              onToggle={(v) => onChange({ ambientMotion: v })}
            />
            <Toggle label="Reveal animation" on={settings.revealAnim} onToggle={(v) => onChange({ revealAnim: v })} />
            <div className="set-field">
              <span className="set-row-l">Density</span>
              <Segmented value={settings.density} options={DENSITY_OPTS} onPick={(v) => onChange({ density: v })} />
            </div>
          </Section>

          <Section title="AMBIENT">
            <div className="set-field">
              <span className="set-row-l">Fill empty space</span>
              <Segmented
                value={settings.ambientFill}
                options={AMBIENT_OPTS}
                onPick={(v) => onChange({ ambientFill: v })}
              />
            </div>
          </Section>

          <Section title="DISPLAY">
            <div className="set-field">
              <span className="set-row-l">Auto-frame after idle</span>
              <Segmented
                value={settings.autoFrameIdleSec}
                options={IDLE_OPTS}
                onPick={(v) => onChange({ autoFrameIdleSec: v })}
              />
            </div>
            <Toggle label="Show colophon" on={settings.showColophon} onToggle={(v) => onChange({ showColophon: v })} />
          </Section>

          <Section title="ABOUT">
            <p className="set-colophon">
              Belkins BirdNET — a living gallery of the birds heard from your window. The number is the truth; the
              painting is the mood.
            </p>
            <a className="set-legacy" href="/#">
              the original gallery ↗
            </a>
          </Section>
        </div>
      </aside>
    </div>
  );
}
