import type { Metadata } from "next";
import type { Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SiteNavigation } from "@/components/shell/navigation";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "ParkShare", template: "%s | ParkShare" },
  description: "Find and share parking spaces.",
};

export const viewport: Viewport = { themeColor: "#0f766e" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#main"
          className="bg-primary text-primary-foreground sr-only fixed top-4 left-4 z-50 rounded px-4 py-2 focus:not-sr-only"
        >
          Skip to main content
        </a>
        <SiteNavigation />
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 pb-24 md:px-6 md:pb-8">
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
