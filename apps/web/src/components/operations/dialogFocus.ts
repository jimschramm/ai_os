import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'button, a, [href], input, select, textarea, [tabindex="-1"]';

/**
 * The drawer title is the initial focus target, so it has to be in this set.
 * Leaving it at tabindex -1 and then omitting that from the trap lets Shift+Tab leave.
 */
export function useDialogCycle(
  activeKey: string | null,
  panelRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (activeKey === null) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener !== null && opener.isConnected) {
        // The opener is already on screen. Scrolling it into view shifts the page.
        opener.focus({ preventScroll: true });
      }
      return;
    }
    const current = document.activeElement;
    const panel = panelRef.current;
    if (current instanceof HTMLElement && (panel === null || !panel.contains(current))) {
      openerRef.current = current;
    }
    // The title can still be offscreen on the first frame. Don't scroll the shell to chase it.
    initialFocusRef.current?.focus({ preventScroll: true });
  }, [activeKey, initialFocusRef, panelRef]);

  useEffect(() => {
    if (activeKey === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeKey, onClose, panelRef]);
}
