import { useEffect, useRef } from 'react';

type Mode = 'easy' | 'pro';

/**
 * Asked once, on a first visit: the simple prediction-style view, or the full options ticket.
 * The header's Easy / Pro switch changes it any time after.
 */
export function ModeChooser({ onChoose }: { onChoose: (m: Mode) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    // Escape keeps the default (Pro) and doesn't ask again.
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onChoose('pro');
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onChoose]);
  return (
    <div className="modal-back">
      <div className="modal mode-chooser" role="dialog" aria-modal="true" aria-labelledby="mode-title">
        <div>
          <div className="eyebrow">Welcome to Ticket</div>
          <h2 id="mode-title">How do you want to trade?</h2>
        </div>
        <div className="mode-options">
          <button ref={first} className="mode-option" onClick={() => onChoose('easy')}>
            <div className="mode-art easy" aria-hidden="true">
              <span className="up">4.2×</span>
              <span className="up">2.1×</span>
              <span className="mode-now" />
              <span className="down">1.9×</span>
              <span className="down">3.8×</span>
            </div>
            <b>Easy</b>
            <span>Tap where you think the price will be. See what you'd profit and your chance, then buy in one tap.</span>
          </button>
          <button className="mode-option" onClick={() => onChoose('pro')}>
            <div className="mode-art pro" aria-hidden="true">
              <span />
            </div>
            <b>Pro</b>
            <span>Build any options strategy: calls and puts at any strike and expiry, with a live profit map, greeks and presets.</span>
          </button>
        </div>
        <p className="fine">You can switch any time with Easy / Pro at the top.</p>
      </div>
    </div>
  );
}
