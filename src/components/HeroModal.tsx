import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A rectangle on screen, in viewport pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A slightly underdamped spring (damping ratio ~0.8): it settles quickly with a hint of overshoot.
const STIFFNESS = 340;
const DAMPING = 30;
/** How much the page behind shrinks while the modal is up. */
const BEHIND_SCALE = 0.04;
/** And how much it blurs, in px. */
const BEHIND_BLUR = 7;
const REDUCED_MOTION = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A modal that grows out of the element that opened it (a "hero" transition): a coloured surface
 * springs from `origin` to the modal's place while the page behind shrinks a little and frosts
 * over; the content fades in as it lands. Closing flies the surface back to where it came from.
 * `children` are shown only while open.
 */
export function HeroModal({
  open,
  origin,
  tone,
  onClose,
  label,
  children,
}: {
  open: boolean;
  origin: Rect | null;
  /** Colour of the flying surface: green for above, red for below. */
  tone: 'above' | 'below';
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  // Mounted from opening until the closing flight has landed.
  const [mounted, setMounted] = useState(open);
  const panel = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const spring = useRef({ x: 0, v: 0, target: 0, raf: 0, last: 0 });
  const from = useRef<Rect | null>(origin);
  const lastTone = useRef(tone);
  /** Where the panel sat while open: the closing flight starts there (its content is gone by then). */
  const lastTo = useRef<Rect | null>(null);
  if (open) {
    from.current = origin ?? from.current;
    lastTone.current = tone;
  }

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Escape closes, as does a click on the backdrop. One listener for as long as it's open (onClose
  // is often a new function each render, and live prices re-render constantly).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const s = spring.current;
    s.target = open ? 1 : 0;
    const app = document.querySelector<HTMLElement>('.app');
    const paint = () => {
      const p = s.x;
      const r = panel.current?.getBoundingClientRect();
      if (open && r && r.height > 0) lastTo.current = { x: r.left, y: r.top, w: r.width, h: r.height };
      const t = open ? lastTo.current : (lastTo.current ?? (r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null));
      const to = t && { left: t.x, top: t.y, width: t.w, height: t.h };
      // The page behind shrinks towards the middle of the screen, and the box with it.
      const scale = 1 - BEHIND_SCALE * Math.min(1, Math.max(0, p));
      if (app) {
        // Shrunk a little and frosted: blurred, dimmed and a touch desaturated.
        const q = Math.min(1, Math.max(0, p));
        app.style.transform = p > 0.001 ? `scale(${scale})` : '';
        app.style.borderRadius = p > 0.001 ? `${12 * q}px` : '';
        app.style.filter = p > 0.001 ? `blur(${(BEHIND_BLUR * q).toFixed(2)}px) saturate(${1 - 0.25 * q}) brightness(${1 - 0.2 * q})` : '';
      }
      const o = from.current;
      if (to && surface.current) {
        const cx = innerWidth / 2;
        const cy = innerHeight / 2;
        const src = o ? { x: cx + (o.x - cx) * scale, y: cy + (o.y - cy) * scale, w: o.w * scale, h: o.h * scale } : { x: to.left + to.width / 2, y: to.top + to.height / 2, w: 0, h: 0 };
        const lerp = (a: number, b: number) => a + (b - a) * p;
        const st = surface.current.style;
        st.left = `${lerp(src.x, to.left)}px`;
        st.top = `${lerp(src.y, to.top)}px`;
        st.width = `${Math.max(0, lerp(src.w, to.width))}px`;
        st.height = `${Math.max(0, lerp(src.h, to.height))}px`;
        st.borderRadius = `${lerp(4, 14)}px`;
        // Opaque while flying; the panel's own background takes over as it lands.
        st.opacity = `${open ? Math.min(1, p * 3) : Math.min(1, p * 2.5)}`;
      }
      if (back.current) back.current.style.opacity = `${Math.min(1, Math.max(0, p))}`;
      if (panel.current) {
        // Content arrives in the second half of the flight; on closing it's gone at once.
        const c = open ? Math.min(1, Math.max(0, (p - 0.45) / 0.45)) : 0;
        panel.current.style.opacity = `${c}`;
        panel.current.style.transform = `translateY(${(1 - c) * 10}px) scale(${0.985 + 0.015 * c})`;
      }
    };
    if (REDUCED_MOTION) {
      s.x = s.target;
      s.v = 0;
      paint();
      if (!open) setMounted(false);
      return;
    }
    const step = (t: number) => {
      const dt = Math.min(0.032, (t - (s.last || t)) / 1000);
      s.last = t;
      // Semi-implicit Euler in small substeps: stable for this stiffness.
      for (let k = 0; k < 4; k++) {
        const h = dt / 4;
        s.v += (STIFFNESS * (s.target - s.x) - DAMPING * s.v) * h;
        s.x += s.v * h;
      }
      paint();
      // Fully open: the page behind is frozen (see Chart), so blurring it costs nothing per frame.
      document.documentElement.classList.toggle('hero-open', open && s.x > 0.98);
      const settled = Math.abs(s.target - s.x) < 0.001 && Math.abs(s.v) < 0.01;
      if (settled) {
        s.x = s.target;
        s.v = 0;
        s.last = 0;
        paint();
        if (!open) {
          if (app) {
            app.style.transform = '';
            app.style.borderRadius = '';
            app.style.filter = '';
          }
          setMounted(false);
        }
        return;
      }
      s.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(s.raf);
    // Closing: the page behind comes back to life at once, so it's current as it unblurs.
    if (!open) document.documentElement.classList.remove('hero-open');
    s.last = 0;
    s.raf = requestAnimationFrame(step);
    if (open) panel.current?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(s.raf);
  }, [open, mounted]);

  // Leaving the page with it open: put the page back.
  useEffect(
    () => () => {
      document.documentElement.classList.remove('hero-open');
      const app = document.querySelector<HTMLElement>('.app');
      if (app) {
        app.style.transform = '';
        app.style.borderRadius = '';
        app.style.filter = '';
      }
    },
    [],
  );

  if (!mounted) return null;
  return createPortal(
    <div className={`hero ${open ? 'is-open' : 'is-closing'}`}>
      <div className="hero-back" ref={back} onMouseDown={() => open && onClose()} />
      <div className={`hero-surface ${lastTone.current}`} ref={surface} aria-hidden="true" />
      <div className="hero-panel" ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {open ? children : null}
      </div>
    </div>,
    document.body,
  );
}
