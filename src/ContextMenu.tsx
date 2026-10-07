import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./context-menu.css";

export interface ContextMenuAnchor {
  x: number;
  y: number;
  returnFocus?: HTMLElement | null;
}

export type ContextMenuItem =
  | {
      id: string;
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      shortcut?: string;
      danger?: boolean;
      title?: string;
    }
  | { id: string; separator: true };

interface ContextMenuProps {
  anchor: ContextMenuAnchor;
  label: string;
  items: ContextMenuItem[];
  onClose: () => void;
}

const OPEN_EVENT = "zgis:context-menu-open";
const EDGE = 8;

export default function ContextMenu({
  anchor,
  label,
  items,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const closed = useRef(false);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  function returnFocus() {
    if (anchor.returnFocus?.isConnected) {
      anchor.returnFocus.focus({ preventScroll: true });
    }
  }

  function close(restoreFocus = true) {
    if (closed.current) return;
    closed.current = true;
    if (restoreFocus) returnFocus();
    closeRef.current();
  }

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    closed.current = false;
    const owner = Symbol();

    function restoreFocus() {
      if (anchor.returnFocus?.isConnected) {
        anchor.returnFocus.focus({ preventScroll: true });
      }
    }

    function dismiss(restore = true) {
      if (closed.current) return;
      closed.current = true;
      if (restore) restoreFocus();
      closeRef.current();
    }

    function positionMenu() {
      if (!menu) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      menu.style.maxWidth = `${Math.max(0, width - EDGE * 2)}px`;
      menu.style.maxHeight = `${Math.max(0, height - EDGE * 2)}px`;
      const bounds = menu.getBoundingClientRect();
      const next = {
        left: Math.max(
          left + EDGE,
          Math.min(anchor.x, left + width - bounds.width - EDGE),
        ),
        top: Math.max(
          top + EDGE,
          Math.min(anchor.y, top + height - bounds.height - EDGE),
        ),
      };
      setPosition((previous) =>
        previous.left === next.left && previous.top === next.top
          ? previous
          : next,
      );
    }

    function outsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !menu?.contains(event.target)) {
        dismiss();
      }
    }

    function anotherMenu(event: Event) {
      if ((event as CustomEvent<symbol>).detail !== owner) dismiss(false);
    }

    function viewportChanged() {
      dismiss();
    }

    function outsideScroll(event: Event) {
      if (event.target instanceof Node && menu?.contains(event.target)) return;
      dismiss();
    }

    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: owner }));
    window.addEventListener(OPEN_EVENT, anotherMenu);
    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("scroll", outsideScroll, true);
    window.addEventListener("resize", viewportChanged);
    window.visualViewport?.addEventListener("resize", viewportChanged);
    window.visualViewport?.addEventListener("scroll", viewportChanged);
    const observer = new ResizeObserver(positionMenu);
    observer.observe(menu);
    positionMenu();
    (
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu
    ).focus({
      preventScroll: true,
    });

    return () => {
      window.removeEventListener(OPEN_EVENT, anotherMenu);
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("scroll", outsideScroll, true);
      window.removeEventListener("resize", viewportChanged);
      window.visualViewport?.removeEventListener("resize", viewportChanged);
      window.visualViewport?.removeEventListener("scroll", viewportChanged);
      observer.disconnect();
      if (!closed.current && menu.contains(document.activeElement))
        restoreFocus();
    };
  }, [anchor.x, anchor.y, anchor.returnFocus]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    if (!buttons.length) return;
    const current = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % buttons.length
            : current < 0
              ? buttons.length - 1
              : (current - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  const visibleItems = items.filter(
    (item, index) =>
      !("separator" in item) ||
      (index > 0 &&
        !("separator" in items[index - 1]) &&
        items
          .slice(index + 1)
          .some((following) => !("separator" in following))),
  );

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={position}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {visibleItems.map((item) =>
        "separator" in item ? (
          <hr key={item.id} role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            className={item.danger ? "context-menu-danger" : undefined}
            title={item.title}
            onClick={() => {
              if (item.disabled || closed.current) return;
              close();
              item.onSelect();
            }}
          >
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && (
              <span className="context-menu-shortcut">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>,
    anchor.returnFocus?.closest("dialog[open]") ?? document.body,
  );
}
