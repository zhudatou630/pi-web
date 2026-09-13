"use client";

import { useEffect, useState } from "react";
import type { ExtensionWidget } from "@/lib/extension-widget";
import { useI18n } from "@/hooks/useI18n";
import { AnsiText } from "./AnsiText";

export function ExtensionTaskNote({
  widget,
  active = false,
}: {
  widget: ExtensionWidget | null;
  active?: boolean;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const key = widget?.key;

  useEffect(() => {
    setHidden(false);
    setCollapsed(true);
  }, [key]);

  useEffect(() => {
    if (active) setHidden(false);
  }, [active]);

  if (!widget || hidden) return null;

  const lines = collapsed ? widget.lines.slice(0, 1) : widget.lines;

  return (
    <div className="extension-task-note">
      <div className={`extension-task-note-card${collapsed ? " is-collapsed" : ""}`}>
        <button
          type="button"
          className="extension-task-note-icon"
          aria-label={t("i18n.close")}
          onClick={(event) => {
            event.stopPropagation();
            setHidden(true);
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        <pre
          className="extension-task-note-body"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("i18n.expand") : t("i18n.collapse")}
          onClick={() => setCollapsed((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setCollapsed((value) => !value);
            }
          }}
        >
          <AnsiText text={lines.join("\n")} />
        </pre>
      </div>
    </div>
  );
}
