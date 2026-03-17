
***

# Chapterize for SillyTavern

**Chapterize** is a narrative management tool designed to keep your long-running roleplays fast, affordable, and coherent. As stories grow, "context bloat" causes AI responses to become slow, expensive, and prone to forgetting recent details. 

Chapterize solves this by periodically closing the current chat and capturing its events into your character’s permanent state. This keeps your active chat context lightweight, fresh, and cheap, while preserving the granularity of your history by moving old turns into RAG (Retrieval-Augmented Generation) vectors.

Everything is done through a safe, step-by-step drafting process—nothing is actually saved to your SillyTavern files until you review and confirm the changes.

### Key Features
*   **Character Evolution:** Automatically audits your character’s description after a chapter ends, suggesting updates for new injuries, status shifts, or personality changes.
*   **Narrative Continuity:** Generates a concise "Previously On..." summary stored in the character's scenario, ensuring the AI never loses the thread of the plot.
*   **Dynamic Lore Extraction:** Identifies new NPCs, locations, or items introduced during play and stages updates to your Lorebook (World Info).
*   **Narrative Memory (RAG):** Instead of simply deleting old messages, Chapterize slices your transcript into structured files uploaded to the SillyTavern Data Bank. The AI can recall these specific past events only when they become relevant.
*   **Clean Transitions:** Opens a fresh chat file seeded with just enough recent messages to maintain tone and conversation flow.
*   **The Repair Engine:** A "surgical" repair mode that lets you undo a transition, tweak the summary or bio, and overwrite the chapter without creating messy duplicate cards or orphaned files.

### Why use it?
1.  **Lower Costs:** By resetting the active chat, you stop paying for thousands of redundant "history" tokens every time you hit send.
2.  **Better Performance:** A shorter context window means faster responses and an AI that stays focused on the current scene.
3.  **Perfect Memory:** By moving old turns into RAG vectors, you preserve the specific details of your journey without clogging the AI's "working memory."

---

## How to Use It

Click the Chapterize button in your Extensions menu (or type `/chapterize` in chat) to open the 5-step wizard:

### Step 1 — Character Workshop
As soon as you open Chapterize, the AI analyzes your chat and suggests updates to the character's description. 
* Use the **Ingester** tab to review these suggestions one by one. 
* Compare the AI's suggestion against your current bio and click **Apply** or **Reject**. 
* You can also type directly into the **Draft Bio** box to make manual edits.

### Step 2 — Situation Workshop
The AI generates a 200–500 word summary of where the story currently stands and what unresolved threads are hanging in the air. You can edit this summary freely. 
Below the summary, use the **Turns** slider to choose how many recent chat pairs (user + AI message) to carry over into the new chapter to maintain the current conversation flow.

### Step 3 — Lorebook Workshop
The AI scans your current Lorebook (World Info) alongside the chat to find stale entries that need updating or new concepts that need their own entry.
* Review the suggested `UPDATE` and `NEW` entries.
* Edit the names, keywords, or content as needed, then apply them individually or click **Apply All Unresolved**.

### Step 4 — Narrative Memory Workshop (Optional)
*(Must be enabled in the Chapterize settings)*
This step turns your finished chapter into a long-term memory document for SillyTavern's Vector Storage (Data Bank).
* **AI Mode:** Automatically chops the chapter into chunks and generates a brief, descriptive header for each event.
* **Simple/Raw Mode:** If you prefer, you can skip the AI generation and manually type out the memory document yourself in the "Raw" tab. 

### Step 5 — Review & Commit
Review a final checklist of the changes you are about to make. 
Clicking **Finalize** will instantly:
1. Update your character card (or create a `(Ch2)` clone).
2. Save your Narrative Memory to the Data Bank.
3. Save your applied Lorebook updates.
4. Create your fresh chat file and automatically switch you over to it.

---

