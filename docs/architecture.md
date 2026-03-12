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

Single-file JS. No build step, no modules, no dependencies beyond what ST provides.

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
│  └──────┬──────┘     └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │          │
└─────────┼───────────────────┼───────────────────┼──────────┘
          │                   │                   │
          │         ┌─────────▼───────────────────▼──────────┐
          │         │           CHAPTERIZE EXTENSION          │
          │         │                                         │
          │         │  ┌─────────────────────────────────┐   │
          └─────────►  │         index.js                │   │
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
                    │  │  │     showStep2() (single   │  │   │
                    │  │  │     step — no Step 1)     │  │   │
                    │  │  │                           │  │   │
                    │  │  │  3. callLLM() ×2          │  │   │
                    │  │  │     [parallel, unblocked] │  │   │
                    │  │  │     a) suggestions call   │  │   │
                    │  │  │        → suggestions box  │  │   │
                    │  │  │     b) situation call     │  │   │
                    │  │  │        → situation text   │  │   │
                    │  │  │                           │  │   │
                    │  │  │  ┌───────────────────┐   │  │   │
                    │  │  │  │  [Update Lorebook] │   │  │   │
                    │  │  │  │  fires 3rd LLM     │   │  │   │
                    │  │  │  │  call; writes are  │   │  │   │
                    │  │  │  │  per-entry/        │   │  │   │
                    │  │  │  │  immediate;        │   │  │   │
                    │  │  │  │  does not gate     │   │  │   │
                    │  │  │  │  Confirm           │   │  │   │
                    │  │  │  └───────────────────┘   │  │   │
                    │  │  └────┬──────────────────────┘  │   │
                    │  │       │ confirm                  │   │
                    │  │  ┌────▼──────────────────────┐  │   │
                    │  │  │     onConfirmClick()       │  │   │
                    │  │  │                           │  │   │
                    │  │  │  persistChangelog()       │  │   │
                    │  │  │                           │  │   │
                    │  │  │  if _isChapterMode:       │  │   │
                    │  │  │    saveCharacter()        │  │   │
                    │  │  │    (bumps name ChX→X+1)   │  │   │
                    │  │  │    getCharacters()        │  │   │
                    │  │  │    selectCharacterById()  │  │   │
                    │  │  │    deriveChapterName()    │  │   │
                    │  │  │    saveNewChat()          │  │   │
                    │  │  │    openCharacterChat()    │  │   │
                    │  │  │                           │  │   │
                    │  │  │  else (base character):   │  │   │
                    │  │  │    createCharacterClone() │  │   │
                    │  │  │    getCharacters()        │  │   │
                    │  │  │    deriveChapterName()    │  │   │
                    │  │  │    saveNewChat()          │  │   │
                    │  │  │    selectCharacterById()  │  │   │
                    │  │  │    openCharacterChat()    │  │   │
                    │  │  │                           │  │   │
                    │  │  │  closeModal()             │  │   │
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
- `_originalDescription` ← everything before it (what the user edits)
- `_priorSituation` ← everything after it (fed to the situation prompt as `PRIOR CHAPTER SUMMARY`)

On Confirm:
```
newDescription = cardText + SITUATION_SEP + situationText
```

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
  │  REVIEW STEP (single step)                          │
  │                                                     │
  │  generateRaw(cardPrompt + description + transcript) │
  │    → suggestions box (read-only, regenerable)       │
  │                                                     │
  │  generateRaw(situationPrompt + transcript           │
  │              + priorSituation)                      │
  │    → situation textarea (editable, regenerable)     │
  │                                                     │
  │  description textarea (editable)                    │
  │  turns input (1–10, default 4)                      │
  │                                                     │
  │  [Confirm]  [Update Lorebook]  [Cancel]             │
  └─────────────────────────────────────────────────────┘
        │ confirm
        ▼
  newDescription = cardText + SITUATION_SEP + situationText

  buildLastN(context.chat, turnsToCarry)
  — strip trailing unmatched user message
  — go back turnsToCarry * 2 messages
  — walk back to first AI reply

  ── if _isChapterMode ──────────────────────────────────
  saveCharacter(char, newDescription, _cloneName)
    POST /api/characters/edit  (multipart, bumps name)
  getCharacters() + selectCharacterById()
  deriveChapterName(char.avatar)
    POST /api/chats/search → max ch\d+ + 1
  saveNewChat(freshChar, chapterName, chatMetadata, lastN)
    POST /api/chats/save
  openCharacterChat(chapterName)

  ── else (base character) ───────────────────────────────
  createCharacterClone(char, "(Ch1)", newDescription)
    POST /api/characters/create  (copies avatar blob)
    → returns new avatar filename
  getCharacters()
  deriveChapterName(newAvatarUrl)
  saveNewChat(cloneChar, chapterName, chatMetadata, lastN)
    POST /api/chats/save
  selectCharacterById(newCharIdx)
  openCharacterChat(chapterName)

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
  │     POST /api/worldinfo/get   → load data into _lorebookData
  │
  ├── showLbModal()
  │
  └── generateRaw(lorebookPrompt + entries + transcript)
        → lbchz-freeform textarea

