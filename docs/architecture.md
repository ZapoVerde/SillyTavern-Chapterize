# Chapterize — Architecture

## Folder Structure

```
chapterize/
├── index.js          # Main entry point — all extension logic
├── style.css         # Modal and button styles
├── manifest.json     # ST extension registration
├── README.md
├── LICENSE
└── Architecture.md
```

Single-file JS. No build step. Imports from ST core (`script.js`, `extensions.js`, `slash-commands/`) and the shared ST extension utility (`scripts/extensions/shared.js`) for `ConnectionManagerRequestService`.

---

## Block Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     SILLYTAVERN HOST                        │
│                                                             │
│  ┌─────────────┐     ┌──────────────┐    ┌──────────────┐  │
│  │  ST Context │     │  ST Chat UI  │    │  ST Server   │  │
│  │             │     │              │    │  (Node.js)   │  │
│  │ .chat[]     │     │  Chat bar    │    │              │  │
│  │ .characters │     │  Extensions  │    │  /api/       │  │
│  │ .characterId│     │  panel       │    │  /chats/     │  │
│  │ generateRaw │     │              │    │  /characters/│  │
│  │ ConnMgrSvc  │     │              │    │              │  │
│  └──────┬──────┘     └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │          │
└─────────┼───────────────────┼───────────────────┼──────────┘
          │                   │                   │
          │         ┌─────────▼───────────────────▼──────────┐
          │         │           CHAPTERIZE EXTENSION          │
          │         │                                         │
          │         │  ┌─────────────────────────────────┐   │
          └─────────►  │  index.js + shared.js (ConnMgr) │   │
                    │  │                                  │   │
                    │  │  ┌──────────┐                   │   │
                    │  │  │  init()  │ — runs on load     │   │
                    │  │  │          │ — injects button   │   │
                    │  │  │          │ — loads settings   │   │
                    │  │  └────┬─────┘                   │   │
                    │  │       │ click                    │   │
                    │  │  ┌────▼──────────────────────┐  │   │
                    │  │  │   onChapterizeClick()     │  │   │
                    │  │  │                           │  │   │
                    │  │  │  1. readContext()         │  │   │
                    │  │  │     — detect (ChX) suffix │  │   │
                    │  │  │     — strip situation sep │  │   │
                    │  │  │     — buildTranscript()   │  │   │
                    │  │  │                           │  │   │
                    │  │  │  2. showModal()           │  │   │
                    │  │  │     showStep2()           │  │   │
                    │  │  │                           │  │   │
                    │  │  │  3. callLLM() ×2          │  │   │
                    │  │  │     [parallel, unblocked] │  │   │
                    │  │  │     a) suggestions call   │  │   │
                    │  │  │        → AI Raw tab       │  │   │
                    │  │  │        → Ingester parsed  │  │   │
                    │  │  │     b) situation call     │  │   │
                    │  │  │        → situation text   │  │   │
                    │  │  │                           │  │   │
                    │  │  │  ┌───────────────────┐   │  │   │
                    │  │  │  │  [Update Lorebook] │   │  │   │
                    │  │  │  │  fires 3rd LLM     │   │  │   │
                    │  │  │  │  call; Apply stages │   │  │   │
                    │  │  │  │  into _draftLorebook│   │  │   │
                    │  │  │  │  only (no server    │   │  │   │
                    │  │  │  │  write until        │   │  │   │
                    │  │  │  │  Finalize)          │   │  │   │
                    │  │  │  └───────────────────┘   │  │   │
                    │  │  └────┬──────────────────────┘  │   │
                    │  │       │ Finalize                 │   │
                    │  │  ┌────▼──────────────────────┐  │   │
                    │  │  │     onConfirmClick()       │  │   │
                    │  │  │   (Draft/Commit — 4 steps) │  │   │
                    │  │  │                           │  │   │
                    │  │  │  Step 1: Card Save        │  │   │
                    │  │  │    if _isChapterMode:     │  │   │
                    │  │  │      saveCharacter()      │  │   │
                    │  │  │      deriveChapterName()  │  │   │
                    │  │  │      getCharacters()      │  │   │
                    │  │  │      selectCharacterById()│  │   │
                    │  │  │    else (base char):      │  │   │
                    │  │  │      createCharacterClone │  │   │
                    │  │  │      getCharacters()      │  │   │
                    │  │  │      deriveChapterName()  │  │   │
                    │  │  │    persistChangelog()     │  │   │
                    │  │  │                           │  │   │
                    │  │  │  Step 2: Lorebook Save    │  │   │
                    │  │  │    lbSaveLorebook(        │  │   │
                    │  │  │      _draftLorebook)      │  │   │
                    │  │  │    (skipped if no draft)  │  │   │
                    │  │  │                           │  │   │
                    │  │  │  Step 3: Chat Save        │  │   │
                    │  │  │    saveNewChat()          │  │   │
                    │  │  │                           │  │   │
                    │  │  │  Step 4: Navigate         │  │   │
                    │  │  │    selectCharacterById()  │  │   │
                    │  │  │    openCharacterChat()    │  │   │
                    │  │  │                           │  │   │
                    │  │  │  Commit Receipts panel    │  │   │
                    │  │  │  shows per-step outcome;  │  │   │
                    │  │  │  safe to retry from any   │  │   │
                    │  │  │  failed step              │  │   │
                    │  │  └───────────────────────────┘  │   │
                    │  └─────────────────────────────────┘   │
                    └─────────────────────────────────────────┘
