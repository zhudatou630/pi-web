"use client";

import { ImageAttachmentStrip } from "./ImageAttachmentStrip";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { Select, type SelectOption } from "./Select";
import { useI18n } from "@/hooks/useI18n";
import { imageRatioKind, MAX_REFERENCE_IMAGES, type ImageConfigView, type ImageConnectionView, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-generation";
import type { Base64ImageAttachment } from "@/lib/image-attachments";
import { compressImageFile } from "./ChatInput";
import { ConfigButton } from "./SettingsUi";

function selectedOption(connection: ImageConnectionView | undefined, list: "sizes" | "resolutions" | "qualities", fallback: "size" | "resolution" | "quality", preferred?: string): string {
  const values = connection?.capabilities[list];
  if (preferred && values?.includes(preferred)) return preferred;
  const configured = connection?.defaults?.[fallback];
  if (configured && values?.includes(configured)) return configured;
  if (values?.includes("auto")) return "auto";
  return values?.[0] ?? "";
}

export function ratioLabel(t: (key: string) => string, value: string): string {
  const kind = imageRatioKind(value);
  if (kind === "auto") return t("image.aspectAuto");
  if (kind === "square") return `${t("image.aspectSquare")} ${value}`;
  if (kind === "portrait") return `${t("image.aspectPortrait")} ${value}`;
  if (kind === "landscape") return `${t("image.aspectLandscape")} ${value}`;
  return value;
}

export function resolutionLabel(value: string): string {
  return value.toUpperCase();
}

export function qualityLabel(t: (key: string) => string, value: string): string {
  if (value === "auto") return t("image.qualityAuto");
  if (value === "low") return t("image.qualityLow");
  if (value === "medium") return t("image.qualityMedium");
  if (value === "high") return t("image.qualityHigh");
  return value;
}

function CompactSelect({ value, label, onChange, options }: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  options: SelectOption[];
}) {
  return (
    <Select ariaLabel={label} value={value} onChange={onChange} options={options} className="select-trigger is-inline image-generation-select" />
  );
}

