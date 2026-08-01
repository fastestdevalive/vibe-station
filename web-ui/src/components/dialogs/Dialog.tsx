import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const openDialogs: (() => void)[] = [];

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabelledBy?: string;
  /** Extra class on the overlay (e.g. flush padding for a mobile fullscreen dialog). */
  overlayClassName?: string;
  /** Extra class on the card (e.g. a fixed-size variant so the dialog doesn't
   *  resize as its content grows). */
  cardClassName?: string;
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  ariaLabelledBy,
  overlayClassName,
  cardClassName,
}: DialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Per-instance id by default — a hardcoded "dialog-title" would collide
  // (duplicate DOM id) as soon as two Dialogs are open at once (e.g. the
  // Folder Chooser nested inside New Agent), which breaks the accessible-name
  // lookup via aria-labelledby for BOTH dialogs, not just the nested one.
  const generatedTitleId = useId();
  const titleId = ariaLabelledBy ?? generatedTitleId;

  // Keep the latest `onClose` in a ref so the keydown handler can stay
  // permanently stable. Callers commonly pass a new inline `onClose` on every
  // render; if the handler's identity tracked `onClose`, the focus effect below
  // would re-run on every background re-render (e.g. an agent chat streaming
  // output) and yank focus back to the first focusable element mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Keydown listener — attached once per open. Restricts handling to the topmost dialog.
  useEffect(() => {
    if (!open) return undefined;

    const closeFn = () => {
      onCloseRef.current();
    };
    openDialogs.push(closeFn);

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only respond if this is the topmost dialog in the stack
      if (openDialogs[openDialogs.length - 1] !== closeFn) {
        return;
      }

      if (e.key === "Escape") {
        e.stopPropagation();
        closeFn();
      }

      if (e.key === "Tab" && cardRef.current) {
        const focusables = cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const list = [...focusables].filter((el) => !el.hasAttribute("disabled"));
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const idx = openDialogs.indexOf(closeFn);
      if (idx !== -1) {
        openDialogs.splice(idx, 1);
      }
    };
  }, [open]);

  // Focus restore on close
  useEffect(() => {
    if (!open) return undefined;
    const activeElBeforeOpen = document.activeElement as HTMLElement | null;
    return () => {
      if (activeElBeforeOpen && typeof activeElBeforeOpen.focus === "function") {
        setTimeout(() => {
          activeElBeforeOpen.focus();
        }, 0);
      }
    };
  }, [open]);

  // Auto-focus on open — keyed on `open` ONLY so background re-renders never
  // re-steal focus. Target priority: an explicit [data-autofocus] field, else
  // the first non-button form control, else the dialog card itself (a neutral
  // fallback via tabIndex=-1). The Close button is never an auto-focus target.
  useEffect(() => {
    if (!open) return undefined;
    const t = window.setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      const target =
        card.querySelector<HTMLElement>("[data-autofocus]") ??
        card.querySelector<HTMLElement>("input, select, textarea") ??
        card;
      target.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className={overlayClassName ? `dialog-overlay ${overlayClassName}` : "dialog-overlay"}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={cardClassName ? `dialog-card ${cardClassName}` : "dialog-card"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-card__header">
          <span id={titleId}>{title}</span>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-card__body">{children}</div>
        {footer ? <div className="dialog-card__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
