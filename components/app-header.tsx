"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** Editorial masthead — a periodical's nameplate. Dateline updates client-side
 *  so we don't serialize a fresh date into HTML (and confuse hydration). */
export function AppHeader() {
  const [dateline, setDateline] = useState("");
  useEffect(() => {
    const d = new Date();
    const months = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ];
    setDateline(
      `VOL. I · ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")} · ${d.getFullYear()}`
    );
  }, []);

  return (
    <header className="relative">
      <div className="container mx-auto px-6 pt-6">
        <div className="flex items-end justify-between gap-6 border-b border-cream-100/20 pb-3">
          <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500">
            {dateline || "VOL. I"}
          </div>
          <div className="font-mono text-[10px] tracking-[0.3em] text-cream-500 hidden sm:block">
            自動逐字稿 · 講者分離 · 智能整稿
          </div>
        </div>

        <div className="relative flex items-center justify-between pt-6 pb-3">
          <Link href="/" className="group flex items-end gap-4">
            <span className="wax-stamp inline-flex h-12 w-12 items-center justify-center rounded-full font-display italic text-2xl leading-none">
              M
            </span>
            <span className="leading-none">
              <span className="block font-display text-[clamp(2.25rem,3.4vw,3rem)] italic leading-[0.85] text-cream-50">
                Super Minutes<span className="text-vermillion">.</span>
              </span>
              <span className="mt-1 block font-mono text-[10px] tracking-[0.3em] text-cream-500">
                會議錄音 · 結構化報告
              </span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 font-mono text-[10px] tracking-[0.3em] text-cream-500">
            <a
              href="https://github.com/HazelnutParadise/super-captions"
              target="_blank"
              rel="noreferrer"
              className="hover:text-cream-200 transition-colors"
            >
              SIBLING · CAPTIONS ↗
            </a>
            <Link
              href="/editor"
              className="hover:text-cream-200 transition-colors"
            >
              EDITOR
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}
