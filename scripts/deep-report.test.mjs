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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
