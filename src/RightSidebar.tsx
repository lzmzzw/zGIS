import { useRef, type ReactNode } from "react";
import "./right-sidebar.css";

export default function RightSidebar({
  hidden,
  label,
  width,
  maxWidth,
  onWidthChange,
  children,
}: {
  hidden: boolean;
  label: string;
  width: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) =>
    Math.max(320, Math.min(maxWidth, Math.round(value)));
  return (
    <div className="right-sidebar" hidden={hidden}>
      <div
        className="right-sidebar-resizer"
        role="separator"
        aria-label={`调整${label}侧栏宽度`}
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          e.preventDefault();
          onWidthChange(
            clamp(
              e.key === "Home"
                ? 320
                : e.key === "End"
                  ? maxWidth
                  : width + (e.key === "ArrowLeft" ? 20 : -20),
            ),
          );
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          drag.current = { x: e.clientX, width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current || !e.currentTarget.hasPointerCapture(e.pointerId))
            return;
          onWidthChange(clamp(drag.current.width + drag.current.x - e.clientX));
        }}
        onPointerUp={(e) => {
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      {children}
    </div>
  );
}
