# Chapterize — Extension Spec

## Overview

A SillyTavern extension that compresses a long roleplay chat into a fresh chapter. It updates the character card with an AI-generated evolution summary and situation brief, then creates a new chat seeded with only the last N turns for tone continuity. The original chat and character card are never modified.

---

## Extension Structure

```
chapterize/
├── index.js          # Main entry point — all extension logic
├── style.css         # Modal and button styles
├── manifest.json     # ST extension registration
├── ST_API_MAP.md     # ST source reference map
├── README.md
├── LICENSE
├── SPEC.md           # This file
└── NEXT_STEPS.md     # Future features
```

Single-file JS for v1. No build step, no modules, no dependencies beyond what ST provides.

---

## UI

### Button
Add a single button labelled **"Chapterize"** to `#extensionsMenu` — the wand/sparkle (✨) button at the bottom left of the chat window. Active only when a non-group character chat is open.

### Review Modal — Two Steps

**Step 1: Change List Review**

Fires immediately on button click. Contains:
- Label: `"Review narrative changes"`
- Editable `<textarea>` pre-filled with LLM change list output
- `[Next →]` — triggers Step 2 LLM calls using current textarea content
- `[Cancel]` — closes modal, no changes made

**Step 2: Card and Situation Review**

Fires after Next is clicked in Step 1. Contains:
- **Character Card Prose**
  - Label: `"Updated Character Description"`
  - Editable `<textarea>` pre-filled with LLM output
  - `⚠ AI flagged possible issues` warning if selfcheck failed (advisory only)
- **Situation Summary**
  - Label: `"Situation Summary"`
  - Editable `<textarea>` pre-filled with LLM output
  - `⚠ AI flagged possible issues` warning if selfcheck failed (advisory only)
- **Turns to carry over**
  - Numeric input, default `4`, min `1`, max `10`
  - Label: `"Turns to carry into new chapter"`
- `[← Back]` — returns to Step 1, change list textarea content preserved, no re-generation
- `[Regenerate]` — re-runs card and situation calls using current Step 1 content
- `[Confirm]` — executes the chapterize action
- `[Cancel]` — closes modal, no changes made

---

## Generation — Three LLM Calls

Use ST's built-in `generateRaw()` for all calls. Uses the currently selected API/model.

### Transcript preparation

Before any LLM call, the extension builds a plain-text transcript:

```
[Character Name]: [mes content]
[User Name]: [mes content]
...
```

- Use only `name` and `mes` fields from `context.chat`
- Filter: `context.chat.filter(m => !m.is_system)`
- `context.chat` in memory contains only real messages — there is no metadata header at index 0. The header only appears as `chat[0]` in the on-disk JSONL format; in memory it is stored separately as `chat_metadata`.

---

### Call 1 — Change List (fires on button click)

Prompt template (user-editable in settings):

```
You are analysing a collaborative fiction roleplay transcript.
Below is a character description as it stood at the start of this chapter,
followed by the full transcript of what happened.

List the narratively significant changes to this character.
Consider: emotional shifts, relationship developments, secrets revealed,
knowledge gained, goals changed, trust earned or lost, physical changes if any.

Write as a simple bullet list. Be specific — reference actual events.
Do not write prose. Do not add preamble or explanation.
Output only the bullet list.

ORIGINAL DESCRIPTION:
{{original_description}}

TRANSCRIPT:
{{transcript}}
```

---

### Call 2 — Character Card Prose (fires on Next click)

Uses the **edited change list** from Step 1, not the full transcript.
This keeps the second call cheap and focused.

Prompt template (user-editable in settings):

```
You are updating a character description for a collaborative fiction character.
Below is the original character description and a list of changes that occurred
during the most recent chapter.

Write an updated character description that reflects who this character is RIGHT NOW.
Write in the same style and format as the original description.
Do not summarise events. Write the character, not the story.
Do not add preamble or explanation. Output only the updated description text.

ORIGINAL DESCRIPTION:
{{original_description}}

CHANGES THIS CHAPTER:
{{edited_change_list}}
```

---

### Call 3 — Situation Summary (fires on Next click, parallel with Call 2)

Uses the full transcript.

Prompt template (user-editable in settings):

```
You are writing a scene-setting summary for the opening of a new chapter
in a collaborative fiction story.
Below is a transcript of the chapter so far.

Write a concise situation summary: where we are, what has just happened,
what is unresolved or hanging in the air.
Tone should match the story. This will be read by the AI at the start of
the next session as grounding context, not as narrative prose for the player.
Write in present tense. Be specific. Aim for 150-250 words.
Do not add preamble or explanation. Output only the summary text.

TRANSCRIPT:
{{transcript}}
```

Calls 2 and 3 can run in parallel — neither depends on the other.

---

### Self-check (optional, default ON, applies to Calls 2 and 3 only)

After each call, send a short verification prompt:

