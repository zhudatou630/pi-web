import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono, Noto_Serif_SC } from "next/font/google";
import { PwaRegistration } from "@/components/PwaRegistration";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

const notoSerifSC = Noto_Serif_SC({
  variable: "--font-noto-serif-sc",
  display: "swap",
  preload: false,
});

const iconVersion = process.env.NEXT_PUBLIC_ICON_VERSION ? `?v=${process.env.NEXT_PUBLIC_ICON_VERSION}` : "";

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: "/manifest.webmanifest",
  icons: {
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
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#f5f5f5",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} ${notoSerifSC.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");var dark=t==="dark"||((t==null||t===""||t==="auto")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark");var c=dark?"#242424":"#f5f5f5";var ms=document.querySelectorAll('meta[name="theme-color"]');if(ms.length===0){var m=document.createElement("meta");m.name="theme-color";m.content=c;document.head.appendChild(m)}else{for(var i=0;i<ms.length;i++){ms[i].removeAttribute("media");ms[i].content=c}}}catch(e){}})();`,
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
