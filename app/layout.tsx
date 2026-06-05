import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Super Minutes · 會議錄音轉結構化會議報告 - 榛果繽紛樂",
  description:
    "把會議音訊或影片自動轉成有講者分離、時間對齊的逐字稿，再整理成包含會議紀要、主要結論、議題要點、待辦行動項的會議報告。可匯出 DOCX / PDF / Markdown，繁體簡體一鍵互轉。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning on <html> and <body>: the Pistachio CF
    // Worker (HazelnutParadise/Pistachio-Global-Announcement-System) sets
    // style/class on both elements via DOMContentLoaded, before React
    // hydrates. Without the suppression React sees the attribute diff and
    // falls back to a full client re-render (flash-and-disappear).
    //
    // NO <head> tag in this JSX — intentional. Fonts are loaded via
    // @import in globals.css. Without a JSX <head>, React doesn't hydrate
    // head content, and the Worker's injected <style>+<script> in <head>
    // can't trigger a structural mismatch (#418). This is the only
    // reliable way to coexist with an HTMLRewriter that appends to <head>.
    <html lang="zh-Hant" className="dark" suppressHydrationWarning>
      <body
        className="min-h-screen bg-background text-foreground font-sans antialiased"
        suppressHydrationWarning
      >
        {/* Pistachio anchor — the Worker looks for this id and injects the
         *  banner inside it. dangerouslySetInnerHTML makes the inner node
         *  opaque to React's reconciler so the Worker's DOM mutations
         *  don't cause hydration issues. */}
        <div
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: '<div id="Pistachio-Announcement"></div>',
          }}
        />

        {/* Vellum grain — gives the background depth. */}
        <div className="vellum pointer-events-none fixed inset-0 -z-10 opacity-[0.07]" />
        {/* Ledger margin line. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-y-0 left-[7rem] -z-10 w-px bg-vermillion/30 hidden md:block"
        />
        {/* Right-edge ornament. */}
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
