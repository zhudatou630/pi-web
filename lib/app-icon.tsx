import { ImageResponse } from "next/og";
import { APP_ICON_COLORS, type AppIdentity } from "./app-identity";
import { APP_MARK_PATH } from "./app-identity-options";

/** PNG bytes of the app icon at `size` px: the white mark on the chosen color, full-bleed like public/icons/*.png. */
export async function renderAppIcon(identity: AppIdentity, size: number): Promise<ArrayBuffer> {
  const markSize = Math.round(size * 0.6);
  const image = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: APP_ICON_COLORS[identity.color] }}>
        <svg width={markSize} height={markSize} viewBox="0 0 560 560">
          <path d={APP_MARK_PATH} fill="#ffffff" />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
  return image.arrayBuffer();
}
