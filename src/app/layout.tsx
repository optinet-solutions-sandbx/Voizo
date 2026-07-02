import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import Providers from "@/components/Providers";
import DotField from "@/components/DotField";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// All figures render in Geist Mono (+ tabular-nums via body) — pattern brief §3.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VOIZO",
  description: "Caller system dashboard for VOIZO",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[var(--bg-app)]`}>
        {/* Global interactive dot-field — ONE fixed layer behind the whole app. -z-10 paints it
            above the body bg but below all content, so no page needs a z-wrapper (keeps full-height
            pages like Workers intact) and no stacking context is introduced (modals stay on top).
            Sidebar + Header are opaque, so the dots only show through the transparent <main>. */}
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
          <DotField />
        </div>
        <Providers>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            {/* right column: header + scrollable content */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <Header />
              {/* pt-14 offsets mobile top bar, pb-16 offsets mobile bottom nav. Transparent so the
                  global dot-field shows through the content gutters. */}
              <main className="flex-1 overflow-y-auto pt-14 pb-16 md:pt-0 md:pb-0">
                {children}
              </main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
