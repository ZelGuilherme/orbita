import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

export const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  tipPos?: 'top' | 'bottom' | 'right' | 'left';
};

export function IconButton({ label, active, tipPos, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={label}
      data-tip-pos={tipPos}
      className={cx('icon-btn', active && 'is-active', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  bodyClass?: string;
}

export function Modal({ title, onClose, children, footer, wide, bodyClass }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cx('modal', wide && 'modal--wide')} role="dialog" aria-modal="true">
        {title && (
          <header className="modal__header">
            <h2>{title}</h2>
            <button type="button" className="modal__close" onClick={onClose} aria-label="Fechar">
              <X size={20} />
            </button>
          </header>
        )}
        <div className={cx('modal__body', bodyClass)}>{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="switch-row">
      <span>
        <span className="switch-row__label">{label}</span>
        {hint && <span className="switch-row__hint">{hint}</span>}
      </span>
      <span className={cx('switch', checked && 'is-on')}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch__knob" />
      </span>
    </label>
  );
}

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

/** Vídeo de um MediaStream (sempre mudo: o som toca pelo AudioRenderer). */
export function VideoEl({
  stream,
  mirror,
  contain,
  videoRef,
}: {
  stream: MediaStream;
  mirror?: boolean;
  contain?: boolean;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => {});
  }, [stream, ref]);
  return <video ref={ref} className={cx('video', mirror && 'is-mirror', contain && 'is-contain')} autoPlay playsInline muted />;
}