```
Review the following output for a collaborative fiction character/situation description.
Flag any hallucinations, contradictions with the source material, or missing critical information.
If the output is acceptable, reply only with: OK
If not, reply with a brief note of what needs fixing.

OUTPUT:
{{generated_text}}

SOURCE:
{{transcript_or_change_list}}
```

If the checker returns anything other than `OK`, show `⚠ AI flagged possible issues` on the relevant textarea. Advisory only — user can still proceed.

---

## On Confirm

### Sequencing

```
persistChangelog()
        │
        ▼
saveCharacter()  ─────┐
                       ├── Promise.all() ──► saveNewChat() ──► openCharacterChat()
deriveChapterName() ───┘
```

**Critical:** `openCharacterChat()` calls `createOrEditCharacter()` internally. Character save must complete first or the updated description will be silently overwritten.

### 1. Persist the changelog entry

Before any writes:

```javascript
const entry = {
    date: new Date().toISOString(),
    chapterName,        // derived in next step — can be done after
    changeList: changeListTextareaContent,
};
extension_settings['chapterize'].changelog.push(entry);
saveSettingsDebounced();
```

### 2. Save the updated character card

```javascript
const char = structuredClone(context.characters[this_chid]);
char.description = cardText + '\n\n---\n\n' + situationText;

const formData = new FormData();
formData.append('json_data', JSON.stringify(char));
formData.append('avatar_url', char.avatar);
formData.append('ch_name', char.name);

await fetch('/api/characters/edit', {
    method: 'POST',
    headers: getRequestHeaders(),  // DO NOT set Content-Type manually on FormData
    body: formData,
});
```

**Critical:** `/api/characters/edit` is fully destructive. Always use the `json_data` approach to round-trip the full character object. Never enumerate fields manually.

### 3. Derive chapter name (parallel with step 2)

```javascript
const res = await fetch('/api/chats/search', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ avatar_url: characters[this_chid].avatar }),
});
const chats = await res.json();
const nums = chats
    .map(c => c.file_name?.match(/^ch(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
const nextN = nums.length ? Math.max(...nums) + 1 : 1;
const chapterName = `ch${nextN}`;
```

### 4. Build and save the new chat

```javascript
// chat_metadata is a module-level ST variable — NOT context.chat[0].
// Confirm whether SillyTavern.getContext() exposes chat_metadata before coding.
// If not exposed, fall back to a fresh object (see ST_API_MAP.md §7 for fallback).
const header = {
    chat_metadata: structuredClone(chat_metadata),
    user_name: 'unused',
    character_name: 'unused',
};
header.chat_metadata.lastInContextMessageId = 0;
header.chat_metadata.integrity = crypto.randomUUID();
header.chat_metadata.tainted = false;

// 1 turn = 1 user message + 1 AI response = 2 array elements.
// If the chat ends on an unanswered user message, the slice naturally includes
// it as a trailing odd element — strip it before slicing so only complete
// turn pairs are carried. See ST_API_MAP.md §7 for the correct pattern.
const lastN = context.chat.slice(-(turnsToCarry * 2));

await fetch('/api/chats/save', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
        ch_name: char.name,
        file_name: chapterName,   // no .jsonl suffix
        avatar_url: char.avatar,
        chat: [header, ...lastN],
        force: true,
    }),
});
```

### 5. Open the new chat

```javascript
await openCharacterChat(chapterName);
```

Defined at `script.js:7522`. Must run after both steps 2 and 4 complete.

### 6. Close modal

---

## Settings Panel

Accessible via the ST Extensions panel. All settings persisted via `extension_settings['chapterize']`.

| Setting | Type | Default |
|---|---|---|
| Turns to carry over | Number | 4 |
| Self-check enabled | Toggle | On |
| Store changelog | Toggle | On |
| Change List prompt | Textarea | (template above) |
| Character Card prompt | Textarea | (template above) |
| Situation Summary prompt | Textarea | (template above) |

---

## Error Handling

- If any LLM call fails or returns empty: show error in modal, offer Retry. Do not proceed.
- If `/api/characters/edit` fails: alert user, abort. Do not proceed to chat save.
- If `/api/chats/save` fails: alert user, abort. Inform user that character card was already saved.
- Modal stays open on any error — user does not lose edited textarea content.

---

## Explicit Non-Goals (v1)

- No support for group chats
- No automatic triggering — always manual
- No modification of lorebooks, author's notes, or any field other than `description`
- No forking or branching of the original chat file
- No UI for reviewing the carried-over turns before confirm
- No per-character settings profiles
- No lorebook population (see NEXT_STEPS.md)

---

## Reference

- Full ST API details and sequencing: `ARCHITECTURE.md`
- ST source reference map: `ST_API_MAP.md`
- Future features: `NEXT_STEPS.md`
- ST extension docs: https://docs.sillytavern.app/for-contributors/writing-extensions/