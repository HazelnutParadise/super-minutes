import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { UploadCard } from "@/components/upload-card";
import { HazelnutNavbar } from "@/components/hazelnut-navbar";
import {
  ShieldCheck,
  Wand2,
  Users,
  Languages,
  Download,
  ScrollText,
  ArrowUpRight,
} from "lucide-react";

export default function Home() {
  return (
    <main className="relative min-h-screen pb-24">
      <AppHeader />

      {/* HERO — editorial masthead. */}
      <section className="container mx-auto grid grid-cols-1 gap-12 px-6 pt-12 md:pt-16 md:grid-cols-[1.15fr_1fr] md:gap-10 lg:gap-20">
        <div className="space-y-8">
          {/* Pre-headline mark */}
          <div className="flex items-center gap-4 animate-ledger-rise">
            <span className="font-mono text-[10px] tracking-[0.32em] text-cream-500">
              ISSUE Nº 01
            </span>
            <span className="h-px flex-1 bg-cream-100/15 max-w-[8rem]" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-vermillion">
              MINUTES · DEPT
            </span>
          </div>

          {/* The headline — Instrument Serif italic display, three-line
           *  italic statement. Reads as one sentence:
           *  「把會議錄音 / 變成 / 一份完整的會議紀錄。」 */}
          <h1
            className="font-display italic text-balance text-[clamp(2.75rem,6.5vw,6rem)] leading-[0.92] tracking-[-0.01em] text-cream-50 animate-ledger-rise"
            style={{ animationDelay: "120ms" }}
          >
            <span className="block">把會議錄音</span>
            <span className="block text-cream-200">
              變成{" "}
              <span className="relative inline-block">
                <span className="text-vermillion">一份</span>
                <svg
                  aria-hidden
                  className="absolute -bottom-1 left-0 w-full text-vermillion/60"
                  height="10"
                  viewBox="0 0 320 10"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M2 6 C 80 1, 160 8, 318 4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </span>
            <span className="block">
              完整的會議紀錄<span className="text-vermillion">。</span>
            </span>
          </h1>

          <p
            className="max-w-[52ch] text-pretty text-[15px] leading-relaxed text-cream-300 animate-ledger-rise"
            style={{ animationDelay: "240ms" }}
          >
            上傳會議的音訊或影片，自動產出有
            <span className="underline-vermillion">講者分離與時間對齊</span>
            的逐字稿，再整理成有
            <em className="font-display not-italic text-cream-100">會議紀要</em>、
            <em className="font-display not-italic text-cream-100">主要結論</em>、
            <em className="font-display not-italic text-cream-100">議題要點</em>、
            <em className="font-display not-italic text-cream-100">待辦行動項</em>
            的會議報告。多語言通吃，繁體 / 簡體一鍵互轉。
          </p>

          <div
            className="animate-ledger-rise"
            style={{ animationDelay: "300ms" }}
          >
            <Link
              href="/editor?demo=1"
              className="inline-flex items-center gap-2 border-b border-cream-100/30 pb-0.5 font-mono text-[11px] tracking-[0.25em] text-cream-200 hover:border-vermillion hover:text-cream-50 transition-colors"
            >
              先看一份範例報告
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {/* Spec strip — typeset like a colophon. Values phrased as
           *  user-visible properties, not implementation choices. */}
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-cream-100/15 pt-6 sm:grid-cols-4 animate-ledger-rise"
            style={{ animationDelay: "360ms" }}
          >
            <Spec label="INPUT" value="音訊 · 影片" detail="拖曳上傳" />
            <Spec label="LANGUAGES" value="10+" detail="繁簡互轉" />
            <Spec label="SPEAKERS" value="自動分離" detail="可改名稱" />
            <Spec label="EXPORT" value="DOCX · PDF · MD" detail="一鍵下載" />
          </div>
        </div>

        <div className="lg:sticky lg:top-8 self-start">
          <UploadCard />
        </div>
      </section>

      {/* HOW — numbered ledger of the pipeline. */}
      <section className="container mx-auto px-6 pt-28">
        <div className="mb-10 flex items-baseline justify-between gap-4">
          <h2 className="font-display italic text-[clamp(2rem,3.5vw,3rem)] leading-none text-cream-50">
            流程．Pipeline
          </h2>
          <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
            FOUR ACTS, ONE REPORT
          </div>
        </div>

        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm border border-cream-100/15 bg-cream-100/10 sm:grid-cols-2 xl:grid-cols-4">
          <Step
            n="01"
            title="挑選來源"
            body="拖曳本機音訊或影片。影片會在瀏覽器內就地抽出音軌，原檔不上傳。"
          />
          <Step
            n="02"
            title="自動分離講者"
            body="多人對話自動切分成不同講者，每段話標上時間軸與發言人，方便回頭核對。"
          />
          <Step
            n="03"
            title="AI 整稿"
            body="把逐字稿濃縮成 會議紀要、主要結論、議題要點、待辦行動項 四段結構化報告，輸出語言可自選。"
          />
          <Step
            n="04"
            title="校對與匯出"
            value
            body="編輯器內直接改字、改名、調講者，完成後一鍵匯出 DOCX、PDF 或 Markdown。"
          />
        </div>
      </section>

      {/* FEATURES — small grid of properties. */}
      <section className="container mx-auto px-6 pt-24">
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm border border-cream-100/15 bg-cream-100/10 sm:grid-cols-2 xl:grid-cols-3">
          <Feature
            icon={<ShieldCheck className="h-4 w-4" />}
            title="影片不外流"
            body="影片只會在你的瀏覽器內處理，原檔不會被上傳；只有抽出來的音訊會送到伺服器。"
          />
          <Feature
            icon={<Users className="h-4 w-4" />}
            title="講者自動分離"
            body="多人會議自動分組標記，每位講者一個顏色與可改名稱。"
          />
          <Feature
            icon={<ScrollText className="h-4 w-4" />}
            title="時間軸對齊"
            body="點任一段直接跳到音訊對應位置，邊聽邊修錯字、漏字。"
          />
          <Feature
            icon={<Languages className="h-4 w-4" />}
            title="多語通吃"
            body="繁體、簡體、英、日、韓、西、法、德、俄都接得住，繁體與簡體可一鍵互轉。"
          />
          <Feature
            icon={<Wand2 className="h-4 w-4" />}
            title="AI 整稿"
            body="把逐字稿改寫成可直接送出的會議報告，輸出語言可自選。"
          />
          <Feature
            icon={<Download className="h-4 w-4" />}
            title="三種格式"
            body="Markdown 純文字、DOCX 排版好、PDF 直接寄。"
          />
        </div>
      </section>

      {/* COLOPHON — bottom-of-page newspaper mark. */}
      <footer className="container mx-auto px-6 pt-24">
        <div className="flex flex-col items-center gap-3 border-t border-cream-100/15 pt-8 text-center">
          <span className="ornament font-mono text-[10px] tracking-[0.3em] text-cream-500">
            END OF FRONT MATTER
          </span>
          <p className="font-display italic text-2xl text-cream-200">
            Transcribed. Drafted. Signed by{" "}
            <span className="text-vermillion">you</span>.
          </p>
          <p className="font-mono text-[10px] tracking-[0.25em] text-cream-500">
            A SIBLING OF SUPER CAPTIONS · POWERED BY HAZELNUTPARADISE
          </p>
        </div>
      </footer>

      <HazelnutNavbar />
    </main>
  );
}

function Spec({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="space-y-1">
      <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
        {label}
      </div>
      <div className="font-display italic text-xl text-cream-50 leading-none">
        {value}
      </div>
      <div className="font-mono text-[10px] tracking-[0.2em] text-cream-400">
        {detail}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
  value?: boolean;
}) {
  return (
    <div className="relative bg-background p-6">
      <div className="flex items-baseline justify-between">
        <span className="ordinal font-display italic text-5xl leading-none">
          {n}
        </span>
        <span className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
          STEP
        </span>
      </div>
      <div className="mt-4 font-display italic text-xl text-cream-50">
        {title}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-cream-300">{body}</p>
    </div>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-background p-6">
      <div className="flex items-center gap-3">
        <div className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-cream-100/20 bg-ink-700/50 text-cream-200">
          {icon}
        </div>
        <div className="font-display italic text-lg leading-none text-cream-50">
          {title}
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-cream-300">{body}</p>
    </div>
  );
}
