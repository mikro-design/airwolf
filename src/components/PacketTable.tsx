import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Frame } from '../lib/types';
import { inspectedFrame } from '../lib/dissection';
import { integrityLabel } from '../lib/decoder';

export default memo(function PacketTable({
  frames,
  selectedId,
  timeOrigin,
  engine,
  view,
  onSelect,
  scrollRef,
  followLatest,
  followEnabled,
  onFollowChange,
}: {
  frames: Frame[];
  selectedId?: number;
  timeOrigin: number;
  engine: 'builtin' | 'wireshark';
  view: 'table' | 'frames';
  onSelect: (id: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  followLatest: boolean;
  followEnabled: boolean;
  onFollowChange: (enabled: boolean) => void;
}) {
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const rowHeight = view === 'frames' ? 32 : 26;
  const anchor = useRef<{ id: number; offset: number } | null>(null);
  const appliedTop = useRef(0);
  const current = useRef({ frames, rowHeight, followLatest, followEnabled, onFollowChange });
  current.current = { frames, rowHeight, followLatest, followEnabled, onFollowChange };
  const measure = () => {
    const element = scrollRef.current!;
    appliedTop.current = element.scrollTop;
    const { frames, rowHeight } = current.current;
    const index = Math.max(0, Math.floor((element.scrollTop - 25) / rowHeight));
    anchor.current = frames[index]
      ? { id: frames[index].id, offset: element.scrollTop - 25 - index * rowHeight }
      : null;
    setViewport((previous) =>
      previous.top === element.scrollTop && previous.height === element.clientHeight
        ? previous
        : { top: element.scrollTop, height: element.clientHeight },
    );
  };
  useEffect(() => {
    const element = scrollRef.current!;
    const scroll = () => {
      // Layout changes also dispatch scroll events. Only a new scroll position
      // should alter the user's choice to follow the tail.
      if (current.current.followEnabled && Math.abs(element.scrollTop - appliedTop.current) > 0.5)
        current.current.onFollowChange(
          element.scrollHeight - element.clientHeight - element.scrollTop <= 2,
        );
      measure();
    };
    element.addEventListener('scroll', scroll);
    const observer = new ResizeObserver(() => {
      if (current.current.followLatest) element.scrollTop = element.scrollHeight;
      measure();
    });
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', scroll);
      observer.disconnect();
    };
  }, [scrollRef]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (followLatest) element.scrollTop = element.scrollHeight;
    else if (anchor.current) {
      const index = frames.findIndex((frame) => frame.id === anchor.current!.id);
      // Retention removes rows from the top. Keep the same visible packet and
      // offset instead of letting every incoming batch move the inspected area.
      element.scrollTop = index < 0 ? 0 : 25 + index * rowHeight + anchor.current.offset;
    }
    measure();
  }, [frames, rowHeight, followLatest]);
  const virtual = frames.length > 100;
  const start = virtual
    ? Math.min(
        Math.max(0, frames.length - 1),
        Math.max(0, Math.floor((viewport.top - 25) / rowHeight) - 8),
      )
    : 0;
  const end = virtual
    ? Math.min(frames.length, start + Math.ceil(viewport.height / rowHeight) + 18)
    : frames.length;
  const visible = frames.slice(start, end);
  const columns = view === 'frames' ? 7 : 9;
  return (
    <table
      className={`${view === 'frames' ? 'frame-table' : ''} ${virtual ? 'virtual-table' : ''}`}
      aria-rowcount={frames.length + 1}
    >
      <thead>
        <tr>
          <th>No.</th>
          <th>Time (s)</th>
          <th>Protocol</th>
          {view === 'table' ? (
            <>
              <th>Source</th>
              <th>Destination</th>
              <th>Type / info</th>
            </>
          ) : (
            <th className="frame-column">Decoded frame structure</th>
          )}
          <th>Length</th>
          <th>RSSI</th>
          <th>FCS / CRC</th>
        </tr>
      </thead>
      <tbody>
        {virtual && start > 0 && (
          <tr className="virtual-spacer" aria-hidden="true">
            <td colSpan={columns} style={{ height: start * rowHeight }} />
          </tr>
        )}
        {visible.map((rawFrame) => {
          const f = inspectedFrame(rawFrame, engine === 'wireshark');
          return (
            <tr
              key={f.id}
              data-packet-id={f.id}
              className={f.id === selectedId ? 'selected' : ''}
              onClick={() => {
                onSelect(f.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(f.id);
                }
              }}
              tabIndex={0}
              aria-selected={f.id === selectedId}
            >
              <td className="packet-number">{f.id.toString().padStart(4, '0')}</td>
              <td>{(f.time - timeOrigin).toFixed(6)}</td>
              <td>
                <span className={`protocol-chip ${f.protocol}`}>
                  {f.protocol.startsWith('enocean')
                    ? f.protocol === 'enocean2'
                      ? 'EnOcean 2'
                      : 'EnOcean 1'
                    : f.protocol === 'zigbee'
                      ? 'Zigbee'
                      : f.protocol === 'ble'
                        ? 'BLE'
                        : '802.15.4'}
                </span>
              </td>
              {view === 'table' ? (
                <>
                  <td>{f.source}</td>
                  <td>{f.destination}</td>
                  <td className="summary-cell">{f.summary}</td>
                </>
              ) : (
                <td>
                  <div className="inline-frame">
                    {f.fields.map((field) => (
                      <span
                        key={field.id}
                        className={`${field.layer} ${field.layer === 'check' ? `checksum-${f.integrity}` : ''}`}
                        style={{ flex: Math.max(field.length, 2) }}
                        title={`${field.name}: ${field.value}`}
                      >
                        {field.text?.length
                          ? `${field.text.some((t) => t.inferred) ? 'Text? ' : ''}${field.text.map((t) => JSON.stringify(t.value)).join(' / ')}`
                          : field.value}
                      </span>
                    ))}
                  </div>
                </td>
              )}
              <td>
                {f.bytes.length} <span className="muted">B</span>
              </td>
              <td>
                {f.rssi ?? '—'}
                {f.rssi !== null && <span className="muted"> dBm</span>}
              </td>
              <td>
                <span className={`integrity ${f.integrity}`}>
                  <i className="dot" />
                  {integrityLabel(f)}
                </span>
              </td>
            </tr>
          );
        })}
        {virtual && end < frames.length && (
          <tr className="virtual-spacer" aria-hidden="true">
            <td colSpan={columns} style={{ height: (frames.length - end) * rowHeight }} />
          </tr>
        )}
      </tbody>
    </table>
  );
});
