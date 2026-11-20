import fs from "fs";
import path from "path";

function createFileBodyStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath, range);
  let closed = false;

  // Backpressure: pause the file once the queue is full and resume on pull, so a
  // slow client holds about 1 MB (16 x 64 KB reads), not the whole file.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) fileStream.pause();
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may cancel media probes before the file stream ends.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    pull() {
      if (!closed) fileStream.resume();
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  }, { highWaterMark: 16 });
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(filePath: string, asDownload = false): string {
  const disposition = asDownload ? "attachment" : "inline";
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export interface StreamFileOptions {
  asDownload?: boolean;
  /** Applied last, so a caller may replace the default security headers. */
  extraHeaders?: Record<string, string>;
}

/** Streams a file with ETag revalidation and single byte-range support. */
export function streamFile(
  filePath: string,
  stat: fs.Stats,
  contentType: string,
  requestHeaders: Headers,
  { asDownload = false, extraHeaders }: StreamFileOptions = {},
): Response {
  const rangeHeader = requestHeaders.get("range");
  // Files can change in place, so revalidate every time; the ETag turns an unchanged file into a 304.
  const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath, asDownload),
    "X-Content-Type-Options": "nosniff",
  };
  // SVG is the only preview type a browser executes as a document. A
  // repo-controlled SVG navigated to directly (for example through a link in
  // a transcript) would otherwise run script in the Pi Web origin, where it
  // can call any /api route. These headers only affect document rendering;
  // <img> preview embedding ignores them.
  if (contentType === "image/svg+xml") {
    headers["Content-Security-Policy"] =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
    headers["Referrer-Policy"] = "no-referrer";
  }
  Object.assign(headers, extraHeaders);

  if (requestHeaders.get("if-none-match")?.split(",").some((tag) => tag.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (!rangeHeader) {
    return new Response(createFileBodyStream(filePath), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createFileBodyStream(filePath, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
}
