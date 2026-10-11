import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const OPEN_EVENT = "zgis:header-menu-open";

export default function HeaderMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttons = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(
        ".menu-items button:not(:disabled)",
      ) ?? [],
    );
  const close = (restoreFocus = false) => {
    if (restoreFocus) ref.current?.querySelector("summary")?.focus();
    setOpen(false);
  };
  const show = (last = false) => {
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    setOpen(true);
    requestAnimationFrame(() => {
      if (!ref.current?.open) return;
      const items = buttons();
      (last ? items.at(-1) : items[0])?.focus();
    });
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const other = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener(OPEN_EVENT, other);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener(OPEN_EVENT, other);
    };
  }, [id]);
  return (
    <details
      ref={ref}
      className="header-menu"
      open={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        if (!open) {
          show(event.key === "ArrowUp" || event.key === "End");
          return;
        }
        const items = buttons();
        const current = items.findIndex(
          (item) => item === document.activeElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? (current + 1) % items.length
                : current < 0
                  ? items.length - 1
                  : (current - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      <summary
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.preventDefault();
          if (open) close(true);
          else show();
        }}
      >
        {label}
      </summary>
      <div
        id={id}
        className="menu-items"
        onClick={(event) => {
          if ((event.target as Element).closest("button:not(:disabled)"))
            close(true);
        }}
      >
        {children}
      </div>
    </details>
  );
}
