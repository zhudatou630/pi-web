import type { ExtensionWidget } from "./extension-widget";

const store = ((globalThis as typeof globalThis & {
  __piExtensionWidgets?: Map<string, ExtensionWidget>;
}).__piExtensionWidgets ??= new Map());

export function getExtensionWidget(sessionId: string): ExtensionWidget | null {
  return store.get(sessionId) ?? null;
}

export function setExtensionWidget(sessionId: string, widget: ExtensionWidget | null): void {
  if (widget) store.set(sessionId, widget);
  else store.delete(sessionId);
}
