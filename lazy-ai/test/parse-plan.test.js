// Regression tests for screen-control.js plan parsing (Stage 5.4 fix).
//
// Guards the truncation-recovery behaviour: the model's reply can be cut off at
// max_tokens on heavy turns (large UIA list + adaptive thinking). parsePlan must
// recover the COMPLETE actions from a truncated reply instead of discarding the
// whole plan (the old "Couldn't work out a safe plan" bug). No test framework —
// run with:  node test/parse-plan.test.js   (exits non-zero on any failure).

const { parsePlan, pruneElements } = require("../src/screen-control");

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`}`);
}
const shape = (p) => ({ done: p.done, n: p.actions.length, parsed: p.parsed });

// 1. Clean, complete JSON.
check("valid plan", shape(parsePlan(`{"done":true,"say":"ok","actions":[{"type":"ui_type","ref":2,"text":"KMKL"}]}`)),
  { done: true, n: 1, parsed: true });

// 2. Truncated mid-string (last action's text cut) → drop the suspect last action.
check("truncated mid-string drops last", shape(parsePlan(`{"done":false,"say":"Typing","actions":[{"type":"ui_type","ref":42,"text":"KMK`)),
  { done: false, n: 0, parsed: true });

// 3. A complete action, then the next action's string is cut → keep the complete one.
check("keeps complete action before cut", shape(parsePlan(`{"done":false,"actions":[{"type":"press","keys":"ctrl+e"},{"type":"text","text":"Bhone`)),
  { done: false, n: 1, parsed: true });

// 4. Cut right after a complete action's closing brace (brackets only) → keep it.
check("keeps action when only brackets closed", shape(parsePlan(`{"done":false,"actions":[{"type":"press","keys":"enter"}`)),
  { done: false, n: 1, parsed: true });

// 5. Two complete actions, cut after a number (no open string) → keep both.
check("keeps both when cut after number", shape(parsePlan(`{"done":false,"actions":[{"type":"launch","app":"teams"},{"type":"wait","ms":2000`)),
  { done: false, n: 2, parsed: true });

// 6. Prose preamble before the JSON → ignored.
check("ignores prose preamble", shape(parsePlan(`Sure, here is the plan: {"done":true,"say":"x","actions":[{"type":"press","keys":"enter"}]}`)),
  { done: true, n: 1, parsed: true });

// 7. Code-fenced JSON → unwrapped.
check("unwraps code fences", shape(parsePlan("```json\n{\"done\":true,\"say\":\"x\",\"actions\":[]}\n```")),
  { done: true, n: 0, parsed: true });

// 8. Empty reply (whole budget went to a thinking block) → NOT done and NOT parsed, so the
//    loop keeps the overlay up and re-plans instead of hiding it as if the task completed
//    (the "opened the app, then nothing happened, bar disappeared" bug).
check("empty reply → not-done re-plan", shape(parsePlan("")),
  { done: false, n: 0, parsed: false });

// 9. Non-JSON garbage → same contract: not done, not parsed (never treat as completion).
check("garbage → not-done re-plan", shape(parsePlan("I cannot help with that.")),
  { done: false, n: 0, parsed: false });

// 10. Malformed actions inside an otherwise-valid plan are dropped, not fatal.
check("drops malformed actions", parsePlan(`{"done":true,"actions":[{"type":"ui_type","ref":3,"text":"hi"},{"type":"bogus"},{"type":"press"}]}`).actions.length,
  1);

// --- Phase 1: UIA pruning (space-complexity fix). Keep only actionable controls;
// drop static chat bubbles / labels / containers, but preserve idx of survivors. ---
const teamsDump = [
  { idx: 0, name: "Search", type: "edit", invoke: false, value: true },          // search box → keep (editable)
  { idx: 1, name: "Hi there, how are you?", type: "text", invoke: false, value: false }, // chat bubble → drop
  { idx: 2, name: "See you tomorrow!", type: "text", invoke: false, value: false },      // chat bubble → drop
  { idx: 3, name: "Bhone Min Thant", type: "list item", invoke: true, value: false },    // contact row → keep (invokable)
  { idx: 4, name: "Type a message", type: "edit", invoke: false, value: true },          // compose box → keep (editable)
  { idx: 5, name: "Send", type: "button", invoke: true, value: false },                  // send → keep
  { idx: 6, name: "Chat", type: "tab", invoke: false, value: false },                    // non-invokable tab → drop
  { idx: 7, name: "Filter", type: "combo box", invoke: false, value: false },            // combo type → keep
];
const pruned = pruneElements(teamsDump);
check("pruning drops static chat bubbles", pruned.map((e) => e.idx), [0, 3, 4, 5, 7]);
check("pruning preserves original idx (refs stay valid)", pruned.find((e) => e.name === "Type a message").idx, 4);
check("pruning on empty/non-array → []", pruneElements(null), []);

console.log(failures === 0 ? "\nAll parse-plan regression tests passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
