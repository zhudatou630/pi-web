"use client";

import React, { useRef, useState, useCallback, useEffect, useId, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { SkillsResponse } from "@/lib/api-types";
import type { TextContent, UserMessage } from "@/lib/types";
import { THINKING_LEVELS as THINKING_LEVEL_VALUES } from "@/lib/thinking-levels";
import {
  clearDraft,
  exceedsAttachedImageSendLimit,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft,
  type ChatDraftImage,
} from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
  type AttachedImage,
  type Base64ImageAttachment,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, buildAtMentionText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { ImageMentionChip } from "./GeneratedImageResult";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { ThinkingIcon } from "./ThinkingIcon";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { CONFIGURED_TOOL_PRESET, type ToolPreset } from "@/lib/tool-presets";
import { formatTokensK } from "@/lib/token-display";
import { isShiftEnterToSend } from "@/lib/shift-enter-to-send-preference";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";


interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  /** Opens the direct image dialog; a single attached image is offered as its source. */
  onOpenImageGeneration?: (sourceImage?: Base64ImageAttachment) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => void;
  isStreaming: boolean;
  /** Keep a session inspectable while preventing it from accepting new input. */
  disabled?: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  modelError?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  cacheHitRate?: number | null;
  onOpenSessionStats?: () => void;
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
  draftKey?: string;
  onDraftChange?: (draftKey: string, value: string, imageCount: number) => void;
  draftPersistenceWarning?: boolean;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
  mentionImage: (path: string) => void;
  removeAttachedImage: (data: string) => void;
}

// "configured" sends no override, so the session follows settings.json defaultTools.
const TOOL_PRESETS = ["configured", "chat-only", "read-only", "default", "full"] as const;
type ToolPresetLabel = typeof TOOL_PRESETS[number];
const TOOL_PRESET_MAP: Record<ToolPresetLabel, ToolPreset> = {
  configured: CONFIGURED_TOOL_PRESET,
  "chat-only": "none",
  "read-only": "read-only",
  default: "default",
  full: "full",
};
const COMPOSITION_END_ENTER_GRACE_MS = 100;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ANCHORED_MENU_GAP = 8;

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>,
): string | null {
  let result = "";
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
    const escapedHref = href.replace(/([\\()])/g, "\\$1");
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
}

function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void,
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(getUpwardMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      getVisibleTopBoundary(menu),
    ));
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver = typeof ResizeObserver === "undefined" || !parent
    ? null
    : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);

  return () => {
    anchorObserver?.disconnect();
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}

const THINKING_LEVELS = ["auto", ...THINKING_LEVEL_VALUES] as const;

function formatTokenCount(tokens: number): string {
  return formatTokensK(tokens);
}

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
};

type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin", availableWhileStreaming: true },
  { name: "copy", description: "chat.commandCopy", source: "builtin", availableWhileStreaming: true },
  { name: "clone", description: "chat.commandClone", source: "builtin" },
  { name: "bug", description: "chat.commandBug", source: "builtin" },
  { name: "auto-compact", description: "chat.commandAutoCompact", source: "builtin" },
];

function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

export function prependImageMentions(message: string, paths: string[]): string {
  return `${paths.map((path) => buildAtMentionText(path, false)).join("")}${message.trim()}`.trim();
}

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

function focusTextareaAt(textareaRef: React.RefObject<HTMLTextAreaElement | null>, position: number): void {
  requestAnimationFrame(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(position, position);
  });
}

function renderSlashCommandName(name: string, query: string | null): React.ReactNode {
  if (!query) return `/${name}`;
  const matchStart = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchStart < 0) return `/${name}`;
  return <>{`/${name.slice(0, matchStart)}`}<span style={{ color: "var(--accent)" }}>{name.slice(matchStart, matchStart + query.length)}</span>{name.slice(matchStart + query.length)}</>;
}

const BUILTIN_SIGNATURES: Record<string, string> = {
  name: "<session-title>",
  session: "[session-id]",
  clone: "[new-title]",
};

function highlightText(text: string, query: string | null): React.ReactNode {
  if (!query) return text;
  const start = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (start < 0) return text;
  return <>{text.slice(0, start)}<mark style={{ padding: 0, color: "var(--accent)", background: "transparent" }}>{text.slice(start, start + query.length)}</mark>{text.slice(start + query.length)}</>;
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

const CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const CLIENT_MAX_IMAGE_SIDE = 1024;
const CLIENT_JPEG_QUALITY = 0.85;

export function shouldCompressImageFile(file: Pick<File, "size" | "type">): boolean {
  return file.size > CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES && file.type !== "image/gif";
}

function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function compressImageFile(file: File): Promise<{ data: string; mimeType: string }> {
  const original = () => readImageFile(file, file.type);
  if (!shouldCompressImageFile(file) || typeof createImageBitmap !== "function") return original();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original();

  try {
    const scale = Math.min(1, CLIENT_MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", CLIENT_JPEG_QUALITY).split(",")[1];
    return data && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: "image/jpeg" }
      : original();
  } catch {
    return original();
  } finally {
    bitmap.close();
  }
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? []).map(draftImageToAttachedImage);
}

