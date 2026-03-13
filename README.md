# Chapterize for SillyTavern

**Chapterize** is a narrative management tool for SillyTavern designed to solve "context bloat" in long-running roleplays. It closes a chapter by evolving your character card with the events of the current chat and transitioning into a fresh chat file with a concise situational summary — all through a staged draft workflow that commits nothing until you hit Finalize.

## How it Works

When you trigger Chapterize the extension determines whether the active character is a **base character** (first chapterize) or an **existing chapter card** already carrying a `(ChX)` suffix (subsequent chapterizes), then opens the Chapterize Workshop:

### 1. Parallel AI Analysis

Two LLM calls fire simultaneously as soon as the modal opens:

- **Card Audit:** Analyses the character description against the session transcript and generates prose snippets — drop-in replacements for sections whose facts have changed.
- **Situation Summary:** Creates a present-tense narrative brief (200–500 words) covering where the story stands, including unresolved threads and character realizations.

### 2. Character Workshop

A three-tab editor lets you stage changes to the character description before anything is saved:

- **Draft Bio** — the full description in an editable textarea. Edit directly, or use the Ingester to apply AI suggestions section by section. A "Revert to Original" button resets it to the unmodified card text.
- **AI Raw** — the unprocessed card-audit output for reference. A regenerate button re-runs the call against the current Draft Bio, and a warning banner appears if the draft has been manually edited since the last generation.
- **Ingester** — a side-by-side panel that parses the AI output into individual section suggestions. Each suggestion shows the matching current draft text alongside the AI's proposed replacement. Click **Apply** to patch the Draft Bio in-place.

### 3. Situation Summary

A separate editable textarea for the situation output, with its own regenerate button. This text is appended to the character description behind a fixed separator so it feeds future sessions as `PRIOR CHAPTER SUMMARY` without cluttering the prose you edit.

### 4. Lorebook Integration

The **Update Lorebook** button opens a separate modal at any time without blocking the main flow. It fires a third LLM call, then lets you stage entry updates using the same Freeform / Ingester tab pattern. **All lorebook changes are staged in memory until Finalize** — Apply Entry and Apply All do not write to the server.

### 5. Finalize & Commit

Clicking **Finalize** runs four steps in sequence, each tracked in a Commit Receipts panel:

1. **Card Save** — creates a clone card (`CharName (Ch1)`) on the first chapterize, or edits the existing chapter card in-place and bumps its name (`(ChX)` → `(ChX+1)`) on subsequent ones.
2. **Lorebook Save** — bulk-writes any staged lorebook changes to the server (skipped if the lorebook modal was never opened this session).
3. **Chat Save** — creates a new chat file (`ch1`, `ch2`, …) seeded with the last N turns for tone continuity.
4. **Navigate** — switches you to the new chat automatically.

If any step fails, the receipts panel shows which step errored. Steps that already succeeded are not re-run on retry — clicking Finalize again resumes from the first incomplete step.

**Cancel before any commit** wipes all staged state. **Cancel after a partial commit** relabels to "Close" and keeps the receipts visible so you can see what was saved and retry if needed.

## Lorebook Staging in Detail

The lorebook modal uses two tabs:

- **Freeform** — the raw AI output, fully editable before parsing.
- **Ingester** — parses the freeform text into structured `UPDATE` and `NEW` blocks. For each suggestion you can edit the keys and content, preview the current entry (for UPDATE suggestions), and apply individually or all at once. Applied suggestions are marked with ✓ in the dropdown.

Staged changes persist across lorebook modal open/close within the same Chapterize session, so you can close and reopen the lorebook modal without losing your work.

## Model Recommendations 🧠

The quality of chapter transitions depends heavily on the model used. Because the extension requires the AI to analyse a long transcript and follow strict formatting, high-reasoning models are recommended.

- **Recommended:** **Gemini 1.5 Flash/Pro**, **GPT-4o**, or **Claude 3.5 Sonnet**. These excel at long-context comprehension and produce clean, well-structured prose updates.
- **Use with Caution:** Smaller or older models (like **DeepSeek-V3** or **Llama-3-8B**) may add meta-commentary or miss subtle character changes.
- **Pro Tip:** Use the **Connection Profile** setting to pin Chapterize to a powerful model while keeping your main roleplay chat on a faster or cheaper one — no manual switching required.

## Installation

### Via SillyTavern UI (Recommended)
1. Open the **Extensions** menu (the "stacked boxes" icon in the top bar).
2. Click **Install extension**.
3. Paste the URL of this repository into the input box.
4. Click **Install**.
5. The **Chapterize** entry (forward-step icon) will appear in your Extensions menu.

### Manual Installation
1. Navigate to your SillyTavern installation folder.
2. Go to `public/extensions`.
3. Clone this repository:
   ```
   git clone https://github.com/YourUsername/chapterize.git
   ```
4. Refresh SillyTavern in your browser.

## Usage

1. **Open a Chat:** Open a standard (non-group) character chat.
2. **Click Chapterize:** Find the **Chapterize** button in the Extensions menu (or use `/chapterize`).
3. **Review in the Character Workshop:**
   - Read the raw AI output in the **AI Raw** tab.
   - Switch to **Ingester** to apply individual suggestions to the Draft Bio.
   - Or edit the **Draft Bio** directly and use Revert if needed.
   - Review and tweak the **Situation Summary**.
   - Optionally open **Update Lorebook** to stage world-info changes.
4. **Finalize:** The extension saves your character, commits any lorebook changes, creates a new chapter chat, and switches you to it automatically.

## Configuration

In the SillyTavern Extensions settings panel you can configure:

- **Default Turns** — how many turns to carry over into new chapters (1–10, default 4).
- **Store Changelog** — keeps a timestamped history of chapter transitions in `extension_settings`.
- **Connection Profile** — pin Chapterize's three AI calls to a specific Connection Manager profile. Leave on default to use whatever connection is currently active. Only Chat Completion and Text Completion profiles are listed; other API types continue to work via the global connection fallback.
- **Prompt Templates** — fully rewrite the instructions for the Card Audit, Situation, and Lorebook calls. Each prompt has a *before content* and *after content* section; both can be reset to their defaults individually.

## Technical Notes

- **Nothing is committed until Finalize.** All edits — to the description, to lorebook entries — are staged in memory and written in a single sequential commit sequence.
- The situation summary is stored at the end of the character's description field separated by `\n\n*** Chapterize Divider — Do Not Edit ***\n\n`. SillyTavern treats the whole description field as part of the character's permanent context, so prior chapter threads always remain in the AI's active memory.
- The original chat file is **never modified**. The new chapter chat is a separate `.jsonl` file seeded with the last N complete turn pairs from the current session.
- The Ingester uses section-aware parsing (`parseDescriptionSections`) to match AI suggestions to bio sections by header text and occurrence order, handling duplicate headers correctly.
- Lorebook entries use SillyTavern's standard world-info schema. A `WORLDINFO_UPDATED` event is emitted after each save so ST's editor reflects changes without a page reload.
- Commit Receipts track step completion. A failed Finalize can be retried by clicking Finalize again — completed steps are not repeated.

## License

AGPL-3.0 — see LICENSE