import { useEffect, useState } from 'react';
import type { LoRaWanKeyState } from '../lib/types';
// LoRaWAN 1.0.x keys for packet inspection. Key values go to the main process
// and never come back; the list shows labels and device identifiers only.
export default function LoRaWanKeys({ onRevision }: { onRevision(revision: number): void }) {
  const [state, setState] = useState<LoRaWanKeyState | null>(null);
  const [kind, setKind] = useState<'session' | 'root'>('session');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void window.lorawanKeys
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
  if (!window.lorawanKeys) return null;
  const change = async (action: () => Promise<LoRaWanKeyState>) => {
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
  const secret = (name: string, label: string) => (
    <label className="control-label">
      {label}
      <input
        name={name}
        aria-label={`LoRaWAN ${label}`}
        type="password"
        autoComplete="new-password"
        required
        pattern="[0-9a-fA-F]{32}"
        minLength={32}
        maxLength={32}
        placeholder="32 hexadecimal digits"
      />
    </label>
  );
  return (
    <details className="zigbee-keys lorawan-keys">
      <summary>
        LoRaWAN keys <span>{state?.keys.length ?? 0}</span>
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
          <span title={key.label}>
            {key.label} · {key.kind === 'root' ? `DevEUI ${key.devEui}` : `DevAddr ${key.devAddr}`}
          </span>
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove key ${key.label}`}
            onClick={() => void change(() => window.lorawanKeys!.remove(key.id))}
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
          const value = (name: string) => String(data.get(name) ?? '').trim();
          const label = value('label');
          const entry =
            kind === 'root'
              ? { label, kind, devEui: value('devEui'), appKey: value('appKey') }
              : {
                  label,
                  kind,
                  devAddr: value('devAddr'),
                  nwkSKey: value('nwkSKey'),
                  appSKey: value('appSKey'),
                };
          // Clear the password elements immediately, including failed submissions.
          for (const name of ['appKey', 'nwkSKey', 'appSKey']) {
            const input = form.elements.namedItem(name) as HTMLInputElement | null;
            if (input) input.value = '';
          }
          void change(() => window.lorawanKeys!.add(entry));
        }}
      >
        <fieldset disabled={busy || !state}>
          <label className="control-label">
            Label
            <input
              name="label"
              aria-label="LoRaWAN key label"
              required
              maxLength={64}
              placeholder="Field sensor"
            />
          </label>
          <label className="control-label">
            Key type
            <select
              aria-label="LoRaWAN key type"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="session">Session keys (data frames)</option>
              <option value="root">Root key (join messages)</option>
            </select>
          </label>
          {kind === 'session' ? (
            <>
              <label className="control-label">
                DevAddr · hex
                <input
                  name="devAddr"
                  aria-label="LoRaWAN DevAddr"
                  required
                  pattern="[0-9a-fA-F]{8}"
                  minLength={8}
                  maxLength={8}
                  placeholder="26011BDA"
                />
              </label>
              {secret('nwkSKey', 'NwkSKey')}
              {secret('appSKey', 'AppSKey')}
            </>
          ) : (
            <>
              <label className="control-label">
                DevEUI · hex
                <input
                  name="devEui"
                  aria-label="LoRaWAN DevEUI"
                  required
                  pattern="[0-9a-fA-F]{16}"
                  minLength={16}
                  maxLength={16}
                  placeholder="70B3D57ED0000001"
                />
              </label>
              {secret('appKey', 'AppKey')}
            </>
          )}
          <button className="secondary-button" type="submit">
            Add key
          </button>
        </fieldset>
      </form>
      <p className="tuning-note">
        LoRaWAN 1.0.x. Session keys check the MIC and decrypt data frames from their DevAddr. A root
        key checks join requests and decrypts join accepts from its DevEUI; session keys are not
        derived from captured joins. The MIC check uses the frame counter&apos;s low 16 bits, so it
        fails once a device has sent more than 65,535 frames. Captures contain original radio bytes.
      </p>
      {error && (
        <p className="tuning-note" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
