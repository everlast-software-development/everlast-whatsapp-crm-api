# Saved Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared list of canned answers, edited by Admins/Supervisors, inserted into the chat composer by typing `/`.

**Architecture:** A `SavedReply` Prisma table behind a small `modules/saved-replies` CRUD module guarded by two new permissions. The frontend adds a Settings tab to manage them and a picker in the chat composer; `{name}` is filled client-side before insertion.

**Tech Stack:** Express 5 + Prisma 5 (Neon Postgres), Next.js + Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-11-04-saved-replies-design.md`

## Global Constraints

- Permissions: `saved_reply:read` → ADMIN (via `*`), SUPERVISOR, AGENT. `saved_reply:write` → ADMIN (via `*`), SUPERVISOR. MARKETING and DIRECTOR get neither.
- Limits: shortcut ≤ 30 chars, lowercase, `[a-z0-9_-]` only; title ≤ 80; body ≤ 4096.
- One global list (not per WhatsApp number): API calls use `{ numberScoped: false }`.
- A reply is inserted into the box, never sent.
- **Both repos have someone else's uncommitted edits** (API: `config/permissions.js`, `prisma/schema.prisma`, `package.json` and others; frontend: 17 files incl. `chats/[id]/page.tsx`, `layout.tsx`). Stage only the hunks this plan adds (`git add -p`); never `git add -A`, never revert their changes. The frontend's `types/index.ts` also has a pending Spending `isDefault` edit from today — leave it.
- User preference: don't run slow check suites. Run only the checks named in each task, one at a time (shared DB).

## Review Focus

1. Patient with no name / phone-only → `{name}` removed cleanly ("Hi {name}," → "Hi,"); tested in Task 3.
2. Arabic text in a reply → stored and inserted unchanged; picker rows use `dir="auto"`; tested in Task 3 (fill leaves Arabic intact).
3. Shortcut typed with capitals or spaces ("Opening Hours") → rejected with a readable 400, never silently rewritten (the Settings form lowercases as you type, so this is rare); tested in Task 1.
4. Two supervisors creating the same shortcut → second gets 409 "That shortcut is already used"; the unique index backs it; tested in Task 1.
5. `/` typed mid-sentence ("1/2 price") → picker must NOT open; only when `/` is the first character of the box; tested in Task 3 (`slashQuery`).

---

### Task 1: API — table, permissions, routes

**Files:**
- Modify: `prisma/schema.prisma` (add model + `User` back-relation `savedReplies SavedReply[]`)
- Create: `prisma/migrations/20261104130000_saved_replies/migration.sql` (via `npx prisma migrate dev --name saved_replies --create-only`, then rename the folder to that timestamp if needed)
- Modify: `config/permissions.js` (ALL_PERMISSIONS under a `// Saved replies` comment; grants in SUPERVISOR and AGENT)
- Create: `modules/saved-replies/savedReply.controller.js`, `modules/saved-replies/savedReply.routes.js`
- Modify: `app.js` (mount after `/api/supervision`)
- Create: `tests/savedReplies.check.js`; Modify: `package.json` (`"check:saved-replies"`), `tests/roles.check.js` (ENDPOINTS)

**Interfaces — Produces:**
- `model SavedReply { id Int @id @default(autoincrement()); shortcut String @unique; title String; body String; createdById Int?; createdBy User? @relation(fields:[createdById], references:[id], onDelete: SetNull); createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }`
- `GET /api/saved-replies` → `{ success, data: SavedReply[] }` ordered by `shortcut asc` (`saved_reply:read`)
- `POST /api/saved-replies` body `{ shortcut, title, body }` → 201 `{ success, data }` (`saved_reply:write`)
- `PATCH /api/saved-replies/:id` partial body → `{ success, data }`; 404 unknown id (`saved_reply:write`)
- `DELETE /api/saved-replies/:id` → `{ success: true }`; 404 unknown id (`saved_reply:write`)
- `validateSavedReply(input, { partial }) → { data } | { error: string }` exported from the controller for the check.
- Audit actions: `saved_reply.created|updated|deleted`, targetType `"SavedReply"`, details `{ shortcut }`.

