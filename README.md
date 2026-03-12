# Chapterize for SillyTavern

**Chapterize** is a narrative management tool for SillyTavern designed to solve "context bloat" in long-running roleplays. It allows you to "close" a chapter by evolving your character card with the events of the current chat and transitioning into a fresh chat file with a concise situational summary.

## How it Works

When you trigger a Chapterize the extension determines whether the active character is a **base character** (first chapterize) or an **existing chapter card** already carrying a `(ChX)` suffix (subsequent chapterizes), then runs a single-step review workflow:

1. **Parallel AI Analysis.** Two LLM calls fire simultaneously as soon as the modal opens:
   - **Card Audit:** Generates prose snippet suggestions — drop-in replacements for sections of the character description that have changed.
   - **Situation Summary:** Creates a present-tense narrative brief (200–500 words) of where the story stands right now, including unresolved threads and character realizations.
2. **Interactive Review.** A single dashboard lets you:
   - Read the AI's suggested tweaks (read-only suggestions box with a regenerate button).
   - Edit the character description prose directly in its own textarea.
   - Review and edit the situation summary.
   - Adjust how many turns (default 4) to carry into the new chapter.
   - Open the **Update Lorebook** modal at any time without blocking the main flow.
3. **Commit & Transition.** On Confirm:
   - **First chapterize** (base character): a new character card named `CharName (Ch1)` is cloned from the original, carrying the updated description + situation block. The original card is never modified.
   - **Subsequent chapterizes** (character already named `CharName (ChX)`): the existing chapter card's name is bumped to `(ChX+1)` and its description is updated in-place — no new card is created.
   - A new chat file (`ch1`, `ch2`, …) is created seeded with the last N turns for tone continuity.
   - SillyTavern automatically switches you to the new chat.

The situation summary is appended to the character description using a fixed separator (`*** Chapterize Divider — Do Not Edit ***`). On the next chapterize the extension strips it back out so you only edit the prose, and feeds it to the situation prompt as `PRIOR CHAPTER SUMMARY`.

## Lorebook Integration

The **Update Lorebook** button opens a separate modal that:
1. Ensures a lorebook named after the base character exists (creates it if not).
2. Fires a third parallel LLM call to suggest `UPDATE` and `NEW` lorebook entries based on the transcript.
3. Presents suggestions in a **Freeform** tab (editable raw text) and an **Ingester** tab (structured apply UI with per-entry current-content preview, key and content editing, and Apply Entry / Apply All buttons).

Lorebook writes are immediate per-entry and do not gate the main Confirm flow.

## Model Recommendations 🧠

The quality of your chapter transitions depends heavily on the model used. Because the extension requires the AI to analyze a long transcript and follow strict formatting, we recommend using high-reasoning models.

- **Recommended:** **Gemini 1.5 Flash/Pro**, **GPT-4o**, or **Claude 3.5 Sonnet**. These models excel at long-context comprehension and provide clean, professional prose updates.
- **Use with Caution:** Smaller or older models (like **DeepSeek-V3** or **Llama-3-8B**) may struggle with the instructions, occasionally adding meta-commentary or failing to identify subtle character changes.
- **Pro Tip:** Use the **Connection Profile** setting (see Configuration below) to pin Chapterize to a powerful model while keeping your main roleplay chat on a faster or cheaper one — no manual switching required.

## Installation

### Via SillyTavern UI (Recommended)
1. Open the **Extensions** menu (the "stacked boxes" icon in the top bar).
2. Click **Install extension**.
3. Paste the URL of this repository into the input box.
4. Click **Install**.
5. The **Chapterize** entry (forward-step icon) will appear in your Extensions menu (the sparkles/wand icon on the chat bar).

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
2. **Click Chapterize:** Find the **Chapterize** button in the Extensions menu.
3. **Review & Edit:**
   - Read the **AI Suggested Tweaks** — prose snippets ready to copy into the description.
   - Edit the **Character Description** textarea directly.
   - Review and tweak the **Situation Summary**.
   - Optionally click **Update Lorebook** to manage world-info entries without leaving the flow.
4. **Confirm:** The extension saves your character, creates a new chapter chat, and switches you to it automatically.

## Configuration

In the SillyTavern Extensions settings panel (gear icon) you can:

- **Default Turns** — how many turns to carry over into new chapters (1–10, default 4).
- **Store Changelog** — keeps a timestamped history of chapter transitions in `extension_settings`.
- **Connection Profile** — pin Chapterize's three AI calls (Card Audit, Situation Summary, Lorebook) to a specific Connection Manager profile. When set, this profile is used regardless of the globally active connection. Leave on the default option to use whatever connection is currently active (the pre-existing behaviour). Only Chat Completion and Text Completion profiles are listed; other API types continue to work via the global connection fallback.
- **Prompt Templates** — fully rewrite the instructions for Card/Suggestions, Situation, and Lorebook calls. Each prompt has a *before content* and *after content* section; both can be reset to their defaults individually.

## Technical Notes

- The situation summary is stored at the end of the character's description field separated by `\n\n*** Chapterize Divider — Do Not Edit ***\n\n`. SillyTavern treats the whole description field as part of the character's permanent context, so the prior chapter's hanging threads always remain in the AI's active memory.
- The original chat file is **never modified**. The new chapter chat is a separate `.jsonl` file seeded with the last N complete turn pairs from the current session.
- Lorebook entries use SillyTavern's standard world-info schema. The extension emits a `WORLDINFO_UPDATED` event after each save so ST's editor reflects changes without a page reload.

## License

AGPL-3.0 — see LICENSE