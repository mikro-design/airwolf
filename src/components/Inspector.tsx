import { useEffect, useMemo, useState } from 'react';
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
import { hex, integrityLabel, protocolHeading } from '../lib/decoder';
import { flattenFields } from '../lib/dissection';
import { blePhyLabel } from '../lib/receiver';
import { esbRateLabel } from '../lib/esb';
import { nrBand, nrGscn } from '../lib/nr';
interface Props {
  expanded: boolean;
  onExpand: () => void;
  frame?: Frame;
  loading?: boolean;
  onNotice: (message: string) => void;
  decodeStatus?: string;
  onRetry?: () => void;
  onViewIq?: () => void;
  iqRetrieving?: boolean;
  hideIqLink?: boolean;
}
export default function Inspector({
  expanded,
  onExpand,
  frame,
  loading = false,
  onNotice,
  decodeStatus,
  onRetry,
  onViewIq,
  iqRetrieving,
  hideIqLink = false,
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
  const initiallyExpanded = useMemo(() => {
    const expanded = new Set<string>();
    const queue = fields.map((field) => ({ field, depth: 0 }));
    let visibleRows = fields.length;
    for (let at = 0; at < queue.length; at++) {
      const { field, depth } = queue[at];
      const children = field.children ?? [];
      // ASN.1 containers can hide all useful values below several wrappers.
      // Keep the existing first two levels, then open deeper groups within a
      // modest row budget instead of treating structural depth as relevance.
      if (children.length && (depth < 2 || visibleRows + children.length <= 80)) {
        expanded.add(field.id);
        visibleRows += children.length;
        queue.push(...children.map((child) => ({ field: child, depth: depth + 1 })));
      }
    }
    return expanded;
  }, [fields]);
  const selectedRange = textRange ?? (active?.mapped !== false ? active : undefined);
  const select = (id: string) => {
    setSelected(id);
    setTextRange(null);
  };
  const crcField = (field: Field) =>
    field.layer === 'check' &&
    !/mic|message integrity/i.test(`${field.filter ?? ''} ${field.name}`);
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
        <code className={crcField(f) ? `checksum-${frame?.integrity}` : ''}>
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
          {frame && !hideIqLink && (
            <button
              className="text-button"
              disabled={!onViewIq || iqRetrieving}
              title={
                onViewIq
                  ? 'View the original samples for this frame'
                  : 'Original IQ is unavailable for this frame. Demo and packet-only imports contain bytes only.'
              }
              onClick={onViewIq}
            >
              {iqRetrieving ? 'Loading IQ…' : 'View IQ'}
            </button>
          )}
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
          {frame.dissection?.security?.map((security, index) => (
            <div
              className={`capture-metadata authentication-${security.status}`}
              key={index}
              aria-label={`${security.layer.toUpperCase()} authentication`}
            >
              <strong>
                {security.layer.toUpperCase()} ·{' '}
                {security.status === 'authenticated'
                  ? 'MIC verified'
                  : security.status === 'authentication-failed'
                    ? 'Authentication failed · wrong key or damaged message/MIC'
                    : security.status === 'key-unavailable'
                      ? 'Key unavailable · MIC not verified'
                      : security.status === 'no-matching-key'
                        ? 'No matching key · MIC not verified'
                        : security.status === 'source-unavailable'
                          ? 'Sender EUI-64 unavailable · MIC not verified'
                          : security.status === 'truncated'
                            ? 'Truncated security data · MIC not verified'
                            : 'No authentication'}
              </strong>
              {security.status === 'authenticated' && (
                <span>
                  {' '}
                  · {security.securityLevel >= 5 ? 'Decrypted' : 'Clear authenticated payload'}
                </span>
              )}
            </div>
          ))}
          {frame.origin === 'live' && (
            <div
              className="capture-metadata"
              title={frame.deviceSerial ? `HackRF serial ${frame.deviceSerial}` : undefined}
            >
              {frame.deviceSerial ? `HackRF …${frame.deviceSerial.slice(-8)} · ` : ''}
              {frame.channel !== null ? `Channel ${frame.channel} · ` : ''}
              {frame.wifiRateMbps
                ? `${frame.wifiPhy?.toUpperCase() ?? 'OFDM'} ${Number(frame.wifiRateMbps.toFixed(2))} Mb/s${frame.wifiPreamble ? ` · ${frame.wifiPreamble} preamble` : ''} · `
                : ''}
              {frame.wifiHt
                ? `MCS ${frame.wifiHt.mcs} · ${frame.wifiHt.coding.toUpperCase()} · GI ${frame.wifiHt.guardNs} ns · ${frame.wifiHt.format}${frame.wifiHt.stbc ? ' · STBC' : ''}${frame.wifiHt.aggregateOffset !== undefined ? ` · A-MPDU offset ${frame.wifiHt.aggregateOffset}` : ''} · `
                : ''}
              {frame.gpsPrn !== undefined
                ? `GPS PRN ${frame.gpsPrn} · C/N₀ ${frame.gpsCn0?.toFixed(1)} dB-Hz · Doppler ${frame.gpsDopplerHz?.toFixed(0)} Hz · next TOW ${frame.gpsTow} s · `
                : ''}
              {frame.ltePci !== undefined
                ? `PCI ${frame.ltePci} · ${frame.ltePrb} PRB · ${frame.ltePorts} antenna ports · SFN ${frame.lteSfn} · ${frame.lteTdd ? 'TDD' : 'FDD'} · ${lteQuality(frame)}`
                : ''}
              {frame.nrPci !== undefined ? nrMetadata(frame) : ''}
              {frame.lora
                ? `LoRa SF${frame.lora.spreadingFactor} · ${frame.lora.bandwidth / 1000} kHz · CR 4/${4 + frame.lora.codingRate} · ${frame.lora.inverted ? 'inverted' : 'normal'}${frame.lora.implicitHeader ? ' · implicit header' : ''} · `
                : ''}
              {frame.phy ? `${blePhyLabel(frame.phy)} · ` : ''}
              {frame.dsrcLink
                ? `DSRC ${frame.dsrcLink}${frame.dsrcSubcarrierHz ? ` · ${(frame.dsrcSubcarrierHz / 1e6).toFixed(1)} MHz subcarrier` : ''}${frame.fecErrors ? ` · FCS repair: ${frame.fecErrors === 1 ? '1 weak bit' : `${frame.fecErrors} weak bits`} flipped` : ''} · `
                : ''}
              {frame.esbRate
                ? `ESB ${esbRateLabel(frame.esbRate)}${frame.fecErrors ? ' · 1 bit corrected' : ''} · `
                : ''}
              {frame.bleCteUs !== undefined
                ? `CTE ${frame.bleCteUs} µs · ${frame.bleCteComplete ? 'samples retained' : 'samples incomplete'} · `
                : ''}
              {frame.phy?.startsWith('coded') && frame.fecErrors !== undefined
                ? `FEC symbol differences ${frame.fecErrors} · `
                : ''}
              {frame.captureEpoch !== undefined ? `RX epoch ${frame.captureEpoch} · ` : ''}
              {frame.connectionEvent !== undefined ? `Event ${frame.connectionEvent} · ` : ''}
              {frame.timeUncertaintyUs !== undefined
                ? frame.protocol === 'lte'
                  ? `${frame.lteChannel === 'pcch' ? 'LTE paging acquisition interval' : frame.lteChannel === 'bcch-dl-sch' ? 'LTE acquisition/combining interval' : 'PBCH observation interval'} ${frame.timeUncertaintyUs} µs · `
                  : frame.protocol === 'nr'
                    ? `SS/PBCH block interval ${frame.timeUncertaintyUs} µs · `
                    : `Time ±${frame.timeUncertaintyUs} µs · `
                : ''}
              {frame.frequency?.toFixed(3)} MHz · Samples {frame.firstSample?.toLocaleString()}–
              {frame.endSample?.toLocaleString()} · Approximate host timestamp
            </div>
          )}
          <div className="frame-strip">
            {fields.map((f) => (
              <button
                key={f.id}
                className={`frame-block ${f.layer} ${crcField(f) ? `checksum-${frame.integrity}` : ''} ${selected === f.id ? 'selected' : ''}`}
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
                <code className={crcField(f) ? `checksum-${frame.integrity}` : ''}>
                  {crcField(f) ? integrityLabel(frame) : `${f.length} B`}
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
                  : protocolHeading[frame.protocol]}
                <span className="muted">{frame.bytes.length} bytes</span>
              </button>
              {open && frame.dissection
                ? fields.map((f) => (
                    <DecodedField
                      key={`${frame?.id}:${frame?.time}:${f.id}`}
                      field={f}
                      row={row}
                      initiallyExpanded={initiallyExpanded}
                    />
                  ))
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
                {active?.provenance && active.provenance !== 'captured' && (
                  <span className="field-provenance" aria-label="Field provenance">
                    {active.provenance === 'decrypted'
                      ? 'Decrypted data · no captured-byte range'
                      : active.provenance === 'reassembled'
                        ? 'Reassembled data · no single captured-byte range'
                        : 'Derived metadata · no captured-byte range'}
                  </span>
                )}
                {active ? (
                  <>
                    <span className={`layer-dot ${active.layer}`} />
                    <strong>{active.name}</strong>
                    <span>
                      {active.mapped === false
                        ? 'Generated / derived field · no verified byte range'
                        : `Offset ${active.offset} · ${active.length} ${active.length === 1 ? 'byte' : 'bytes'}`}
                    </span>
                    <code className={crcField(active) ? `checksum-${frame.integrity}` : ''}>
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
  initiallyExpanded,
  depth = 0,
}: {
  field: Field;
  row: (field: Field, child?: boolean) => React.ReactNode;
  initiallyExpanded: ReadonlySet<string>;
  depth?: number;
}) {
  const [open, setOpen] = useState(() => initiallyExpanded.has(field.id));
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
          <DecodedField
            key={f.id}
            field={f}
            row={row}
            initiallyExpanded={initiallyExpanded}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

// The SS/PBCH block a 5G NR MIB came from. SNR and RSRP are measured on its
// PSS/SSS; RSRP is relative to full-scale input (dBFS).
function nrMetadata(frame: Frame) {
  const ssb = frame.nrSsbFrequencyHz ?? 0;
  const band = nrBand(ssb);
  const gscn = nrGscn(ssb);
  return [
    `PCI ${frame.nrPci}`,
    `SSB ${(ssb / 1e6).toFixed(2)} MHz${band ? ` (${band}${gscn !== undefined ? `, GSCN ${gscn}` : ''})` : ''}`,
    `${frame.nrScsKhz} kHz SSB`,
    `block ${frame.nrSsbIndex}`,
    `SFN ${frame.nrSfn} · half frame ${frame.nrHalfFrame ? 1 : 0}`,
    `kSSB ${frame.nrKSsb}`,
    frame.nrSnrDb !== undefined ? `SNR ${frame.nrSnrDb.toFixed(1)} dB` : '',
    frame.nrRsrpDb !== undefined ? `RSRP ${frame.nrRsrpDb.toFixed(1)} dBFS (PSS/SSS)` : '',
    frame.nrContext ? `receiver offset ${(frame.nrContext.cfoHz / 1e3).toFixed(1)} kHz` : '',
  ]
    .filter(Boolean)
    .map((part) => `${part} · `)
    .join('');
}
// Reference-signal measurements of the decoding subframe. RSRP is relative to
// full-scale input (dBFS), so it compares cells only at the same gain.
function lteQuality(frame: {
  lteSnrDb?: number;
  lteRsrpDb?: number;
  lteRsrqDb?: number;
  lteChannel?: string;
}) {
  const parts = [
    frame.lteSnrDb !== undefined ? `SNR ${frame.lteSnrDb.toFixed(1)} dB` : '',
    frame.lteRsrpDb !== undefined ? `RSRP ${frame.lteRsrpDb.toFixed(1)} dBFS` : '',
    frame.lteRsrqDb !== undefined ? `RSRQ ${frame.lteRsrqDb.toFixed(1)} dB` : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  return `${parts.join(' · ')} (${frame.lteChannel === 'bcch-bch' ? 'central 6 PRB' : 'whole cell'}) · `;
}