export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
): boolean {
  return !value.trim() && attachedImageCount === 0 && pendingImageCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function getUserMessageDraftImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];

    // Support both the current nested image format and older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  return (
    <div
      title={text}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: 4,
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

function ModelNoticeBanner({ tone, title, body, onClose }: { tone: "error" | "warning"; title: string; body: string; onClose?: () => void }) {
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 4,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "0 2px",
            cursor: "pointer",
            color: "inherit",
            opacity: 0.7,
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={t("chat.modelError")} body={error} />;
}

/** True when the selected model is known to accept image input (#584). Unknown modality info never blocks the user. */
export function modelSupportsImageInput(
  model: { provider: string; modelId: string } | null | undefined,
  modelList: { id: string; name: string; provider: string; input?: string[] }[] | undefined
): boolean {
  if (!model) return true;
  const entry = modelList?.find((m) => m.provider === model.provider && m.id === model.modelId);
  if (!entry || !entry.input) return true;
  return entry.input.includes("image");
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? t("chat.modelScopeWarnings") : t("chat.modelScopeWarning")}
      body={warnings.join("\n")}
    />
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onOpenImageGeneration, onAbort, onSteer, onFollowUp, isStreaming, disabled = false, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange, modelSwitching,
  onCompact, onAbortCompaction, isCompacting, compactError, compactResult, toolPreset, onToolPresetChange,
  contextUsage, cacheHitRate, onOpenSessionStats,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  onDraftChange,
  draftPersistenceWarning = false,
  cwd,
  compact = false,
}: Props, ref) {
  const { t } = useI18n();
  const { fontSize } = useChatAppearance();
  const isMobile = useIsMobile();
  const menuId = useId();
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [controlsView, setControlsView] = useState<"root" | "tools" | "compact">("root");
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [statsActive, setStatsActive] = useState(false);
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [mentionedImages, setMentionedImages] = useState<string[]>([]);
  const mentionedImagesRef = useRef<string[]>([]);
  mentionedImagesRef.current = mentionedImages;
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const trimmedValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<number | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuMaxHeight, setAtMenuMaxHeight] = useState<number | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const [imageWarningDismissed, setImageWarningDismissed] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const historyStashRef = useRef<{ text: string } | null>(null);
  const [draftPersistenceFailed, setDraftPersistenceFailed] = useState(false);
  const [fileIndex, setFileIndex] = useState<{
    cwd: string;
    entries: FileIndexEntry[];
    clientTruncated: boolean;
    serverHardTruncated: boolean;
  } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const statsButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const builtinCommandPendingRef = useRef(false);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const imageProcessEpochRef = useRef(0);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      valueRef.current = text;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
      });
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(current, attachedImagesRef.current.length, pendingImageCountRef.current)) return;

      const restoredText = getUserMessageText(message);
      const restoredImages = draftImagesToAttachedImages(getUserMessageDraftImages(message));
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(combined.length, combined.length);
      });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      valueRef.current = moved.value;
      attachedImagesRef.current = movedImages;
      setValue(moved.value);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? attachedImagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = draftImagesToAttachedImages(restoredDraft.images);
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      setValue((current) => {
        const restored = mergeRestoredSubmissionText(text, current);
        valueRef.current = restored;
        return restored;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        attachedImagesRef.current = restoredImages;
        return restoredImages;
      });
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      valueRef.current = newVal;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
    mentionImage(path: string) {
      setMentionedImages((prev) => prev.includes(path) ? prev : [...prev, path]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    removeAttachedImage(data: string) {
      const index = attachedImagesRef.current.findIndex((image) => image.data === data);
      if (index >= 0) removeImage(index);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    if (compact) return;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    const processEpoch = imageProcessEpochRef.current;
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(async (file) => ({
          ...await compressImageFile(file),
          previewUrl: URL.createObjectURL(file),
        }))
      );
      setAttachedImages((prev) => {
        if (processEpoch !== imageProcessEpochRef.current) {
          newImages.forEach(revokeImagePreview);
          return prev;
        }
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        const next = [...prev, ...accepted];
        attachedImagesRef.current = next;
        return next;
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, [compact]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    imageProcessEpochRef.current += 1;
    historyStashRef.current = null;
    valueRef.current = "";
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    mentionedImagesRef.current = [];
    setMentionedImages([]);
  }, [clearImages, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    const persisted = setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
    });
    setDraftPersistenceFailed(!persisted);
    onDraftChange?.(draftKey, value, attachedImages.length);
  }, [attachedImages, draftKey, onDraftChange, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    const nextValue = draft?.value ?? "";
    const nextImages = draftImagesToAttachedImages(draft?.images);
    imageProcessEpochRef.current += 1;
    valueRef.current = nextValue;
    attachedImagesRef.current = nextImages;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return nextImages;
    });
    if (draftKey) onDraftChange?.(draftKey, nextValue, nextImages.length);
  }, [draftKey, onDraftChange]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Measure without a scrollbar: the global ::-webkit-scrollbar takes 4px of
    // layout width (even on mobile), which would wrap a nearly-full last line
    // during measurement and leave a phantom blank line afterwards.
    ta.style.overflowY = "hidden";
    ta.style.height = "auto";
    if (!ta.value) return;
    const height = ta.scrollHeight;
    ta.style.height = `${Math.min(height, 200)}px`;
    if (height > 200) ta.style.overflowY = "auto";
  }, []);

  useLayoutEffect(resizeTextarea, [value, fontSize, resizeTextarea]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      // Height updates also notify the observer; only remeasure on width changes.
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resizeTextarea();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  useEffect(() => {
    return () => {
      imageProcessEpochRef.current += 1;
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {
    if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
    if (builtinCommandPendingRef.current) return true;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(msg);
      if (!result.handled) return false;
      if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
      return true;
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [attachedImages.length, clearInput, onBuiltinCommand]);

  const handleSend = useCallback(async () => {
    if (disabled) return;
    const msg = value.trim();
    if (exceedsAttachedImageSendLimit(attachedImages.length)) return;
    const outgoing = prependImageMentions(msg, mentionedImages);
    if (!outgoing && !attachedImages.length) return;
    onAudioUnlock?.();
    const builtinAllowed = !isStreaming || canRunBuiltinSlashCommandWhileStreaming(msg);
    if (builtinAllowed && await runBuiltinCommand(msg)) return;
    if (isStreaming) return;
    const images = attachedImages.length ? attachedImages : undefined;
    clearInput();
    onSend(outgoing, images);
  }, [disabled, value, attachedImages, mentionedImages, isStreaming, runBuiltinCommand, onSend, clearInput, onAudioUnlock]);

  const slashQuery = !compact && value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const builtinCommands = isStreaming
      ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming)
      : BUILTIN_SLASH_COMMANDS;
    const commands = [...builtinCommands, ...(slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = getSlashDescription(command, t).toLowerCase();
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || TEXT_COLLATOR.compare(a.name, b.name);
      });
  })();

  const {
    commands: displayedSlashCommands,
    groups: groupedSlashCommands,
  } = buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

  const slashUsage = (() => {
    if (compact) return null;
    const cursor = cursorPosition ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    if (beforeCursor.includes("\n")) return null;
    const match = /^\/([^\s]+)\s(.*)$/.exec(beforeCursor);
    if (!match || !BUILTIN_SIGNATURES[match[1]]) return null;
    return {
      command: match[1],
      signature: BUILTIN_SIGNATURES[match[1]],
      hasArgument: match[2].trim().length > 0,
    };
  })();

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const imageSendBlocked = exceedsAttachedImageSendLimit(attachedImages.length);
  const canQueueStreamingMessage = !imageSendBlocked && (hasInputText || attachedImages.length > 0 || mentionedImages.length > 0);
  const canSendMessage = !disabled && !imageSendBlocked && (hasInputText || attachedImages.length > 0 || mentionedImages.length > 0);
  // Warn when images are attached but the selected model is known not to accept
  // image input (#584), including a resolved default. Unknown models stay silent.
  const showImageUnsupportedWarning = (
    attachedImages.length > 0
    && !modelSupportsImageInput(model, modelList)
    && !imageWarningDismissed
  );
  useEffect(() => {
    if (attachedImages.length === 0) setImageWarningDismissed(false);
  }, [attachedImages.length]);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.clientTruncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{
          files?: string[];
          clientTruncated?: boolean;
          serverHardTruncated?: boolean;
        }>
      })
      .then((data) => {
        setFileIndex({
          cwd: fetchCwd,
          entries: buildEntriesFromFiles(data.files ?? []),
          clientTruncated: !!data.clientTruncated,
          serverHardTruncated: !!data.serverHardTruncated,
        });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    valueRef.current = newValue;
    setValue(newValue);
    setCursorPosition(newPos);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    focusTextareaAt(textareaRef, newPos);
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const dismissHistoryMenu = useCallback(() => {
    const stash = historyStashRef.current;
    historyStashRef.current = null;
    if (stash) {
      valueRef.current = stash.text;
      setValue(stash.text);
    }
    setHistoryMenuOpen(false);
  }, []);

  const applyHistoryInput = useCallback((text: string) => {
    historyStashRef.current = null;
    valueRef.current = text;
    setValue(text);
    setCursorPosition(text.length);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    focusTextareaAt(textareaRef, text.length);
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    valueRef.current = nextValue;
    setValue(nextValue);
    setCursorPosition(nextValue.length);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    focusTextareaAt(textareaRef, nextValue.length);
  }, []);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = value.trim();
    if (exceedsAttachedImageSendLimit(attachedImages.length)) return;
    const outgoing = prependImageMentions(msg, mentionedImages);
    if (!outgoing && !attachedImages.length) return;
    onAudioUnlock?.();
    if (!attachedImages.length && onBuiltinCommand && canRunBuiltinSlashCommandWhileStreaming(msg)) {
      void runBuiltinCommand(msg);
      return;
    }
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    const images = attachedImages.length ? attachedImages : undefined;
    if (msg.startsWith("/") && onPromptWithStreamingBehavior) {
      clearInput();
      onPromptWithStreamingBehavior(msg, streamingBehavior, images);
      return;
    }
    clearInput();
    if (mode === "steer" && onSteer) {
      onSteer(outgoing, images);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(outgoing, images);
    }
  }, [value, attachedImages, mentionedImages, onBuiltinCommand, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, runBuiltinCommand]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const sendWithShift = !isMobile && isShiftEnterToSend();
      const sendShortcut = e.key === "Enter" && e.shiftKey === sendWithShift && (!isMobile || e.ctrlKey || e.metaKey);
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (sendShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          dismissHistoryMenu();
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex((index) => displayedSlashCommands.length === 0
            ? 0
            : (index + 1) % displayedSlashCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex((index) => displayedSlashCommands.length === 0
            ? 0
            : (index - 1 + displayedSlashCommands.length) % displayedSlashCommands.length);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        const selectedCommand = displayedSlashCommands[slashActiveIndex];
        if (e.key === "Tab" && selectedCommand) {
          e.preventDefault();
          applySlashCommand(selectedCommand);
          return;
        }
        if (sendShortcut && selectedCommand) {
          e.preventDefault();
          const canSubmitNow = !isStreaming
            || (selectedCommand.source === "builtin" && selectedCommand.availableWhileStreaming === true);
          if (canSubmitNow && isExactSlashCommand(value, selectedCommand)) {
            setSlashMenuOpen(false);
            void handleSend();
          } else {
            applySlashCommand(selectedCommand);
          }
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => atMatches.length === 0 ? 0 : (i + 1) % atMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => atMatches.length === 0 ? 0 : (i - 1 + atMatches.length) % atMatches.length);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !value && !isComposing && !isStreaming && inputHistory.length > 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        historyStashRef.current = { text: value };
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      if (e.key === "Escape" && (imageMenuOpen || controlsMenuOpen || thinkingDropdownOpen)) {
        e.preventDefault();
        setImageMenuOpen(false);
        setControlsMenuOpen(false);
        setControlsView("root");
        setThinkingDropdownOpen(false);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (sendShortcut) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          sendQueued((e.altKey && onFollowUp) || !onSteer ? "followup" : "steer");
        } else {
          handleSend();
        }
      }
    },
    [isMobile, isStreaming, onSteer, onFollowUp, onAbort, imageMenuOpen, controlsMenuOpen, thinkingDropdownOpen, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, dismissHistoryMenu, value]
  );

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!compact && imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }

    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html || !text) return;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(parsed.querySelectorAll("a[href]"), (link) => {
      const label = link.textContent ?? "";
      const range = parsed.createRange();
      range.setStart(parsed.body, 0);
      range.setEndBefore(link);
      return {
        label,
        href: link.getAttribute("href")?.trim() ?? "",
        occurrence: label ? range.toString().split(label).length - 1 : 0,
      };
    });
    const markdown = replaceLinksWithMarkdown(text, links);
    if (markdown === null) return;

    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
    e.preventDefault();
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, start + markdown.length);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, [compact, processImageFiles, updateAtQuery]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  // Lazy-load skill dormancy (disable-model-invocation) each time the slash
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (!slashMenuOpen || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, cwd]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useLayoutEffect(() => {
    if (!slashMenuOpen || slashQuery === null) {
      setSlashMenuMaxHeight(null);
      return;
    }
    const menu = slashMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [slashMenuOpen, slashQuery]);

  useLayoutEffect(() => {
    if (!atMenuOpen || atQuery === null) {
      setAtMenuMaxHeight(null);
      return;
    }
    const menu = atMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setAtMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [atMenuOpen, atQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelSelectorOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const rawToolPresetLabel = Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? CONFIGURED_TOOL_PRESET))?.[0] ?? "configured";
  const toolPresetLabel = rawToolPresetLabel === "chat-only" ? t("chat.chatOnly") : rawToolPresetLabel;
  const toolPresetOffDefault = rawToolPresetLabel !== "configured";
  const showSessionMenu = Boolean(onToolPresetChange || onCompact);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(target)) {
        setThinkingDropdownOpen(false);
      }
      if (imageMenuRef.current && !imageMenuRef.current.contains(target)) {
        setImageMenuOpen(false);
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(target)) {
        setControlsMenuOpen(false);
        setControlsView("root");
      }
      if (statsButtonRef.current && !statsButtonRef.current.contains(target)) {
        setStatsActive(false);
      }
      if (slashMenuRef.current && !slashMenuRef.current.contains(target) && !textareaRef.current?.contains(target)) {
        setSlashMenuOpen(false);
      }
      if (atMenuRef.current && !atMenuRef.current.contains(target) && !textareaRef.current?.contains(target)) {
        setAtMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(target) && !textareaRef.current?.contains(target)) {
        dismissHistoryMenu();
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => {
      document.removeEventListener("pointerdown", handler);
    };
  }, [dismissHistoryMenu]);

  const contextPercent = contextUsage && contextUsage.contextWindow > 0
    ? contextUsage.percent ?? (contextUsage.tokens !== null ? (contextUsage.tokens / contextUsage.contextWindow) * 100 : null)
    : null;

  // Context usage is a readout: it opens the usage panel, never compacts. Color only past 70%.
  const renderContextUsageWidget = () => {
    if (!contextUsage || contextPercent === null) return null;
    const windowTokens = contextUsage.contextWindow;
    const tokens = contextUsage.tokens;
    const isHigh = contextPercent >= 85;
    const isWarning = contextPercent >= 70 && !isHigh;
    const remaining = tokens !== null ? Math.max(0, windowTokens - tokens) : null;
    const tooltip = [
      `${t("chat.contextUsage")}: ${tokens !== null ? formatTokensK(tokens) : "?"} / ${formatTokensK(windowTokens)} (${contextPercent.toFixed(1)}%)`,
      remaining !== null ? `${t("chat.contextRemaining")}: ${formatTokensK(remaining)}` : null,
      cacheHitRate !== null && cacheHitRate !== undefined
        ? `${t("session.cacheHitRate")}: ${cacheHitRate.toFixed(1)}%`
        : null,
      isHigh ? t("chat.contextHighWarning") : null,
    ].filter(Boolean).join("\n");

    return (
      <button
        ref={statsButtonRef}
        type="button"
        className={`composer-btn chat-input-context${isHigh ? " is-high" : isWarning ? " is-warning" : ""}`}
        aria-pressed={onOpenSessionStats ? statsActive : undefined}
        onClick={() => {
          setStatsActive((v) => !v);
          onOpenSessionStats?.();
        }}
        title={tooltip}
        aria-label={tooltip}
        data-top-panel-trigger={onOpenSessionStats ? "session" : undefined}
        aria-controls={onOpenSessionStats ? "workspace-top-panel" : undefined}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" opacity="0.3" />
          <circle cx="8" cy="8" r="6" pathLength="100" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeDasharray={`${Math.min(100, Math.round(contextPercent))} 100`} />
        </svg>
        <span>{tokens !== null ? formatTokensK(tokens) : "?"}/{formatTokensK(windowTokens)}</span>
        {cacheHitRate !== null && cacheHitRate !== undefined && (
          <span className="chat-input-context-cache">
            cache {cacheHitRate.toFixed(0)}%
          </span>
        )}
      </button>
    );
  };

  const menuChevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="chat-input-menu-chevron">
      <path d="M4 2.5 6.5 5 4 7.5" />
    </svg>
  );
  const menuCheck = (checked: boolean) => (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="chat-input-menu-check" style={{ visibility: checked ? "visible" : "hidden" }}>
      <polyline points="1.5 5 4 7.5 8.5 2.5" />
    </svg>
  );
  const closeMenuOnEscape = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setImageMenuOpen(false);
    setControlsMenuOpen(false);
    setControlsView("root");
    setThinkingDropdownOpen(false);
    textareaRef.current?.focus();
  };

  const arrowUpIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5m-7 7 7-7 7 7" />
    </svg>
  );
  const stopIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
  const followUpShortcut = isMobile ? "Control+Alt+Enter Meta+Alt+Enter" : "Alt+Enter";
  // One filled slot carries the Enter verb: Send, Stop, or Steer. While a run is live and a
  // draft is ready, a quiet Stop and the Alt+Enter follow-up queue join it. Icons only; the
  // titles carry the words and shortcuts.
  const actionButtons = !isStreaming ? (
    <button
      type="button"
      className="composer-send"
      aria-label={t("chat.send")}
      title={imageSendBlocked ? t("chat.tooManyImagesTitle") : t("chat.send")}
      onClick={handleSend}
      disabled={!canSendMessage}
    >
      {arrowUpIcon}
    </button>
  ) : !canQueueStreamingMessage ? (
    <button type="button" className="composer-send" aria-label={t("chat.stop")} title={t("chat.stopAgent")} onClick={onAbort}>
      {stopIcon}
    </button>
  ) : (
    <>
      <button type="button" className="composer-btn is-icon" aria-label={t("chat.stop")} title={t("chat.stopAgent")} onClick={onAbort}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.9" />
          <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
        </svg>
      </button>
      {onSteer && onFollowUp && (
        <button
          type="button"
          className="composer-btn is-icon"
          aria-label={t("chat.followUp")}
          title={`${t("chat.followUpHint")} (${isMobile ? "Ctrl/Cmd+" : ""}Alt/Option+Enter)`}
          aria-keyshortcuts={followUpShortcut}
          onClick={() => sendQueued("followup")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="composer-send"
        aria-label={onSteer ? t("chat.steer") : t("chat.followUp")}
        title={onSteer ? t("chat.steerHint") : t("chat.followUpHint")}
        onClick={() => sendQueued(onSteer ? "steer" : "followup")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14m-6-6 6 6-6 6" />
        </svg>
      </button>
    </>
  );

  useEffect(() => {
    if (!isStreaming) return;
    setThinkingDropdownOpen(false);
    setControlsView("root");
    setImageMenuOpen(false);
    setControlsMenuOpen(false);
  }, [isStreaming]);

  const historyListboxId = `${menuId}-history`;
  const slashListboxId = `${menuId}-slash`;
  const fileListboxId = `${menuId}-files`;
  const activeListboxId = historyMenuOpen && inputHistory.length > 0
    ? historyListboxId
    : slashMenuOpen && slashQuery !== null
      ? slashListboxId
      : atMenuOpen && atQuery !== null
        ? fileListboxId
        : undefined;
  const activeOptionId = activeListboxId === historyListboxId && inputHistory[historyActiveIndex] !== undefined
    ? `${historyListboxId}-${historyActiveIndex}`
    : activeListboxId === slashListboxId && displayedSlashCommands[slashActiveIndex]
      ? `${slashListboxId}-${slashActiveIndex}`
      : activeListboxId === fileListboxId && atMatches[atActiveIndex]
        ? `${fileListboxId}-${atActiveIndex}`
        : undefined;

  return (
    <fieldset
      disabled={builtinCommandPending}
      aria-busy={builtinCommandPending}
      className={compact ? "chat-input is-compact" : "chat-input"}
      style={{
        flexShrink: 0,
        minWidth: 0,
        margin: 0,
        border: 0,
        background: "transparent",
        padding: compact ? 0 : "0 16px 8px",
        paddingRight: compact ? 0 : 16,
        opacity: builtinCommandPending ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {/* Hidden file input */}
      {!compact && <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />}
      <div style={{ maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {imageSendBlocked && (
          <ModelNoticeBanner
            tone="error"
            title={t("chat.tooManyImagesTitle")}
            body={t("chat.tooManyImagesBody", { count: attachedImages.length, max: MAX_ATTACHED_IMAGES })}
          />
        )}
        {showImageUnsupportedWarning && (() => {
          const entry = modelList?.find((m) => m.provider === model?.provider && m.id === model?.modelId);
          return (
            <ModelNoticeBanner
              tone="warning"
              title={t("chat.imageNotSupportedTitle")}
              body={t("chat.imageNotSupportedBody", { model: entry?.name || model?.modelId || "" })}
              onClose={() => setImageWarningDismissed(true)}
            />
          );
        })()}
        {/* Queued steering / follow-up messages (delivered by pi on upcoming turns) */}
        {((queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)) > 0 && (
          <div style={{
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                {t("chat.queued", { count: (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) })}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                   title={t("chat.recallTitle")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                   {t("chat.recall")}
                </button>
              )}
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div className="chat-input-feedback chat-input-feedback-warning">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div className="chat-input-feedback chat-input-feedback-success">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div role="alert" className="chat-input-feedback chat-input-feedback-error chat-input-feedback-detail" style={{ whiteSpace: "pre-wrap" }}>
            {compactError}
          </div>
        )}
        {(draftPersistenceFailed || draftPersistenceWarning) && (
          <div role="status" className="chat-input-feedback chat-input-feedback-warning chat-input-feedback-draft">
            {t("chat.draftPageOnly")}
          </div>
        )}
        {/* Main input */}
        <div ref={composerBoxRef} style={{ position: "relative", minWidth: 0 }}>
          {slashUsage && !slashMenuOpen && (
            <div
              style={{
                position: "absolute",
                left: 0,
                bottom: "calc(100% + 6px)",
                zIndex: 119,
                height: 24,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0 8px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1,
                color: "var(--text-dim)",
                opacity: slashUsage.hasArgument ? 0.45 : 1,
                pointerEvents: "none",
              }}
            >
              <span style={{ color: "var(--text-muted)" }}>Usage:</span>
              <span style={{ color: "var(--text)" }}>/{slashUsage.command}</span>
              <span>{slashUsage.signature}</span>
            </div>
          )}
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              className="popover-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title={t("chat.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div id={historyListboxId} role="listbox" style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      id={`${historyListboxId}-${index}`}
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 4,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              ref={slashMenuRef}
              className="popover-surface"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: slashMenuMaxHeight === null
                  ? "min(72.8vh, 598px)"
                  : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                 <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                 <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div id={slashListboxId} role="listbox" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 6 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                     {t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 8 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -6,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 8px 3px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                        }}
                      >
                        <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)" }}>{group.items.length}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              id={`${slashListboxId}-${index}`}
                              role="option"
                              aria-selected={active}
                              tabIndex={-1}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                height: 30,
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                padding: "0 8px",
                                border: "none",
                                borderRadius: 4,
                                background: active ? "var(--bg-selected)" : "none",
                                color: dormant ? "var(--text-dim)" : "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                transition: "background 0.08s ease",
                              }}
                            >
                              <span style={{
                                flexShrink: 0,
                                fontSize: 12,
                                fontFamily: "var(--font-mono)",
                                whiteSpace: "nowrap",
                                color: active ? "var(--text)" : (dormant ? "var(--text-dim)" : "var(--text)"),
                              }}>
                                {renderSlashCommandName(command.name, slashQuery)}
                                {command.source === "builtin" && BUILTIN_SIGNATURES[command.name] && (
                                  <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11, fontWeight: 400 }}>
                                    {BUILTIN_SIGNATURES[command.name]}
                                  </span>
                                )}
                                {dormant && (
                                  <span style={{
                                    marginLeft: 6,
                                    padding: "0 4px",
                                    border: "1px solid var(--border)",
                                    borderRadius: 3,
                                    fontSize: 11,
                                    color: "var(--text-dim)",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {t("chat.dormant")}
                                  </span>
                                )}
                              </span>
                              <span style={{
                                flex: "1 1 auto",
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                color: "var(--text-dim)",
                                fontSize: 12,
                              }}>
                                {getSlashDescription(command, t)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.serverHardTruncated
               ? t("chat.serverIndexTruncated")
               : fileIndex?.clientTruncated && !serverResultInUse
                 ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
                : "";
            return (
              <div
                ref={atMenuRef}
                className="popover-surface"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  overflow: "hidden",
                  boxSizing: "border-box",
                  display: "flex",
                  flexDirection: "column",
                  maxHeight: atMenuMaxHeight === null
                    ? "min(48vh, 400px)"
                    : `min(48vh, 400px, ${atMenuMaxHeight}px)`,
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div id={fileListboxId} role="listbox" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          id={`${fileListboxId}-${index}`}
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            height: 30,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "0 8px",
                            border: "none",
                            borderRadius: 4,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12,
                            fontFamily: "var(--font-mono)",
                            transition: "background 0.08s ease",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={13} /> : getFileIcon(name, 13)}
                          </span>
                          <span style={{ flexShrink: 0, color: "var(--text)", whiteSpace: "nowrap" }}>
                            {highlightText(name, atQuery?.query ?? null)}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                          {dirPrefix && (
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }}>
                              {dirPrefix}
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            className={`chat-input-composer${bashMode ? " is-bash-mode" : ""}${bashMode && bashExcluded ? " is-bash-excluded" : ""}`}
          >
          {/* Image previews */}
          {(attachedImages.length > 0 || mentionedImages.length > 0) && (
            <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              {mentionedImages.map((path) => (
                <ImageMentionChip
                  key={path}
                  path={path}
                  cwd={cwd ?? undefined}
                  onRemove={() => setMentionedImages((prev) => prev.filter((item) => item !== path))}
                />
              ))}
              {attachedImages.map((img, i) => (
                <div key={i} className="chat-input-image-preview">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.previewUrl} alt="" />
                  <button
                    type="button"
                    className="chat-input-image-remove"
                    onClick={() => removeImage(i)}
                    title={t("i18n.close")}
                    aria-label={t("i18n.close")}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {bashMode && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 6px",
                borderRadius: 4,
                background: bashExcluded ? "rgba(100,116,139,0.12)" : "rgba(37,99,235,0.12)",
                color: bashExcluded ? "var(--text-muted)" : "var(--accent)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                flexShrink: 0,
                alignSelf: "flex-start",
                userSelect: "none",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden="true">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span style={{ lineHeight: 1 }}>{bashExcluded ? "Local" : "Shell"}</span>
            </div>
          )}
          <div className="chat-input-field-row">
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={Boolean(activeListboxId)}
            aria-controls={activeListboxId}
            aria-activedescendant={activeOptionId}
            aria-label={compact ? t("chat.quoteQuestion") : t("chat.message")}
            disabled={disabled}
            placeholder={disabled ? t("agentSwitcher.status.queued") : undefined}
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setCursorPosition(e.target.selectionStart);
              historyStashRef.current = null;
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              setCursorPosition(el.selectionStart);
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              setCursorPosition(el.selectionStart);
              updateAtQuery(el.value, el.selectionStart);
            }}
            onPaste={handlePaste}
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-content-font-size, 14px)",
              lineHeight: 1.5,
              // Center a 21px line on the 24px action row.
              padding: compact ? 0 : "2px 0 1px",
              fontFamily: bashMode ? "var(--font-mono)" : "var(--font-chat)",
              minHeight: compact ? 96 : 24,
              maxHeight: 200,
            }}
          />
          <div className="chat-input-actions">{actionButtons}</div>
          </div>

          {!compact && (
            <div className="chat-input-dock">
              <div ref={imageMenuRef} className="chat-input-popover-anchor">
                <button
                  type="button"
                  className="composer-btn is-icon"
                  disabled={disabled}
                  data-active={attachedImages.length > 0 || undefined}
                  onClick={() => {
                    if (onOpenImageGeneration) {
                      setControlsMenuOpen(false);
                      setThinkingDropdownOpen(false);
                      setImageMenuOpen((prev) => !prev);
                    } else {
                      fileInputRef.current?.click();
                    }
                  }}
                  title={onOpenImageGeneration ? `${t("chat.attachImage")} / ${t("image.title")}` : t("chat.attachImage")}
                  aria-label={onOpenImageGeneration ? `${t("chat.attachImage")} / ${t("image.title")}` : t("chat.attachImage")}
                  aria-expanded={onOpenImageGeneration ? imageMenuOpen : undefined}
                  aria-haspopup={onOpenImageGeneration ? "menu" : undefined}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </button>
                {imageMenuOpen && onOpenImageGeneration && (
                  <div role="menu" className="chat-input-menu menu-surface" style={{ left: 0 }} onKeyDown={closeMenuOnEscape}>
                    <button type="button" role="menuitem" onClick={() => { setImageMenuOpen(false); fileInputRef.current?.click(); }}>{t("chat.attachImage")}</button>
                    <button type="button" role="menuitem" onClick={() => { setImageMenuOpen(false); const [only] = attachedImagesRef.current.length === 1 ? attachedImagesRef.current : []; onOpenImageGeneration(only ? imageToDraftImage(only) : undefined); }}>{t("image.title")}</button>
                  </div>
                )}
              </div>
              {(modelOptions.length > 0 || model || modelError) && onModelChange && (
                <ModelSelector
                  options={modelOptions}
                  value={model}
                  onChange={onModelChange}
                  disabled={isStreaming}
                  busy={modelSwitching}
                  isAutoSelection={isAutoModelSelection}
                />
              )}
              {onThinkingLevelChange && (
                <div ref={thinkingDropdownRef} className="chat-input-popover-anchor">
                  <button
                    type="button"
                    className="composer-btn"
                    onClick={() => {
                      setControlsMenuOpen(false);
                      setImageMenuOpen(false);
                      setThinkingDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    title={t("chat.changeReasoning", { level: thinkingDisplayLabel })}
                    aria-label={t("chat.changeReasoningLabel")}
                    aria-haspopup="menu"
                    aria-expanded={thinkingDropdownOpen}
                  >
                    <ThinkingIcon size={13} />
                    <span>{thinkingDisplayLabel}</span>
                  </button>
                  {thinkingDropdownOpen && (
                    <div role="menu" className="chat-input-menu menu-surface" style={{ left: 0 }} onKeyDown={closeMenuOnEscape}>
                      {THINKING_LEVELS.filter((lvl) => {
                        if (!availableThinkingLevels) return true;
                        if (lvl === "auto") return true;
                        return availableThinkingLevels.includes(lvl);
                      }).map((lvl) => {
                        const isActive = (thinkingLevel ?? "auto") === lvl;
                        const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                        const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                        return (
                          <button
                            key={lvl}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isActive}
                            onClick={() => {
                              setThinkingDropdownOpen(false);
                              if (!isActive) onThinkingLevelChange(lvl);
                            }}
                          >
                            {menuCheck(isActive)}
                            <span>{displayLabel}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <div className="chat-input-dock-spacer" />
              {renderContextUsageWidget()}
              {showSessionMenu && (
                <div ref={controlsMenuRef} className="chat-input-popover-anchor">
                  <button
                    type="button"
                    className={`composer-btn${toolPresetOffDefault && onToolPresetChange ? " is-flagged" : " is-icon"}`}
                    aria-label={t("chat.moreControls")}
                    aria-haspopup="menu"
                    aria-expanded={controlsMenuOpen}
                    title={toolPresetOffDefault && onToolPresetChange ? `${t("chat.changeToolPreset")}: ${toolPresetLabel}` : t("chat.moreControls")}
                    onClick={() => {
                      setImageMenuOpen(false);
                      setThinkingDropdownOpen(false);
                      setControlsView("root");
                      setControlsMenuOpen((open) => !open);
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
                      <circle cx="15" cy="7" r="2" />
                      <circle cx="9" cy="17" r="2" />
                    </svg>
                    {toolPresetOffDefault && onToolPresetChange && <span className="composer-tools-label">{rawToolPresetLabel}</span>}
                  </button>
                  {controlsMenuOpen && (
                    <div role="menu" className="chat-input-menu menu-surface" style={{ right: 0, minWidth: 180 }} onKeyDown={closeMenuOnEscape}>
                      {controlsView !== "root" ? (
                        <>
                          <button type="button" role="menuitem" className="chat-input-menu-back" onClick={() => setControlsView("root")}>
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M6 2.5 3.5 5 6 7.5" />
                            </svg>
                            <span>{controlsView}</span>
                          </button>
                          {controlsView === "tools" && onToolPresetChange && TOOL_PRESETS.map((lvl) => {
                            const preset = TOOL_PRESET_MAP[lvl];
                            const isActive = (toolPreset ?? CONFIGURED_TOOL_PRESET) === preset;
                            return (
                              <button
                                key={lvl}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isActive}
                                onClick={() => {
                                  setControlsMenuOpen(false);
                                  if (!isActive) onToolPresetChange(preset);
                                }}
                              >
                                {menuCheck(isActive)}
                                <span>{lvl}</span>
                              </button>
                            );
                          })}
                          {controlsView === "compact" && onCompact && (
                            // A second step so a stray click cannot rewrite the context.
                            <button
                              type="button"
                              role="menuitem"
                              disabled={isStreaming}
                              onClick={() => {
                                setControlsMenuOpen(false);
                                onCompact();
                              }}
                            >
                              {menuCheck(false)}
                              <span>{t("chat.compactConfirm")}</span>
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {onToolPresetChange && (
                            <button type="button" role="menuitem" aria-haspopup="menu" disabled={isStreaming} onClick={() => setControlsView("tools")}>
                              <span>tools</span>
                              <span className="chat-input-menu-note">{rawToolPresetLabel}</span>
                              {menuChevron}
                            </button>
                          )}
                          {onCompact && (isCompacting ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setControlsMenuOpen(false);
                                onAbortCompaction?.();
                              }}
                            >
                              <span>{t("chat.stopCompaction")}</span>
                            </button>
                          ) : (
                            <button type="button" role="menuitem" aria-haspopup="menu" disabled={isStreaming} onClick={() => setControlsView("compact")}>
                              <span>compact</span>
                              {contextPercent !== null && <span className="chat-input-menu-note">{Math.round(contextPercent)}%</span>}
                              {menuChevron}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}

      </div>
    </fieldset>
  );
});
