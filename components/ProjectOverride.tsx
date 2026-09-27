"use client";

import type { ProjectOverride } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";

/** Marks a global resource whose state this project overrides (edited on the Project page). */
export function ProjectOverrideTag({ value }: { value?: ProjectOverride | "mixed" }) {
  const { t } = useI18n();
  if (!value || value === "inherit") return null;
  return <span className="settings-row-status">{t(`project.tag.${value}`)}</span>;
}
