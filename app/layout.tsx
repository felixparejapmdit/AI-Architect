import type { Metadata, Viewport } from "next";
// Self-hosted: Strata is local-first, and next/font/google needs the internet at build time.
import "@fontsource-variable/inter/wght.css";
import "./globals.css";
import { SwRegister } from "@/components/SwRegister";

export const metadata: Metadata = {
  title: "Strata: structure-locked material rendering",
  description: "Apply real Philippine finishes to architectural renders with local ComfyUI, without touching structure, then export a costed specification proposal.",
  applicationName: "Strata",
  appleWebApp: { capable: true, title: "Strata", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#f7f7f5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
