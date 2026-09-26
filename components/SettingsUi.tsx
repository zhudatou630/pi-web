"use client";

import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";

type ConfigButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ConfigButtonSize = "small" | "default";

interface ConfigPanelShellProps {
  embedded: boolean;
  title: string;
  subtitle?: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  height?: string;
}

export function ConfigPanelShell({
  embedded,
  title,
  subtitle,
  closeLabel = "Close",
  onClose,
  children,
  width = 900,
  height = "78vh",
}: ConfigPanelShellProps) {
  const panelStyle = embedded
    ? undefined
    : ({
        "--config-panel-width": `${width}px`,
        "--config-panel-height": height,
      } as CSSProperties);

  return (
    <div
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label={title}
      className={`config-panel-root ${embedded ? "is-embedded" : "is-modal"}`}
      onClick={(event) => {
        if (!embedded && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="config-panel-surface" style={panelStyle}>
        {!embedded && (
          <div className="config-panel-header">
            <strong className="config-panel-title">{title}</strong>
            {subtitle && (
              <span className="config-panel-subtitle" title={subtitle}>
                {subtitle}
              </span>
            )}
            <button
              type="button"
              className="config-close-button"
              onClick={onClose}
              title={closeLabel}
              aria-label={closeLabel}
            >
              ×
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function ConfigDetailHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={["config-detail-header", className].filter(Boolean).join(" ")}
    />
  );
}

export function ConfigDetailHeaderInfo({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={["config-detail-header-info", className].filter(Boolean).join(" ")}
    />
  );
}

export function ConfigDetailActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={["config-detail-actions", className].filter(Boolean).join(" ")}
    />
  );
}

export function ConfigField({ label, children, style }: { label: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="config-field" style={style}>
      <span className="config-field-label">{label}</span>
      {children}
    </div>
  );
}

export function ConfigEmptyState({ children }: { children: ReactNode }) {
  return <div className="config-empty-state">{children}</div>;
}

/** The one wait indicator for settings pages. It stays invisible for 400ms, so a
    fast load reads as part of the page appearing instead of a loading step. */
export function SettingsLoading({ label }: { label: string }) {
  return <p role="status" className="settings-loading"><span>{label}</span></p>;
}

export function ConfigFooter({ status, children }: { status?: ReactNode; children?: ReactNode }) {
  return (
    <footer className="config-footer">
      <div className="config-footer-status">{status}</div>
      <div className="config-footer-actions">{children}</div>
    </footer>
  );
}

/** A titled group of setting rows; the page template every settings section follows. */
export function SettingsGroup({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      {(title || action) && (
        <div className="settings-group-header">
          {title && <h3 className="settings-group-title">{title}</h3>}
          {action}
        </div>
      )}
      <div className="settings-group-rows">{children}</div>
    </section>
  );
}

/** Label and one-line explanation on the left, the control on the right.
    `stacked` puts a wide control (segmented, slider) under the copy on narrow screens. */
export function SettingsRow({ label, description, htmlFor, stacked = false, title, children }: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  stacked?: boolean;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`settings-row${stacked ? " is-stacked" : ""}`} title={title}>
      <div className="settings-row-copy">
        {htmlFor ? <label htmlFor={htmlFor} className="settings-row-label">{label}</label> : <span className="settings-row-label">{label}</span>}
        {description && <p className="settings-row-description">{description}</p>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** A list row that opens its item: the copy is the button, controls stay on the right. */
export function SettingsLinkRow({ label, description, muted = false, title, onOpen, children }: {
  label: ReactNode;
  description?: ReactNode;
  muted?: boolean;
  title?: string;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row is-link">
      <button type="button" className="settings-row-copy settings-row-open" title={title} onClick={onOpen}>
        <span className={`settings-row-label${muted ? " is-dim" : ""}`}>{label}</span>
        {description && <span className="settings-row-description is-clamped">{description}</span>}
      </button>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

/** Returns from an item page to its list. The phone sheet header drives it instead. */
export function SettingsBackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" data-settings-back className="settings-back-link" onClick={onClick}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      {label}
    </button>
  );
}

/** Filters a list page. */
export function SettingsSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="settings-search-field">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

/** Group title with a quiet count, e.g. "Global 14". */
export function CountedTitle({ label, count }: { label: ReactNode; count: number }) {
  return <>{label}<span className="settings-group-count">{count}</span></>;
}

/** Detail page for one list item: title, a meta line (scope, path), then groups. */
export function SettingsDetailPage({ title, meta, description, children }: {
  title: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-detail-page">
      <header className="settings-detail-header">
        <h2 className="settings-detail-title">{title}</h2>
        {meta && <div className="settings-detail-meta">{meta}</div>}
        {description && <p className="settings-detail-description">{description}</p>}
      </header>
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** A small single-choice switcher (scope, theme-like choices). */
export function SettingsSegmented<T extends string>({ label, options, value, onChange, disabled = false }: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="settings-segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className="settings-segmented-option"
          disabled={disabled || option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Read-only facts as label/value pairs. */
export function SettingsProperties({ children }: { children: ReactNode }) {
  return <dl className="settings-properties">{children}</dl>;
}

export function SettingsProperty({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function ConfigButton({
  variant = "secondary",
  size = "default",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ConfigButtonVariant; size?: ConfigButtonSize }) {
  return (
    <button
      type="button"
      {...props}
      className={[
        "config-button",
        `config-button-${variant}`,
        `config-button-${size}`,
        className,
      ].filter(Boolean).join(" ")}
    >
      {children}
    </button>
  );
}

export function ConfigSwitch({ checked, disabled = false, loading = false, label, onChange }: { checked: boolean; disabled?: boolean; loading?: boolean; label: string; onChange: (checked: boolean) => void }) {
  const inactive = disabled || loading;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={loading || undefined}
      aria-label={label}
      title={label}
      disabled={inactive}
      className={`config-switch${loading ? " is-loading" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="config-switch-knob" aria-hidden="true" />
    </button>
  );
}

/** Marks a list item that needs attention. Enabled/disabled is shown by text tone, not a dot. */
export function ConfigStatusDot({ tone, title }: { tone: "warning" | "danger"; title?: string }) {
  return <span role="img" aria-label={title} title={title} className={`config-status-dot is-${tone}`} />;
}
