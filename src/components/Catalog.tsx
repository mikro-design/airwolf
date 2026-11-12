import { Search, ArrowUpRight, X } from 'lucide-react';
import { useState } from 'react';
import { profiles, type Profile } from '../lib/protocols';
export default function Catalog({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (p: Profile) => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal catalog-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">DECODER WORKSPACE</span>
            <h2 id="catalog-title">Protocol catalog</h2>
            <p>Your complete target scope, with implementation status kept explicit.</p>
          </div>
          <button className="icon-button" aria-label="Close catalog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="catalog-note">
          <strong>Implementation status</strong> Experimental live reception covers BLE 1M legacy
          advertisements, 2.4 GHz 802.15.4 O-QPSK, and EnOcean ERP1 ASK / ERP2 FSK. Only BLE has
          been verified on air here. Other PHYs and protocols remain planned. Encrypted payloads
          remain opaque.
        </div>
        <label className="search catalog-search">
          <Search size={15} />
          <input
            autoFocus
            placeholder="Find a standard, PHY, or band…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="catalog-list">
          {profiles
            .filter((p) =>
              `${p.name} ${p.modes} ${p.bands}`.toLowerCase().includes(query.toLowerCase()),
            )
            .map((p) => (
              <article className="protocol-card" key={p.id}>
                <div className="protocol-card-top">
                  <h3>{p.name}</h3>
                  <span className={`readiness ${p.readiness === 'Planned' ? 'planned' : ''}`}>
                    {p.readiness}
                  </span>
                  <button className="text-button" onClick={() => onSelect(p)}>
                    Tune preset <ArrowUpRight size={13} />
                  </button>
                </div>
                <div className="protocol-spec">
                  <span>{p.modes}</span>
                  <span>{p.bands}</span>
                </div>
                <p>{p.note}</p>
                {p.exclusions && <p className="muted">{p.exclusions}</p>}
                <span className="tiny muted">REQUESTED TARGET: {p.target.toUpperCase()}</span>
              </article>
            ))}
        </div>
      </section>
    </div>
  );
}
