import { useEffect, useRef, useState } from 'react';

/**
 * A number that flashes green when it ticks up and red when it ticks down, like an exchange's
 * last price. The flash restarts on every change (the element is re-keyed).
 */
export function TickFlash({ value, children, className = '' }: { value: number; children: React.ReactNode; className?: string }) {
  const prev = useRef(value);
  const [tick, setTick] = useState<{ dir: 'up' | 'down' | null; n: number }>({ dir: null, n: 0 });
  useEffect(() => {
    if (value !== prev.current && Number.isFinite(value) && Number.isFinite(prev.current) && prev.current !== 0) {
      setTick((t) => ({ dir: value > prev.current ? 'up' : 'down', n: t.n + 1 }));
    }
    prev.current = value;
  }, [value]);
  return (
    <span key={tick.n} className={`${className} ${tick.dir ? `tick-${tick.dir}` : ''}`}>
      {children}
    </span>
  );
}
