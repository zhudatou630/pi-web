import { getSessionEntries, resolveSessionPath } from "./session-reader";
import { homedir } from "os";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import { isFilePathReferencedByEntries, isValidSessionId } from "./session-file-references-core";

export async function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isFilePathReferencedByEntries(filePath, getSessionEntries(sessionPath), homedir());
  } catch {
    return false;
  }
}
