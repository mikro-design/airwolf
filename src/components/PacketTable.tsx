import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Frame } from '../lib/types';
import { integrityLabel } from '../lib/decoder';

export default memo(function PacketTable({
  frames,
  selectedId,
  timeOrigin,
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
  const intentPaused = useRef(false);
  const previousFollow = useRef(followLatest);
  const current = useRef({ frames, rowHeight, followLatest, followEnabled, onFollowChange });
  current.current = { frames, rowHeight, followLatest, followEnabled, onFollowChange };
  const measure = () => {
    const element = scrollRef.current;
    if (!element) return;
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
    const element = scrollRef.current;
    if (!element) return;
    const pause = () => {
      if (!current.current.followEnabled) return;
      // Set the latch before React commits or a packet batch can scroll again.
      intentPaused.current = true;
      current.current.onFollowChange(false);
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !event.ctrlKey) pause();
    };
    const key = (event: KeyboardEvent) => {
      const destinations: Record<string, number> = {
        Home: 0,
        End: element.scrollHeight,
        PageUp: element.scrollTop - element.clientHeight,
        PageDown: element.scrollTop + element.clientHeight,
        ArrowUp: element.scrollTop - current.current.rowHeight,
        ArrowDown: element.scrollTop + current.current.rowHeight,
      };
      if (!(event.key in destinations)) return;
      event.preventDefault();
      pause();
      // Native smooth key scrolling can outlive an explicit Follow click and
      // pull the list away again. Navigate this packet pane synchronously.
      element.scrollTo({ top: destinations[event.key], behavior: 'instant' });
    };
    const pointer = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      // Classic scrollbars have a gutter; overlay scrollbars occupy the right
      // edge of the content box. Clicking a packet does not pause following.
      const gutter = Math.max(12, element.offsetWidth - element.clientWidth);
      if (
        event.button === 0 &&
        element.scrollHeight > element.clientHeight &&
        event.clientX >= rect.right - gutter &&
        event.clientX <= rect.right
      )
        pause();
    };
    const scroll = () => {
      // Scroll positions cannot distinguish old browser animation from new user
      // input. Only the intent handlers pause an active Follow. Keep an explicit
      // resume in control until the user supplies fresh input.
      if (current.current.followLatest && !intentPaused.current) {
        if (element.scrollHeight - element.clientHeight - element.scrollTop > 2)
          element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
        measure();
        return;
      }
      // Resume when the user actually moves down to the tail, not on a delayed
      // layout scroll event still reporting the pre-gesture bottom position.
      if (
        current.current.followEnabled &&
        element.scrollTop > appliedTop.current + 0.5 &&
        element.scrollHeight - element.clientHeight - element.scrollTop <= 2
      )
        current.current.onFollowChange(true);
      measure();
    };
    element.addEventListener('scroll', scroll);
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('keydown', key);
    element.addEventListener('pointerdown', pointer);
    const observer = new ResizeObserver(() => {
      if (current.current.followLatest && !intentPaused.current)
        element.scrollTop = element.scrollHeight;
      measure();
    });
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', scroll);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('keydown', key);
      element.removeEventListener('pointerdown', pointer);
      observer.disconnect();
    };
  }, [scrollRef]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const resuming = followLatest && !previousFollow.current;
    previousFollow.current = followLatest;
    if (resuming) {
      intentPaused.current = false;
    }
    // A browser scroll can occur before its scroll event is dispatched. Preserve
    // that movement instead of restoring an anchor measured before the input.
    if (
      !resuming &&
      (!followLatest || intentPaused.current) &&
      Math.abs(element.scrollTop - appliedTop.current) > 0.5
    ) {
      measure();
      return;
    }
    if (followLatest && !intentPaused.current)
      element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
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
              <th title="Packet summary. Select a packet for detailed protocol fields in the inspector.">
                Type / info
              </th>
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
        {visible.map((f) => {
          // On-demand dissection belongs to the inspector. Keep list text,
          // structure and CRC stable when a packet is selected or evicted from cache.
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
                        : f.protocol === 'wifi'
                          ? 'Wi-Fi'
                          : f.protocol === 'lte'
                            ? 'LTE'
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
