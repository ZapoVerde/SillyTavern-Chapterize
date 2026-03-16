***

# Chapterize for SillyTavern

**Chapterize** is a narrative management tool for SillyTavern designed to solve "context bloat" in long-running roleplays. It closes a chapter by evolving your character card with the events of the current chat, extracting lore, and transitioning into a fresh chat file with a concise situational summary — all through a staged draft workflow that commits nothing until you hit Finalize.

## How it Works

When you trigger Chapterize, the extension determines whether the active character is a **base character** (first chapterize) or an **existing chapter card** already carrying a `(ChX)` suffix (subsequent chapterizes). It then orchestrates a 5-step wizard:

### Step 1 — Character Workshop
Two LLM calls fire simultaneously as soon as the modal opens: the **Card Audit** and the **Situation Summary** (see Step 2). A third call fetches and analyses the lorebook in parallel (see Step 3).

The Character Workshop is a three-tab editor for staging changes to the character description:
- **Draft Bio** — the full description in an editable textarea. Edit directly, or use the Ingester to apply AI suggestions section by section. A "Revert to Original" button resets it to the unmodified card text.
- **AI Raw** — the unprocessed card-audit output. A regenerate button re-runs the call against the current Draft Bio. A warning banner appears if any suggestions remain unapplied or unrejected.
- **Ingester** — a section-aware diff panel. A dropdown lists every parsed suggestion. The diff pane shows a word-level comparison between the matching bio section and the current editor content. Controls allow you to jump to unresolved items, revert to the AI's generation or the current draft bio, and selectively apply or reject edits.

### Step 2 — Situation Workshop
An editable textarea receives the **Situation Summary**: a 200–500 word present-tense narrative brief covering where the story stands, unresolved threads, and character realizations. It has its own regenerate button. The **Turns** slider (1–10, default 4) controls how many recent chat pairs are seeded into the new chapter for tone continuity.

### Step 3 — Lorebook Workshop
Exposes the results of the background lorebook audit across two tabs:
- **Freeform** — the raw AI output, fully editable before parsing.
- **Ingester** — parses the text into structured `UPDATE` and `NEW` blocks. Each suggestion is enriched with a UID anchor to ensure manual edits or regenerations don't lose track of your applied/rejected states. You can apply items one by one or click **Apply All Unresolved**.

### Step 4 — Narrative Memory (RAG) Workshop
*(Optional: Must be enabled in Settings)*
Transforms the completed chapter's transcript into a structured reference document for SillyTavern's Data Bank (Vector Storage). 
- **AI Mode:** Automatically slices the transcript into sliding-window chunks and queues concurrent LLM calls to generate brief, semantic headers describing the specific events of each chunk (e.g., *"The protagonist discovers the hidden letter"*). 
- **Simple Mode:** Bypasses AI generation entirely, labeling chunks with basic numerical markers (e.g., *"Chunk 1 (Turns 1-2)"*). Fast and completely local.
- **Detached Editing:** Switch to the "Raw" tab to manually edit the compiled document. Doing so "detaches" the workshop, preventing further AI generation from overwriting your custom formatting. Upon Finalize, this document is automatically uploaded and linked to the new chapter card.

### Step 5 — Review & Commit
A pre-flight summary shows the target character name, operation mode (Clone, Edit-in-Place, or Repair), the number of messages being carried over, and pending lorebook updates.

Clicking **Finalize** executes the following atomic sequence:
1. **Card Save** — Creates a clone card (`CharName (Ch1)`) or edits an existing chapter card in-place and bumps its name (`(ChX)` → `(ChX+1)`).
2. **RAG Upload** — Pushes the completed Narrative Memory file to the Data Bank and registers the attachment.
3. **Lorebook Save** — Bulk-writes staged lorebook changes to the server.
4. **Chat Save** — Creates the new chat file (`ch1`, `ch2`, …) seeded with the last N turns.
5. **Navigate** — Switches you to the new chat automatically.

