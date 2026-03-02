import type { Metadata } from "next";
import "./globals.css";
import AppShell from "./components/AppShell";
import OnboardingWrapper from "./components/OnboardingWrapper";

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
        <OnboardingWrapper>
          <AppShell>{children}</AppShell>
        </OnboardingWrapper>
      </body>
    </html>
  );
}