- [ ] **Step 1: Write `tests/savedReplies.check.js`** in the style of `tests/quietHours.check.js` (pure, no DB), against `validateSavedReply`:
  - `{shortcut:"hours", title:"Opening hours", body:"9–9"}` → data with same values (trimmed)
  - `shortcut:"Opening Hours"` → error containing "lowercase"
  - shortcut 31 chars → error; title 81 → error; body 4097 → error; empty body → error
  - `{ title:"x" }` with `partial:true` → data `{ title:"x" }` only
  - Arabic body `"مواعيد العمل ٩–٩"` → kept byte-for-byte
- [ ] **Step 2:** `node tests/savedReplies.check.js` → FAIL (module not found)
- [ ] **Step 3:** Add model, generate migration (`--create-only`, inspect SQL: one table + unique index + FK), add permissions with a comment like neighbours, write controller (409 on Prisma `P2002` with "That shortcut is already used", AppError for 400/404, `logAudit` like `list.controller.js`), routes (`protect` + `requirePermission`), mount in `app.js`, add `check:saved-replies` script.
- [ ] **Step 4:** `node tests/savedReplies.check.js` → all PASS
- [ ] **Step 5:** Add to `tests/roles.check.js` ENDPOINTS: `["GET","/api/saved-replies","saved_reply:read"]`, `["POST","/api/saved-replies","saved_reply:write"]`, `["PATCH",\`/api/saved-replies/${NOPE}\`,"saved_reply:write"]`, `["DELETE",\`/api/saved-replies/${NOPE}\`,"saved_reply:write"]`. Apply migration to the dev DB (`npx prisma migrate deploy`) — **ask the user first**, it is the shared Neon DB. Then `npm run check:roles` once → PASS.
- [ ] **Step 6: Commit** only this task's hunks: `git add -p` the schema/permissions/app.js/package.json/roles.check hunks plus the new files; `git commit -m "Saved replies: table, permissions and API"`

### Task 2: Frontend — API client, types, Settings tab

**Files:**
- Modify: `lib/permissions.ts` (add `"saved_reply:read" | "saved_reply:write"` to the union)
- Modify: `types/index.ts` (`SavedReply { id: number; shortcut: string; title: string; body: string; updatedAt: string }`)
- Modify: `lib/api.ts` (`apiGetSavedReplies()`, `apiCreateSavedReply(data)`, `apiUpdateSavedReply(id, data)`, `apiDeleteSavedReply(id)` — all `{ numberScoped: false }`)
- Create: `components/settings/SavedRepliesPanel.tsx`
- Modify: `app/(dashboard)/settings/page.tsx`, `app/(dashboard)/layout.tsx:323`

**Interfaces — Consumes:** Task 1 routes. **Produces:** `apiGetSavedReplies(): Promise<{ success: boolean; data: SavedReply[] }>` used by Task 3.

- [ ] **Step 1:** Add types, permission names, API functions.
- [ ] **Step 2:** `SavedRepliesPanel`: table (shortcut as `/hours`, title, body preview with `dir="auto"` line-clamp-2), search box, Add/Edit dialog via `DialogShell` (shortcut — lowercased and spaces→`-` as you type, title, body textarea `dir="auto"` with a hint "Use {name} for the patient's first name"), delete with confirm. Show the server's 409/400 message inline. Match `QuietHoursPanel`/`UsersPanel` styling.
- [ ] **Step 3:** Settings page: give every TAB a `perm` (`users`→`user:write`, `numbers`→`number:write`, `quiet-hours`/`campaign-safety`→`settings:write`, new `saved-replies`→`saved_reply:write` with group "Messaging", icon `MessageSquareText`, wide true, description "Ready-made answers agents insert by typing /", `account`→ none). Filter tabs by `can`; page allowed when `can("settings:write") || can("saved_reply:write")`; default tab = first visible.
- [ ] **Step 4:** Nav item: `perm: can("settings:write") ? "settings:write" : "saved_reply:write"` and update its comment.
- [ ] **Step 5:** `npx tsc --noEmit -p .` → no errors; `npx eslint` on touched files → clean.
- [ ] **Step 6: Commit** (`git add -p`, own hunks only): "Settings: Saved replies tab"

