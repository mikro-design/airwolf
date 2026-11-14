import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const defaultRatio = 55;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function PacketSplit({
  children,
  expanded,
  onResize,
}: {
  children: [ReactNode, ReactNode];
  expanded: boolean;
  onResize: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('airwolf.packetSplit'));
      if (saved >= 20 && saved <= 80) return saved;
    } catch {
      /* Storage can be disabled. */
    }
    return defaultRatio;
  });
  useLayoutEffect(() => {
    setWidth(container.current!.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  const available = Math.max(700, width - 8);
  const min = Math.max(20, (340 / available) * 100);
  const max = Math.min(80, (1 - 360 / available) * 100);
  const visibleRatio = clamp(expanded ? 38 : ratio, min, max);
  const resize = (value: number) => {
    onResize();
    const next = clamp(value, min, max);
    // Persist the gesture before a reload can discard a pending React effect.
    try {
      localStorage.setItem('airwolf.packetSplit', String(next));
    } catch {
      /* Storage can be disabled. */
    }
    setRatio(next);
  };
  return (
    <div
      ref={container}
      className={`packet-split${dragging ? ' resizing' : ''}`}
      style={{
        gridTemplateColumns: `minmax(340px, ${visibleRatio}fr) 8px minmax(360px, ${100 - visibleRatio}fr)`,
      }}
    >
      {children[0]}
      <div
        className="packet-divider"
        role="separator"
        tabIndex={0}
        aria-label="Resize packet list and inspector"
        aria-orientation="vertical"
        aria-controls="packet-list-pane"
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(visibleRatio)}
        aria-valuetext={`${Math.round(visibleRatio)} percent packet list`}
        title="Drag to resize · Arrow keys to adjust · Double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const rect = container.current!.getBoundingClientRect();
          resize(((event.clientX - rect.left - 4) / (rect.width - 8)) * 100);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            const rect = container.current!.getBoundingClientRect();
            resize(((event.clientX - rect.left - 4) / (rect.width - 8)) * 100);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => resize(defaultRatio)}
        onKeyDown={(event) => {
          const value = {
            ArrowLeft: visibleRatio - 2,
            ArrowRight: visibleRatio + 2,
            Home: min,
            End: max,
          }[event.key];
          if (value === undefined) return;
          event.preventDefault();
          resize(value);
        }}
      />
      {children[1]}
    </div>
  );
}
