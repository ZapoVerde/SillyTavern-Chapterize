# Git Cheatsheet — Chapterize Extension

## Navigate to the Project

```bash
cd /stext/SillyTavern/data/default-user/extensions/chapterize
```

---

## Stage All Changes

```bash
git add .
```

---

## Commit with a Message

```bash
git commit -m "your commit message here"
```

Example:
```bash
git commit -m "fix: update chapter detection logic"
```

---

## Push to Remote

```bash
git push
```

If pushing a new branch for the first time:
```bash
git push -u origin main
```

---

## Full Workflow (copy-paste ready)

```bash
cd /stext/SillyTavern/data/default-user/extensions/chapterize
git add .
git commit -m "your message here"
git push
```

---

## Other Useful Commands

| Command | What it does |
|---|---|
| `git status` | Show changed/staged files |
| `git log --oneline` | See recent commits |
| `git diff` | Show unstaged changes |
| `git pull` | Pull latest from remote |
