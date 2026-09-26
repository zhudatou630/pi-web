"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme, type ThemePalette, type ThemePreference } from "@/hooks/useTheme";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_FONT_SIZE_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ShellToolSettingsResponse } from "@/lib/api-types";
import { getJson, peekJson, prefetchSettings, revalidateSettings, settingsUrls } from "@/lib/settings-cache";
import {
  setLastSettingsSection,
  type SettingsSection,
} from "@/lib/settings-navigation";
import {
  isAutoSessionTitleEnabled,
  setAutoSessionTitleEnabled,
} from "@/lib/auto-session-title-preference";
import {
  isShiftEnterToSend,
  setShiftEnterToSend,
} from "@/lib/shift-enter-to-send-preference";
import {
  isThinkingExpandedByDefault,
  setThinkingExpandedByDefault,
} from "@/lib/thinking-expansion-preference";
import {
  isSidebarSingleProject,
  setSidebarSingleProject,
} from "@/lib/sidebar-single-project-preference";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { AgentsConfig } from "./AgentsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ImagesConfig } from "./ImagesConfig";
import { UsageStats } from "./UsageStats";
import { subscribeNotificationPermission } from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";
import { downloadSarasa, hasDownloadedSarasa } from "@/lib/sarasa-font";
import { AppUpdateNotice } from "./AppUpdateNotice";
import { ConfigButton, ConfigSwitch, SettingsGroup, SettingsRow } from "./SettingsUi";
import { SubagentIcon } from "./SubagentIcon";

interface Props {
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
  onModelsChanged: () => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
  soundEnabled: boolean;
  onSoundToggle: () => void;
}

const SECTION_ICON_PATHS: Record<Exclude<SettingsSection, "agents">, ReactNode> = {
  general: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  models: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></>,
  images: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></>,
  skills: <path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" />,
  plugins: <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />,
  usage: <path d="M3 3v16a2 2 0 0 0 2 2h16M18 17V9M13 17V5M8 17v-3" />,
};

function SectionIcon({ section }: { section: SettingsSection }) {
  if (section === "agents") return <SubagentIcon size={15} />;
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="settings-nav-icon">{SECTION_ICON_PATHS[section]}</svg>;
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="settings-theme-icon"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" /></svg>;
  }
  if (preference === "dark") {
    return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="settings-theme-icon"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></svg>;
  }
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="settings-theme-icon"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}

