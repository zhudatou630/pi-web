import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Noto_Sans_Mono } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import { appIconUrl, appIconVersion, effectiveAppName, readAppIdentity } from "@/lib/app-identity";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";
import "./routines.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

const iconVersion = process.env.NEXT_PUBLIC_ICON_VERSION ? `?v=${process.env.NEXT_PUBLIC_ICON_VERSION}` : "";

const stockIcons: Metadata["icons"] = {
  icon: [
    {
      url: `/favicon.svg${iconVersion}`,
      type: "image/svg+xml",
    },
    {
      url: `/icons/icon-192.png${iconVersion}`,
      sizes: "192x192",
      type: "image/png",
    },
    {
      url: `/favicon.ico${iconVersion}`,
      sizes: "any",
    },
  ],
  apple: [
    {
      url: `/icons/apple-touch-icon.png${iconVersion}`,
      sizes: "180x180",
      type: "image/png",
    },
  ],
};

// Per request: Settings › General › Appearance renames and recolors this server's app.
// AppShell reads the name back from <meta name="application-name"> for the window title.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const identity = readAppIdentity();
  const name = effectiveAppName(identity);
  const iconVersion = appIconVersion(identity);
  return {
    title: name,
    description: "Pi Web interface for the pi coding agent",
    applicationName: name,
    manifest: "/manifest.webmanifest",
    icons: iconVersion
      ? {
        icon: [{ url: appIconUrl(192, iconVersion), sizes: "192x192", type: "image/png" }],
        apple: [{ url: appIconUrl(180, iconVersion), sizes: "180x180", type: "image/png" }],
      }
      : stockIcons,
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: name,
    },
    formatDetection: {
      telephone: false,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var f=['16px "Sarasa Term SC Web"','600 16px "Sarasa Term SC Web"'];var s=null;try{s=localStorage.getItem("pi-font-scheme")}catch(e){}if(s==="wenkai"){document.documentElement.dataset.font="wenkai";f.push('16px "LXGW WenKai Web"','600 16px "LXGW WenKai Web"')}else if(s!=="sarasa"){document.documentElement.dataset.font="system"}addEventListener("load",function(){f.forEach(function(x){document.fonts.load(x,"a\u4e2d")})});var t=localStorage.getItem("pi-theme");var dark=t==="dark"||((t==null||t===""||t==="auto")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark");var c=dark?"#1c1c1c":"#ffffff";var ms=document.querySelectorAll('meta[name="theme-color"]');if(ms.length===0){var m=document.createElement("meta");m.name="theme-color";m.content=c;document.head.appendChild(m)}else{for(var i=0;i<ms.length;i++){ms[i].removeAttribute("media");ms[i].content=c}}}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
