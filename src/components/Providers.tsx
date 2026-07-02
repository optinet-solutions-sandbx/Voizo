"use client";

import { NotificationsProvider } from "@/lib/notificationsContext";
import { ToastProvider } from "@/lib/toastContext";
import { ThemeProvider } from "@/lib/themeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionConfig } from "motion/react";
import { ReactNode } from "react";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <NotificationsProvider>
        {/* One app-level Radix tooltip provider: 150ms open delay (snappy, not flickery),
            with the built-in skip-delay so moving between hints opens them instantly. */}
        <TooltipProvider delayDuration={150}>
          {/* reducedMotion="user": every motion component honors prefers-reduced-motion
              (matches the existing glow-card reduced-motion handling in globals.css). */}
          <MotionConfig reducedMotion="user">
            <ToastProvider>{children}</ToastProvider>
          </MotionConfig>
        </TooltipProvider>
      </NotificationsProvider>
    </ThemeProvider>
  );
}