```

---

## Chapter Detection

```
parseChapter(char.name)
  │
  ├── "Vera"          → { isChapter: false, baseName: "Vera",  chNum: 0 }
  ├── "Vera (Ch1)"    → { isChapter: true,  baseName: "Vera",  chNum: 1 }
  └── "Vera (Ch2)"   → { isChapter: true,  baseName: "Vera",  chNum: 2 }

_isChapterMode = parsed.isChapter
_nextChNum     = parsed.chNum + 1
_cloneName     = isChapter ? "Vera (Ch3)" : "Vera (Ch1)"
```

**Base character** → `createCharacterClone()` creates a new card named `(Ch1)`. Original card is untouched.

**Chapter card** → `saveCharacter()` updates the existing card in-place, bumping the display name (e.g. `(Ch2)` → `(Ch3)`). No new card created; all existing chats remain on the same avatar.

---

## Situation Separator

The situation summary is stored at the end of the description field using:

```
\n\n*** Chapterize Divider — Do Not Edit ***\n\n
```

On each invocation the extension splits on this separator:
- `_originalDescription` ← everything before it (what the user edits in Draft Bio)
- `_priorSituation` ← everything after it (fed to the situation prompt as `PRIOR CHAPTER SUMMARY`)

On Finalize:
```
newDescription = cardText + SITUATION_SEP + situationText
```

---

## Draft/Commit Architecture

All user edits and AI-generated content are **staged in memory** until Finalize is clicked. No server write occurs before that point.

```
┌────────────────────────────────────────────────────┐
│  DRAFT PHASE (all in-memory, zero server writes)   │
│                                                    │
│  Character Workshop                                │
│    Draft Bio textarea  ← editable                  │
│    AI Raw tab          ← raw card-audit text       │
│    Ingester tab        ← Apply patches Draft Bio   │
│                           in-place (memory only)   │
│                                                    │
│  Lorebook Workshop                                 │
│    Freeform textarea   ← editable AI output        │
│    Ingester tab        ← Apply Entry/Apply All     │
│                           stages into _draftLorebook│
│                           (memory only)            │
│                                                    │
│  Situation Summary textarea  ← editable            │
└───────────────────────┬────────────────────────────┘
                        │ Finalize click
┌───────────────────────▼────────────────────────────┐
│  COMMIT PHASE (sequential, with receipts)          │
│                                                    │
│  Step 1 — Card Save        _finalizeSteps.cardSaved│
│  Step 2 — Lorebook Save    _finalizeSteps.lorebookSaved│
│  Step 3 — Chat Save        _finalizeSteps.chatSaved│
│  Step 4 — Navigate         (not flagged; retried)  │
│                                                    │
│  Each step is idempotent behind its flag.          │
│  A retry re-enters at the first un-flagged step.   │
│  Cancel before any commit → wipes all state.       │
│  Cancel after partial commit → relabelled "Close"  │
│  and Commit Receipts remain visible.               │
└────────────────────────────────────────────────────┘
```

---

## Character Workshop

The modal's Character Workshop has three tabs sharing a single `_cardSuggestions` array:

```
AI card-audit call
  └── raw text
        ├── AI Raw tab     — displays raw text verbatim (<pre>)
        ├── Ingester tab   — parses via parseCardSuggestions()
        │     └── _cardSuggestions[{ header, content, reason, _applied }]
        │           │
        │           ├── dropdown populated from _cardSuggestions
        │           ├── renderIngesterDetail():
        │           │     parseDescriptionSections(Draft Bio)
        │           │       → match section by header + occurrence index
        │           │       → show Current Draft / AI Suggestion side by side
        │           └── Apply → applyDescriptionSection() patches Draft Bio textarea
        │
        └── Draft Bio tab  — editable textarea, seeded from _originalDescription
              ├── Revert to Original → resets to _originalDescription
              └── Regen Warning banner when draft modified since last regen
