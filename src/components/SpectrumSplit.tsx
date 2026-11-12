import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import Spectrum from './Spectrum';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function SpectrumSplit({
  spectrum,
  children,
}: {
  spectrum: Omit<ComponentProps<typeof Spectrum>, 'layout' | 'onLayout'>;
  children: ReactNode;
}) {
  const container = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(700);
  const [dragging, setDragging] = useState(false);
  const [layout, setLayout] = useState({ expanded: false, collapsed: false, controls: false });
  const [height, setHeight] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem('airwolf.spectrumHeight'));
      if (Number.isFinite(saved) && saved >= 150 && saved <= 10000) return saved;
    } catch {
      /* Resizing still works without storage. */
    }
    return null;
  });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.height - 8));
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      if (height === null) localStorage.removeItem('airwolf.spectrumHeight');
      else localStorage.setItem('airwolf.spectrumHeight', String(height));
    } catch {
      /* Resizing still works without storage. */
    }
  }, [height]);
  useEffect(() => {
    if (spectrum.mode === 'live' && spectrum.running)
      setLayout((current) => ({ ...current, collapsed: false }));
  }, [spectrum.mode, spectrum.running]);
  const defaultHeight = available < 760 ? 150 : 180;
  const min = defaultHeight + (layout.controls ? 35 : 0);
  const max = Math.max(min, available - 300);
  const visibleHeight = layout.collapsed
    ? 32
    : clamp(layout.expanded ? available * 0.6 : (height ?? min), min, max);
  const resize = (value: number) => {
    setLayout((current) => ({ ...current, expanded: false }));
    setHeight(clamp(value, min, max));
  };
  return (
    <main
      ref={container}
      className={`workspace spectrum-split${dragging ? ' resizing' : ''}`}
      aria-label="Spectrum and packet analysis"
      style={{
        gridTemplateRows: `${layout.collapsed ? '32px' : `clamp(${min}px, ${visibleHeight}px, calc(100% - 308px))`} ${layout.collapsed ? 5 : 8}px minmax(0, 1fr)`,
      }}
    >
      <Spectrum {...spectrum} layout={layout} onLayout={setLayout} />
      <div
        className="spectrum-divider"
        role="separator"
        tabIndex={0}
        hidden={layout.collapsed}
        aria-label="Resize spectrum and packets"
        aria-orientation="horizontal"
        aria-controls="spectrum-pane"
        aria-valuemin={min}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(visibleHeight)}
        aria-valuetext={`${Math.round(visibleHeight)} pixels spectrum height`}
        title="Drag to resize · Up/Down to adjust · Double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const top = container
            .current!.querySelector('.spectrum-panel')!
            .getBoundingClientRect().top;
          resize(event.clientY - top - 4);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => {
          setLayout((current) => ({ ...current, expanded: false }));
          setHeight(null);
        }}
        onKeyDown={(event) => {
          const value = {
            ArrowUp: visibleHeight - 20,
            ArrowDown: visibleHeight + 20,
            Home: min,
            End: max,
          }[event.key];
          if (value === undefined) return;
          event.preventDefault();
          resize(value);
        }}
      />
      {children}
    </main>
  );
}
