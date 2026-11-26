import { useEffect, useState } from 'react';
import type { ZigbeeKeyState } from '../lib/types';
// The Zigbee 3.0 default trust-center link key, the ASCII text
// "ZigBeeAlliance09": public, used by devices joining without an install code.
const ALLIANCE_KEY = '5a6967426565416c6c69616e63653039',
  ALLIANCE_LABEL = 'ZigBeeAlliance09 (default TC link key)';
export default function ZigbeeKeys({ onRevision }: { onRevision(revision: number): void }) {
  const [state, setState] = useState<ZigbeeKeyState | null>(null);
  const [kind, setKind] = useState<'network' | 'link'>('network');
  const [source, setSource] = useState<'key' | 'install'>('key');
  const fromInstallCode = kind === 'link' && source === 'install';
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void window.zigbeeKeys
      ?.list()
      .then((value) => {
        if (!cancelled) setState(value);
      })
      .catch(() => {
        if (!cancelled) setError('Key settings could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!window.zigbeeKeys) return null;
  const change = async (action: () => Promise<ZigbeeKeyState>) => {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      setState(next);
      onRevision(next.revision);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Key settings could not be updated.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="zigbee-keys">
      <summary>
        Zigbee keys <span>{state?.keys.length ?? 0}</span>
      </summary>
      <p className="tuning-note">
        {state?.storage === 'os-protected'
          ? 'Saved with OS protection.'
          : state?.notice || 'Loading key settings…'}
      </p>
      {state?.notice && state.storage === 'os-protected' && (
        <p className="tuning-note">{state.notice}</p>
      )}
      {state?.keys.map((key) => (
        <div className="zigbee-key-entry" key={key.id}>
          <span title={key.label}>{key.label}</span>
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove key ${key.label}`}
            onClick={() => void change(() => window.zigbeeKeys!.remove(key.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <form
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget,
            data = new FormData(form);
          const key = String(data.get('key') ?? '');
          // Clear the password element immediately, including failed submissions.
          (form.elements.namedItem('key') as HTMLInputElement).value = '';
          const pan = String(data.get('pan') ?? '').trim(),
            source = String(data.get('source') ?? '').trim(),
            sequence = String(data.get('sequence') ?? '').trim();
          void change(() =>
            window.zigbeeKeys!.add({
              label: String(data.get('label') ?? ''),
              kind,
              ...(fromInstallCode ? { installCode: key } : { key }),
              ...(pan ? { panId: parseInt(pan, 16) } : {}),
              ...(source ? { sourceEui64: source } : {}),
              ...(kind === 'network' && sequence ? { keySequence: Number(sequence) } : {}),
            }),
          );
        }}
      >
        <fieldset disabled={busy || !state}>
          <label className="control-label">
            Label
            <input
              name="label"
              aria-label="Zigbee key label"
              required
              maxLength={64}
              placeholder="Office network"
            />
          </label>
          <label className="control-label">
            Key type
            <select
              aria-label="Zigbee key type"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="network">Network</option>
              <option value="link">Link / trust center</option>
            </select>
          </label>
          {kind === 'link' && (
            <label className="control-label">
              Link key from
              <select
                aria-label="Zigbee link key source"
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
              >
                <option value="key">AES-128 key</option>
                <option value="install">Install code</option>
              </select>
            </label>
          )}
          {fromInstallCode ? (
            <label className="control-label">
              Install code with CRC
              <input
                key="install"
                name="key"
                aria-label="Zigbee install code"
                type="password"
                autoComplete="new-password"
                required
                pattern="[0-9a-fA-F]{16}|[0-9a-fA-F]{20}|[0-9a-fA-F]{28}|[0-9a-fA-F]{36}"
                maxLength={36}
                placeholder="16, 20, 28 or 36 hexadecimal digits"
              />
            </label>
          ) : (
            <label className="control-label">
              AES-128 key
              <input
                key="key"
                name="key"
                aria-label="Zigbee key value"
                type="password"
                autoComplete="new-password"
                required
                pattern="[0-9a-fA-F]{32}"
                minLength={32}
                maxLength={32}
                placeholder="32 hexadecimal digits"
              />
            </label>
          )}
          <div className="zigbee-key-scopes">
            <label className="control-label">
              PAN · hex
              <input
                name="pan"
                aria-label="Zigbee key PAN"
                pattern="[0-9a-fA-F]{1,4}"
                maxLength={4}
                placeholder="Any"
              />
            </label>
            {kind === 'network' && (
              <label className="control-label">
                Sequence
                <input
                  name="sequence"
                  aria-label="Zigbee key sequence"
                  type="number"
                  min={0}
                  max={255}
                  placeholder="Any"
                />
              </label>
            )}
          </div>
          <label className="control-label">
            Sender EUI-64 · hex
            <input
              name="source"
              aria-label="Zigbee key sender"
              pattern="[0-9a-fA-F]{16}"
              maxLength={16}
              placeholder="Any sender"
            />
          </label>
          <button className="secondary-button" type="submit">
            Add key
          </button>
        </fieldset>
      </form>
      <button
        className="secondary-button"
        type="button"
        disabled={busy || !state || state.keys.some((k) => k.label === ALLIANCE_LABEL)}
        title="The public Zigbee 3.0 default trust-center link key, used by devices that join without an install code"
        onClick={() =>
          void change(() =>
            window.zigbeeKeys!.add({
              label: ALLIANCE_LABEL,
              kind: 'link',
              key: ALLIANCE_KEY,
            }),
          )
        }
      >
        Add ZigBeeAlliance09 key
      </button>
      <label className="control-label">
        Security level
        <select
          aria-label="Zigbee security level"
          disabled={busy || !state}
          value={state?.securityLevel ?? 5}
          onChange={(e) => void change(() => window.zigbeeKeys!.setLevel(Number(e.target.value)))}
        >
          <option value={5}>Encryption + MIC32</option>
          <option value={6}>Encryption + MIC64</option>
          <option value={7}>Encryption + MIC128</option>
          <option value={1}>MIC32 only</option>
          <option value={2}>MIC64 only</option>
          <option value={3}>MIC128 only</option>
        </select>
      </label>
      <p className="tuning-note">
        An install code (printed on the device, with its CRC) is checked and turned into the
        device's trust-center link key; the code itself is not stored. Optional restrictions limit
        where a key is used. Key changes update only the selected packet. Captures contain original
        radio bytes.
      </p>
      {error && (
        <p className="tuning-note" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
