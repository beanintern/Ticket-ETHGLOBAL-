// Whether to animate. Follows the device's reduce-motion setting, unless overridden in this
// browser (TEMPORARY testing switch in the header: "Motion").
export type MotionPref = 'system' | 'on' | 'off';

const KEY = 'ticket.motion';
const query = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

let pref: MotionPref = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'on' || v === 'off' ? v : 'system';
  } catch {
    return 'system';
  }
})();

/** Whether the device asks for reduced motion. */
export const systemReducesMotion = () => !!query?.matches;

export const motionPref = () => pref;

/** Whether to skip animations now. */
export const reduceMotion = () => (pref === 'system' ? systemReducesMotion() : pref === 'off');

/** CSS follows the same switch: `html.reduce-motion`. */
export function applyMotionClass() {
  document.documentElement.classList.toggle('reduce-motion', reduceMotion());
}

export function setMotionPref(p: MotionPref) {
  pref = p;
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* for this visit only */
  }
  applyMotionClass();
}

query?.addEventListener?.('change', applyMotionClass);
