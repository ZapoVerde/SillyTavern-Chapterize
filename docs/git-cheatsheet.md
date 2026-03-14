This updated cheatsheet incorporates the specific safety checks and remote cleanup commands we just used. I've added a **"Proactive Cleanup"** section to help you identify which branches are safe to kill before you even try.

### Git + Firebase Cheatsheet (Updated)

#### 1. Basic Branch Navigation & Syncing
- **Show current branch:**  
  `git branch --show-current`

- **List all local branches:**  
  `git branch` (current has `*`)

- **Switch to branch:**  
  `git switch <branch-name>`

- **Sync with GitHub (Update all references):**  
  `git fetch --all`

- **Sync & Prune (Remove local "ghost" references to deleted remote branches):**  
  `git fetch --prune` ← *Highly recommended for keeping your list clean.*

#### 2. Creating a New Branch
- **From current branch:**  
  `git switch -c new-branch`

- **From a specific branch (e.g., main):**  
  `git switch -c new-branch main`

#### 3. Typical Hotfix/Feature Flow
```bash
# 1. Start fresh on main
git switch main
git pull origin main

# 2. Create & work on fix
git switch -c branch-fix
# ... work, add, commit
git push origin branch-fix

# 3. Switch back to your main project
git switch feature/vectorize
```

#### 4. Merging & Updating
**Fast-forward (The "No-Merge-Commit" way):**
```bash
git switch main
git pull origin main
git merge --ff-only branch-fix
git push origin main
```

**Via Pull Request (GitHub UI):**
1. `git push origin branch-fix`
2. Open PR on GitHub → Merge.
3. Use the "Delete branch" button on GitHub after merging.

#### 5. Branch Cleanup (The "Safety First" Method)
Always try the safe delete (`-d`) first. Git will stop you if you're about to lose unmerged work.

**Identify what is safe to delete:**
- `git branch --merged main` (Lists branches already fully integrated into main)

**Execute local cleanup:**
```bash
# Safe delete (fails if not merged)
git branch -d branch-name

# Force delete (use ONLY if you want to trash the code)
git branch -D branch-name
```

**Execute remote cleanup:**
```bash
# Remove the branch from GitHub
git push origin --delete branch-name
```

#### 6. Firebase Project Switching & Deploy
- **Switch project:**  
  `firebase use prod` or `firebase use dev`

- **Check active project:**  
  `firebase use`

- **Build & Deploy:**  
  `npm run build`  
  `firebase deploy --only hosting`

---

### Quick Reference Table (Updated)

| Goal | Command | Why/Notes |
| :--- | :--- | :--- |
| **Switch** | `git switch <branch>` | Move between tasks |
| **Sync List** | `git fetch --prune` | Clears "deleted" branches from your local list |
| **Check Safety** | `git branch --merged` | See what is 100% safe to delete |
| **Delete Local** | `git branch -d <name>` | **Safe:** Won't delete unmerged work |
| **Force Delete** | `git branch -D <name>` | **Dangerous:** Deletes even if NOT merged |
| **Delete Remote**| `git push origin --delete <name>` | Cleans up the GitHub UI list |
| **Merge (Clean)** | `git merge --ff-only <name>`| Keeps history linear (no merge bubble) |
| **FB Switch** | `firebase use <alias>` | Changes the target for `firebase deploy` |
| **FB Deploy** | `firebase deploy` | Deploys based on current `firebase use` |