Freeform tab:
  Raw AI output, fully editable.

Ingester tab (parsed on tab switch):
  parseLbSuggestions(freeformText)
    → splits on **UPDATE:** / **NEW:** headers
    → extracts { type, name, keys, content, reason }

  Per-entry:
    [Apply Entry] → lbApplySuggestion()
      UPDATE: mutate _lorebookData.entries[matched uid]
      NEW / unmatched: insert at nextLorebookUid()
      POST /api/worldinfo/edit + emit WORLDINFO_UPDATED

  [Apply All] → sequential loop over all suggestions
```

---

## Modal Structure

```
chz-overlay
└── chz-modal
    └── chz-step-2  (single review step — no step-1 in DOM)
        ├── AI Suggested Tweaks  [spinner] [↻ regen]
        │     chz-suggestions (read-only box, <pre> content)
        ├── Character Description textarea  (editable)
        ├── Situation Summary  [spinner] [↻ regen]
        │     chz-situation-text textarea  (editable)
        ├── Turns input  (1–10)
        ├── Error banner
        └── [Confirm]  [Update Lorebook]  [Cancel]

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

Cleared at the start of each `onChapterizeClick()` invocation (and on `closeModal()`):

| Variable | Purpose |
|---|---|
| `_transcript` | Filtered chat text fed to all LLM prompts |
| `_originalDescription` | Description prose (situation block stripped) |
| `_priorSituation` | Situation text from previous chapter |
| `_suggestionsLoading` | Guards confirm button and spinner |
| `_situationLoading` | Guards confirm button and spinner |
| `_isChapterMode` | true if active char already has `(ChX)` suffix |
| `_nextChNum` | Chapter number to assign on confirm |
| `_cloneName` | Display name for the chapter card |
| `_generationId` | Incremented each invocation; drops stale callbacks |
| `_lorebookName` | Base character name used as lorebook filename |
| `_lorebookData` | `{entries:{}}` loaded from server; mutated on Apply |
| `_lorebookLoading` | Guards lorebook spinner and regen button |

`_generationId` is incremented on both `closeModal()` and each new invocation. All `.then()` callbacks guard with `if (_generationId !== genId) return` before touching the DOM.

---

## ST APIs Used

| What | How | Notes |
|---|---|---|
| Read chat | `SillyTavern.getContext().chat` | Real message objects only — no metadata header |
| Read character | `SillyTavern.getContext().characters[characterId]` | Full object |
| Generate text | `await generateRaw({ prompt, trimNames: false })` | Uses current API/model |
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

## Sequencing Constraints

**First chapterize (clone path):**
```
createCharacterClone()
        │
        ▼
getCharacters()  ──►  findByAvatar  ──►  selectCharacterById()
        │
        ▼
deriveChapterName()
        │
        ▼
saveNewChat()
        │
        ▼
openCharacterChat()
```

**Subsequent chapterizes (in-place update path):**
```
saveCharacter()   (rename + description update)
        │
        ▼
getCharacters()  ──►  findByAvatar  ──►  selectCharacterById()
        │                                        │
        │                   deriveChapterName() ─┘  (parallel, started early)
        │
        ▼
saveNewChat()
        │
        ▼
openCharacterChat()
```

`openCharacterChat()` calls `createOrEditCharacter()` internally. Character save + select **must** complete before it is called or the card will be overwritten with stale state.