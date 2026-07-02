"use client";

import { NotificationsProvider } from "@/lib/notificationsContext";
import { ToastProvider } from "@/lib/toastContext";
import { ThemeProvider } from "@/lib/themeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReactNode } from "react";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <NotificationsProvider>
        {/* One app-level Radix tooltip provider: 150ms open delay (snappy, not flickery),
            with the built-in skip-delay so moving between hints opens them instantly. */}
        <TooltipProvider delayDuration={150}>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </NotificationsProvider>
    </ThemeProvider>
  );
}