function GeneralSettings({ sessionId, onSessionReloaded, quoteSelectionEnabled, onQuoteSelectionChange, soundEnabled, onSoundToggle }: Pick<Props, "sessionId" | "onSessionReloaded" | "quoteSelectionEnabled" | "onQuoteSelectionChange" | "soundEnabled" | "onSoundToggle">) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { preference, setThemePreference, palette, setThemePalette } = useTheme();
  const { width: chatContentWidth, setWidth: setChatContentWidth, fontSize, setFontSize } = useChatAppearance();
  // The last replies paint at once; the mount loads then revalidate them.
  const [shellSettings, setShellSettings] = useState<ShellToolSettingsResponse | null>(() => {
    const reply = peekJson<ShellToolSettingsResponse & { error?: string }>(settingsUrls.toolSettings);
    return reply?.ok && !reply.data.error ? reply.data : null;
  });
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [autoSessionTitle, setAutoSessionTitle] = useState(true);
  const [singleProject, setSingleProject] = useState(false);
  const [shiftEnterToSend, setShiftEnterToSendState] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | null>(null);
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [webAuthEnabled, setWebAuthEnabled] = useState(() => peekJson<{ enabled?: boolean }>(settingsUrls.webAuth)?.data.enabled === true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [sarasaStatus, setSarasaStatus] = useState<"cached" | "available" | "loading" | "error">("available");
  const [sarasaError, setSarasaError] = useState<string | null>(null);

  useEffect(() => {
    setThinkingExpanded(isThinkingExpandedByDefault());
    setAutoSessionTitle(isAutoSessionTitleEnabled());
    setSingleProject(isSidebarSingleProject());
    setShiftEnterToSendState(isShiftEnterToSend());
  }, []);
  useEffect(() => {
    void getJson<{ enabled?: boolean }>(settingsUrls.webAuth)
      .then((response) => setWebAuthEnabled(response.ok && response.data.enabled === true))
      .catch(() => {});
  }, []);
  useEffect(() => subscribeNotificationPermission(setNotificationPermission), []);
  const themeOptions: { id: ThemePreference; label: string }[] = [
    { id: "light", label: t("settings.themeLight") },
    { id: "dark", label: t("settings.themeDark") },
    { id: "auto", label: t("settings.themeSystem") },
  ];
  const paletteOptions: { id: ThemePalette; label: string }[] = [
    { id: "default", label: t("settings.paletteDefault") },
    { id: "claude", label: t("settings.paletteClaude") },
  ];

  useEffect(() => {
    let cancelled = false;
    void getJson<ShellToolSettingsResponse & { error?: string }>(settingsUrls.toolSettings)
      .then(async (response) => {
        const data = response.data;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setShellSettings(data);
      })
      .catch((cause) => {
        if (!cancelled) setShellError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setShellError(null);
    try {
      const response = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as ShellToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: "reload" });
        onSessionReloaded();
      }
    } catch (cause) {
      setShellError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  const registerPush = async () => {
    if (pushRegistering) return;
    setPushRegistering(true);
    setPushStatus(null);
    try {
      if (typeof window === "undefined" || !("Notification" in window)) {
        throw new Error("unsupported or not permitted");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") throw new Error("unsupported or not permitted");
      const ok = await setupPushSubscription(locale);
      if (!ok) throw new Error("unsupported or not permitted");
      setPushStatus({ kind: "ok", message: t("settings.pushRegistered") });
    } catch (cause) {
      setPushStatus({ kind: "error", message: `${t("settings.pushRegisterFailed")} ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setPushRegistering(false);
    }
  };

  useEffect(() => {
    const downloaded = hasDownloadedSarasa();
    setSarasaStatus(downloaded ? "cached" : "available");
  }, []);

  const downloadSarasaFont = async () => {
    setSarasaStatus("loading");
    setSarasaError(null);
    try {
      await downloadSarasa();
      setSarasaStatus("cached");
    } catch (cause) {
      setSarasaStatus("error");
      setSarasaError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const logOut = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/web-auth", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.location.replace("/login");
    } catch {
      setLogoutError(t("auth.logoutFailed"));
    } finally {
      setLoggingOut(false);
    }
  };

  const resetIcon = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
    </svg>
  );
  const switchRow = (label: string, description: string, checked: boolean, onChange: (enabled: boolean) => void) => (
    <SettingsRow label={label} description={description}>
      <ConfigSwitch checked={checked} label={label} onChange={onChange} />
    </SettingsRow>
  );
  const rangeControl = (id: string, value: number, min: number, max: number, step: number, fallback: number, resetLabel: string, onChange: (value: number) => void) => (
    <div className="settings-range">
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <output htmlFor={id}>{value}px</output>
      <ConfigButton
        variant="ghost"
        size="small"
        className="settings-chat-reset"
        title={resetLabel}
        aria-label={resetLabel}
        disabled={value === fallback}
        onClick={() => onChange(fallback)}
      >
        {resetIcon}
      </ConfigButton>
    </div>
  );

  return (
    <div className="settings-page">
      <SettingsGroup title={t("settings.appearance")}>
        <SettingsRow label={t("settings.theme")} stacked>
          <div role="radiogroup" aria-label={t("settings.theme")} className="settings-segmented">
            {themeOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={preference === option.id}
                onClick={() => setThemePreference(option.id)}
                className="settings-segmented-option"
              >
                <ThemeIcon preference={option.id} />
                <span className="settings-segmented-label">{option.label}</span>
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label={t("settings.palette")} stacked>
          <div role="radiogroup" aria-label={t("settings.palette")} className="settings-segmented">
            {paletteOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={palette === option.id}
                onClick={() => setThemePalette(option.id)}
                className="settings-segmented-option"
              >
                <span className="settings-segmented-label">{option.label}</span>
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label={t("common.language")} stacked>
          <div role="radiogroup" aria-label={t("common.language")} className="settings-segmented">
            {supportedLocales.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                role="radio"
                aria-checked={locale === plugin.id}
                onClick={() => setLocale(plugin.id as typeof locale)}
                className="settings-segmented-option"
              >
                <span className="settings-segmented-label">{plugin.label}</span>
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label={t("settings.typography")} description={t("settings.typographyDescription")}>
          {sarasaStatus === "cached" ? (
            <span role="status" className="settings-row-status">{t("settings.fontCached")}</span>
          ) : (
            <ConfigButton size="small" disabled={sarasaStatus === "loading"} onClick={() => void downloadSarasaFont()}>
              {sarasaStatus === "loading" ? t("settings.fontDownloadLoading") : t("settings.fontDownload")}
            </ConfigButton>
          )}
        </SettingsRow>
        {sarasaStatus === "error" && <p role="alert" className="settings-row-message is-error">{t("settings.fontDownloadFailed")} {sarasaError}</p>}
        <SettingsRow label={t("settings.chatContentWidth")} description={t("settings.chatContentWidthDescription")} htmlFor="settings-chat-content-width" stacked>
          {rangeControl("settings-chat-content-width", chatContentWidth, CHAT_CONTENT_WIDTH_MIN, CHAT_CONTENT_WIDTH_MAX, 10, CHAT_CONTENT_WIDTH_DEFAULT, t("settings.resetChatContentWidth"), setChatContentWidth)}
        </SettingsRow>
        <SettingsRow label={t("settings.chatContentFontSize")} description={t("settings.chatContentFontSizeDescription")} htmlFor="settings-chat-content-font-size" stacked>
          {rangeControl("settings-chat-content-font-size", fontSize, CHAT_CONTENT_FONT_SIZE_MIN, CHAT_CONTENT_FONT_SIZE_MAX, 1, CHAT_CONTENT_FONT_SIZE_DEFAULT, t("settings.resetChatContentFontSize"), setFontSize)}
        </SettingsRow>
        {switchRow(t("settings.thinkingExpandedDefault"), t("settings.thinkingExpandedDefaultDescription"), thinkingExpanded, (enabled) => {
          setThinkingExpandedByDefault(enabled);
          setThinkingExpanded(enabled);
        })}
      </SettingsGroup>

      <SettingsGroup title={t("settings.chat")}>
        {switchRow(t("settings.shiftEnterToSend"), t("settings.shiftEnterToSendDescription"), shiftEnterToSend, (enabled) => {
          setShiftEnterToSend(enabled);
          setShiftEnterToSendState(enabled);
        })}
        {switchRow(t("settings.autoSessionTitle"), t("settings.autoSessionTitleDescription"), autoSessionTitle, (enabled) => {
          setAutoSessionTitleEnabled(enabled);
          setAutoSessionTitle(enabled);
        })}
        {switchRow(t("settings.quoteSelection"), t("settings.quoteSelectionDescription"), quoteSelectionEnabled, onQuoteSelectionChange)}
        {switchRow(t("settings.sidebarSingleProject"), t("settings.sidebarSingleProjectDescription"), singleProject, (enabled) => {
          setSidebarSingleProject(enabled);
          setSingleProject(enabled);
        })}
        {shellSettings?.isWindows && (
          <SettingsRow label={t("settings.usePowerShell")} description={t("settings.shellToolDescription")}>
            <ConfigSwitch
              checked={shellSettings.powerShellEnabled}
              loading={shellSaving}
              label={t("settings.usePowerShell")}
              onChange={(enabled) => void togglePowerShell(enabled)}
            />
          </SettingsRow>
        )}
        {shellError && <p role="alert" className="settings-row-message is-error">{shellError}</p>}
      </SettingsGroup>

      <SettingsGroup title={t("settings.notifications")}>
        {switchRow(t("settings.completionSound"), t("settings.completionSoundDescription"), soundEnabled, onSoundToggle)}
        {notificationPermission && (
          <SettingsRow label={t("settings.browserNotifications")} description={t("settings.browserNotificationsDescription")}>
            {notificationPermission === "granted" ? (
              <span className="settings-row-status">{t("settings.browserNotificationsOn")}</span>
            ) : notificationPermission === "denied" ? (
              <span className="settings-row-status">{t("settings.browserNotificationsBlocked")}</span>
            ) : (
              <ConfigButton size="small" onClick={() => void Notification.requestPermission().then(setNotificationPermission)}>
                {t("settings.browserNotificationsEnable")}
              </ConfigButton>
            )}
          </SettingsRow>
        )}
        <SettingsRow label={t("settings.pushPermission")} description={t("settings.pushPermissionDescription")}>
          <ConfigButton size="small" disabled={pushRegistering} onClick={() => void registerPush()}>
            {pushRegistering ? t("settings.pushRegisterLoading") : t("settings.pushRegister")}
          </ConfigButton>
        </SettingsRow>
        {pushStatus && (
          <p role="status" className={`settings-row-message ${pushStatus.kind === "ok" ? "is-success" : "is-error"}`}>
            {pushStatus.message}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.about")}>
        <AppUpdateNotice showCurrentVersion />
        {webAuthEnabled && (
          <SettingsRow label={t("auth.logOut")} description={t("settings.logOutDescription")}>
            <ConfigButton size="small" variant="danger" disabled={loggingOut} onClick={() => void logOut()}>
              {loggingOut ? t("auth.loggingOut") : t("auth.logOut")}
            </ConfigButton>
          </SettingsRow>
        )}
        {logoutError && <p role="alert" className="settings-row-message is-error">{logoutError}</p>}
      </SettingsGroup>
    </div>
  );
}

export function SettingsPanel({ cwd, sessionId, initialSection, onClose, onSessionReloaded, onModelsChanged, quoteSelectionEnabled, onQuoteSelectionChange, soundEnabled, onSoundToggle }: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  // Narrow screens show one page at a time: the section list, then the section.
  const [pane, setPane] = useState<"nav" | "section">("nav");
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(
    () => new Set([section]),
  );
  const navGroups: { label: string; sections: { id: SettingsSection; label: string; requiresProject: boolean }[] }[] = [
    { label: t("settings.title"), sections: [
      { id: "general", label: t("settings.general"), requiresProject: false },
      { id: "usage", label: t("settings.usage"), requiresProject: false },
    ] },
    { label: t("settings.navAgent"), sections: [
      { id: "models", label: t("common.models"), requiresProject: false },
      { id: "agents", label: t("common.agents"), requiresProject: true },
      { id: "images", label: t("settings.images"), requiresProject: false },
      { id: "skills", label: t("common.skills"), requiresProject: true },
      { id: "plugins", label: t("common.plugins"), requiresProject: true },
    ] },
  ];
  const sections = navGroups.flatMap((group) => group.sections);

  // Unsaved models.json edits live only in the Models section; closing drops them.
  const modelsDirtyRef = useRef(false);
  const handleModelsDirty = useCallback((dirty: boolean) => { modelsDirtyRef.current = dirty; }, []);
  const requestClose = useCallback(() => {
    if (modelsDirtyRef.current && !window.confirm(t("models.discardConfirm"))) return;
    onClose();
  }, [onClose, t]);

  useEffect(() => setLastSettingsSection(initialSection), [initialSection]);
  // Sections not visited yet load in the background, so switching to them paints at once.
  useEffect(() => prefetchSettings(cwd), [cwd]);
  useEffect(() => revalidateSettings, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  useEffect(() => {
    if (cwd || (section !== "skills" && section !== "agents" && section !== "plugins")) return;
    setSection("general");
    setMountedSections((current) => new Set(current).add("general"));
    setLastSettingsSection("general");
  }, [cwd, section]);

  const activateSection = (nextSection: SettingsSection) => {
    setMountedSections((current) => new Set(current).add(nextSection));
    setSection(nextSection);
    setLastSettingsSection(nextSection);
    setPane("section");
  };
  const sectionLabel = sections.find((item) => item.id === section)?.label;
  const mainRef = useRef<HTMLElement>(null);
  // One back button on phones: it leaves a section's detail page before the section itself.
  // ponytail: reaches into the section's DOM for its own back link; lift page state up if sections grow more levels.
  const goBack = () => {
    const innerBack = mainRef.current?.querySelector<HTMLButtonElement>(
      ".settings-section-host:not([hidden]) [data-settings-back]",
    );
    if (innerBack) innerBack.click();
    else setPane("nav");
  };

  const sectionHost = (id: SettingsSection, content: ReactNode) => mountedSections.has(id) ? (
    <div
      key={id}
      hidden={section !== id}
      className="settings-section-host"
    >
      {content}
    </div>
  ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
      className="settings-dialog-backdrop"
    >
      <div className="settings-dialog-surface" data-pane={pane}>
        <nav aria-label={t("settings.title")} className="settings-nav">
          <strong className="settings-nav-title">{t("settings.title")}</strong>
          {navGroups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="settings-nav-group">
              <span className="settings-nav-group-label">{group.label}</span>
              {group.sections.map((item) => {
                const disabled = item.requiresProject && !cwd;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="settings-nav-item"
                    disabled={disabled}
                    title={disabled ? t("settings.projectRequired") : undefined}
                    aria-current={section === item.id ? "page" : undefined}
                    onClick={() => activateSection(item.id)}
                  >
                    <SectionIcon section={item.id} />
                    <span className="settings-nav-label">{item.label}</span>
                    <svg className="settings-nav-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="settings-dialog-content">
          <div className="settings-dialog-header">
            <button type="button" className="settings-nav-back" onClick={goBack} aria-label={t("i18n.back")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <strong className="settings-dialog-title">{sectionLabel}</strong>
          </div>

          <main ref={mainRef} className="settings-dialog-main">
            {sectionHost("general", <GeneralSettings sessionId={sessionId} onSessionReloaded={onSessionReloaded} quoteSelectionEnabled={quoteSelectionEnabled} onQuoteSelectionChange={onQuoteSelectionChange} soundEnabled={soundEnabled} onSoundToggle={onSoundToggle} />)}
            {sectionHost("models", <ModelsConfig embedded onClose={requestClose} cwd={cwd} onModelsChanged={onModelsChanged} onDirtyChange={handleModelsDirty} />)}
            {cwd && sectionHost("agents", <AgentsConfig embedded key={cwd} cwd={cwd} sessionId={sessionId} onClose={onClose} onReloaded={onSessionReloaded} />)}
            {sectionHost("images", <ImagesConfig sessionId={sessionId} onReloaded={onSessionReloaded} />)}
            {cwd && sectionHost("skills", <SkillsConfig embedded key={cwd} cwd={cwd} onClose={onClose} />)}
            {cwd && sectionHost("plugins", <PluginsConfig embedded key={cwd} cwd={cwd} sessionId={sessionId} onClose={onClose} onReloaded={onSessionReloaded} />)}
            {sectionHost("usage", <UsageStats />)}
          </main>
        </div>
        <button type="button" onClick={requestClose} title={t("i18n.close")} aria-label={t("i18n.close")} className="config-close-button settings-dialog-close">×</button>
      </div>
    </div>
  );
}
