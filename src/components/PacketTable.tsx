import { memo, useEffect, useState, type RefObject } from 'react';
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
}: {
  frames: Frame[];
  selectedId?: number;
  timeOrigin: number;
  engine: 'builtin' | 'wireshark';
  view: 'table' | 'frames';
  onSelect: (id: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const element = scrollRef.current!;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    element.addEventListener('scroll', update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [scrollRef]);
  const virtual = frames.length > 100;
  const rowHeight = view === 'frames' ? 32 : 26;
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
