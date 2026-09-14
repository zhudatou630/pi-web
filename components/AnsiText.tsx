"use client";

import { useMemo } from "react";
import { AnsiUp } from "ansi_up";

/**
 * Renders ANSI SGR escape sequences as colored/styled HTML.
 *
 * Uses the battle-tested `ansi_up` library, which supports the full SGR
 * set (16/256/24-bit colors, bold/italic/underline/strikethrough, links,
 * reset codes). `ansi_up` escapes HTML entities by default, so ANSI text
 * cannot inject markup.
 */

export function AnsiText({ text }: { text: string }) {
  const html = useMemo(() => new AnsiUp().ansi_to_html(text), [text]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
