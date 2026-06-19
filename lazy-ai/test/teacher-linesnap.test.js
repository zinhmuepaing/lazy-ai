// Regression tests for screen-teacher.js OCR line-snapping (Sonnet accuracy fix).
//
// Sonnet 4.6 can't place pixels for code lines, so it quotes a line's VERBATIM text
// in "code" and resolveLineRefs() fuzzy-matches it to the real OCR rect and snaps
// the annotation there. This replaced an index-based scheme that landed ~2 visible
// lines too high (the model miscounted against the blank-stripped list). These
// guard the text-matching + the integer-index fallback. No framework — run with:
//   node test/teacher-linesnap.test.js   (exits non-zero on any failure).

const { resolveLineRefs } = require("../src/screen-teacher");

let failures = 0;
function check(name, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
}

// OCR output mirrors the real "twoSum" screenshot — blank editor lines are absent
// (OCR only returns lines with text), which is exactly what broke index counting.
const OCR = [
  { text: "class Solution:", x: 240, y: 178, w: 200, h: 22 },
  { text: "def twoSum(self, nums: List[int], target: int) -> List[int]:", x: 290, y: 210, w: 720, h: 22 },
  { text: "map = {}", x: 345, y: 277, w: 110, h: 22 }, // editor line 4
  { text: "for i, n in enumerate(nums):", x: 345, y: 343, w: 370, h: 22 }, // editor line 6
  { text: "diff = target - n", x: 400, y: 376, w: 230, h: 22 }, // editor line 7
  { text: "if diff in map:", x: 400, y: 442, w: 180, h: 22 }, // editor line 9
  { text: "return [map[diff], i]", x: 455, y: 475, w: 290, h: 22 }, // editor line 10
  { text: "map[n] = i", x: 400, y: 541, w: 140, h: 22 }, // editor line 12
  { text: "return []", x: 345, y: 607, w: 130, h: 22 }, // editor line 14
];
const draw = (steps) => resolveLineRefs(steps, OCR, 1280, 800)[0].draw;

// 1. THE BUG: a highlight for the for-loop must land on the for-loop's real rect
//    (y≈343), NOT ~2 lines above on "map = {}" (y≈277).
{
  const d = draw([{ say: "the loop", draw: [{ shape: "highlight", code: "for i, n in enumerate(nums):", label: "loop" }] }])[0];
  check("highlight by code → lands on the for-loop line (not 2 above)",
    d.shape === "highlight" && d.y <= 343 && d.y + d.h >= 365 && d.y > 320);
}

// 2. Fuzzy match survives OCR whitespace noise (extra spaces, missing colon).
{
  const d = draw([{ say: "x", draw: [{ shape: "highlight", code: "for i,n in enumerate(nums)" }] }])[0];
  check("fuzzy code match tolerates whitespace/colon diffs", d.shape === "highlight" && d.y > 320 && d.y < 360);
}

// 3. code range → band spanning first..last matched line.
{
  const d = draw([{ say: "x", draw: [{ shape: "highlight", code: "if diff in map:", codeTo: "return [map[diff], i]" }] }])[0];
  check("code range spans both lines", d.shape === "highlight" && d.y <= 442 && d.y + d.h >= 497);
}

// 4. arrow by code at a roomy line → horizontal arrow into the line's left edge.
{
  const d = draw([{ say: "x", draw: [{ shape: "arrow", code: "diff = target - n" }] }])[0];
  check("arrow by code → horizontal into left edge",
    d.shape === "arrow" && d.from[1] === d.to[1] && d.to[0] < 400 && Math.abs(d.to[1] - 387) < 6);
}

// 5. label by code → example note glued to the RIGHT of the matched line.
{
  const d = draw([{ say: "x", draw: [{ shape: "label", code: "diff = target - n", text: "diff = 9 - 2 = 7" }] }])[0];
  check("label by code → note beside the line",
    d.shape === "label" && d.text === "diff = 9 - 2 = 7" && d.x >= 400 + 230 && Math.abs(d.y - 376) < 4);
}

// 6. a stray integer index (no "code") is IGNORED — the index path is gone, so a
//    miscounted index can't drift the box ~2 lines or cascade across steps.
{
  const d = draw([{ say: "x", draw: [{ shape: "highlight", line: 3 }] }]);
  check("stray integer index is dropped (no cascade path)", d.length === 0);
}