```

### Description Section Parsing

`parseDescriptionSections(text)` produces an ordered list of `{ header, index, headerLine, startLine, endLine }` objects. The helpers it relies on:

| Helper | Purpose |
|---|---|
| `isDecoratorLine(line)` | True for lines containing only `-`, `*`, `━`, spaces |
| `stripHeaderDecorators(line)` | Removes leading/trailing `*`, `-`, `#`, `━`, `:` |
| `isHeaderLine(line)` | Non-decorator line whose stripped text is 1–3 words |
| `applyDescriptionSection(text, start, end, newContent)` | Replaces content lines in a description string |

Ingester maps **nth suggestion for a given header** → **nth matching section in the bio**, so duplicate section headers are handled correctly.

---

## Data Flow

```
ST Context
  │
  ├── context.chat[]              — real message objects only (no metadata header)
  │     └── {name, mes, is_user, is_system, ...}
  │
  ├── context.characters[]        — array of character objects
  │     └── {name, description, personality, avatar, chat, ...}
  │
  └── context.characterId         — index into characters[]
        │
        ▼
  parseChapter(char.name)         — detect (ChX) suffix
  stripSituationSep()             — split _originalDescription / _priorSituation
  buildTranscript()               — filter !is_system → "Name: mes\n..."

        │
        │  two parallel LLM calls fire immediately on modal open
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  REVIEW STEP (Character Workshop + Situation)       │
  │                                                     │
  │  generateWithProfile(cardPrompt + description +     │
  │                       transcript)                   │
  │    → AI Raw tab (read-only)                         │
  │    → Ingester tab (section-aware apply)             │
  │    → Draft Bio textarea (user edits directly)       │
  │                                                     │
  │  generateWithProfile(situationPrompt + transcript   │
  │                       + priorSituation)             │
  │    → situation textarea (editable, regenerable)     │
  │                                                     │
  │  turns input (1–10, default 4)                      │
  │                                                     │
  │  [Finalize]  [Update Lorebook]  [Cancel]            │
  └─────────────────────────────────────────────────────┘
        │ Finalize
        ▼
  newDescription = cardText + SITUATION_SEP + situationText

  buildLastN(context.chat, turnsToCarry)
  — strip trailing unmatched user message
  — go back turnsToCarry * 2 messages
  — walk back to first AI reply

  ── Step 1 — Card Save ─────────────────────────────────
  if _isChapterMode:
    saveCharacter(char, newDescription, _cloneName)
      POST /api/characters/edit  (multipart, bumps name)
    _chapterName = deriveChapterName(char.avatar)
    getCharacters() + selectCharacterById()
  else:
    _cloneAvatarUrl = createCharacterClone(char, "(Ch1)", newDescription)
      POST /api/characters/create  (copies avatar blob)
    getCharacters()
    _chapterName = deriveChapterName(_cloneAvatarUrl)
  persistChangelog(_chapterName)

  ── Step 2 — Lorebook Save ─────────────────────────────
  if _draftLorebook && _lorebookName:
    lbSaveLorebook(_lorebookName, _draftLorebook)
      POST /api/worldinfo/edit
      emit WORLDINFO_UPDATED
  else:
    (skipped — no lorebook opened this session)

  ── Step 3 — Chat Save ─────────────────────────────────
  saveNewChat(freshChar, _chapterName, chatMetadata, lastN)
    POST /api/chats/save

  ── Step 4 — Navigate ──────────────────────────────────
  if !_isChapterMode: selectCharacterById(cloneIdx)
  openCharacterChat(_chapterName)

  closeModal()
```

---

## Lorebook Flow

