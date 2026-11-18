"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { APP_ICON_COLORS, APP_MARK_PATH, APP_NAME_MAX_LENGTH, type AppIconColor, type AppIdentity } from "@/lib/app-identity-options";
import { Select } from "./Select";
import { SettingsRow } from "./SettingsUi";

const ENDPOINT = "/api/app-identity";

type AppIdentityView = AppIdentity & { defaultName: string };

// Input width in columns: CJK and other wide characters take two.
const textColumns = (text: string) => [...text].reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);

/** Settings › General › Appearance: this server's app icon and name (server-wide, saved on change). */
export function AppIdentityRows() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<AppIdentityView | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Saves run one at a time, so responses land in order; controls stay enabled (a blur save
  // must not disable the icon the same click is landing on).
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void fetch(ENDPOINT, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as AppIdentityView & { error?: string };
        if (cancelled) return;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setSaved(data);
        setName(data.name);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  if (!saved) return error ? <p role="alert" className="settings-row-message is-error">{error}</p> : null;

  // Sends only the changed field; the server merges it into the latest identity.
  const save = (patch: Partial<AppIdentity>) => {
    queue.current = queue.current.then(async () => {
      setError(null);
      try {
        const response = await fetch(ENDPOINT, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await response.json() as AppIdentityView & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setSaved(data);
        if (patch.name !== undefined) setName(data.name);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  };

  const dot = (color: AppIconColor) => <span className="settings-app-icon-dot" style={{ background: APP_ICON_COLORS[color] }} aria-hidden="true" />;

  // The name (edited in place), then the icon at the row's end where switches sit (opens the color menu).
  return (
    <>
      <SettingsRow label={t("settings.app")} htmlFor="settings-app-name">
        <input
          id="settings-app-name"
          className="settings-app-name"
          aria-label={t("settings.appName")}
          value={name}
          maxLength={APP_NAME_MAX_LENGTH}
          placeholder={saved.defaultName}
          size={Math.max(6, textColumns(name || saved.defaultName) + 1)}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => { if (name.trim() !== saved.name) save({ name }); }}
          onKeyDown={(event) => {
            // Enter also confirms an IME candidate (Chinese input); only a plain Enter commits.
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.currentTarget.blur();
          }}
        />
        <Select
          className="settings-app-tile"
          align="end"
          label=""
          ariaLabel={t("settings.appIconColor")}
          icon={(
            <svg width="20" height="20" viewBox="-187 -187 934 934" aria-hidden="true">
              <rect x="-187" y="-187" width="934" height="934" fill={APP_ICON_COLORS[saved.color]} />
              <path d={APP_MARK_PATH} fill="#ffffff" />
            </svg>
          )}
          value={saved.color}
          onChange={(color) => save({ color: color as AppIconColor })}
          options={(Object.keys(APP_ICON_COLORS) as AppIconColor[]).map((color) => ({ value: color, label: t(`settings.appIconColor.${color}`), icon: dot(color) }))}
        />
      </SettingsRow>
      {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
    </>
  );
}
