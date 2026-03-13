# Chapterize for SillyTavern

**Chapterize** is a narrative management tool for SillyTavern designed to solve "context bloat" in long-running roleplays. It closes a chapter by evolving your character card with the events of the current chat and transitioning into a fresh chat file with a concise situational summary — all through a staged draft workflow that commits nothing until you hit Finalize.

## How it Works

When you trigger Chapterize the extension determines whether the active character is a **base character** (first chapterize) or an **existing chapter card** already carrying a `(ChX)` suffix (subsequent chapterizes), then opens a four-step wizard:

### Step 1 — Character Workshop

Two LLM calls fire simultaneously as soon as the modal opens: the **Card Audit** and the **Situation Summary** (see Step 2). A third call fetches and analyses the lorebook in parallel (see Step 3).

The Character Workshop is a three-tab editor for staging changes to the character description:

- **Draft Bio** — the full description in an editable textarea. Edit directly, or use the Ingester to apply AI suggestions section by section. A "Revert to Original" button resets it to the unmodified card text.
- **AI Raw** — the unprocessed card-audit output. A regenerate button re-runs the call against the current Draft Bio. A warning banner appears if any suggestions remain unapplied or unrejected.
- **Ingester** — a section-aware diff panel. A dropdown lists every parsed suggestion; each entry is prefixed with ✓ (applied), ✗ (rejected), or nothing (unresolved). The diff pane shows a word-level comparison between the matching bio section and the current editor content. Controls:
  - **➡ (Next)** — jumps to the next unresolved suggestion.
  - **Revert to AI** — resets the editor to the original AI-generated text for this suggestion.
  - **Revert to Bio** — resets the editor to whatever the matching bio section currently contains.
  - **Reject** — marks the suggestion dismissed without applying it.
  - **Apply** — patches the Draft Bio in-place with the editor content and marks the suggestion ✓.

### Step 2 — Situation Workshop

An editable textarea receives the **Situation Summary**: a 200–500 word present-tense narrative brief covering where the story stands, unresolved threads, and character realizations. It has its own regenerate button. The **Turns** input (1–10, default 4) controls how many turn pairs are seeded into the new chapter chat.

### Step 3 — Lorebook Workshop

The lorebook call fires in parallel with the bio and situation calls at modal open. Step 3 exposes the result in two tabs:

- **Freeform** — the raw AI output, fully editable before parsing.
- **Ingester** — parses the freeform text into structured `UPDATE` and `NEW` blocks. Each suggestion is enriched with a UID anchor into `_draftLorebook` and an AI snapshot for revert operations. Controls mirror the character ingester:
  - **➡ (Next)** — jumps to the next unresolved suggestion.
  - **Revert to AI** — resets the three editor fields (Name, Keys, Content) to the original AI text.
  - **Revert to Draft** — resets the editor fields to whatever is currently staged in `_draftLorebook` for the linked entry (disabled for unapplied NEW entries).
  - **Reject** / **Apply** — per-suggestion staging (no server write).
  - **Apply All Unresolved** — applies every unreviewed suggestion after a confirmation dialog.

**All lorebook changes are staged in memory until Finalize.** Staged changes persist across Lorebook tab open/close within the same Chapterize session.

### Step 4 — Review & Commit

A pre-flight summary shows the target character name and operation mode (clone or edit-in-place), the number of messages being carried into the new chat, and how many lorebook entries are staged for update or creation. A pending-review warning is shown if any lorebook suggestions remain unresolved.

Clicking **Finalize** runs four steps in sequence, each tracked in a Commit Receipts panel:

1. **Card Save** — creates a clone card (`CharName (Ch1)`) on the first chapterize, or edits the existing chapter card in-place and bumps its name (`(ChX)` → `(ChX+1)`) on subsequent ones.
2. **Lorebook Save** — bulk-writes all staged lorebook changes to the server (skipped if no changes were staged).
3. **Chat Save** — creates a new chat file (`ch1`, `ch2`, …) seeded with the last N turns for tone continuity.
4. **Navigate** — switches you to the new chat automatically.

If any step fails, the receipts panel shows which step errored. Steps that already succeeded are not re-run on retry — clicking Finalize again resumes from the first incomplete step.

**Cancel before any commit** wipes all staged state. **Cancel after a partial commit** relabels to "Close" and keeps the receipts visible so you can see what was saved and retry if needed.

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
   git clone https://github.com/ZapoVerde/SillyTavern-Chapterize.git
   ```
4. Refresh SillyTavern in your browser.

## Usage

1. **Open a Chat:** Open a standard (non-group) character chat.
2. **Click Chapterize:** Find the **Chapterize** button in the Extensions menu (or use `/chapterize`).
3. **Step 1 — Character Workshop:**
   - Read the raw AI output in the **AI Raw** tab.
   - Switch to **Ingester** to apply, reject, or edit individual suggestions with word-level diffs.
   - Or edit the **Draft Bio** directly.
4. **Step 2 — Situation Workshop:** Review and tweak the Situation Summary and set how many turns to carry.
5. **Step 3 — Lorebook Workshop:** Review AI suggestions in Freeform or Ingester tabs; apply, reject, or edit entries staged to `_draftLorebook`.
6. **Step 4 — Review & Commit:** Confirm the pre-flight summary, then click **Finalize**.

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
- The Character Ingester uses section-aware parsing (`parseDescriptionSections`) to match AI suggestions to bio sections by header text and occurrence order, handling duplicate headers correctly. Word-level LCS diffs (`wordDiff`) power the diff pane.
- The Lorebook Ingester uses a Virtual Document model (`toVirtualDoc`) that flattens Name, Keys, and Content into a single string for diffing. Suggestions are enriched with UID anchors (`enrichLbSuggestions`) so regen and manual edits are reconciled without losing applied/rejected state.
- Lorebook entries use SillyTavern's standard world-info schema. A `WORLDINFO_UPDATED` event is emitted after each save so ST's editor reflects changes without a page reload.
- Commit Receipts track step completion. A failed Finalize can be retried by clicking Finalize again — completed steps are not repeated.

## License

AGPL-3.0 — see LICENSE