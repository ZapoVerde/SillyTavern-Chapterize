Here is the revised `README.md`. It includes the updated installation instructions, the accurate description of the current single-step workflow, and a new section on model recommendations.

***

# Chapterize for SillyTavern

**Chapterize** is a narrative management tool for SillyTavern designed to solve "context bloat" in long-running roleplays. It allows you to "close" a chapter by evolving your character card with the events of the current chat and transitioning into a fresh chat file with a concise situational summary.

## How it Works

When you trigger a Chapterize:
1. **Parallel AI Analysis:** The extension sends two calls to your LLM simultaneously:
    - **Card Audit:** Generates bullet-point suggestions of how the character has changed (injuries, relationship shifts, new facts).
    - **Situation Summary:** Creates a present-tense narrative brief of where the story stands "right now."
2. **Interactive Review:** You see a single dashboard to review the AI's suggestions and the situation summary. You can edit the character's description prose directly in the window.
3. **Commit & Transition:** 
    - The character card is updated with your new description + the situation block.
    - A new chat is created, seeding the last few turns (default 4) for tone continuity.
    - Your original chat remains untouched and safe.

## Model Recommendations 🧠

The quality of your chapter transitions depends heavily on the model used. Because the extension requires the AI to analyze a long transcript and follow strict formatting, we recommend using "High-Reasoning" models.

*   **Recommended:** **Gemini 1.5 Flash/Pro**, **GPT-4o**, or **Claude 3.5 Sonnet**. These models excel at "long-context" comprehension and provide clean, professional prose updates.
*   **Use with Caution:** Smaller or older models (like **DeepSeek-V3** or **Llama-3-8B**) may struggle with the instructions, occasionally adding meta-commentary or failing to identify subtle character changes.
*   **Pro Tip:** If you usually roleplay with a cheaper/smaller model, consider temporarily switching to a more powerful model (like Gemini) just for the Chapterize step to ensure your character card evolves accurately.

## Installation

### Via SillyTavern UI (Recommended)
1. Open the **Extensions** menu (the "stacked boxes" icon in the top bar).
2. Click **Install extension**.
3. Paste the URL of this repository into the input box.
4. Click **Install**.
5. The "Chapterize" button (a forward-step icon ⏭️) will now appear in your extension menu (the Sparkles/Wand icon on the chat bar).

### Manual Installation
1. Navigate to your SillyTavern installation folder.
2. Go to `public/extensions`.
3. Clone this repository: 
   `git clone https://github.com/YourUsername/chapterize.git`
4. Refresh SillyTavern in your browser.

## Usage

1. **Open a Chat:** Open a standard (non-group) character chat.
2. **Click Chapterize:** Find the **Chapterize** button in the extension menu (bottom left sparkles/wand icon).
3. **Review & Edit:**
    - Look at the **AI Suggested Tweaks** to see what the AI noticed.
    - Edit the **Character Description** to integrate those changes into your prose.
    - Review the **Situation Summary**.
4. **Confirm:** Click **Confirm**. The extension will save your character, create a new chat file, and automatically switch you to it.

## Configuration

In the SillyTavern Extensions settings (the gear icon next to the extension name), you can:
- Change the **Default Turns** to carry over into new chapters.
- Toggle the **Changelog** (keeps a history of your chapter transitions in the settings).
- **Edit Prompt Templates:** Completely rewrite the instructions used for generating suggestions and situation summaries.

## Technical Note
This extension writes the situation summary to the end of your character's description field using a specific separator (`***---SITUATION---***`). SillyTavern will treat this as part of the character's permanent context, ensuring the "hanging threads" of the previous chapter are always in the AI's active memory.

## License

AGPL-3.0 — see LICENSE
```
