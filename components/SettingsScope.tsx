"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigSwitch, SettingsRow } from "./SettingsUi";

export function SettingsResetButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <ConfigButton variant="ghost" size="small" className="settings-chat-reset" aria-label={t("settings.scope.reset")} disabled={disabled} onClick={onClick}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
      </svg>
    </ConfigButton>
  );
}

export function SettingsScopeStatus({ overridden, onReset, disabled = false }: { overridden: boolean; onReset?: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  return overridden ? (
    <>
      <span className="settings-row-status">{t("settings.scope.project")}</span>
      {onReset && <SettingsResetButton onClick={onReset} disabled={disabled} />}
    </>
  ) : <span className="settings-scope-inherited">{t("settings.scope.follows")}</span>;
}

/** Global rows omit `overridden`; project rows put their status after the switch. */
export function SettingsScopeControl({ checked, onChange, label, overridden, onReset, disabled = false, loading = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  overridden?: boolean;
  onReset?: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <>
      <ConfigSwitch checked={checked} onChange={onChange} label={label} disabled={disabled} loading={loading} />
      {overridden !== undefined && <SettingsScopeStatus overridden={overridden} onReset={onReset} disabled={disabled || loading} />}
    </>
  );
}

export function SettingsScopeRow({ projectPath, label, children, ...control }: Omit<Parameters<typeof SettingsScopeControl>[0], "label"> & { projectPath?: string; label?: string; children?: ReactNode }) {
  const { t } = useI18n();
  const rowLabel = label ?? (projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath : t("settings.scope.default"));
  return (
    <SettingsRow label={rowLabel} title={projectPath}>
      {children}
      <SettingsScopeControl {...control} label={rowLabel} />
    </SettingsRow>
  );
}
