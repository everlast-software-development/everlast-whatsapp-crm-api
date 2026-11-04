// Pure check of the saved-reply validation — no database, no network.
// Run: npm run check:saved-replies

const { validateSavedReply } = require("../modules/saved-replies/savedReply.controller");

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${label}${ok ? "" : `  (got ${actual}, expected ${expected})`}`);
}
const err = (r) => r.error || "";

const ok = validateSavedReply({ shortcut: " hours ", title: " Opening hours ", body: "9–9 " });
check("valid reply is trimmed", JSON.stringify(ok.data), JSON.stringify({ shortcut: "hours", title: "Opening hours", body: "9–9" }));

check("capitals/spaces are rejected, not rewritten", /lowercase/.test(err(validateSavedReply({ shortcut: "Opening Hours", title: "t", body: "b" }))), true);
check("shortcut over 30 rejected", !!validateSavedReply({ shortcut: "a".repeat(31), title: "t", body: "b" }).error, true);
check("shortcut of 30 accepted", !!validateSavedReply({ shortcut: "a".repeat(30), title: "t", body: "b" }).data, true);
check("title over 80 rejected", !!validateSavedReply({ shortcut: "a", title: "t".repeat(81), body: "b" }).error, true);
check("body over 4096 rejected", !!validateSavedReply({ shortcut: "a", title: "t", body: "b".repeat(4097) }).error, true);
check("empty body rejected", !!validateSavedReply({ shortcut: "a", title: "t", body: "   " }).error, true);
check("missing title rejected", !!validateSavedReply({ shortcut: "a", body: "b" }).error, true);

const partial = validateSavedReply({ title: "x" }, { partial: true });
check("partial update keeps only given fields", JSON.stringify(partial.data), JSON.stringify({ title: "x" }));
check("partial update still validates", !!validateSavedReply({ shortcut: "A B" }, { partial: true }).error, true);

const arabic = "مواعيد العمل ٩–٩";
check("Arabic body kept as is", validateSavedReply({ shortcut: "hours-ar", title: "مواعيد", body: arabic }).data?.body, arabic);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
