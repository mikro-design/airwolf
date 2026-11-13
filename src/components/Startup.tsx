import { useEffect, useState, type ReactNode } from 'react';
import './startup.css';

/** A short, skippable intro. Unmount it entirely so no animation runs during capture. */
export default function Startup({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<'intro' | 'leaving' | 'done'>(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'done' : 'intro',
  );
  useEffect(() => {
    if (phase === 'done') return;
    const timer = window.setTimeout(
      () => setPhase(phase === 'intro' ? 'leaving' : 'done'),
      phase === 'intro' ? 1050 : 240,
    );
    const skip = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPhase('done');
    };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduceMotion = () => {
      if (motion.matches) setPhase('done');
    };
    window.addEventListener('keydown', skip);
    motion.addEventListener('change', reduceMotion);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', skip);
      motion.removeEventListener('change', reduceMotion);
    };
  }, [phase]);
  return (
    <>
      <div inert={phase !== 'done'} aria-hidden={phase !== 'done' || undefined}>
        {children}
      </div>
      {phase !== 'done' && (
        <div
          className={`startup ${phase}`}
          role="dialog"
          aria-modal="true"
          aria-label="Welcome to Airwolf"
        >
          <div className="startup-grid" aria-hidden="true" />
          <div className="startup-content">
            <div className="startup-scope" aria-hidden="true">
              <div className="startup-ring outer" />
              <div className="startup-ring inner" />
              <div className="startup-sweep" />
              <svg className="startup-reticle" viewBox="0 0 420 420" fill="none">
                <path d="M210 8v22m0 360v22M8 210h22m360 0h22M66 66l15 15m258 258 15 15M66 354l15-15M339 81l15-15" />
                <path d="M12 176v-20h20m356 0h20v20M12 244v20h20m356 0h20v-20" />
              </svg>
              <div className="startup-crest">
                <img src="./airwolf-mark.png" width="270" height="270" alt="" draggable="false" />
              </div>
              <span className="startup-signal first" />
              <span className="startup-signal second" />
            </div>
            <h1>AIRWOLF</h1>
            <p className="startup-subtitle">
              Spectrum <span> / </span> Capture <span> / </span> Decode
            </p>
            <div className="startup-rule">
              <span />
            </div>
            <p className="startup-status" role="status">
              Opening workspace
            </p>
          </div>
          <button className="startup-skip" autoFocus onClick={() => setPhase('done')}>
            Skip intro <kbd>Esc</kbd>
          </button>
        </div>
      )}
    </>
  );
}
