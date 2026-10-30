"use client";

import { useI18n } from "@/hooks/useI18n";

export function pauseOtherMedia(current: HTMLMediaElement): void {
  for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
    if (media !== current) media.pause();
  }
}

/** The file viewer's native controls, without its file toolbar and watch lifecycle. */
export function MarkdownMedia({ src, alt, video }: { src?: string; alt?: string; video: boolean }) {
  const { t } = useI18n();
  const Player = video ? "video" : "audio";
  return (
    <Player
      className="markdown-media"
      controls
      playsInline={video || undefined}
      preload="metadata"
      src={src}
      aria-label={alt?.trim() ? alt : t(video ? "chat.videoPlayer" : "chat.audioPlayer")}
      onPlay={(event) => pauseOtherMedia(event.currentTarget)}
    />
  );
}
