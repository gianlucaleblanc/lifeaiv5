import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppShell from "./components/AppShell";
import OnboardingWrapper from "./components/OnboardingWrapper";
import { ToastProvider } from "./components/Toast";

export const metadata: Metadata = {
  title: "OpenHour",
  description: "Turn natural language into your daily plan.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "OpenHour",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#ec4899",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased">
        <ToastProvider>
          <OnboardingWrapper>
            <AppShell>{children}</AppShell>
          </OnboardingWrapper>
        </ToastProvider>
      </body>
    </html>
  );
}
