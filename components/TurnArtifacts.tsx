"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { requestOpenRoutine } from "@/lib/routine-events";
import type { CreatedRoutine } from "@/lib/turn-routines";

const CHIP_BACKGROUND = "color-mix(in srgb, var(--bg-subtle) 65%, var(--bg))";

/** One thing a turn produced (a written file, a created routine), as a small button under the answer. */
export function TurnArtifactChip({ icon, label, title, ariaLabel, onClick }: {
  icon: ReactNode;
  label: string;
  title?: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2.5px 7px",
        minHeight: 22,
        fontSize: 11,
        fontFamily: "var(--font-ui)",
        lineHeight: 1.35,
        color: "var(--text-muted)",
        background: CHIP_BACKGROUND,
        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        borderRadius: "var(--ui-radius-md)",
        cursor: "pointer",
        transition: "background var(--motion-fast), color var(--motion-fast)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = CHIP_BACKGROUND;
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/**
 * Routines this turn created (approved `create_routine` calls), like the written-file chips:
 * the result stays where the turn is, and one click opens it on the Routines page.
 */
export function TurnCreatedRoutines({ routines }: { routines: CreatedRoutine[] }) {
  const { t } = useI18n();
  if (routines.length === 0) return null;
  return (
    <div data-export-exclude aria-label={t("chat.routinesCreated")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
      {routines.map((routine) => (
        <TurnArtifactChip
          key={routine.id}
          icon={(
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
            </svg>
          )}
          label={routine.name}
          title={t("chat.openRoutine", { name: routine.name })}
          ariaLabel={t("chat.openRoutine", { name: routine.name })}
          onClick={() => requestOpenRoutine(routine.id)}
        />
      ))}
    </div>
  );
}
