"use client";

import { useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

/**
 * The one "when does this apply" banner for settings pages. Settings are saved at once,
 * but an open session keeps what it loaded until it is reloaded.
 */
export function ReloadNotice({ sessionId, onReloaded, onDone }: {
  sessionId: string | null;
  onReloaded?: () => void;
  /** The change is now live (reloaded); the page hides the banner. */
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    if (!sessionId) return;
    setReloading(true);
    setError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="settings-reload-notice" role="status">
      <span className={error ? "is-error" : undefined}>
        {error ?? (sessionId ? t("agents.reloadRequired") : t("project.newSessionsOnly"))}
      </span>
      {sessionId && (
        <ConfigButton size="small" variant="primary" onClick={() => void reload()} disabled={reloading}>
          {reloading ? t("agents.reloading") : t("agents.reloadSession")}
        </ConfigButton>
      )}
    </div>
  );
}
