# SillyTavern-Chapterize

A SillyTavern extension that compresses a long roleplay chat into a fresh chapter.

## What it does

When a chat gets long and token-heavy, Chapterize lets you start a clean new chapter without losing story continuity. It:

- Generates an updated character description reflecting who the character is *right now*
- Generates a situation summary of where the story stands
- Writes both into the character card description
- Creates a new chat seeded with the last N turns for tone continuity
- Leaves the original chat and character card untouched

## Installation

In your SillyTavern directory, navigate to `data/default-user/extensions/third-party/` and run:

```bash
git clone https://github.com/ZapoVerde/SillyTavern-Chapterize chapterize
```

Then restart SillyTavern.

## Usage

1. Duplicate your character card manually before starting a story (SillyTavern has a duplicate button in the character menu)
2. Play using the duplicate
3. When ready to chapter-break, click **Chapterize** in the chat bar
4. Review and edit the generated character evolution and situation summary
5. Click **Confirm** — the character card updates and a new chat opens with your last few turns carried over

## Settings

| Setting | Default | Description |
|---|---|---|
| Turns to carry over | 4 | How many turns seed the new chat |
| Self-check | On | AI reviews its own output for errors before you see it |
| Character Evolution prompt | (built-in) | Editable in the Extensions panel |
| Situation Summary prompt | (built-in) | Editable in the Extensions panel |

## Status

Early development. See [spec](SPEC.md) for planned functionality.

## License

AGPL-3.0 — see LICENSE
```
