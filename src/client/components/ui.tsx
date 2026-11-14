import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, Clipboard, Loader2, X } from "lucide-react";
import clsx from "clsx";
import { formatCountdown } from "../../shared/format.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "quiet" | "danger" | "accent";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return clsx("btn", `btn-${variant}`, `btn-${size}`, extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
    >
      {loading ? <Loader2 size={15} className="spin" aria-hidden="true" /> : icon}
      <span>{children}</span>
      {!loading && iconRight}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "lime" | "green" | "amber" | "red" | "blue" | "outline";
  className?: string;
}) {
  return <span className={clsx("badge", `badge-${tone}`, className)}>{children}</span>;
}

export function Card({
  children,
  className,
  as: Tag = "div",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={clsx("card", className)} {...props}>
      {children}
    </Tag>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} className="spin" aria-label="Loading" />;
}

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={clsx("skeleton", className)} style={style} aria-hidden="true" />;
}

export function SectionHead({
  eyebrow,
  title,
  action,
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("section-head", className)}>
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h2 className="section-title">{title}</h2>
      </div>
      {action ? <div className="section-action">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  size = "md",
  hideClose,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
  hideClose?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const focusTarget = ref.current?.querySelector<HTMLElement>(
      "input, textarea, button, [href], [tabindex]:not([tabindex='-1'])",
    );
    window.setTimeout(() => focusTarget?.focus(), 40);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={ref}
        className={clsx("modal", `modal-${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Dialog"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {title || !hideClose ? (
          <div className="modal-head">
            {title ? <div className="modal-title">{title}</div> : <span />}
            {!hideClose ? (
              <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
                <X size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ProgressBar({
  value,
  tone = "lime",
  className,
  marker,
}: {
  value: number;
  tone?: "lime" | "amber" | "red" | "blue";
  className?: string;
  marker?: number;
}) {
  return (
    <div className={clsx("progress-track", className)}>
      <div
        className={clsx("progress-fill", `progress-${tone}`)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
      {marker !== undefined ? (
        <span
          className="progress-marker"
          style={{ left: `${Math.max(0, Math.min(100, marker))}%` }}
        />
      ) : null}
    </div>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  className,
  size = 13,
}: {
  text: string;
  label?: string;
  className?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  async function copy(event: React.MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button
      type="button"
      className={clsx("copy-btn", className)}
      onClick={copy}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check size={size} /> : <Clipboard size={size} />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

export function Countdown({
  to,
  className,
  prefix,
}: {
  to: string | number | Date;
  className?: string;
  prefix?: string;
}) {
  const target = new Date(to).getTime();
  const [remaining, setRemaining] = useState(() => Math.max(0, target - Date.now()));
  useEffect(() => {
    setRemaining(Math.max(0, target - Date.now()));
    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, target - Date.now()));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [target]);
  return (
    <span className={clsx("countdown", className)}>
      {prefix ? <span className="countdown-prefix">{prefix}</span> : null}
      <span className="mono">{formatCountdown(remaining / 1000)}</span>
    </span>
  );
}

export function LiveDot({ label = "Live", tone = "lime" }: { label?: string; tone?: "lime" | "red" | "amber" }) {
  return (
    <span className={clsx("live-dot-wrap", `live-${tone}`)}>
      <span className="live-dot" />
      <span>{label}</span>
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ id: T; label: ReactNode; count?: number }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("tabs", className)} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={clsx("tab", active === tab.id && "tab-active")}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "positive" | "negative";
  className?: string;
}) {
  return (
    <div className={clsx("stat", className)}>
      <span className="stat-label">{label}</span>
      <span className={clsx("stat-value mono", tone && `text-${tone}`)}>{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="inline-code">{children}</code>;
}

export function DefinitionList({
  items,
  className,
}: {
  items: Array<{ label: ReactNode; value: ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={clsx("definition-list", className)}>
      {items.map((item, index) => (
        <div className="definition-row" key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UniqueGradient() {
  return useId().replace(/:/g, "");
}
