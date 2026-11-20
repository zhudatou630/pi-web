import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import { PlantUmlBlock } from "./PlantUmlBlock";
import { SvgBlock } from "./SvgBlock";

export function MarkdownFence({ code, lang, isStreaming }: { code: string; lang: string; isStreaming?: boolean }) {
  if (lang === "mermaid") return <MermaidBlock code={code} isStreaming={isStreaming} defaultPreview />;
  if (lang === "svg") return <SvgBlock code={code} isStreaming={isStreaming} />;
  if (lang === "plantuml" || lang === "puml") return <PlantUmlBlock code={code} lang={lang} isStreaming={isStreaming} />;
  return <CodeBlock code={code} lang={lang} isStreaming={isStreaming} />;
}
