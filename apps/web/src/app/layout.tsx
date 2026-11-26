import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Support AI",
  description: "Customer support agent with streaming chat and live voice.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {/* Resolve the saved theme (light/dark/system) before first paint so dark mode never flashes light. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`try{var p=localStorage.getItem("support-ai:theme");if(p!=="light"&&p!=="dark"&&p!=="system")p="system";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light"}catch(e){}`}
        </Script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
