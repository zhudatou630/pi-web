"use client";

import { createContext, useContext, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";
import { TurnArtifactChip } from "./TurnArtifacts";

/** Where clicks on a turn's file chips go. */
export const TurnFilesContext = createContext<{
  onOpenDiff?: (filePath: string) => void;
  /** Opens the panel's Changes view on "only this turn's files". */
  onReview?: () => void;
}>({});

/** More chips than this fold behind a "+N" chip. */
const VISIBLE_FILES = 8;

/**
 * The files a turn actually wrote, as chips under the answer (docs/ui.md, File panel): icon and
 * name, each opening its diff; the folder shows only where two names collide. The last turn also
 * gets a "Review" link to the Changes view. Entries come from the turn's successful
 * `write`/`edit` tool calls; the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, cwd, latest = false, onOpenFile }: {
  files: WrittenFile[];
  cwd?: string;
  /** The session's last turn: gets the Review link. */
  latest?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const { onOpenDiff, onReview } = useContext(TurnFilesContext);
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const open = onOpenDiff ?? onOpenFile;
  const names = files.map(({ filePath }) => getFileName(filePath));
  const shown = expanded || files.length <= VISIBLE_FILES ? files : files.slice(0, VISIBLE_FILES - 1);

  return (
    <div data-export-exclude className="turn-files" aria-label={t("chat.filesWritten")}>
      {shown.map(({ filePath }, index) => {
        const name = names[index];
        const relative = getRelativeFilePath(filePath, cwd);
        const slash = relative.lastIndexOf("/");
        const dir = names.indexOf(name) !== names.lastIndexOf(name) && slash > 0 ? relative.slice(0, slash) : "";
        return (
          <TurnArtifactChip
            key={filePath}
            icon={getFileIcon(name, 12)}
            label={dir ? <>{name} <span className="turn-files-dir">{dir}</span></> : name}
            title={filePath}
            ariaLabel={t("chat.openWrittenFile", { name: dir ? relative : name })}
            onClick={() => open?.(filePath)}
          />
        );
      })}
      {shown.length < files.length && (
        <TurnArtifactChip
          label={`+${files.length - shown.length}`}
          ariaLabel={t("chat.showMoreFiles", { count: files.length - shown.length })}
          onClick={() => setExpanded(true)}
        />
      )}
      {latest && onReview && (
        <button type="button" className="turn-files-review" title={t("chat.reviewChangesTitle")} onClick={onReview}>
          {t("chat.reviewChanges")}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3.5 2 6.5 5 3.5 8" />
          </svg>
        </button>
      )}
    </div>
  );
}