// 7. raw-pixel shape with no ref passes through unchanged.
{
  const d = draw([{ say: "x", draw: [{ shape: "circle", x: 500, y: 500, r: 20 }] }])[0];
  check("raw-pixel circle passes through", d.shape === "circle" && d.x === 500 && d.r === 20);
}

// 8. an unmatchable code string with no pixel fallback is dropped (never drawn coordless).
{
  const d = draw([{ say: "x", draw: [{ shape: "highlight", code: "zzz nothing like this on screen qqq" }] }]);
  check("unmatchable code dropped", d.length === 0);
}

// 9. empty OCR → steps pass through untouched (Opus / OCR-failed path).
{
  const steps = [{ say: "x", draw: [{ shape: "box", x: 1, y: 2, w: 3, h: 4 }] }];
  check("empty OCR → unchanged", resolveLineRefs(steps, [], 1280, 800) === steps);
}

// 10. older model habit: the code text is only in "label" (no "code") → still snaps.
{
  const d = draw([{ say: "x", draw: [{ shape: "highlight", label: "for i, n in enumerate(nums)" }] }])[0];
  check("label-as-code still snaps to the line", d.shape === "highlight" && d.y > 320 && d.y < 360);
}

// 11. a semantic caption + pixel coords must NOT be hijacked — it keeps its pixels.
{
  const d = draw([{ say: "x", draw: [{ shape: "circle", x: 900, y: 500, r: 15, label: "the result area" }] }])[0];
  check("semantic label + pixels kept", d.shape === "circle" && d.x === 900 && d.y === 500);
}

// --- Math-diagram anchoring (OCR mangles symbols; match on letters+digits) ------
// Mirrors the real "trig triangle" capture: "34°" is OCR'd as "340", "18 cm" as
// ".1ßErn", and the y-angle / "10 cm" aren't detected at all.
const DIAGRAM = [
  { text: "In the triangle, angle y is obtuse.", x: 255, y: 71, w: 440, h: 32 },
  { text: ".1ßErn", x: 802, y: 317, w: 91, h: 33 }, // "18 cm" mangled
  { text: "340", x: 994, y: 512, w: 45, h: 25 }, // "34°" → "340"
  { text: "24 cm", x: 300, y: 560, w: 110, h: 28 },
];
const ddraw = (steps) => resolveLineRefs(steps, DIAGRAM, 1745, 720)[0].draw;

// 12. THE TRIG BUG: circle the "34°" angle → snaps onto the "340" label at the
//     bottom-right vertex (≈994–1039 x, ≈512–537 y), not the model's pixel guess.
{
  const d = ddraw([{ say: "the angle", draw: [{ shape: "circle", code: "34°", label: "angle" }] }])[0];
  check("circle 34° → snaps to the 340 vertex label",
    d.shape === "circle" && d.x > 994 && d.x < 1040 && d.y > 510 && d.y < 540);
}

// 13. "34°" must NOT false-match "24 cm" (different digits).
{
  const d = ddraw([{ say: "x", draw: [{ shape: "circle", code: "34°" }] }])[0];
  check("34° doesn't hijack 24 cm", d.x > 994); // 24 cm is at x≈300
}

// 14. Copying the OCR-mangled list string verbatim matches it exactly.
{
  const d = ddraw([{ say: "x", draw: [{ shape: "arrow", code: ".1ßErn", label: "opp" }] }])[0];
  check("verbatim mangled anchor (.1ßErn) snaps", d.shape === "arrow" && d.to[0] < 802 + 91 + 30);
}

// 15. A short SEMANTIC caption ("angle") on a pixel-placed shape must NOT hijack a
//     sentence that merely contains the word — the shape keeps its own pixels.
{
  const d = ddraw([{ say: "x", draw: [{ shape: "circle", x: 1016, y: 524, r: 30, label: "angle" }] }])[0];
  check("semantic caption doesn't hijack a sentence", d.x === 1016 && d.y === 524);
}

console.log(failures ? `\n${failures} FAILED` : "\nAll teacher line-snap tests passed.");
process.exit(failures ? 1 : 0);
