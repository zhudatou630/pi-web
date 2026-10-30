"use client";

import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";
import { TurnArtifactChip } from "./TurnArtifacts";

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div data-export-exclude aria-label={t("chat.filesWritten")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
      {files.map(({ filePath }) => {
        const name = getFileName(filePath);
        return (
          <TurnArtifactChip
            key={filePath}
            icon={getFileIcon(name, 12)}
            label={name}
            title={filePath}
            ariaLabel={t("chat.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(filePath)}
          />
        );
      })}
    </div>
  );
}
