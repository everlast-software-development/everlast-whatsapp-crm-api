# Saved replies — design (approved 2026-11-04)

## Why
Agents keep typing the same answers (prices, address, opening hours). One
shared list lets them insert a vetted answer in a keystroke and keeps answers
consistent across the team.

## Goals
- One shared list, edited by Admins and Supervisors, used by everyone with an inbox.
- In the composer, `/` opens a picker; the chosen reply is inserted for editing.

## Non-goals (later, if wanted)
Personal replies, attachments, usage counts, one-click send.

## Anti-goals
- A reply must never be sent without the agent seeing it in the box first.
- Not WhatsApp templates: no Meta approval, no template machinery.

## Approaches
- **DB table + Settings tab + composer picker (chosen):** shared across the
  team, follows existing patterns (permissions table, Settings panels, emoji picker).
- Reuse WhatsApp templates: rejected — needs Meta approval, wrong tool for in-window replies.
- Browser-only storage: rejected — can't be shared.

## Design
- **Data:** `SavedReply` { id, shortcut (unique, lowercase, no spaces), title,
  body, createdById, createdAt, updatedAt }. Global, not per WhatsApp number.
- **Permissions** (`config/permissions.js`): `saved_reply:read` → ADMIN,
  SUPERVISOR, AGENT; `saved_reply:write` → ADMIN, SUPERVISOR. MARKETING and
  DIRECTOR get neither.
- **API:** `GET/POST /api/saved-replies`, `PATCH/DELETE /api/saved-replies/:id`.
  Duplicate shortcut → 409 with a readable message. Writes go to the audit log.
- **Settings:** new "Saved replies" tab (list, search, add, edit, delete).
  Supervisors see Settings with only this tab (plus My account).
- **Composer:** `/` as the first character opens a picker above the box,
  filtered by shortcut/title as the agent types; ↑/↓, Enter/Tab inserts
  (replacing the `/query`), Esc closes. A button beside emoji opens the same
  picker. Hidden when the 24h window is closed.
- **Placeholder:** `{name}` → patient's first name; with no name, removed along
  with a dangling space/comma ("Hi {name}," → "Hi,").

## Left to the builder
Exact UI styling (match the emoji picker and Settings panels), list ordering
(alphabetical by shortcut), field length limits (shortcut ≤ 30, title ≤ 80,
body ≤ 4096 — WhatsApp's text limit).
