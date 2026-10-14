import { useEffect, useRef, useState } from 'react';

/** Schedule cosmetic updates only while the renderer is actually visible.
 * The monitor service continues scanning/alerting independently of this hook.
 */
export function useVisibleInterval(callback: () => void, intervalMs: number, enabled = true): boolean {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' || document.visibilityState !== 'hidden');

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  useEffect(() => {
    if (!visible || !enabled) return;
    callbackRef.current();
    const clock = window.setInterval(() => callbackRef.current(), intervalMs);
    return () => window.clearInterval(clock);
  }, [visible, enabled, intervalMs]);

  return visible;
}
