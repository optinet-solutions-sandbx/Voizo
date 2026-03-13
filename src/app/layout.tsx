import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import Header from "@/components/Header";
import Providers from "@/components/Providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rooster Partners - Caller System Dashboard",
  description: "Caller system dashboard for Rooster Partners",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} antialiased bg-[var(--bg-app)]`}>
        <Providers>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            {/* right column: header + scrollable content */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <Header />
              {/* pt-14 offsets mobile top bar, pb-16 offsets mobile bottom nav */}
              <main className="flex-1 overflow-y-auto bg-[var(--bg-app)] pt-14 pb-16 md:pt-0 md:pb-0">
                {children}
              </main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
