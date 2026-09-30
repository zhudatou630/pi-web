"use client";

import { useEffect, useMemo, useState } from "react";
import type { ToolEntry } from "@/lib/tool-presets";
import { InfoDialog } from "./InfoDialog";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  tools: ToolEntry[] | null;
  translate: Translate;
}

/** Selection state shared by the dialog header (phone back/title) and the panel body. */
function useToolBrowser(tools: ToolEntry[] | null) {
  const activeTools = useMemo(() => tools?.filter((tool) => tool.active) ?? null, [tools]);
  const [selectedToolName, setSelectedToolName] = useState<string | null>(null);
  // Phone only: the list and one tool's details are two pushed panes, like the settings sheet.
  const [pane, setPane] = useState<"list" | "detail">("list");
  // The list only replays its entry motion when coming back to it; on first open the dialog itself animates.
  const [returned, setReturned] = useState(false);

  useEffect(() => {
    setSelectedToolName((current) => (
      activeTools?.some((tool) => tool.name === current)
        ? current
        : activeTools?.[0]?.name ?? null
    ));
  }, [activeTools]);

  const selectedTool = activeTools?.find((tool) => tool.name === selectedToolName)
    ?? activeTools?.[0]
    ?? null;
  return {
    activeTools,
    selectedTool,
    pane,
    select: (name: string) => { setSelectedToolName(name); setPane("detail"); },
    returned,
    back: () => { setPane("list"); setReturned(true); },
  };
}
type ToolBrowser = ReturnType<typeof useToolBrowser>;

export function ToolDefinitionsDialog({ loading, tools, translate, onClose }: Props & { onClose: () => void }) {
  const browser = useToolBrowser(tools);
  const showingDetail = browser.pane === "detail" && browser.selectedTool;
  return (
    <InfoDialog
      title={translate("tools.title")}
      phoneTitle={showingDetail ? browser.selectedTool!.name : undefined}
      onBack={showingDetail ? browser.back : undefined}
      wide
      onClose={onClose}
    >
      <ToolDefinitionsPanel loading={loading} translate={translate} browser={browser} />
    </InfoDialog>
  );
}

interface ParameterField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  allowedValues?: string;
  defaultValue?: string;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatSchemaType(schema: Record<string, unknown>): string {
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (variants) {
    return variants
      .map((variant) => variant && typeof variant === "object"
        ? formatSchemaType(variant as Record<string, unknown>)
        : "unknown")
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" | ");
  }

  if (schema.const !== undefined) return formatValue(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.type === undefined) {
    return [...new Set(schema.enum.map((value) => value === null ? "null" : typeof value))].join(" | ");
  }

  const rawType = schema.type;
  const type = Array.isArray(rawType)
    ? rawType.filter((value): value is string => typeof value === "string").join(" | ")
    : typeof rawType === "string"
      ? rawType
      : typeof schema.$ref === "string"
        ? schema.$ref.split("/").pop() ?? "object"
        : "unknown";

  if (type === "array") {
    const items = schema.items;
    const itemType = items && typeof items === "object"
      ? formatSchemaType(items as Record<string, unknown>)
      : "unknown";
    return `${itemType}[]`;
  }
  return type;
}

export function getToolParameterFields(parameters?: Record<string, unknown>): ParameterField[] {
  if (!parameters || !parameters.properties || typeof parameters.properties !== "object") return [];
  const properties = parameters.properties as Record<string, unknown>;
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return Object.entries(properties).map(([name, value]) => {
    const schema = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      name,
      type: formatSchemaType(schema),
      description: typeof schema.description === "string" ? schema.description : undefined,
      required: required.has(name),
      allowedValues: Array.isArray(schema.enum) ? schema.enum.map(formatValue).join(", ") : undefined,
      defaultValue: schema.default === undefined ? undefined : formatValue(schema.default),
    };
  });
}

// First sentence of a tool description, shown under its name in the list.
function summarize(description: string): string {
  return description.trim().split(/(?<=[.。])\s/)[0];
}

function EmptyState({ children }: { children: string }) {
  return <div className="tool-definitions-empty">{children}</div>;
}

