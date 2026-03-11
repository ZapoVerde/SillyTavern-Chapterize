# Chapterize — SillyTavern Extension Spec

## Overview

A SillyTavern extension that compresses a long roleplay chat into a fresh chapter. It updates the character card with an AI-generated evolution summary and situation brief, then creates a new chat file seeded with only the last N turns for tone continuity. The original chat and character card are never modified.

---

## Extension Structure

Standard ST third-party extension layout:

```
SillyTavern/data/<user>/extensions/third-party/chapterize/
  index.js
  manifest.json
  style.css
```

`manifest.json` should declare the extension name as `"Chapterize"` and entry point as `index.js`.

---

## UI

### Button
Add a single button labelled **"Chapterize"** to the chat action bar (the row of icons below the chat window). It should only be active when a non-group character chat is open.

### Review Modal
A modal overlay triggered by the button. Contains:

- **Section 1: Character Evolution**
  - Label: `"Character Evolution"`
  - Editable `<textarea>` pre-filled with LLM output (see Generation below)
  - Token count display (live update as user edits)

- **Section 2: Situation Summary**
  - Label: `"Situation Summary"`
  - Editable `<textarea>` pre-filled with LLM output
  - Token count display

- **Turns to carry over**
  - Small numeric input, default `4`, min `1`, max `10`
  - Label: `"Turns to carry into new chapter"`

- **Buttons**
  - `Confirm` — executes the chapterize action
  - `Regenerate` — re-runs both LLM calls and replaces textarea content
  - `Cancel` — closes modal, no changes made

---

## Generation — Two LLM Calls

Use ST's built-in `generateRaw()` function for both calls. Use the currently selected API/model — no separate connection profile needed for v1.

### Input prepared by the extension (not the LLM)

Before calling the LLM, the extension assembles the chat into a clean plain-text transcript:

```
[Character Name]: [mes content]
[User Name]: [mes content]
...
```

Strip all JSONL metadata. Use only the `name` and `mes` fields. Skip the metadata header line (line 1). Skip any `is_system` messages.

### Call 1 — Character Evolution

Prompt template (user-editable in extension settings):

```
You are updating a character description for a collaborative fiction character.
Below is the original character description, followed by a transcript of recent events.

Analyse how the character has changed — emotionally, relationally, physically if relevant, 
in terms of knowledge or secrets revealed, goals shifted, trust earned or lost.

Write an updated character description that reflects who this character is RIGHT NOW.
Write in the same style and format as the original description.
Do not summarise events. Write the character, not the story.
Do not add preamble or explanation. Output only the updated description text.

ORIGINAL DESCRIPTION:
{{original_description}}

TRANSCRIPT:
{{transcript}}
```

### Call 2 — Situation Summary

Prompt template (user-editable in extension settings):

```
You are writing a scene-setting summary for the opening of a new chapter in a collaborative fiction story.
Below is a transcript of the chapter so far.

Write a concise situation summary: where we are, what has just happened, 
what is unresolved or hanging in the air. 
Tone should match the story. This will be read by the AI at the start of the next session
as grounding context, not as narrative prose for the player.
Write in present tense. Be specific. Aim for 150-250 words.
Do not add preamble or explanation. Output only the summary text.

TRANSCRIPT:
{{transcript}}
```

### Self-check (optional, default ON, toggle in settings)

After each call, send a second short prompt:

```
Review the following output for a collaborative fiction character/situation description.
Flag any hallucinations, contradictions with the source transcript, or missing critical information.
If the output is acceptable, reply only with: OK
If not, reply with a brief note of what needs fixing.

OUTPUT:
{{generated_text}}

SOURCE TRANSCRIPT:
{{transcript}}
```

If the checker returns anything other than `OK`, append a small warning indicator to the relevant textarea in the review modal (e.g. a yellow `⚠ AI flagged possible issues` note). The user can still proceed — it is advisory only.

---

## On Confirm

### 1. Update the character card

Read the current character object via `SillyTavern.getContext()`.

Construct the new description by concatenating:

```
[Character Evolution textarea content]

---

[Situation Summary textarea content]
```

Write this to the character's `description` field using the ST API. Save the character.

The original character card's other fields (personality, scenario, example dialogue, etc.) are left untouched.

### 2. Build the new chat file

Read the current chat JSONL file. Structure:
- Line 1: metadata header object
- Lines 2–N: message objects

Steps:
1. Parse all lines
2. Keep line 1 (metadata header) — reset `lastInContextMessageId` to `0`
3. From the message lines, take only the last **N** (where N = the turns input value)
4. "Turns" = one user message + one character response = 2 lines. So last N turns = last N×2 message lines. Round down if the chat ends on a user message.
5. Write the new file as valid JSONL (one JSON object per line)

### 3. Name and save the new file

Detect the current chapter number from the existing filename if present, otherwise start at 2.

Naming convention:
```
[CharacterName]_ch[N]_[timestamp].jsonl
```

Example: `Vera_ch2_2026-03-11.jsonl`

Save to the same directory as ST chat files for this character.

### 4. Open the new chat

Use ST's internal API to open the newly created chat file with the current character. The modal closes. The user lands in the new chat ready to continue.

---

## Settings Panel

Accessible via the ST Extensions panel. Settings:

| Setting | Type | Default |
|---|---|---|
| Turns to carry over | Number | 4 |
| Self-check enabled | Toggle | On |
| Character Evolution prompt | Textarea | (template above) |
| Situation Summary prompt | Textarea | (template above) |
| Chapter filename prefix | Text | (character name, auto) |

Settings persisted via ST's extension settings API (`extension_settings`).

---

## Error Handling

- If either LLM call fails or returns empty, show an error message in the modal and do not proceed. Offer a Retry button.
- If the chat file cannot be written, alert the user and abort. Do not modify the character card.
- Character card is written **after** the new chat file is confirmed saved — so if file writing fails, the card is never touched.

---

## Explicit Non-Goals (v1)

- No support for group chats
- No automatic triggering — always manual
- No modification of lorebooks, author's notes, or any field other than `description`
- No forking or branching of the original chat file
- No UI for reviewing the carried-over turns before confirm

---

## Reference Material for the Coder

- ST extension API docs: https://docs.sillytavern.app/for-contributors/writing-extensions/
- `SillyTavern.getContext()` exposes: `chat`, `characters`, `characterId`, `name1`, `name2`
- `generateRaw(prompt, api, instructOverride, systemPrompt)` for LLM calls
- `writeExtensionField(characterId, key, value)` for character card writes
- Look at the built-in Summarize extension source as a reference for `generateRaw` usage
- Chat JSONL location: `SillyTavern/data/<user>/chats/<charactername>/`
- The metadata header (line 1) contains `chat_metadata` — preserve it, just reset `lastInContextMessageId`