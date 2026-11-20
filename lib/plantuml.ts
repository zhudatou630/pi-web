const SVG_ENDPOINT = "https://www.plantuml.com/plantuml/svg/";
// Leave headroom for browser headers within the server's request size limit.
const MAX_PAYLOAD_LENGTH = 6000 - SVG_ENDPOINT.length;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function rawDeflate(): CompressionStream | undefined {
  if (typeof CompressionStream === "undefined") return;
  try {
    return new CompressionStream("deflate-raw");
  } catch (error) {
    // Older browsers with CompressionStream reject this format with TypeError.
    if (!(error instanceof TypeError)) throw error;
  }
}

/** Build the image URL locally; null means it exceeds the request size limit. */
export async function plantUmlSvgUrl(source: string): Promise<string | null> {
  const bytes = new TextEncoder().encode(source);
  const deflate = rawDeflate();
  if (!deflate) {
    if (2 + bytes.length * 2 > MAX_PAYLOAD_LENGTH) return null;
    return SVG_ENDPOINT + "~h" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const compressed = new Blob([bytes]).stream().pipeThrough(deflate);
  const packed = new Uint8Array(await new Response(compressed).arrayBuffer());
  const groups = Math.ceil(packed.length / 3);
  if (groups * 4 > MAX_PAYLOAD_LENGTH) return null;
  // PlantUML fills the final group with zero bytes instead of emitting '=' padding.
  const binary = String.fromCharCode(...packed).padEnd(groups * 3, "\0");
  return SVG_ENDPOINT + btoa(binary).replace(/./g, (char) => ALPHABET[BASE64.indexOf(char)]);
}
