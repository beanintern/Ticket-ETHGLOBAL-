import { useEffect, useRef, useState } from 'react';

/**
 * A number that flashes green when it ticks up and red when it ticks down, like an exchange's
 * last price. Only a change you can see flashes: `children` is the number as shown, so a move in
 * a decimal it doesn't show doesn't. The flash restarts on every change (the element is re-keyed).
 */
export function TickFlash({ value, children, className = '' }: { value: number; children: string; className?: string }) {
  const prev = useRef({ value, shown: children });
  const [tick, setTick] = useState<{ dir: 'up' | 'down' | null; n: number }>({ dir: null, n: 0 });
  useEffect(() => {
    const p = prev.current;
    if (children !== p.shown && Number.isFinite(value) && Number.isFinite(p.value) && p.value !== 0) {
      setTick((t) => ({ dir: value > p.value ? 'up' : 'down', n: t.n + 1 }));
    }
    // Remember the last shown change, so the direction is against what was last seen.
    if (children !== p.shown) prev.current = { value, shown: children };
  }, [value, children]);
  return (
    <span key={tick.n} className={`${className} ${tick.dir ? `tick-${tick.dir}` : ''}`}>
      {children}
    </span>
  );
}
