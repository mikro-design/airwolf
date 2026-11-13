import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  LockKeyhole,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import type { Field, Frame } from '../lib/types';
import { hex, integrityLabel } from '../lib/decoder';
import { flattenFields } from '../lib/dissection';
import { blePhyLabel } from '../lib/receiver';
interface Props {
  expanded: boolean;
  onExpand: () => void;
  frame?: Frame;
  loading?: boolean;
  onNotice: (message: string) => void;
  decodeStatus?: string;
  onRetry?: () => void;
}
export default function Inspector({
  expanded,
  onExpand,
  frame,
  loading = false,
  onNotice,
  decodeStatus,
  onRetry,
}: Props) {
  const [selected, setSelected] = useState('fc'),
    [open, setOpen] = useState(true),
    [details, setDetails] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [textRange, setTextRange] = useState<{ offset: number; length: number } | null>(null);
  useEffect(() => {
    setSelected(frame?.fields[0]?.id ?? 'fc');
    setTextRange(null);
  }, [frame?.id, frame?.fields]);
  const fields = loading ? [] : (frame?.fields ?? []),
    all = flattenFields(fields),
    active = all.find((f) => f.id === selected);
  const selectedRange = textRange ?? (active?.mapped !== false ? active : undefined);
  const select = (id: string) => {
    setSelected(id);
    setTextRange(null);
  };
  function row(f: Field, child = false) {
    return (
      <button
        key={f.id}
        className={`field-row ${child ? 'child' : ''} ${selected === f.id ? 'selected' : ''}`}
        onClick={() => select(f.id)}
        title={`${f.filter ? `${f.filter}\n` : ''}${f.name}: ${f.value}`}
      >
        <span className={`layer-dot ${f.layer}`} />
        <span>{f.name}</span>
        <code className={f.layer === 'check' ? `checksum-${frame?.integrity}` : ''}>
          {f.text?.length
            ? `${f.text.some((t) => t.inferred) ? 'Possible text: ' : ''}${f.text.map((t) => JSON.stringify(t.value)).join(' / ')}`
            : f.value}
        </code>
      </button>
    );
  }
  return (
    <section
      className={`panel inspector ${expanded ? 'expanded' : ''} ${collapsed ? 'collapsed' : ''}`}
      aria-label="Frame inspector"
      aria-busy={loading}
    >
      <div className="panel-heading">
        <div className="panel-title">
          <Layers size={15} /> Frame inspector{' '}
          {frame && <span className="tag">#{frame.id.toString().padStart(4, '0')}</span>}
          {frame && !loading && (
            <span className={`integrity ${frame.integrity}`} aria-label="Selected frame integrity">
              {integrityLabel(frame)}
            </span>
          )}
        </div>
        <div className="legend">
          {['mac', 'network', 'application', 'payload', 'check'].map((layer) => (
            <span key={layer}>
              <i className={`layer-dot ${layer}`} />
              {
                (
                  {
                    mac: 'MAC',
                    network: 'Network',
                    application: 'Application',
                    payload: 'Payload',
                    check: 'FCS / CRC',
                  } as Record<string, string>
                )[layer]
              }
            </span>
          ))}
        </div>
        <div className="inspector-actions">
          {!collapsed && (
            <button
              className="text-button inspector-toggle"
              aria-label={expanded ? 'Compact inspector' : 'Expand inspector'}
              aria-expanded={expanded}
              onClick={onExpand}
            >
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              {expanded ? 'Compact' : 'Expand'}
            </button>
          )}
          <button
            className="text-button"
            aria-label={collapsed ? 'Show inspector' : 'Hide inspector'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {collapsed ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>
      {!frame ? (
        <div className="empty">Select a packet to inspect its fields and bytes.</div>
      ) : loading ? (
        <div className="empty inspector-loading" role="status">
          <span className="decode-spinner" aria-hidden="true" />
          Decoding packet…
        </div>
      ) : (
        <>
          {decodeStatus && (
            <div className="capture-metadata" role="status" title={decodeStatus}>
              {decodeStatus}
              {onRetry && (
                <button className="text-button" onClick={onRetry}>
                  Retry decoding
                </button>
              )}
            </div>
          )}
          {frame.dissection && (
            <div
              className="capture-metadata"
              aria-label="Selected frame summary"
              title={frame.summary}
            >
              {frame.summary}
            </div>
          )}
          {frame.origin === 'live' && (
            <div
              className="capture-metadata"
              title={frame.deviceSerial ? `HackRF serial ${frame.deviceSerial}` : undefined}
            >
              {frame.deviceSerial ? `HackRF …${frame.deviceSerial.slice(-8)} · ` : ''}
              {frame.channel !== null ? `Channel ${frame.channel} · ` : ''}
              {frame.phy ? `${blePhyLabel(frame.phy)} · ` : ''}
              {frame.phy?.startsWith('coded') && frame.fecErrors !== undefined
                ? `FEC symbol differences ${frame.fecErrors} · `
                : ''}
              {frame.captureEpoch !== undefined ? `RX epoch ${frame.captureEpoch} · ` : ''}
              {frame.connectionEvent !== undefined ? `Event ${frame.connectionEvent} · ` : ''}
              {frame.timeUncertaintyUs !== undefined
                ? `Time ±${frame.timeUncertaintyUs} µs · `
                : ''}
              {frame.frequency?.toFixed(3)} MHz · Samples {frame.firstSample?.toLocaleString()}–
              {frame.endSample?.toLocaleString()} · Approximate host timestamp · RSSI uncalibrated
            </div>
          )}
          <div className="frame-strip">
            {fields.map((f) => (
              <button
                key={f.id}
                className={`frame-block ${f.layer} ${f.layer === 'check' ? `checksum-${frame.integrity}` : ''} ${selected === f.id ? 'selected' : ''}`}
                style={{ flex: Math.max(f.length, 2) }}
                onClick={() => select(f.id)}
                title={`${f.name}: ${f.value}`}
              >
                <span>
                  {f.name
                    .replace('Destination ', 'Dst. ')
                    .replace('Source ', 'Src. ')
                    .replace('Frame check sequence', 'FCS')
                    .replace('Frame control', 'Control')
                    .replace('Sequence number', 'Seq.')
                    .replace('Network ', 'NWK ')}
                </span>
                <code className={f.layer === 'check' ? `checksum-${frame.integrity}` : ''}>
                  {f.layer === 'check' ? integrityLabel(frame) : `${f.length} B`}
                </code>
              </button>
            ))}
          </div>
          <div className="inspector-body">
            <div className="field-tree">
              <button className="tree-heading" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{' '}
                {frame.dissection
                  ? frame.dissection.protocols.join(' → ')
                  : frame.protocol === 'enocean2'
                    ? 'EnOcean · ERP2 radio frame'
                    : frame.protocol === 'enocean'
                      ? 'EnOcean · ERP1 radio subtelegram'
                      : frame.protocol === 'ble'
                        ? 'Bluetooth LE · Link layer'
                        : 'IEEE 802.15.4 · MAC frame'}
                <span className="muted">{frame.bytes.length} bytes</span>
              </button>
              {open && frame.dissection
                ? fields.map((f) => <DecodedField key={f.id} field={f} row={row} />)
                : open &&
                  fields.map((f) => (
                    <div key={f.id}>
                      <div className="field-with-toggle">
                        {f.children && (
                          <button
                            className="field-toggle"
                            aria-label="Expand frame control bits"
                            aria-expanded={details}
                            onClick={() => setDetails(!details)}
                          >
                            {details ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                          </button>
                        )}
                        {row(f)}
                      </div>
                      {details && f.children?.map((c) => row(c, true))}
                    </div>
                  ))}
            </div>
            <div className="hex-panel">
              <div className="hex-heading">
                <span>
                  RAW BYTES <span className="muted">/ HEX</span>
                </span>
                <button
                  className="icon-button"
                  title="Copy frame bytes"
                  aria-label="Copy frame bytes"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(frame.bytes.map((n) => hex(n)).join(' '))
                      .then(() => onNotice('Frame bytes copied'))
                      .catch(() => onNotice('Clipboard unavailable'));
                  }}
                >
                  <Copy size={13} />
                </button>
              </div>
              <div className="hex-columns">
                <span>OFFSET</span>
                <span>00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F</span>
              </div>
              {Array.from({ length: Math.ceil(frame.bytes.length / 16) }, (_, r) => (
                <div className="hex-row" key={r}>
                  <span className="hex-offset">{hex(r * 16, 4)}</span>
                  <div>
                    {frame.bytes.slice(r * 16, r * 16 + 16).map((n, c) => {
                      const i = r * 16 + c,
                        f = all
                          .filter(
                            (f) => f.mapped !== false && i >= f.offset && i < f.offset + f.length,
                          )
                          .at(-1),
                        selected =
                          selectedRange &&
                          i >= selectedRange.offset &&
                          i < selectedRange.offset + selectedRange.length;
                      return (
                        <button
                          key={i}
                          className={`hex-byte ${f?.layer ?? ''} ${selected ? 'selected' : ''}`}
                          aria-label={`Byte ${i}: ${hex(n)}`}
                          onClick={() => f && select(f.id)}
                        >
                          {hex(n)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="field-detail">
                {active ? (
                  <>
                    <span className={`layer-dot ${active.layer}`} />
                    <strong>{active.name}</strong>
                    <span>
                      {active.mapped === false
                        ? 'Generated / derived field · no verified byte range'
                        : `Offset ${active.offset} · ${active.length} ${active.length === 1 ? 'byte' : 'bytes'}`}
                    </span>
                    <code className={active.layer === 'check' ? `checksum-${frame.integrity}` : ''}>
                      {active.value}
                    </code>
                  </>
                ) : (
                  <span>Select a field or byte to explore the frame.</span>
                )}
              </div>
              {active?.text?.map((text, i) => (
                <button
                  key={i}
                  className="text-preview"
                  onClick={() => setTextRange(text)}
                  title="Highlight these text bytes"
                >
                  <span>
                    {text.inferred ? 'Possible UTF-8 text' : 'UTF-8 text'} · {text.length} bytes
                  </span>
                  <code>{JSON.stringify(text.value)}</code>
                </button>
              ))}
              {frame.warnings.length > 0 && (
                <div className="decode-warning">
                  <LockKeyhole size={12} />
                  {frame.warnings.join(' ')}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function DecodedField({
  field,
  row,
  depth = 0,
}: {
  field: Field;
  row: (field: Field, child?: boolean) => React.ReactNode;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <div className="decoded-field">
      <div className="field-with-toggle" style={{ paddingLeft: Math.min(depth, 8) * 10 }}>
        {field.children?.length ? (
          <button
            className="field-toggle"
            aria-label={`Expand ${field.name}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        ) : null}
        {row(field)}
      </div>
      {open &&
        field.children?.map((f) => (
          <DecodedField key={f.id} field={f} row={row} depth={depth + 1} />
        ))}
    </div>
  );
}
