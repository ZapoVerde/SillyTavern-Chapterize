# Chapterize — Next Steps

## Lorebook Integration (v2 candidate)

### Concept

The change list generated during chapterization is pre-processed lorebook material. Each bullet point is a discrete, significant narrative fact about a character, relationship, or event. With one additional LLM call and a write to ST's lorebook API, these facts can be automatically persisted as lorebook entries — becoming permanently retrievable context that gets injected into future sessions when relevant.

### Why this is valuable

ST's lorebook is keyword-triggered. When a keyword appears in the conversation, the associated entry is injected into the prompt. This means:

- Facts from Chapter 1 remain accessible in Chapter 10 without bloating the character card
- The lorebook becomes a living story record, not a manually maintained document
- Budget API users benefit most — expensive context is replaced by cheap, targeted injection

### Proposed flow

After the standard chapterize confirm, an optional additional step:

```
editedChangeList
      │
      ▼
Call 4 — Keyword Generation
  For each bullet point in the change list, suggest 2-3 trigger keywords.
  Output as structured list: one entry per line, format:
  [keywords]: [fact]

  Example:
  dispatch, orders, Vera: Vera has read the dispatch and knows the regiment
                         is being reassigned east within the week
      │
      ▼
Lorebook Review Panel
  — list of proposed entries with editable keywords and fact text
  — checkboxes to include/exclude individual entries
  — select target lorebook (dropdown of existing lorebooks)
  — [Add to Lorebook] button
      │
      ▼
POST to ST lorebook API
  — one entry per checked item
  — keywords as trigger array
  — fact as lorebook entry content
```

### What needs research before implementing

- ST lorebook API — how to read existing lorebooks, how to add entries programmatically
- Whether lorebook entries can be written via a fetch to the ST server or require a different approach
- The lorebook entry data shape — fields, required vs optional
- How to present the lorebook selector in the UI (list of existing lorebooks for the character)

### Changelog as seed data

The changelog already stored in `extension_settings['chapterize'].changelog` is the raw material for this feature. Each stored change list entry could be retroactively processed for lorebook population — not just the current chapter. This means a future "Populate Lorebook from History" button is also possible.

### Separation of concerns

Lorebook population should remain opt-in and separate from the core chapterize flow. A user who only wants the character card update and chapter reset should not be forced through a lorebook step. Implementation options:

1. An additional optional step at the end of the existing modal
2. A separate "Lore" button that processes the stored changelog on demand
3. A separate extension (`Chapterize-Lore`) that reads the changelog written by Chapterize

Option 2 or 3 is preferred for v1 clarity.

---

## Other Possible Future Features

- **Per-character prompt profiles** — different evolution/situation prompts for different character types
- **Chapter naming customisation** — user-defined naming scheme beyond `ch[N]`
- **Carry-over turn preview** — show the user which turns will be kept before confirming
- **Group chat support** — currently excluded; would require rethinking the transcript and card update logic
- **Changelog viewer** — a panel in the extension settings that shows the full history of change lists across all chapters