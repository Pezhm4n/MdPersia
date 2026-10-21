import React, { useCallback, useRef, useState } from 'react';

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Fixed-position tooltip: panels clip their content with overflow-hidden,
 * so an absolutely positioned tip inside the trigger would be cut off.
 */
export const Tooltip: React.FC<TooltipProps> = ({ label, children, className }) => {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setCoords({ top: r.top - 8, left: r.left + r.width / 2 });
    }, 120);
  }, []);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setCoords(null);
  }, []);

  return (
    <span
      data-tip-host
      className={`inline-flex ${className ?? ''}`}
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={hide}
      onFocus={(e) => show(e.currentTarget)}
      onBlur={hide}
    >
      {children}
      {coords && (
        <span
          role="tooltip"
          className="tip"
          style={{ top: coords.top, left: coords.left, transform: 'translate(-50%, -100%)' }}
        >
          {label}
        </span>
      )}
    </span>
  );
};