```
[Update Lorebook] click
  │
  ├── lbEnsureLorebook(baseName)
  │     POST /api/worldinfo/list  → check existence
  │     POST /api/worldinfo/edit  → create if missing
  │     POST /api/worldinfo/get   → load into _lorebookData
  │
  ├── deep-clone _lorebookData → _draftLorebook
  │   (skipped on re-open if _draftLorebook already set —
  │    preserves staged changes within the same session)
  │
  ├── showLbModal()
  │
  └── generateWithProfile(lorebookPrompt + entries + transcript)
        → lbchz-freeform textarea

Freeform tab:
  Raw AI output, fully editable.

Ingester tab (parsed on tab switch from lbchz-freeform.val()):
  parseLbSuggestions(freeformText)
    → splits on **UPDATE:** / **NEW:** headers
    → extracts { type, name, keys, content, reason }

  Per-entry:
    [Apply Entry] → lbApplySuggestion()
      UPDATE: mutate _draftLorebook.entries[matched uid]  (memory only)
      NEW / unmatched: insert at nextLorebookUid()         (memory only)
      No server write — bulk commit on Finalize Step 2

  [Apply All] → sequential loop over all suggestions      (memory only)

Finalize Step 2:
  lbSaveLorebook(_lorebookName, _draftLorebook)
    POST /api/worldinfo/edit + emit WORLDINFO_UPDATED
```

---

## Modal Structure

```
chz-overlay
└── chz-modal
    └── chz-step-2  (single review step)
        ├── Character Workshop  [spinner] [↻ regen]
        │     [Dirty-draft warning banner]
        │     Tab bar: [Draft Bio] [AI Raw] [Ingester]
        │
        │     Draft Bio panel
        │       chz-card-text textarea  (editable)
        │       [Revert to Original]
        │
        │     AI Raw panel
        │       chz-suggestions-raw <pre> (read-only)
        │
        │     Ingester panel
        │       Suggestion select dropdown
        │       Current Draft textarea (read-only)
        │       AI Suggestion textarea (editable)
        │       No-match warning banner
        │       [Apply]
        │
        ├── Situation Summary  [spinner] [↻ regen]
        │     chz-situation-text textarea  (editable)
        ├── Turns input  (1–10)
        ├── Error banner
        ├── [Finalize]  [Update Lorebook]  [Cancel / Close]
        └── Commit Receipts panel (hidden until first Finalize attempt)
              card row / lorebook row / chat row — each ✓ or ✗

lbchz-overlay
└── lbchz-modal
    ├── Title + [spinner] [↻ regen]
    ├── Tab bar: [Freeform] [Ingester]
    ├── Freeform panel
    │     lbchz-freeform textarea
    ├── Ingester panel
    │     Suggestion select dropdown
    │     Current entry content (UPDATE only, read-only)
    │     Keys input
    │     Suggested content textarea
    │     Error banner
    │     [Apply Entry]  [Apply All]
    ├── Error banner (modal-level)
    └── [Close]
```

---

## Session State

Cleared at the start of each `onChapterizeClick()` invocation (and on `closeModal()`).  
`_draftLorebook` is cleared on `closeModal()` but **not** between lorebook modal open/close within the same session, so staged lorebook changes survive re-opening the lorebook modal.

| Variable | Purpose |
|---|---|
| `_transcript` | Filtered chat text fed to all LLM prompts |
| `_originalDescription` | Description prose (situation block stripped) |
| `_priorSituation` | Situation text from previous chapter |
| `_suggestionsLoading` | Guards Finalize button and spinner |
| `_situationLoading` | Guards Finalize button and spinner |
| `_isChapterMode` | true if active char already has `(ChX)` suffix |
| `_nextChNum` | Chapter number to assign on next chapterize |
| `_cloneName` | Display name for the chapter card |
| `_suggestionsGenId` | Incremented each suggestions call; drops stale callbacks |
| `_situationGenId` | Incremented each situation call; drops stale callbacks |
| `_lorebookGenId` | Incremented each lorebook call; drops stale callbacks |
| `_cardSuggestions` | Parsed suggestion objects from last card AI call |
| `_draftModifiedSinceRegen` | True if Draft Bio edited since last regen |
| `_chapterName` | Derived chat file name (e.g. `ch2`); set during Step 1 |
| `_cloneAvatarUrl` | Clone path only — avatar URL of the created clone |
| `_finalizeSteps` | `{ cardSaved, lorebookSaved, chatSaved }` — step completion flags; reset only on fresh session, not between retry attempts |
| `_lorebookName` | Base character name used as lorebook filename |
| `_lorebookData` | `{entries:{}}` server copy loaded on first lorebook open |
| `_draftLorebook` | Working copy — deep clone of `_lorebookData`; Apply mutations staged here only |
| `_lorebookLoading` | Guards lorebook spinner and regen button |

All three `*GenId` values are incremented on `closeModal()`. Every `.then()` callback guards with `if (_xxxGenId !== localId) return` before touching the DOM.

