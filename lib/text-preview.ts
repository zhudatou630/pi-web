import fs from "fs";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";

export interface TextPreviewChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function readTextPreviewChunk(
  filePath: string,
  fileSize: number,
  offset: number,
): TextPreviewChunk {
  const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, fileSize - offset);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  let bytesRead: number;
  let encoding: "utf8" | "utf-16le" | "utf-16be" = "utf8";
  try {
    // Continuation offsets are bytes, so rediscover the encoding from the same open file.
    const bom = Buffer.alloc(2);
    if (fs.readSync(descriptor, bom, 0, 2, 0) === 2) {
      if (bom[0] === 0xff && bom[1] === 0xfe) encoding = "utf-16le";
      else if (bom[0] === 0xfe && bom[1] === 0xff) encoding = "utf-16be";
    }
    bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }

  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);
  if (offset + end < fileSize && encoding !== "utf8") {
    end -= end % 2;
    if (end >= 2) {
      const lastUnit = encoding === "utf-16le" ? buffer.readUInt16LE(end - 2) : buffer.readUInt16BE(end - 2);
      if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 2;
    }
  } else if (offset + end < fileSize) {
    let sequenceStart = end;
    while (sequenceStart > end - 3 && (buffer[sequenceStart] & 0xc0) === 0x80) {
      sequenceStart--;
    }
    if (utf8SequenceLength(buffer[sequenceStart]) > end - sequenceStart) {
      end = sequenceStart;
    }
  }

  const nextOffset = offset + end;
  return {
    content: encoding === "utf8"
      ? buffer.toString("utf8", 0, end)
      : new TextDecoder(encoding, { ignoreBOM: true }).decode(buffer.subarray(offset === 0 ? 2 : 0, end)),
    nextOffset,
    truncated: nextOffset < fileSize,
  };
}