function ToolDefinitionsPanel({ loading, translate, browser }: Omit<Props, "tools"> & { browser: ToolBrowser }) {
  const { activeTools, selectedTool } = browser;
  const fields = selectedTool ? getToolParameterFields(selectedTool.parameters) : [];

  return (
    <div className="tool-definitions-panel" data-pane={browser.pane} data-returned={browser.returned || undefined}>
      <nav className="tool-definitions-sidebar" aria-label={translate("tools.title")}>
        <div className="tool-definitions-list">
          {activeTools && activeTools.length > 0 ? activeTools.map((tool) => {
            const selected = tool.name === selectedTool?.name;
            return (
              <button
                key={tool.name}
                type="button"
                className={`tool-definitions-item${selected ? " selected" : ""}`}
                aria-pressed={selected}
                onClick={() => browser.select(tool.name)}
              >
                <span className="tool-definitions-name">{tool.name}</span>
                <span className="tool-definitions-summary">{summarize(tool.description)}</span>
                <svg className="tool-definitions-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            );
          }) : activeTools ? (
            <EmptyState>{translate("tools.noTools")}</EmptyState>
          ) : (
            <EmptyState>{loading ? translate("tools.loading") : translate("tools.load")}</EmptyState>
          )}
        </div>
      </nav>

      <section className="tool-definition-detail" aria-label={translate("tools.details")}>
        {selectedTool ? (
          <div className="tool-definition-scroll" key={selectedTool.name}>
            <h3 className="tool-definition-title">{selectedTool.name}</h3>
            {selectedTool.description && (
              <section className="tool-definition-section">
                <div className="tool-definition-section-label">{translate("tools.description")}</div>
                <div className="tool-definition-description">{selectedTool.description}</div>
              </section>
            )}

            <section className="tool-definition-section">
              <div className="tool-definition-section-label">
                <span>{translate("tools.parameters")}</span>
                <span>{translate("tools.parameterCount", { count: fields.length })}</span>
              </div>
              {fields.length > 0 ? (
                <div className="tool-definition-fields">
                  {fields.map((field) => (
                    <div className="tool-definition-field" key={field.name}>
                      <div className="tool-definition-field-name">
                        <span className="tool-definition-field-label">{field.name}</span>
                        <span className={field.required ? "required" : undefined}>
                          {translate(field.required ? "tools.required" : "tools.optional")}
                        </span>
                      </div>
                      <div className="tool-definition-field-value">
                        <div className="tool-definition-type">{field.type}</div>
                        {field.description && <div>{field.description}</div>}
                        {field.allowedValues && (
                          <div className="tool-definition-meta">
                            {translate("tools.allowedValues")}: {field.allowedValues}
                          </div>
                        )}
                        {field.defaultValue !== undefined && (
                          <div className="tool-definition-meta">
                            {translate("tools.defaultValue")}: {field.defaultValue}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tool-definition-no-parameters">{translate("tools.noParameters")}</div>
              )}
            </section>

            {selectedTool.promptGuidelines && selectedTool.promptGuidelines.length > 0 && (
              <section className="tool-definition-section">
                <div className="tool-definition-section-label">{translate("tools.guidelines")}</div>
                <ul className="tool-definition-guidelines">
                  {selectedTool.promptGuidelines.map((guideline, index) => (
                    <li key={`${selectedTool.name}:${index}`}>{guideline}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <EmptyState>
            {activeTools
              ? translate("tools.noTools")
              : loading
                ? translate("tools.loading")
                : translate("tools.load")}
          </EmptyState>
        )}
      </section>

      <style>{`
        .tool-definitions-panel {
          display: grid;
          grid-template-columns: clamp(112px, 30%, 260px) minmax(0, 1fr);
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .tool-definitions-sidebar,
        .tool-definition-detail {
          display: flex;
          min-width: 0;
          min-height: 0;
          flex-direction: column;
        }
        .tool-definitions-sidebar {
          border-right: 1px solid var(--border);
          background: var(--bg-panel);
        }
        .tool-definitions-list,
        .tool-definition-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
        }
        .tool-definitions-list {
          padding: 10px;
        }
        /* Selection language of the settings nav: flat fill, no lift. The name stays --text so it leads each row. */
        .tool-definitions-item {
          display: flex;
          width: 100%;
          flex-direction: column;
          align-items: flex-start;
          gap: 1px;
          padding: 6px 10px;
          border: none;
          border-radius: var(--ui-radius-sm);
          background: transparent;
          font: inherit;
          line-height: 1.4;
          cursor: pointer;
          text-align: left;
          transition: background-color 0.1s ease;
        }
        .tool-definitions-item:not(.selected):hover {
          background: var(--bg-hover);
        }
        .tool-definitions-item.selected {
          background: var(--bg-selected);
        }
        .tool-definitions-name,
        .tool-definitions-summary {
          max-width: 100%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tool-definitions-name {
          color: var(--text);
          font-size: 13px;
          line-height: 1.4;
        }
        .tool-definitions-summary {
          margin-top: 2px;
          color: var(--text-dim);
          font-size: 11px;
        }
        /* Switching tools swaps the whole pane, so it only eases in: no travel, and it never dips to
           transparent (a blank flash on every click reads as flicker). */
        @keyframes tool-definition-in {
          from { opacity: 0.4; }
        }
        .tool-definition-scroll {
          padding: 16px 20px 22px;
          animation: tool-definition-in 0.14s ease-out;
        }
        .tool-definition-title {
          margin: 0 0 10px;
          color: var(--text);
          font-size: 14px;
          font-weight: 600;
          line-height: 1.4;
          overflow-wrap: anywhere;
        }
        .tool-definition-section + .tool-definition-section {
          margin-top: 20px;
        }
        .tool-definition-section-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 6px;
          color: var(--text-dim);
          font-size: 11px;
          line-height: 1.4;
        }
        .tool-definition-description {
          color: var(--text-muted);
          font-size: 13px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .tool-definition-field {
          display: grid;
          grid-template-columns: minmax(96px, 0.7fr) minmax(0, 1.5fr);
          gap: 14px;
          padding: 8px 0;
          font-size: 12px;
          line-height: 1.5;
        }
        .tool-definition-field + .tool-definition-field {
          border-top: 1px solid var(--border);
        }
        .tool-definition-field-name {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 2px;
          color: var(--text);
        }
        .tool-definition-field-label {
          overflow-wrap: anywhere;
        }
        .tool-definition-field-name span:not(.tool-definition-field-label) {
          color: var(--text-dim);
          font-size: 10px;
        }
        .tool-definition-field-name span.required {
          color: var(--accent);
        }
        .tool-definition-field-value {
          min-width: 0;
          color: var(--text-muted);
          overflow-wrap: anywhere;
        }
        .tool-definition-type {
          margin-bottom: 2px;
          color: var(--text-dim);
          font-size: 11px;
        }
        .tool-definition-meta {
          margin-top: 4px;
          color: var(--text-dim);
          font-size: 11px;
        }
        .tool-definition-no-parameters {
          color: var(--text-dim);
          font-size: 12px;
        }
        .tool-definition-guidelines {
          margin: 0;
          padding-left: 18px;
          list-style: disc;
          color: var(--text-muted);
          font-size: 12px;
          line-height: 1.6;
        }
        .tool-definitions-empty {
          padding: 14px 12px;
          color: var(--text-muted);
          font-size: 12px;
          overflow-wrap: anywhere;
        }
        .tool-definitions-chevron {
          display: none;
        }
        /* Phone: full-screen sheet with push navigation, like the settings sheet.
           The list comes first; a tool opens as its own pane with a back button in the header. */
        @media (max-width: 640px) {
          .tool-definitions-panel {
            grid-template-columns: minmax(0, 1fr);
          }
          .tool-definitions-panel[data-pane="list"] .tool-definition-detail,
          .tool-definitions-panel[data-pane="detail"] .tool-definitions-sidebar {
            display: none;
          }
          /* Same motion as the settings sheet: the pane that appears replays menu-surface-in. */
          .tool-definitions-panel[data-pane="list"][data-returned] .tool-definitions-sidebar {
            animation: menu-surface-in 0.12s ease-out;
          }
          .tool-definitions-sidebar {
            border-right: 0;
            background: var(--bg);
          }
          .tool-definitions-list {
            padding: 4px 16px 24px;
          }
          .tool-definitions-item {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            column-gap: 12px;
            align-items: center;
            min-height: 56px;
            padding: 8px 4px;
            border-radius: 0;
          }
          .tool-definitions-item + .tool-definitions-item {
            box-shadow: inset 0 1px 0 var(--border);
          }
          .tool-definitions-item.selected,
          .tool-definitions-item:not(.selected):hover {
            background: transparent;
          }
          .tool-definitions-name,
          .tool-definitions-summary {
            grid-column: 1;
          }
          .tool-definitions-chevron {
            display: block;
            grid-column: 2;
            grid-row: 1 / span 2;
            color: var(--text-dim);
          }
          .tool-definition-scroll {
            padding: 16px 16px 32px;
            animation: menu-surface-in 0.12s ease-out;
          }
          .tool-definition-title {
            display: none;
          }
          .tool-definition-field {
            grid-template-columns: minmax(80px, 0.7fr) minmax(0, 1.3fr);
            gap: 10px;
          }
        }
        @media (max-width: 640px) and (prefers-reduced-motion: reduce) {
          .tool-definitions-panel[data-pane="list"][data-returned] .tool-definitions-sidebar,
          .tool-definition-scroll {
            animation-name: menu-surface-fade;
          }
        }
      `}</style>
    </div>
  );
}