### Task 3: Frontend — composer picker and `{name}` fill

**Files:**
- Create: `lib/savedReplies.ts`, `scripts/check-saved-replies.ts`
- Create: `components/SavedReplyPicker.tsx`
- Modify: `app/(dashboard)/chats/[id]/page.tsx` (composer around the textarea `onChange`/`onKeyDown`, ~L2150–2185, and the button row next to emoji)

**Interfaces — Produces (in `lib/savedReplies.ts`):**
- `slashQuery(text: string): string | null` — `null` unless `text` starts with `/` and has no newline; otherwise the text after `/`.
- `filterReplies(replies: SavedReply[], query: string): SavedReply[]` — case-insensitive match on shortcut prefix first, then title/shortcut substring; max 8.
- `fillReply(body: string, fullName: string | null | undefined): string` — `{name}` → first word of `fullName`; with no name, removes `{name}` and collapses a resulting `" ,"`, `"  "` or leading/trailing space on that line.

- [ ] **Step 1: Write `scripts/check-saved-replies.ts`** (same PASS/FAIL printer as the API checks), importing from `../lib/savedReplies.ts`:
  - `slashQuery("/ho")` → `"ho"`; `slashQuery("/")` → `""`; `slashQuery("1/2 price")` → `null`; `slashQuery("hi")` → `null`; `slashQuery("/a\nb")` → `null`
  - `fillReply("Hi {name}, welcome", "Sara Ahmed")` → `"Hi Sara, welcome"`
  - `fillReply("Hi {name}, welcome", null)` → `"Hi, welcome"`; `fillReply("{name} hello", "")` → `"hello"`
  - `fillReply("أهلاً {name}", "محمد علي")` → `"أهلاً محمد"`
  - `filterReplies` with shortcuts `["hours","address","price-list"]`, query `"pr"` → first is `price-list`
- [ ] **Step 2:** `node scripts/check-saved-replies.ts` (Node 24 strips types) → FAIL (module missing)
- [ ] **Step 3:** Implement `lib/savedReplies.ts`.
- [ ] **Step 4:** `node scripts/check-saved-replies.ts` → all PASS
- [ ] **Step 5:** `SavedReplyPicker` props `{ replies: SavedReply[]; query: string; activeIndex: number; onPick(r: SavedReply): void; onClose(): void }` — positioned like the emoji picker (`absolute bottom-… z-50`), rows show `/shortcut`, title, one-line body (`dir="auto"`), empty state "No saved replies match" (and, when the list is empty, "No saved replies yet" + a Settings link for those with `saved_reply:write`).
- [ ] **Step 6:** Wire into the chat page, only when `can("saved_reply:read")` and `!windowClosed`: load replies once on mount (`apiGetSavedReplies`, ignore errors); picker open when `slashQuery(message) !== null` or the new button (`MessageSquareText`, beside Smile) is toggled; in `onKeyDown`, while open, ArrowUp/Down move, Enter/Tab pick (`preventDefault`, so Enter doesn't send), Escape closes. Pick → `setMessage(fillReply(r.body, customer?.name))`, resize the textarea, focus it with the caret at the end. Don't touch the other session's pending edits in this file.
- [ ] **Step 7:** `npx tsc --noEmit -p .` → clean. Manual check in the browser (dev server): `/` opens, filters, Enter inserts without sending, `{name}` fills, Esc closes, `1/2` doesn't open, closed window hides it, agent login sees the picker but not the Settings tab.
- [ ] **Step 8: Commit** (own hunks only): "Chat: insert saved replies with /"
