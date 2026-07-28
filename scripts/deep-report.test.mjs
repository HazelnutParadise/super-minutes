// Unit tests for the pure plumbing in lib/server/deep-report.ts — the code
// that repairs model output so nothing is silently lost.
//
//   node --experimental-strip-types scripts/deep-report.test.mjs
//
// These functions are what stands between a misbehaving model and a broken
// report: they must survive unsorted, duplicated, out-of-range, missing and
// empty model output without dropping a single note.
import {
  cutBudget,
  sliceTranscript,
  boundariesToRanges,
  evenRanges,
  groupsToSections,
  routeNote,
  normaliseActions,
  normaliseKey,
  verifiedOpenQuestions,
} from "../lib/server/deep-report.ts";

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + "\n    got  " + g + "\n    want " + w);
  }
};
const shape = (s) => s.map((x) => [x.heading, x.ranges]);

// --- cutBudget scales with input, never degenerates ---
eq("cutBudget 134", cutBudget(134), { lo: 9, hi: 22 });
eq("cutBudget 67", cutBudget(67), { lo: 4, hi: 11 });
eq("cutBudget 20 small meeting keeps a floor", cutBudget(20), { lo: 3, hi: 6 });
eq("cutBudget 600 long meeting is capped", cutBudget(600), { lo: 40, hi: 60 });

// --- sliceTranscript cuts on line boundaries with overlap ---
const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
const slices = sliceTranscript(lines.join("\n"), 60, 1);
eq(
  "sliceTranscript covers every line",
  slices.join("\n").includes("line 9"),
  true
);
eq("sliceTranscript empty input → one slice", sliceTranscript("", 60, 1).length, 1);

// --- boundariesToRanges repairs model output ---
eq("boundaries normal", boundariesToRanges([1, 5, 9], 12), [[1, 4], [5, 8], [9, 12]]);
eq("boundaries unsorted+dup", boundariesToRanges([9, 1, 5, 5], 12), [[1, 4], [5, 8], [9, 12]]);
eq("boundaries first forced to 1", boundariesToRanges([3, 7], 10), [[1, 6], [7, 10]]);
eq("boundaries out of range dropped", boundariesToRanges([1, 5, 99], 10), [[1, 4], [5, 10]]);
eq("boundaries empty → whole recording", boundariesToRanges([], 10), [[1, 10]]);
eq("boundaries null → whole recording", boundariesToRanges(null, 10), [[1, 10]]);
eq("boundaries non-numeric dropped", boundariesToRanges([1, "x", 5], 10), [[1, 4], [5, 10]]);

// --- evenRanges mechanical fallback ---
eq("evenRanges 10/3", evenRanges(10, 3), [[1, 4], [5, 8], [9, 10]]);
eq("evenRanges more targets than notes", evenRanges(3, 10), [[1, 1], [2, 2], [3, 3]]);
eq("evenRanges exact division", evenRanges(12, 4), [[1, 3], [4, 6], [7, 9], [10, 12]]);

// --- groupsToSections repairs and never loses material ---
const R = [[1, 4], [5, 8], [9, 12], [13, 16]];
eq(
  "groups adjacent merge",
  shape(groupsToSections([{ heading: "A", stretches: [1, 2] }, { heading: "B", stretches: [3, 4] }], R)),
  [["A", [[1, 4], [5, 8]]], ["B", [[9, 12], [13, 16]]]]
);
eq(
  "groups doubled-back subject: non-adjacent stretches in one section",
  shape(groupsToSections([{ heading: "A", stretches: [1, 4] }, { heading: "B", stretches: [2, 3] }], R)),
  [["A", [[1, 4], [13, 16]]], ["B", [[5, 8], [9, 12]]]]
);
eq(
  "groups duplicate member keeps first group",
  shape(groupsToSections([{ heading: "A", stretches: [1, 2] }, { heading: "B", stretches: [2, 3, 4] }], R)),
  [["A", [[1, 4], [5, 8]]], ["B", [[9, 12], [13, 16]]]]
);
eq(
  "groups forgotten stretch joins nearest neighbour",
  shape(groupsToSections([{ heading: "A", stretches: [1] }, { heading: "B", stretches: [3, 4] }], R)),
  [["A", [[1, 4], [5, 8]]], ["B", [[9, 12], [13, 16]]]]
);
eq(
  "groups headingless group dropped BEFORE claiming its stretches",
  shape(groupsToSections([{ heading: "A", stretches: [1, 2] }, { heading: " ", stretches: [3, 4] }], R)),
  [["A", [[1, 4], [5, 8], [9, 12], [13, 16]]]]
);
eq("groups empty input", groupsToSections(null, R), []);

