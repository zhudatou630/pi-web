"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { imageRatioKind, type ImageConfigView, type ImageConnectionView, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-generation";
import type { Base64ImageAttachment } from "@/lib/image-attachments";
import { compressImageFile } from "./ChatInput";

function selectedOption(connection: ImageConnectionView | undefined, list: "sizes" | "resolutions" | "qualities", fallback: "size" | "resolution" | "quality", preferred?: string): string {
  const values = connection?.capabilities[list];
  if (preferred && values?.includes(preferred)) return preferred;
  const configured = connection?.defaults?.[fallback];
  if (configured && values?.includes(configured)) return configured;
  if (values?.includes("auto")) return "auto";
  return values?.[0] ?? "";
}

function ratioLabel(t: (key: string) => string, value: string): string {
  const kind = imageRatioKind(value);
  if (kind === "auto") return t("image.aspectAuto");
  if (kind === "square") return `${t("image.aspectSquare")} ${value}`;
  if (kind === "portrait") return `${t("image.aspectPortrait")} ${value}`;
  if (kind === "landscape") return `${t("image.aspectLandscape")} ${value}`;
  return value;
}

function resolutionLabel(value: string): string {
  return value.toUpperCase();
}

function qualityLabel(t: (key: string) => string, value: string): string {
  if (value === "auto") return t("image.qualityAuto");
  if (value === "low") return t("image.qualityLow");
  if (value === "medium") return t("image.qualityMedium");
  if (value === "high") return t("image.qualityHigh");
  return value;
}

function CompactSelect({ value, label, onChange, children }: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="relative inline-flex flex-none items-center">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="image-generation-select appearance-none bg-transparent py-1 pl-1.5 pr-5 text-[12px] text-text-muted outline-none hover:text-text focus:text-text"
      >
        {children}
      </select>
      <svg className="pointer-events-none absolute right-0.5 top-1/2 -translate-y-1/2 text-text-dim" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </label>
  );
}

