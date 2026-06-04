"use client";

export type ChineseScript = "traditional" | "simplified";

type Converter = (s: string) => string;

let _converterPromise: Promise<{
  toTraditional: Converter;
  toSimplified: Converter;
}> | null = null;

async function getConverters() {
  if (!_converterPromise) {
    _converterPromise = import("opencc-js").then((mod) => {
      const Converter =
        (mod as unknown as { Converter: typeof import("opencc-js").Converter })
          .Converter ??
        (mod as unknown as { default: { Converter: typeof import("opencc-js").Converter } })
          .default.Converter;
      return {
        toTraditional: Converter({ from: "cn", to: "twp" }),
        toSimplified: Converter({ from: "tw", to: "cn" }),
      };
    });
  }
  return _converterPromise;
}

/**
 * Convert a snippet of Chinese text to the requested script. Whisper itself
 * has no zh-Hant / zh-Hans distinction, so we normalise on the client.
 * The OpenCC dictionary is fetched lazily on first use.
 */
export async function convertChinese(
  text: string,
  target: ChineseScript
): Promise<string> {
  if (!text) return text;
  const { toTraditional, toSimplified } = await getConverters();
  return target === "traditional" ? toTraditional(text) : toSimplified(text);
}
