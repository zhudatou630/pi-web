"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AnthropicCacheTtl } from "@/lib/prompt-cache-settings";
import { SettingsGroup, SettingsRow, SettingsSegmented } from "../SettingsUi";

const ENDPOINT = "/api/models-config/prompt-cache";

/** Settings › Models: Anthropic prompt-cache TTL, saved on click (not part of the models.json draft). */
export function PromptCacheGroup() {
  const { t } = useI18n();
  const [ttl, setTtl] = useState<AnthropicCacheTtl | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(ENDPOINT, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { anthropicTtl?: AnthropicCacheTtl; error?: string };
        if (cancelled) return;
        if (data.anthropicTtl) setTtl(data.anthropicTtl);
        else setError(data.error ?? `HTTP ${response.status}`);
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  const save = async (next: AnthropicCacheTtl) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anthropicTtl: next }),
      });
      const data = await response.json() as { anthropicTtl?: AnthropicCacheTtl; error?: string };
      if (!response.ok || !data.anthropicTtl) throw new Error(data.error ?? `HTTP ${response.status}`);
      setTtl(data.anthropicTtl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroup title={t("models.promptCache")}>
      {ttl && (
        <SettingsRow label={t("models.anthropicCacheTtl")}>
          <SettingsSegmented
            label={t("models.anthropicCacheTtl")}
            value={ttl}
            onChange={(next) => { if (next !== ttl) void save(next); }}
            disabled={saving}
            options={[
              { value: "5m", label: t("models.cacheTtl5m") },
              { value: "1h", label: t("models.cacheTtl1h") },
            ]}
          />
        </SettingsRow>
      )}
      {error && <p role="alert" className="settings-row-message is-error">{error}</p>}
    </SettingsGroup>
  );
}
