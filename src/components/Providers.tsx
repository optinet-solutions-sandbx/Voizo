"use client";

import { NotificationsProvider } from "@/lib/notificationsContext";
import { ToastProvider } from "@/lib/toastContext";
import { ThemeProvider } from "@/lib/themeContext";
import { ReactNode } from "react";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <NotificationsProvider>
        <ToastProvider>{children}</ToastProvider>
      </NotificationsProvider>
    </ThemeProvider>
  );
}