## 🛠️ Repair Mode
Did you click Finalize and realize you made a typo, or didn't carry over enough turns? 
Open the Chapterize settings panel and click the **Repair** button. This will reopen the wizard exactly as it was during your last transition. You can fix your mistakes, hit Finalize again, and it will safely overwrite the broken chapter. It even acts as a "Janitor," hunting down and cleaning up the orphaned Lorebook and RAG data from your mistake.

---

## ⚙️ Configuration & Settings

In the SillyTavern Extensions settings panel, you can configure how Chapterize behaves:

*   **Default Turns:** How many turns to carry over into new chapters by default (1–10).
*   **Enable RAG / RAG AI Mode:** Toggles Step 4 (Narrative Memory builder) and its AI-driven semantic header generation. If you don't use Vector Storage, turn this off.
*   **Connection Profiles:** You can pin Chapterize's core AI calls (and its RAG classification calls) to specific Connection Manager profiles. *Pro Tip: This allows you to use a heavy, smart model for Chapterize background tasks, while using a faster/cheaper model for your main chat.*
*   **Concurrency & Lookback:** Tune how many parallel RAG calls can fire at once, and how many past turns the AI is allowed to "look back" on for context.
*   **Prompt Templates:** Fully rewrite the instructions for the Card Audit, Situation, Lorebook, and RAG calls. 

---

## 🧠 Basic RAG Setup & Model Recommendations

### Setting up Vector Storage (For Step 4)
Chapterize automates the creation of RAG documents, but **SillyTavern needs to be configured to read them.** If you do not have Vector Storage set up, Step 4 will upload text files to your Data Bank, but the AI won't be able to "remember" them.
1. In SillyTavern, go to the **Data Bank** (the book icon).
2. Go to the **Vectorization** settings.
3. Select an **Embedding Provider** (e.g., OpenAI, Cohere, Transformers, Extras) and ensure it is connected.
4. Enable "Vector Storage" in your chat settings.
*If you don't want to use this feature, simply disable RAG in the Chapterize settings.*

### Choosing the Right AI Model
The quality of your chapter transitions depends heavily on the model you use. Because Chapterize needs to analyze long chats, extract facts, and output strict formats, **large, high-reasoning models are strongly recommended.** Smaller or heavily roleplay-tuned models may struggle to follow formatting rules or might start writing dialogue instead of summaries.

*(Note: Chapterize intentionally ignores your SillyTavern system prompts and jailbreaks. This ensures the AI treats the chat as pure data to be summarized, rather than a prompt to continue roleplaying.)*

---

## 💡 Best Practices & Limitations

### Limitations
*   **Single Character Only:** Chapterize does not currently support Group Chats.

### Shortcuts
*   **Slash Command:** You can trigger the workflow at any time by typing `/chapterize` in the chat box. This is useful for mapping the extension to Quick Reply buttons or automated macros.

### Best Practices
*   **When to Chapterize:** The best time to Chapterize is when a major narrative scene concludes (e.g., the characters leave a tavern, finish a battle, or go to sleep), or when your context window is maxing out and responses are getting sluggish/expensive.
*   **The Scenario Divider:** After finalizing, you will see `*** Chapterize Divider — Do Not Edit ***` in your character's Scenario box. **Do not delete this.** The extension uses it to distinguish between your permanent world-state and the "rolling" narrative summary.
*   **The Ledger File:** Chapterize stores a file called `chz_ledger_[character].json` in your Data Bank. This tracks your chapter history and acts as a safety lock to prevent data corruption. **Do not delete this file**, or Repair Mode will permanently lose the ability to fix past transitions for that character.

---

## Installation

**Via SillyTavern UI (Recommended)**
1. Open the **Extensions** menu (the "stacked boxes" icon in the top bar).
2. Click **Install extension**.
3. Paste this repository URL into the input box and click **Install**.
4. The **Chapterize** entry will appear in your Extensions menu.

**Manual Installation**
1. Navigate to your SillyTavern installation folder.
2. Go to `public/extensions`.
3. Clone this repository: `git clone https://github.com/ZapoVerde/SillyTavern-Chapterize.git`
4. Refresh SillyTavern in your browser.

## License
AGPL-3.0 — see LICENSE