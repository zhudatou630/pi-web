"use client";

import { useEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { useI18n } from "@/hooks/useI18n";
import { THINKING_LEVELS } from "@/lib/thinking-levels";
import { serializeHeaderRows, updateHeaderRow, type HeaderRow } from "../models-config-helpers";
import { ConfigButton } from "../SettingsUi";

// ── Inputs ────────────────────────────────────────────────────────────────────

export function TextInput({ value, onChange, placeholder, mono, disabled, id }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; disabled?: boolean; id?: string;
}) {
  return (
    <input
      id={id}
      className={`models-input${mono ? " is-mono" : ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}

export function SecretTextInput({ value, onChange, placeholder, mono, onKeyDown }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div className="models-secret">
      <input
        type={visible ? "text" : "password"}
        className={`models-input${mono ? " is-mono" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="models-secret-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
        title={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
      >
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="number" className="models-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
}

export function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  const { t } = useI18n();
  return (
    <select className="models-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {!required && <option value="">{t("models.useDefault")}</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="models-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <span className="models-hint">{children}</span>;
}

export function Notice({ tone = "info", children, action }: { tone?: "info" | "warning" | "danger" | "success"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`models-notice is-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <div className="models-notice-body">{children}</div>
      {action}
    </div>
  );
}

// ── Header list ───────────────────────────────────────────────────────────────

// Editable key/value request-header list for a provider or model. Rows stay
// local so a blank draft is never persisted as an invalid HTTP header name.
export function HeaderListEditor({ headers, onChange }: {
  headers: Record<string, string> | undefined;
  onChange: (h: Record<string, string> | undefined) => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(headers ?? {}).map(
    ([name, value], id) => ({ id, name, value }),
  ));
  const nextRowIdRef = useRef(rows.length);

  const applyRows = (next: HeaderRow[]): void => {
    setRows(next);
    onChange(serializeHeaderRows(next));
  };
  const setEntry = (id: number, changes: Partial<Pick<HeaderRow, "name" | "value">>): void => {
    applyRows(updateHeaderRow(rows, id, changes));
  };
  const removeEntry = (id: number): void => {
    applyRows(rows.filter((row) => row.id !== id));
  };
  return (
    <div className="models-header-list">
      {rows.map((row) => (
        <div key={row.id} className="models-header-row">
          <input className="models-input is-mono" value={row.name} onChange={(e) => setEntry(row.id, { name: e.target.value })} placeholder="Header-Name" />
          <input className="models-input is-mono" value={row.value} onChange={(e) => setEntry(row.id, { value: e.target.value })} placeholder="value" />
          <button type="button" className="models-icon-button is-danger" onClick={() => removeEntry(row.id)} aria-label={t("i18n.remove")} title={t("i18n.remove")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
      <ConfigButton size="small" className="models-self-start" onClick={() => setRows((current) => [
        ...current,
        { id: nextRowIdRef.current++, name: "", value: "" },
      ])}>
        {t("models.addHeader")}
      </ConfigButton>
    </div>
  );
}

// ── Thinking level map ────────────────────────────────────────────────────────

export function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const { t } = useI18n();
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") delete next[level];
    else next[level] = entry;
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div className="models-thinking-map">
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";

        return (
          <div key={level} className={`models-thinking-row is-${state}`}>
            <span className="models-thinking-level">{level}</span>
            <div className="models-segmented" role="radiogroup" aria-label={level}>
              <button type="button" role="radio" aria-checked={state === "omit"} onClick={() => setLevel(level, "omit")}>
                {t("models.levelDefault")}
              </button>
              <button type="button" role="radio" aria-checked={state === "null"} className="is-danger" onClick={() => setLevel(level, null)}>
                {t("models.levelDisabled")}
              </button>
              <button type="button" role="radio" aria-checked={state === "string"} onClick={() => setLevel(level, strVal || level)}>
                {t("models.levelCustom")}
              </button>
            </div>
            <input
              className="models-input is-mono models-thinking-input"
              value={strVal}
              onChange={(e) => setLevel(level, e.target.value)}
              onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
              placeholder={level}
              maxLength={10}
              aria-label={`${level} ${t("models.levelCustom")}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Dialog shell ──────────────────────────────────────────────────────────────

/** Nested dialog inside Settings. Escape closes only this layer. */
export function ModelsDialog({ title, description, width = 560, onClose, children, footer, header }: {
  title?: string;
  description?: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Replaces the title block, e.g. with a search field. */
  header?: ReactNode;
}) {
  return (
    <div
      className="models-dialog-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="models-dialog" style={{ width }}>
        {header ?? (
          <div className="models-dialog-header">
            <strong>{title}</strong>
            {description && <span>{description}</span>}
          </div>
        )}
        <div className="models-dialog-body">{children}</div>
        {footer && <div className="models-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