export function ImageGenerationDialog({ config, edit, editPreviewUrl, initialSourceImages, onClose, onSubmit }: {
  config: ImageConfigView;
  edit?: ImageGenerationResult | null;
  editPreviewUrl?: string;
  /** Source images carried over from the composer; they follow the edited result, if any. */
  initialSourceImages?: Base64ImageAttachment[];
  onClose: () => void;
  onSubmit: (request: ImageGenerationRequest, sourceImages: Base64ImageAttachment[]) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const editableConnections = config.connections.filter((item) => item.capabilities.editing === true);
  // The edited result stays first and fixed; uploaded sources follow, up to the reference limit.
  const sourceLimit = MAX_REFERENCE_IMAGES - (edit ? 1 : 0);
  const [sourceImages, setSourceImages] = useState<Base64ImageAttachment[]>(() => (
    editableConnections.length ? (initialSourceImages ?? []).slice(0, sourceLimit) : []
  ));
  const editing = Boolean(edit || sourceImages.length);
  const connections = editing ? editableConnections : config.connections;
  const [connectionId, setConnectionId] = useState(() => (
    edit?.connection && config.connections.some((item) => item.id === edit.connection) ? edit.connection : config.defaultConnection
  ));
  useEffect(() => {
    if (connections.some((item) => item.id === connectionId)) return;
    setConnectionId(connections.some((item) => item.id === config.defaultConnection) ? config.defaultConnection : connections[0]?.id ?? "");
  }, [config.defaultConnection, connections, connectionId]);
  const connection = connections.find((item) => item.id === connectionId) ?? connections[0];
  const canAttachSource = editableConnections.length > 0 && sourceImages.length < sourceLimit;
  const attachSource = (files: Iterable<File>) => {
    const images = Array.from(files).filter((item) => item.type.startsWith("image/")).slice(0, sourceLimit - sourceImages.length);
    if (!images.length) return false;
    void Promise.all(images.map(compressImageFile)).then(
      (added) => setSourceImages((current) => [...current, ...added].slice(0, sourceLimit)),
      (error) => console.error("Failed to read source image:", error),
    );
    return true;
  };
  const [size, setSize] = useState(() => selectedOption(connection, "sizes", "size", edit?.size));
  const [resolution, setResolution] = useState(() => selectedOption(connection, "resolutions", "resolution", edit?.resolution));
  const [quality, setQuality] = useState(() => selectedOption(connection, "qualities", "quality", edit?.quality));
  const sizeChoices = connection?.capabilities.sizes ?? [];
  const resolutionChoices = connection?.capabilities.resolutions ?? [];
  const qualityChoices = connection?.capabilities.qualities ?? [];
  const showConnection = connections.length > 1;
  const previews = [
    ...(edit && editPreviewUrl ? [{ src: editPreviewUrl, alt: edit.prompt }] : []),
    ...sourceImages.map((image) => ({ src: `data:${image.mimeType};base64,${image.data}`, alt: t("image.editSource") })),
  ];

  const resizePrompt = () => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  useLayoutEffect(resizePrompt, [prompt]);

  // Phones keep the dialog's default focus so the keyboard does not cover the sheet on open.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 640px)").matches) promptRef.current?.focus();
  }, []);

  useEffect(() => {
    const fromEdit = edit && connection?.id === edit.connection ? edit : undefined;
    setSize(selectedOption(connection, "sizes", "size", fromEdit?.size));
    setResolution(selectedOption(connection, "resolutions", "resolution", fromEdit?.resolution));
    setQuality(selectedOption(connection, "qualities", "quality", fromEdit?.quality));
  }, [connection, edit]);

  const submit = () => {
    if (!prompt.trim() || !connection) return;
    const request: ImageGenerationRequest = {
      prompt: prompt.trim(),
      connection: connection.id,
      ...(size ? { size } : {}),
      ...(resolution ? { resolution } : {}),
      ...(quality ? { quality } : {}),
      ...(edit ? { reference_images: [edit.path] } : {}),
    };
    onClose();
    void onSubmit(request, sourceImages);
  };

  return (
    <ModalDialog aria-labelledby="image-generation-title" className="fixed inset-0 flex items-end justify-center bg-[var(--settings-scrim,rgba(0,0,0,0.32))] p-0 sm:items-center sm:p-4" onClose={onClose}>
      <div
        onDragOver={(event) => { if (canAttachSource && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (canAttachSource && attachSource(event.dataTransfer.files)) event.preventDefault(); }}
        className="flex max-h-[min(92dvh,100%)] w-full max-w-full flex-col overflow-hidden rounded-t-[16px] border border-border bg-[var(--bg-elevated)] [box-shadow:var(--ui-shadow-dialog)] sm:max-h-[calc(100dvh-2rem)] sm:w-[480px] sm:rounded-[10px]"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      >
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        <header className="flex h-10 shrink-0 items-center px-4 sm:h-11">
          <h2 id="image-generation-title" className="text-[14px] font-semibold text-text">{editing ? t("image.editTitle") : t("image.title")}</h2>
          <button type="button" onClick={onClose} className="ghost-icon-button ml-auto" title={t("trust.cancel")} aria-label={t("trust.cancel")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-4">
          {previews.length ? (
            <ImageAttachmentStrip
              images={previews}
              lockedCount={edit && editPreviewUrl ? 1 : 0}
              onMove={(from, to) => setSourceImages((current) => {
                const offset = edit && editPreviewUrl ? 1 : 0;
                const next = [...current];
                next.splice(to - offset, 0, ...next.splice(from - offset, 1));
                return next;
              })}
              onRemove={(index) => setSourceImages((current) => current.filter((_, i) => i !== index - (edit && editPreviewUrl ? 1 : 0)))}
            />
          ) : null}
          <textarea
            ref={promptRef}
            id="image-prompt"
            rows={2}
            value={prompt}
            maxLength={32000}
            aria-label={t("image.prompt")}
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={(event) => { if (canAttachSource && attachSource(event.clipboardData.files)) event.preventDefault(); }}
            placeholder={editing ? t("image.editPromptPlaceholder") : t("image.promptPlaceholder")}
            className="image-generation-prompt w-full resize-none rounded-[10px] border-0 bg-[var(--ui-field-bg)] px-3 py-2.5 leading-[1.5] text-text outline-none placeholder:text-text-dim focus:[box-shadow:var(--ui-field-ring)]"
            style={{ fontFamily: "var(--font-chat)", fontSize: "var(--chat-content-font-size, 14px)" }}
          />
        </div>

        <footer className="flex shrink-0 items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5">
            {canAttachSource ? (
              <>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="ghost-icon-button" title={t("image.addSource")} aria-label={t("image.addSource")}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { attachSource(event.target.files ?? []); event.target.value = ""; }} />
              </>
            ) : null}
            {showConnection ? (
              <CompactSelect value={connectionId} label={t("image.connection")} onChange={setConnectionId} options={config.connections.map((item) => ({ value: item.id, label: item.label }))}>
                </CompactSelect>
            ) : null}
            {sizeChoices.length ? (
              <CompactSelect value={size} label={t("image.aspect")} onChange={setSize} options={sizeChoices.map((value) => ({ value, label: ratioLabel(t, value) }))}>
                </CompactSelect>
            ) : null}
            {resolutionChoices.length ? (
              <CompactSelect value={resolution} label={t("image.resolution")} onChange={setResolution} options={resolutionChoices.map((value) => ({ value, label: resolutionLabel(value) }))}>
                </CompactSelect>
            ) : null}
            {qualityChoices.length ? (
              <CompactSelect value={quality} label={t("image.quality")} onChange={setQuality} options={qualityChoices.map((value) => ({ value, label: qualityLabel(t, value) }))}>
                </CompactSelect>
            ) : null}
          </div>
          <ConfigButton variant="primary" className="shrink-0" disabled={!prompt.trim()} onClick={submit}>{editing ? t("image.edit") : t("image.generate")}</ConfigButton>
        </footer>
      </div>
    </ModalDialog>
  );
}
