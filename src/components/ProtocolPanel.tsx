import { Children, type ReactNode } from 'react';

/**
 * The one place a protocol's own settings live. Its contents change with
 * the selected protocol; the frame, title and position stay the same so
 * every protocol's options are found in the same spot.
 */
export default function ProtocolPanel({
  protocol,
  address,
  children,
}: {
  /** Short protocol name, shown in the title. */
  protocol: string;
  /** Device-address filter, present for every protocol. */
  address?: {
    value: string;
    placeholder: string;
    onChange: (value: string) => void;
    /** Fills the filter from the selected packet's source; absent without one. */
    fromSelected?: () => void;
  };
  children?: ReactNode;
}) {
  const empty = Children.toArray(children).length === 0;
  return (
    <section className="protocol-panel" aria-label={`${protocol} settings`}>
      <div className="protocol-panel-title">{protocol} settings</div>
      {address && (
        <div className="address-filter">
          <label className="control-label">
            Device address
            <input
              aria-label={`${protocol} device address filter`}
              placeholder={address.placeholder}
              value={address.value}
              onChange={(e) => address.onChange(e.target.value)}
              spellCheck={false}
            />
          </label>
          {address.fromSelected && (
            <button type="button" className="address-filter-button" onClick={address.fromSelected}>
              Selected
            </button>
          )}
          {address.value && (
            <button
              type="button"
              className="address-filter-button"
              aria-label="Clear device address filter"
              onClick={() => address.onChange('')}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {empty ? (
        <p className="protocol-panel-empty">No settings beyond channel and sample rate.</p>
      ) : (
        children
      )}
    </section>
  );
}
