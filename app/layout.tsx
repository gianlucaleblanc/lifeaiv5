import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./components/AppShell";
import OnboardingWrapper from "./components/OnboardingWrapper";
import { ToastProvider } from "./components/Toast";

export const metadata: Metadata = {
  title: "LifeOS",
  description: "Turn natural-language intentions into a grounded daily plan.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
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