export function ImageGenerationDialog({ config, edit, editPreviewUrl, initialSourceImage, onClose, onSubmit }: {
  config: ImageConfigView;
  edit?: ImageGenerationResult | null;
  editPreviewUrl?: string;
  /** Source image for a new edit (not used when editing a generated result). */
  initialSourceImage?: Base64ImageAttachment;
  onClose: () => void;
  onSubmit: (request: ImageGenerationRequest, sourceImage?: Base64ImageAttachment) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const editableConnections = config.connections.filter((item) => item.capabilities.editing === true);
  const [sourceImage, setSourceImage] = useState(() => (edit || !editableConnections.length ? undefined : initialSourceImage));
  const editing = Boolean(edit || sourceImage);
  const connections = editing ? editableConnections : config.connections;
  const [connectionId, setConnectionId] = useState(() => (
    edit?.connection && config.connections.some((item) => item.id === edit.connection) ? edit.connection : config.defaultConnection
  ));
  useEffect(() => {
    if (connections.some((item) => item.id === connectionId)) return;
    setConnectionId(connections.some((item) => item.id === config.defaultConnection) ? config.defaultConnection : connections[0]?.id ?? "");
  }, [config.defaultConnection, connections, connectionId]);
  const connection = connections.find((item) => item.id === connectionId) ?? connections[0];
  const canAttachSource = !edit && editableConnections.length > 0;
  const attachSource = (files: Iterable<File>) => {
    const file = Array.from(files).find((item) => item.type.startsWith("image/"));
    if (!file) return false;
    void compressImageFile(file).then(setSourceImage, (error) => console.error("Failed to read source image:", error));
    return true;
  };
  const [size, setSize] = useState(() => selectedOption(connection, "sizes", "size", edit?.size));
  const [resolution, setResolution] = useState(() => selectedOption(connection, "resolutions", "resolution", edit?.resolution));
  const [quality, setQuality] = useState(() => selectedOption(connection, "qualities", "quality", edit?.quality));
  const sizeChoices = connection?.capabilities.sizes ?? [];
  const resolutionChoices = connection?.capabilities.resolutions ?? [];
  const qualityChoices = connection?.capabilities.qualities ?? [];
  const showConnection = connections.length > 1;
  const previewUrl = edit ? editPreviewUrl : sourceImage ? `data:${sourceImage.mimeType};base64,${sourceImage.data}` : undefined;

  const resizePrompt = () => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  useLayoutEffect(resizePrompt, [prompt]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    if (!window.matchMedia("(max-width: 640px)").matches) promptRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
    };
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
      ...(edit ? { target: edit.path } : sourceImage ? {} : { new_image: true }),
    };
    onClose();
    void onSubmit(request, edit ? undefined : sourceImage);
  };

  return (
    <div role="presentation" className="fixed inset-0 z-[1100] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-generation-title"
        tabIndex={-1}
        onDragOver={(event) => { if (canAttachSource && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (canAttachSource && attachSource(event.dataTransfer.files)) event.preventDefault(); }}
        className="flex max-h-[min(92dvh,100%)] w-full max-w-full flex-col overflow-hidden rounded-t-[16px] border border-border/80 bg-bg-panel shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:w-[480px] sm:rounded-[12px]"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), select:not(:disabled), input:not(:disabled)") ?? []).filter((element) => element.offsetParent !== null);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        <header className="flex h-10 shrink-0 items-center px-4 sm:h-11">
          <h2 id="image-generation-title" className="text-[14px] font-semibold text-text">{editing ? t("image.editTitle") : t("image.title")}</h2>
          <button type="button" onClick={onClose} className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md border-0 bg-transparent text-text-muted hover:bg-bg-hover hover:text-text" title={t("trust.cancel")} aria-label={t("trust.cancel")}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-4">
          <div className={previewUrl ? "flex flex-col gap-3 sm:flex-row sm:items-start" : undefined}>
            {previewUrl ? (
              <div className="relative overflow-hidden rounded-[10px] sm:shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt={edit?.prompt ?? t("image.editSource")} className="block h-auto w-full sm:h-28 sm:w-auto sm:max-w-[7.5rem]" />
                {!edit ? (
                  <button type="button" onClick={() => setSourceImage(undefined)} className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full border-0 bg-black/60 text-white hover:bg-black/80" title={t("image.removeSource")} aria-label={t("image.removeSource")}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                ) : null}
              </div>
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
              className={`image-generation-prompt w-full resize-none rounded-[10px] border-0 bg-bg px-3 py-2.5 leading-[1.5] text-text outline-none ring-1 ring-inset ring-transparent placeholder:text-text-dim focus:ring-accent/50 ${previewUrl ? "sm:min-h-28 sm:flex-1" : ""}`}
              style={{ fontFamily: "var(--font-chat)", fontSize: "var(--chat-content-font-size, 14px)" }}
            />
          </div>
        </div>

        <footer className="flex shrink-0 items-center gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5">
            {canAttachSource && !sourceImage ? (
              <>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-md border-0 bg-transparent text-text-muted hover:bg-bg-hover hover:text-text" title={t("image.addSource")} aria-label={t("image.addSource")}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => { attachSource(event.target.files ?? []); event.target.value = ""; }} />
              </>
            ) : null}
            {showConnection ? (
              <CompactSelect value={connectionId} label={t("image.connection")} onChange={setConnectionId}>
                {config.connections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </CompactSelect>
            ) : null}
            {sizeChoices.length ? (
              <CompactSelect value={size} label={t("image.aspect")} onChange={setSize}>
                {sizeChoices.map((value) => <option key={value} value={value}>{ratioLabel(t, value)}</option>)}
              </CompactSelect>
            ) : null}
            {resolutionChoices.length ? (
              <CompactSelect value={resolution} label={t("image.resolution")} onChange={setResolution}>
                {resolutionChoices.map((value) => <option key={value} value={value}>{resolutionLabel(value)}</option>)}
              </CompactSelect>
            ) : null}
            {qualityChoices.length ? (
              <CompactSelect value={quality} label={t("image.quality")} onChange={setQuality}>
                {qualityChoices.map((value) => <option key={value} value={value}>{qualityLabel(t, value)}</option>)}
              </CompactSelect>
            ) : null}
          </div>
          <button type="button" disabled={!prompt.trim()} onClick={submit} className="h-8 shrink-0 rounded-md border-0 bg-accent px-3 text-[12px] text-white disabled:cursor-not-allowed disabled:opacity-50">{editing ? t("image.edit") : t("image.generate")}</button>
        </footer>
      </div>
    </div>
  );
}
