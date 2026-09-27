import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import subsetFont from "subset-font";

// Message image export embeds fonts into an SVG; the bundled CJK faces are 8-10 MB
// each, which mobile browsers drop. Subsetting to the message's characters keeps
// each face in the hundreds of KB.
const FONT_DIR = join(process.cwd(), "public", "fonts");

export async function POST(request: Request) {
  const { file, text } = await request.json().catch(() => ({}));
  if (typeof file !== "string" || !/^[\w-]+\.woff2$/.test(file) || typeof text !== "string" || text.length > 20_000) {
    return NextResponse.json({ error: "Invalid font subset request" }, { status: 400 });
  }
  const font = await readFile(join(FONT_DIR, file)).catch(() => null);
  if (!font) return NextResponse.json({ error: "Font not found" }, { status: 404 });
  // ponytail: harfbuzz runs on the main thread (~0.3 s per face, serialized by subset-font);
  // move to a worker if exports start stalling other requests.
  const subset = await subsetFont(font, text, { targetFormat: "truetype" });
  return new Response(new Uint8Array(subset), { headers: { "Content-Type": "font/ttf" } });
}
