// What Find signals found, by protocol, for the answer-first summary: only
// what a decoder confirmed (valid frames; for GPS, satellites in bit sync),
// never energy alone.
import type { DiscoveryState } from './discovery';
import type { DiscoveryTarget } from './sweep';
import type { SurveyResult, SurveyTarget } from './forensics';
import { networkName } from './plmn';
import type { GpsSatellite } from './types';

export interface Finding {
  key: string;
  title: string;
  detail: string;
  /** Reopens this tuning in Live analysis; also the decoder tuning's result. */
  target: SurveyResult;
}
export interface FindingGroup {
  protocol: string;
  label: string;
  summary: string;
  items: Finding[];
  satellites?: GpsSatellite[];
}
export interface Findings {
  groups: FindingGroup[];
  /** Protocols listened for, nothing confirmed, every tuning finished. */
  absent: { protocol: string; label: string; tunings: number }[];
}

const labels: Record<string, string> = {
  lte: 'LTE',
  wifi: 'Wi-Fi',
  ble: 'Bluetooth LE',
  gps: 'GPS',
  zigbee: 'Zigbee / 802.15.4',
  lora: 'LoRa',
};
const order = ['lte', 'wifi', 'ble', 'gps', 'zigbee', 'lora'];
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A GPS tuning counts once a satellite holds bit sync: its 50 bit/s data
 * edges line up over many bits, which noise does not do. */
export const gpsLocked = (row: Pick<SurveyResult, 'satellites'>) =>
  !!row.satellites?.some((s) => s.tracking && s.bitSync);
export const confirms = (row: SurveyResult) =>
  row.valid > 0 || (row.config.decoder === 'gps' && gpsLocked(row));

export function surveyTarget(t: DiscoveryTarget, bandwidth = 2): SurveyTarget {
  return {
    id: t.id,
    label: t.candidate.label,
    protocol: t.candidate.protocol,
    config: t.config,
    dwell: t.dwell,
    bandwidth,
    lteBand: t.candidate.lteBand,
  };
}

function names(list: Record<string, { name?: string; frames: number }> | undefined, max = 4) {
  // Named networks and devices first (a person recognises those), then by
  // how often each was heard; unnamed ones show their address.
  const entries = Object.entries(list ?? {}).sort(
    (a, b) => Number(!a[1].name) - Number(!b[1].name) || b[1].frames - a[1].frames,
  );
  const shown = entries.slice(0, max).map(([id, v]) => v.name ?? id);
  return entries.length > max
    ? `${shown.join(', ')} +${entries.length - max} more`
    : shown.join(', ');
}

function cells(row: SurveyResult) {
  return row.cells
    .map((pci) => {
      const q = row.cellQuality?.[pci],
        network = row.cellNetworks?.[pci];
      const parts = [
        ...(network ? [network.plmns.map(networkName).join(' + ')] : []),
        ...(q ? [`SNR ${q.snrDb.toFixed(0)} dB`] : []),
      ];
      return parts.length ? `PCI ${pci} (${parts.join(', ')})` : `PCI ${pci}`;
    })
    .join(' · ');
}
/** The primary network of every cell found, by name, most cells first. */
export function lteOperators(rows: SurveyResult[]) {
  const count = new Map<string, number>();
  for (const row of rows)
    for (const network of Object.values(row.cellNetworks ?? {})) {
      const name = networkName(network.plmns[0]).replace(/ \(.*\)$/, '');
      count.set(name, (count.get(name) ?? 0) + 1);
    }
  return [...count].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

export function findings(state: DiscoveryState): Findings {
  const byProtocol = new Map<string, SurveyResult[]>();
  for (const t of state.targets) {
    const row = state.results.get(t.id);
    const list = byProtocol.get(t.candidate.protocol) ?? [];
    if (row) list.push(row);
    byProtocol.set(t.candidate.protocol, list);
  }
  const groups: FindingGroup[] = [],
    absent: Findings['absent'] = [];
  const protocols = [...byProtocol.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  for (const protocol of protocols) {
    const rows = byProtocol.get(protocol)!,
      found = rows.filter(confirms).sort((a, b) => a.config.frequency - b.config.frequency),
      label = labels[protocol] ?? protocol.toUpperCase();
    if (!found.length) {
      const tunings = state.targets.filter((t) => t.candidate.protocol === protocol).length;
      if (
        state.phase === 'complete' &&
        rows.length === tunings &&
        rows.every((r) => r.state === 'complete')
      )
        absent.push({ protocol, label, tunings });
      continue;
    }
    const items: Finding[] = found.map((row) => {
      const frames = plural(row.valid, 'valid frame');
      const mhz = `${row.config.frequency.toFixed(row.config.frequency % 1 ? 3 : 1)} MHz`;
      switch (protocol) {
        case 'lte':
          return {
            key: row.id,
            title: `${row.lteBand ? `Band ${row.lteBand} · ` : ''}${row.config.frequency.toFixed(1)} MHz`,
            detail: row.cells.length ? cells(row) : frames,
            target: row,
          };
        case 'wifi': {
          const networks = Object.keys(row.networks ?? {}).length;
          return {
            key: row.id,
            title: `${row.label.replace(/^Wi-Fi /, '')} · ${mhz}`,
            detail: networks
              ? `${plural(networks, 'network')}: ${names(row.networks)}`
              : `${frames}, no beacon heard`,
            target: row,
          };
        }
        case 'ble': {
          const devices = Object.keys(row.devices ?? {}).length;
          return {
            key: row.id,
            title: `${row.label.replace(/^BLE · /, '')} · ${mhz}`,
            detail: devices ? `${plural(devices, 'advertiser')}: ${names(row.devices)}` : frames,
            target: row,
          };
        }
        case 'gps': {
          const locked = (row.satellites ?? []).filter((s) => s.tracking && s.bitSync);
          return {
            key: row.id,
            title: 'L1 C/A · 1575.42 MHz',
            detail: `${plural(locked.length, 'satellite')} in bit sync${
              row.valid ? ` · ${plural(row.valid, 'navigation subframe')}` : ''
            }`,
            target: row,
          };
        }
        default:
          return {
            key: row.id,
            // "Zigbee / 802.15.4 · CH 21" under the Zigbee heading: just the channel.
            title: `${row.label.startsWith(`${label} · `) ? row.label.slice(label.length + 3) : row.label} · ${mhz}`,
            detail: frames,
            target: row,
          };
      }
    });
    let summary: string;
    if (protocol === 'lte') {
      const pcis = new Set(found.flatMap((r) => r.cells));
      const networks = lteOperators(found);
      summary = `${plural(found.length, 'carrier')} · ${plural(pcis.size, 'cell')}${
        networks.length ? ` · ${networks.join(', ')}` : ''
      }`;
    } else if (protocol === 'wifi') {
      const networks = new Set(found.flatMap((r) => Object.keys(r.networks ?? {})));
      summary = `${plural(found.length, 'channel')} · ${plural(networks.size, 'network')}`;
    } else if (protocol === 'ble') {
      const devices = new Set(found.flatMap((r) => Object.keys(r.devices ?? {})));
      summary = plural(devices.size, 'advertiser');
    } else if (protocol === 'gps') {
      const prns = new Set(
        found.flatMap((r) =>
          (r.satellites ?? []).filter((s) => s.tracking && s.bitSync).map((s) => s.prn),
        ),
      );
      summary = plural(prns.size, 'satellite');
    } else summary = plural(found.length, 'channel');
    groups.push({
      protocol,
      label,
      summary,
      items,
      satellites: protocol === 'gps' ? found.at(-1)?.satellites : undefined,
    });
  }
  return { groups, absent };
}
