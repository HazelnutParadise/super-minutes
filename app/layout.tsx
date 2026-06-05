import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Super Minutes · 會議錄音轉結構化會議報告",
  description:
    "把會議音訊或影片自動轉成有講者分離、時間對齊的逐字稿，再整理成包含會議紀要、主要結論、議題要點、待辦行動項的會議報告。可匯出 DOCX / PDF / Markdown，繁體簡體一鍵互轉。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-Hant" className="dark">
      <head>
        {/* Instrument Serif — distinctive editorial display, italic-leaning. */}
        {/* Geist Sans — refined neo-grotesque body. */}
        {/* JetBrains Mono — monospace for timecodes. */}
        {/* Noto Serif TC — Han glyphs in the editorial idiom. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Noto+Serif+TC:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-background text-foreground font-sans antialiased">
        {/* Vellum grain over the whole document — gives the background depth. */}
        <div className="vellum pointer-events-none fixed inset-0 -z-10 opacity-[0.07]" />
        {/* Ledger margin line — runs down the entire page like a paper margin. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-y-0 left-[7rem] -z-10 w-px bg-vermillion/30 hidden md:block"
        />
        {/* Right-edge ornament — small fixed mark. */}
        <div
          aria-hidden
          className="pointer-events-none fixed top-6 right-6 -z-10 font-mono text-[10px] tracking-[0.3em] text-cream-500 hidden lg:block"
          style={{ writingMode: "vertical-rl" }}
        >
          NO. 001 · DOSSIER · MINUTES.SYSTEM
        </div>

        {children}

        <Toaster
          position="bottom-right"
          theme="dark"
          richColors
          closeButton
          toastOptions={{
            classNames: {
              toast:
                "!font-sans !rounded-sm !border !border-border !bg-card !text-foreground",
              title: "!font-medium",
            },
          }}
        />
      </body>
    </html>
  );
}
