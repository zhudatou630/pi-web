"use client";

import { createContext, useContext } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";

/** What the chat around a turn card knows: whether the file panel is open, and where clicks go. */
export const TurnFilesContext = createContext<{
  panelOpen: boolean;
  onOpenDiff?: (filePath: string) => void;
  /** Opens the panel's Changes view on "only this turn's files". */
  onReview?: () => void;
}>({ panelOpen: false });

/**
 * The files a turn actually wrote, as a card under the answer (docs/ui.md, File panel): names and
 * folders only, each opening its diff. The last turn's card also opens the Changes view; while the
 * file panel is open every card folds to its title row. Entries come from the turn's successful
 * `write`/`edit` tool calls; the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, cwd, latest = false, onOpenFile }: {
  files: WrittenFile[];
  cwd?: string;
  /** The session's last turn: "this turn", with the Review link. */
  latest?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const { panelOpen, onOpenDiff, onReview } = useContext(TurnFilesContext);
  if (files.length === 0) return null;
  const open = onOpenDiff ?? onOpenFile;

  return (
    <div data-export-exclude className="turn-files-card" aria-label={t("chat.filesWritten")}>
      {latest && onReview ? (
        <button type="button" className="turn-files-head" title={t("chat.reviewChangesTitle")} onClick={onReview}>
          <span>{t(files.length === 1 ? "chat.turnWroteFilesOne" : "chat.turnWroteFiles", { count: files.length })}</span>
          <span className="turn-files-go">
            {t("chat.reviewChanges")}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3.5 2 6.5 5 3.5 8" />
            </svg>
          </span>
        </button>
      ) : (
        <div className="turn-files-head">{t(`${latest ? "chat.turnWroteFiles" : "chat.wroteFiles"}${files.length === 1 ? "One" : ""}`, { count: files.length })}</div>
      )}
      {!panelOpen && (
        <div className="turn-files-rows">
          {files.map(({ filePath }) => {
            const name = getFileName(filePath);
            const relative = getRelativeFilePath(filePath, cwd);
            const slash = relative.lastIndexOf("/");
            return (
              <button
                key={filePath}
                type="button"
                className="turn-files-row"
                title={filePath}
                aria-label={t("chat.openWrittenFile", { name })}
                onClick={() => open?.(filePath)}
              >
                <span className="turn-files-name">{name}</span>
                <span className="turn-files-dir">{slash > 0 ? relative.slice(0, slash) : ""}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
