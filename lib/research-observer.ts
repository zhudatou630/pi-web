/** Read-only presentation of real workflow events and Claude stream records. */
export type ResearchRecord = { id: string; kind: "assistant" | "tool" | "output" | "error" | "workflow"; title: string; text: string; source: string; at: number; recorded_at?: number };
export const researchRunPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function researchSelection(value: string | null): string | null {
  return value === "latest" || (value !== null && researchRunPattern.test(value)) ? value : null;
}
export function redactResearchText(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_TOKEN]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"'`,;)}]+/gi, "$1[REDACTED]");
}
export function sanitizeResearchValue(value: unknown, privateToken = ""): unknown {
  if (typeof value === "string") return redactResearchText(privateToken ? value.replaceAll(privateToken, "[REDACTED_SERVICE_TOKEN]") : value);
  if (Array.isArray(value)) return value.map(item => sanitizeResearchValue(item, privateToken));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,
    /(?:api.?key|auth.?token|access.?token|password|secret)/i.test(key) ? "[REDACTED]" : sanitizeResearchValue(item,privateToken)]));
  return value;
}
function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
}
type StreamBlock={type?:string;text?:string;name?:string;input?:unknown;is_error?:boolean;content?:unknown};
type StreamRow={type?:string;timestamp?:string|number;message?:{model?:string;content?:StreamBlock[]};is_error?:boolean;result?:string;errors?:unknown;subtype?:string};
export function parseResearchLog(text: string, source: string, startOffset = 0): ResearchRecord[] {
  const records: ResearchRecord[] = [];
  const time = Number(source.match(/\/(\d+)-/)?.[1] || 0) / 1000;
  let offset = startOffset;
  for (const line of text.split("\n")) {
    const id = `${source}:${offset}`; offset += new TextEncoder().encode(line+"\n").length;
    if (!line.trim()) continue;
    let item:StreamRow|null=null;
    const add = (kind: ResearchRecord["kind"], title: string, body: string, suffix = "") => {
      const stamp=typeof item?.timestamp==="string"?Date.parse(item.timestamp)/1000:typeof item?.timestamp==="number"?item.timestamp/(item.timestamp>1e12?1000:1):NaN;
      if (typeof body === "string" && body.trim()) {
        const safe=redactResearchText(body);
        records.push({ id:id+suffix,kind,title,text:safe.slice(0,6000)+(safe.length>6000?"\n…（显示已截短，完整内容见原始日志）":""),source,at:time+offset/1e9,
          ...(Number.isFinite(stamp)?{recorded_at:stamp}:{}) });
      }
    };
    try { item = JSON.parse(line); } catch { if (!line.trimStart().startsWith("{")) add(source.endsWith(".err")?"error":"output","进程输出",line); continue; }
    if (!item || typeof item !== "object") continue;
    // Never expose model reasoning, base64 images, init settings or credentials.
    if (item.type === "assistant") {
      for (const [index,block] of (Array.isArray(item.message?.content)?item.message.content:[]).entries()) {
        if (!block || typeof block!=="object") continue;
        if (block.type === "text") add("assistant",`代理回复${item.message?.model ? ` · ${item.message.model}` : ""}`,block.text || "",`:${index}`);
        if (block.type === "tool_use") add("tool",`工具调用 · ${block.name || "tool"}`,JSON.stringify(sanitizeResearchValue(block.input),null,2) || "",`:${index}`);
      }
    } else if (item.type === "user") {
      for (const [index,block] of (Array.isArray(item.message?.content)?item.message.content:[]).entries()) {
        if (!block || typeof block!=="object") continue;
        if (block.type === "tool_result") add(block.is_error ? "error":"output","工具返回",textBlocks(block.content),`:${index}`);
      }
    } else if (item.type === "result") {
      add(item.is_error?"error":"assistant",item.is_error?"调用失败":"调用最终结果",item.result || JSON.stringify(item.errors || item.subtype));
    } else if (!item.type) add("output","进程结果",JSON.stringify(sanitizeResearchValue(item),null,2));
  }
  return records;
}