If a step fails, the Receipts Panel shows the error. You can click Finalize again to retry *only* the failed steps.

### 🛠️ Repair Mode
Mistakes happen. If a transition went wrong, use the **Repair** button in the Chapterize settings. This re-inflates the wizard using the exact chat file and state from your last transition, allowing you to tweak the summary, adjust the carried turns, or fix the bio, and perform a *surgical overwrite* of the existing chapter without generating messy duplicates.

---

## Model Recommendations & Inference Notes 🧠

The quality of chapter transitions depends heavily on the model used. Because the extension requires the AI to analyze long transcripts, parse facts, and output strict structural formatting (like exact Lorebook block matching), **large, high-reasoning models are strongly recommended.** Smaller or heavily roleplay-tuned models may struggle with formatting constraints, hallucinate details, or output conversational filler.

**⚠️ Note on Inference (Text Completion vs. Chat Completion):**
Chapterize uses **Raw Text Completion (Direct Inference)**. It intentionally bypasses SillyTavern's global System Prompts, instruction templates, and Character-specific jailbreaks.
*   **Context Isolation:** The AI calls made by this extension do not include your chat history outside of what is explicitly interpolated into the prompt templates. 
*   **Why?** This isolation is by design. It forces the AI to treat the transcript as a *technical data source* to be analyzed rather than a prompt to continue the roleplay, ensuring clean, factual outputs uncolored by your current roleplay style.

## Installation

### Via SillyTavern UI (Recommended)
1. Open the **Extensions** menu (the "stacked boxes" icon in the top bar).
2. Click **Install extension**.
3. Paste the URL of this repository into the input box and click **Install**.
4. The **Chapterize** entry (forward-step icon) will appear in your Extensions menu.

### Manual Installation
1. Navigate to your SillyTavern installation folder.
2. Go to `public/extensions`.
3. Clone this repository: `git clone https://github.com/ZapoVerde/SillyTavern-Chapterize.git`
4. Refresh SillyTavern in your browser.

## Configuration

In the SillyTavern Extensions settings panel you can configure:

- **Default Turns:** How many turns to carry over into new chapters (1–10).
- **Store Changelog:** Keeps a timestamped history of transitions.
- **Enable RAG / RAG AI Mode:** Toggles the Narrative Memory builder and its AI-driven semantic header generation.
- **Connection Profiles:** Pin Chapterize's core AI calls (and its RAG classification calls) to specific Connection Manager profiles. *Pro Tip: This allows you to use a heavy reasoning model for Chapterize background tasks while using a faster/cheaper model for your main chat.*
- **Concurrency & Lookback:** Tune how many parallel RAG calls can fire at once, and how many past turns the AI is allowed to "look back" on for context.
- **Prompt Templates:** Fully rewrite the instructions for the Card Audit, Situation, Lorebook, and RAG calls. Each prompt has a *before content* and *after content* section to ensure constraints are placed at the very end of the prompt for maximum adherence.

## Technical Notes

- **Staged Memory:** Nothing is committed until you hit Finalize. All edits to the bio, RAG document, and lorebook are staged entirely in your browser's memory.
- **Divider Persistence:** The situation summary is appended to the bottom of the character's **Scenario** box, separated by `\n\n*** Chapterize Divider — Do Not Edit ***\n\n`. This keeps the character's core bio clean while ensuring the AI has a high-recency, rolling summary of the prior chapter's events. Any original world-state text in the Scenario box is preserved above the divider.
- **Non-Destructive:** Outside of Repair Mode, the original chat file is **never modified**. The new chapter chat is a cleanly generated `.jsonl` file.
- **Diff Engine:** The extension utilizes section-aware parsing (`parseDescriptionSections`) and word-level Longest Common Subsequence logic (`wordDiff`) to accurately track changes and map AI suggestions even when duplicate headers exist in a character's bio.

## License
AGPL-3.0 — see LICENSE