// Names that must not repeat (campaigns, templates, flows — same idea as lists
// and usernames) are compared case-insensitively and without surrounding
// spaces. Rows that were already duplicated before these checks existed stay
// as they are; only new saves and renames are checked.

// Prisma `where` fragment: name equals `name` (trimmed, any case), optionally
// ignoring one row (the row being renamed).
const nameEquals = (name, exceptId = null) => ({
  name: { equals: String(name).trim(), mode: "insensitive" },
  ...(exceptId ? { id: { not: exceptId } } : {}),
});

// True when a rename really changes the name — a save that sends the name
// back unchanged (only case/spaces aside) isn't checked, so an old duplicate
// can still be edited.
const isRename = (current, next) =>
  String(current || "").trim().toLowerCase() !== String(next || "").trim().toLowerCase();

// First free name in the series produced by `candidate(base, n)` for n = 1, 2,
// 3… `exists(name)` is an async check against the model's own scope. `taken`
// is an optional Set of lower-cased names already handed out in the same batch
// (an import), so two rows of one batch don't both get the same name.
async function freeName(exists, base, candidate, taken = null) {
  const clean = String(base).trim();
  for (let n = 1; n < 1000; n++) {
    const name = candidate(clean, n);
    if (taken?.has(name.toLowerCase())) continue;
    if (!(await exists(name))) {
      taken?.add(name.toLowerCase());
      return name;
    }
  }
  throw new Error(`No free name found for "${clean}"`);
}

// "X", "X (2)", "X (3)"…
const numbered = (base, n) => (n === 1 ? base : `${base} (${n})`);
// "X (copy)", "X (copy 2)"…
const copied = (base, n) => (n === 1 ? `${base} (copy)` : `${base} (copy ${n})`);

module.exports = { nameEquals, isRename, freeName, numbered, copied };