---

## ST APIs Used

| What | How | Notes |
|---|---|---|
| Read chat | `SillyTavern.getContext().chat` | Real message objects only — no metadata header |
| Read character | `SillyTavern.getContext().characters[characterId]` | Full object |
| Generate text | `await generateWithProfile(prompt)` | Routes to `ConnectionManagerRequestService.sendRequest()` when a profile is configured (returns `result.content`); falls back to `generateRaw({ prompt, trimNames: false })` otherwise |
| Connection profiles | `ConnectionManagerRequestService` from `scripts/extensions/shared.js` | Used to send requests against a specific profile without mutating global API state; only Chat Completion and Text Completion profiles are supported |
| Create character | `POST /api/characters/create` multipart | Returns plain-text avatar filename |
| Save character | `POST /api/characters/edit` multipart | Fully destructive — must round-trip all fields via `buildCharacterFormData()` |
| Refresh char list | `await getCharacters()` | Required after create/edit before `selectCharacterById` |
| Select character | `await selectCharacterById(idx)` | idx is position in `context.characters[]` |
| List chats | `POST /api/chats/search { avatar_url }` | Returns array; filter `file_name` for `ch\d+` |
| Save new chat | `POST /api/chats/save` JSON | `force: true` skips integrity check |
| Open chat | `await openCharacterChat(fileName)` | Must run after character save + select |
| Lorebook list | `POST /api/worldinfo/list {}` | Returns `[{name, ...}]` |
| Lorebook get | `POST /api/worldinfo/get { name }` | Returns `{entries:{}}` |
| Lorebook save | `POST /api/worldinfo/edit { name, data }` | + emit `WORLDINFO_UPDATED` event |
| Persist settings | `extension_settings['chapterize']` + `saveSettingsDebounced()` | Standard ST pattern |
| Request headers | `getRequestHeaders()` | Required on all fetch calls — adds CSRF token; delete Content-Type on FormData |

### Chat save body shape
```javascript
{
    ch_name:    char.name,
    avatar_url: char.avatar,
    file_name:  chapterName,   // no .jsonl suffix
    chat:       [header, ...lastN],
    force:      true,
}
```

### Chat metadata header
```javascript
// context.chatMetadata is exposed by SillyTavern.getContext()
const header = {
    chat_metadata:  structuredClone(context.chatMetadata ?? {}),
    user_name:      'unused',
    character_name: 'unused',
};
header.chat_metadata.lastInContextMessageId = 0;
header.chat_metadata.integrity = crypto.randomUUID();
header.chat_metadata.tainted   = false;
```

---

## LLM Routing

All three LLM calls (`runSuggestionsCall`, `runSituationCall`, `runLorebookCall`) go through the central `generateWithProfile(prompt)` helper:

```
generateWithProfile(prompt)
  │
  ├── settings.profileId set?
  │     YES → ConnectionManagerRequestService.sendRequest(profileId, prompt, null)
  │               returns ExtractedData { content, reasoning }
  │               → return result.content
  │
  └── NO  → generateRaw({ prompt, trimNames: false })
                uses globally active connection (pre-existing behaviour)
```

The profile dropdown in Settings lists only `openai` (Chat Completion) and `textgenerationwebui` (Text Completion) profile types — the set supported by `ConnectionManagerRequestService`. Profiles using other API backends remain usable via the global connection fallback.

---

## Sequencing Constraints

**First chapterize (clone path):**
```
createCharacterClone()
        │
        ▼
getCharacters()  ──►  findByAvatar(_cloneAvatarUrl)
        │
        ▼
deriveChapterName(_cloneAvatarUrl)
        │
        ▼
saveNewChat()
        │
        ▼
selectCharacterById(cloneIdx)
        │
        ▼
openCharacterChat()
```

**Subsequent chapterizes (in-place update path):**
```
saveCharacter()   (rename + description update)
        │
        ▼
deriveChapterName(char.avatar)
        │
        ▼
getCharacters()  ──►  findByAvatar(char.avatar)  ──►  selectCharacterById()
        │
        ▼
saveNewChat()
        │
        ▼
openCharacterChat()
```

`openCharacterChat()` calls `createOrEditCharacter()` internally. Character save + select **must** complete before it is called or the card will be overwritten with stale state.

**Retry safety:** each `_finalizeSteps` flag is only set after its server call succeeds. A retry re-enters `onConfirmClick()` and skips already-completed steps, so a network failure mid-sequence can be resolved by clicking Finalize again without duplicating work.