import { useEffect, useRef, useState } from 'react';
import { referralCode, referralLink, siteUrl } from '../lib/referral';
import { CARD_H, CARD_W, drawShareCard, multipleText, shareText, targetText, type ShareData } from '../lib/shareCard';

const SIZE_KEY = 'ticket.share.size';
const REF_KEY = 'ticket.share.ref';
const remembered = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const remember = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* for this visit only */
  }
};

/**
 * After a trade: a card to share, with the multiple, the target and the date up front. The size
 * is optional (off unless chosen), and so is the referral link (on unless turned off).
 */
export function ShareTrade({ data, onClose }: { data: ShareData; onClose: () => void }) {
  const [showSize, setShowSize] = useState(() => remembered(SIZE_KEY, false));
  const [withRef, setWithRef] = useState(() => remembered(REF_KEY, true));
  const [note, setNote] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const link = withRef ? referralLink() : `${siteUrl()}/`;
  const text = shareText(data);
  const fileName = `ticket-${data.asset}-${data.dir}-${String(data.level).replace('.', '_')}.png`.toLowerCase();

  useEffect(() => {
    if (canvas.current) void drawShareCard(canvas.current, data, { showSize, link: withRef ? referralLink() : null });
  }, [data, showSize, withRef]);

  // One Escape listener while open (onClose is a new function on every live-price render).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote((n) => (n === msg ? null : n)), 2200);
  };
  const blob = () =>
    new Promise<Blob | null>((res) => {
      if (canvas.current) canvas.current.toBlob(res, 'image/png');
      else res(null);
    });

  const download = async () => {
    const b = await blob();
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('Image saved');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${link}`);
      flash('Copied');
    } catch {
      flash('Couldn’t copy: select the link below instead');
    }
  };
  const nativeShare = async () => {
    const b = await blob();
    const file = b ? new File([b], fileName, { type: 'image/png' }) : null;
    const withFile = file && navigator.canShare?.({ files: [file] }) ? { files: [file] } : {};
    try {
      await navigator.share({ title: 'My Ticket trade', text, url: link, ...withFile });
    } catch {
      /* closed the share sheet */
    }
  };
  const postX = () => {
    const u = new URL('https://twitter.com/intent/tweet');
    u.searchParams.set('text', text);
    u.searchParams.set('url', link);
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="modal-back share-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="modal-head">
          <div>
            <div className="eyebrow">Trade placed</div>
            <h2 id="share-title">Share it</h2>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <canvas
          ref={canvas}
          className="share-card"
          width={CARD_W}
          height={CARD_H}
          role="img"
          aria-label={`${multipleText(data.multiple)} if ${targetText(data)}, share card`}
        />
        <div className="share-options">
          <label className="switch">
            <input
              type="checkbox"
              checked={showSize}
              onChange={(e) => {
                setShowSize(e.target.checked);
                remember(SIZE_KEY, e.target.checked);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span>Show how much I put in</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={withRef}
              onChange={(e) => {
                setWithRef(e.target.checked);
                remember(REF_KEY, e.target.checked);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span>Include my referral link</span>
          </label>
        </div>
        <div className="share-actions">
          {typeof navigator.share === 'function' && (
            <button className="primary" onClick={() => void nativeShare()}>
              Share…
            </button>
          )}
          <button className={typeof navigator.share === 'function' ? 'ghost' : 'primary'} onClick={postX}>
            Post on X
          </button>
          <button className="ghost" onClick={() => void download()}>
            Download image
          </button>
          <button className="ghost" onClick={() => void copy()}>
            Copy link
          </button>
        </div>
        <p className="fine share-link">
          {withRef ? (
            <>
              Your referral link: <span className="num">{link}</span> (code {referralCode()}). Referral rewards are coming soon.
            </>
          ) : (
            <>Shares link to {link} without your referral code.</>
          )}
          {note && <b className="share-note"> {note}</b>}
        </p>
      </div>
    </div>
  );
}