// --- routeNote pure lookup ---
const secs = groupsToSections(
  [{ heading: "A", stretches: [1, 3] }, { heading: "B", stretches: [2, 4] }],
  R
);
eq("routeNote hits merged section's second range", routeNote(10, secs), 0);
eq("routeNote hits middle section", routeNote(6, secs), 1);
eq("routeNote unowned note", routeNote(99, secs), -1);
eq(
  "indices concatenate across ranges",
  secs.map((s) => s.indices),
  [[1, 2, 3, 4, 9, 10, 11, 12], [5, 6, 7, 8, 13, 14, 15, 16]]
);

// --- normaliseActions: model output → action list ---
eq(
  "actions keep task/owner/due",
  normaliseActions([{ task: " 交報告 ", owner: " 小美 ", due: " 週五 " }]),
  [{ task: "交報告", owner: "小美", due: "週五" }]
);
eq(
  'actions treat "N/A" and blanks as no deadline',
  normaliseActions([
    { task: "A", owner: "x", due: "N/A" },
    { task: "B", owner: "", due: "   " },
  ]),
  [
    { task: "A", owner: "x", due: null },
    { task: "B", owner: null, due: null },
  ]
);
eq(
  "actions drop entries with no task",
  normaliseActions([{ task: "  ", owner: "x" }, { owner: "y" }, { task: "C" }]),
  [{ task: "C", owner: null, due: null }]
);
eq("actions non-array → empty", normaliseActions(null), []);

// --- normaliseKey: near-duplicate detection for the supplement pass ---
eq(
  "key ignores spacing and trailing punctuation",
  normaliseKey(" 交出 報告。") === normaliseKey("交出報告"),
  true
);
eq(
  "key ignores brackets and case",
  normaliseKey("Ship PR（本週）") === normaliseKey("ship pr本週"),
  true
);
eq(
  "key keeps genuinely different tasks apart",
  normaliseKey("交報告") === normaliseKey("交企劃"),
  false
);

// --- verifiedOpenQuestions: an entry survives only if its evidence is real ---
const NOTES = [
  "怡君說折扣的影響先擱著，等政雄禮拜四的拆解出來再定調。",
  "亞馬遜後臺的頁面瀏覽沒有細分到圖片或影片，不像 GA4 可以埋 call。",
];
eq(
  "keeps an entry whose evidence is in the notes",
  verifiedOpenQuestions(
    [{ question: "折扣影響多大還沒定調。", evidence: "先擱著" }],
    NOTES
  ),
  ["折扣影響多大還沒定調。"]
);
eq(
  "drops an answered fact dressed up as an open question",
  verifiedOpenQuestions(
    [
      {
        question: "頁面瀏覽能不能細分到圖片或影片？",
        evidence: "這件事還沒有結論",
      },
    ],
    NOTES
  ),
  []
);
eq(
  "evidence matching ignores punctuation and spacing",
  verifiedOpenQuestions(
    [{ question: "Q", evidence: " 等政雄，禮拜四的拆解出來。" }],
    NOTES
  ),
  ["Q"]
);
eq(
  "drops entries with missing or empty fields",
  verifiedOpenQuestions(
    [
      { question: "", evidence: "先擱著" },
      { question: "Q", evidence: "  " },
      { question: "Q2" },
      "not an object",
    ],
    NOTES
  ),
  []
);
eq(
  "drops evidence too short to mean anything",
  verifiedOpenQuestions([{ question: "Q", evidence: "再" }], NOTES),
  []
);
eq("non-array → empty", verifiedOpenQuestions(null, NOTES), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
