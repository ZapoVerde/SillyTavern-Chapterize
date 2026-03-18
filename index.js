/**
 * @file data/default-user/extensions/chapterize/index.js
 * @stamp {"utc":"2026-03-16T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern extension that closes a roleplay chapter using a Draft/Commit
 * architecture. Orchestrates a 5-step wizard modal to transition narrative
 * state. Supports standard Chapterize (cloning/updating) and Repair Mode 
 * (surgical overwrite of the most recent transition).
 * 
 * Steps:
 * (1) Character Workshop — 3-tab bio editor with robust multi-paragraph parsing
 *     that respects the Chapterize Divider as a hard boundary;
 * (2) Situation Workshop — situation summary + dynamic turns carry-over slider;
 * (3) Lorebook Workshop — diff-based Update tab with freeform AI output,
 *     UID-anchored suggestions, and regen reconciliation;
 * (4) Narrative Memory — RAG document builder with semantic header classification,
 *     concurrency-limited AI calls, and detached raw editing;
 * (5) Review & Commit — pre-flight summary with pending-review guards and
 *     destructive overwrite warnings when in Repair Mode.
 * 
 * @core-principles
 * 1. OWNS the full chapterize workflow from button click through new chat open.
 * 2. MUST NOT commit any server write until the user clicks Finalize.
 * 3. DELEGATES all disk persistence to ST server endpoints via fetch.
 * 4. MAINTAINS strict separation between staged section data and raw document views.
 * 5. SURGICAL OVERWRITE: Repair mode must overwrite existing IDs (cards/chats/files)
 *    rather than creating versioned duplicates.
 * 6. SOURCE TRUTH: Repair mode re-fetches the original source chat file to 
 *    allow full turn-count re-slicing without "copy of a copy" degradation.
 * 7. THE JANITOR: Repair mode must physically delete orphaned Data Bank files 
 *    and scrub attachment metadata to prevent "missing vector" warnings.
 * 
 * @api-declaration
 * Entry points: onChapterizeClick() (standard), onRepairClick() (maintenance).
 * Key internal APIs (Character): parseDescriptionSections (divider-aware), applyDescriptionSection.
 * Key internal APIs (Lorebook): toVirtualDoc, enrichLbSuggestions, updateLbDiff.
 * Key internal APIs (RAG): buildRagChunks, ragFireChunk, uploadRagFile, registerCharacterAttachment.
 * Key internal APIs (Repair): initWizardSession (reset), onConfirmClick (destructive path).
 * 
 * @contract
 *   assertions:
 *     purity: mutates # Modifies module-level session state on each invocation.
 *     state_ownership: [_transcript, _originalDescription, _priorSituation, _baseScenario, _stagedProsePairs,
 *       _cardSuggestions, _ingesterSnapshot, _ingesterDebounceTimer,
 *       _activeIngesterIndex, _chapterName, _cloneAvatarUrl, _finalizeSteps,
 *       _isRepairMode, _sourceChatId, _lastRagUrl, _repairSourceMessages,
 *       _suggestionsGenId, _situationGenId, _lorebookGenId,
 *       _lorebookName, _lorebookData, _draftLorebook, _lorebookLoading,
 *       _lorebookSuggestions, _lbActiveIngesterIndex, _lbDebounceTimer,
 *       _lorebookFreeformLastParsed, _currentStep, _lorebookRawText,
 *       _lorebookRawError, _ragChunks, _ragRawDetached, _lastSummaryUsedForRag,
 *       _ragInFlightCount, _ragCallQueue, _ragGlobalGenId,
 *       _splitPairIdx, _splitIndexWhenRagBuilt,
 *       _ledgerManifest, _sessionStartId, _lorebookDelta,
 *       extension_settings.chapterize]
 *     external_io: [generateWithProfile, /api/characters/*, /api/worldinfo/*, 
 *       /api/chats/*, /api/files/*] # Includes physical deletion of Data Bank files.
 */

import { generateRaw, saveSettingsDebounced, getRequestHeaders, openCharacterChat, getCharacters, selectCharacterById, eventSource, event_types, callPopup } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { buildModalHTML, buildSettingsHTML } from './ui.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME        = 'chapterize';
const SITUATION_SEP   = '\n\n*** Chapterize Divider — Do Not Edit ***\n\n';
const MIN_TURNS       = 1;
const MAX_TURNS       = 10;
const DEFAULT_TURNS_N = 4;
const MIN_LOOKBACK        = 0;
const MAX_LOOKBACK        = 10;
const DEFAULT_LOOKBACK    = 1;
const MIN_CONCURRENCY     = 1;
const MAX_CONCURRENCY     = 10;
const DEFAULT_CONCURRENCY = 5;

const DEFAULT_CARD_PROMPT = `
TASK:
1. Examine the CHARACTER DESCRIPTION for specific facts (age, health, relations, location).
2. Examine the transcript for changes to those facts.
3. Update the existing prose ONLY where facts have changed or a major status shift (like an injury or new possession) has occurred.
4. Maintain the exact existing structure and header names.

CONSTRAINTS:
- DO NOT invent new categories.
- DO NOT rewrite paragraphs that are still factually accurate.
- People change slowly; keep edits minimal and integrated into the current prose style.
- If no changes are needed, return nothing.

### OUTPUT FORMAT
Format your response as standard character description sections. Each header must be on its own line, followed by the updated content on the next line. Use the exact same header names as in the current description. Provide only the updated sections; do not include a preamble or conversational filler.

Example:
Health:
Wounded in the left shoulder, moving carefully.

CHARACTER DESCRIPTION:
{{original_description}}

SESSION TRANSCRIPT:
{{transcript}}


`;

const DEFAULT_CARD_PROMPT_AFT = `
Generate 2–4 specific prose sections based on the recent events, written as drop-in replacements or new additions to the character's description. Each section header must be on its own line, followed by the content on the next line. Use the exact same header names as in the description. Maintain the established tone and formatting exactly. Do not provide meta-advice; provide only the actual text sections.
`;

const DEFAULT_SITUATION_PROMPT = `
[SYSTEM: TASK - STORY CHRONICLER]
Analyze the provided TRANSCRIPT to update the narrative state. Write a concise, comprehensive situation summary (200-500 words) using the following guidelines:

1. TONE & STYLE: Adopt the prose style, vocabulary, and emotional weight of the transcript. If the story is gritty, be blunt; if it is whimsical, be descriptive.
2. PLOT STATE: Identify the current location and immediate physical stakes. Detail what has just been accomplished and, crucially, what "ticking clocks" or unresolved threats remain "hanging in the air."
3. CHARACTER DYNAMICS: Focus on internal shifts. Note new realizations, changes in trust, or veiled intentions that were exposed.
4. FORMAT: Write in the present tense. Use a single fluid narrative or organized paragraphs. Avoid bullet points to keep the summary immersive for the next generation.

Constraints: No preamble. No "This is a summary." No editorializing.
TRANSCRIPT:
{{transcript}}
`;

const DEFAULT_SITUATION_PROMPT_AFT = `
REMINDER: You are an objective chronicler. Summarize the narrative state; do not continue the roleplay or narrate future events. Focus on the 'Unresolved Threads' and 'Character Realizations'. Output only the summary text in present tense (200-500 words).
`;

const DEFAULT_LOREBOOK_PROMPT = `
[SYSTEM: TASK — LOREBOOK CURATOR]
You are reviewing a session transcript and the current lorebook entries for a character.
Your job is to suggest targeted updates to existing entries and identify new concepts
that warrant a lorebook entry.

CURRENT LOREBOOK ENTRIES:
{{lorebook_entries}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- For each existing entry whose information is now stale, incomplete, or contradicted by
  the transcript, output an UPDATE block.
- For each new person, place, faction, item, or recurring concept introduced in the
  transcript that does NOT already have an entry, output a NEW block.
- Keep entries concise (2–6 sentences). Write in third-person present tense.
- Keys: the most natural words a reader would search for (lowercase, 2–5 keys per entry).
- If no changes are needed, output exactly: NO CHANGES NEEDED

### OUTPUT FORMAT — use exactly this structure for each suggestion:

**UPDATE: [Exact Entry Name to Match]**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this entry — write the complete entry, not just the changed part.]
*Reason: One sentence explaining what changed and why.*

**NEW: [Suggested Entry Name]**
Keys: keyword1, keyword2
[Full content for this new entry.]
*Reason: One sentence explaining why this warrants a new entry.*
`;

const DEFAULT_LOREBOOK_PROMPT_AFT = `
REMINDER: Output only UPDATE and NEW blocks in the exact format shown above.
No preamble. No commentary. No numbering. Each block must begin with **UPDATE:** or **NEW:**
on its own line. The Keys line must immediately follow the header line. Content follows the
Keys line. The *Reason:* line closes each block. Leave one blank line between blocks.
`;

const DEFAULT_RAG_CLASSIFIER_PROMPT = `
You are a precise Narrative Memory Classifier.

Output rules — follow exactly, no exceptions:
- Output ONLY the 2–3 sentence header text in present tense.
- No quotes. No final punctuation. No explanations. No other text at all.
- Capture ONLY the core dramatic event, revelation, confrontation, decision, or emotional shift in the TARGET TURNS.
- Ignore the GLOBAL CHAPTER SUMMARY except as loose context.

Focus priority:
- Most significant narrative moment only
- Present tense, concise (2–3 sentences max)

Example:
TARGET TURNS: [character finds hidden letter] [reads it] [gasps] "It was you all along."
Header: The protagonist discovers undeniable proof of betrayal in the hidden letter. Shock and realization hit as the truth becomes clear

GLOBAL CHAPTER SUMMARY (context only — do NOT classify):
{{summary}}
{{context_block}}

TARGET TURNS:
{{target_turns}}
`;

const SETTINGS_DEFAULTS = Object.freeze({
    turnsN:              DEFAULT_TURNS_N,
    storeChangelog:      true,
    enableRag:           false,
    ragAiMode:           true,
    classifierLookback:  DEFAULT_LOOKBACK,
    maxConcurrentCalls:  DEFAULT_CONCURRENCY,
    profileId:           null,
    ragProfileId:        null,
    ragMaxTokens:        100,
    ragClassifierPrompt: DEFAULT_RAG_CLASSIFIER_PROMPT,
    cardPrompt:          DEFAULT_CARD_PROMPT,
    cardPromptAft:       DEFAULT_CARD_PROMPT_AFT,
    situationPrompt:     DEFAULT_SITUATION_PROMPT,
    situationPromptAft:  DEFAULT_SITUATION_PROMPT_AFT,
    lorebookPrompt:      DEFAULT_LOREBOOK_PROMPT,
    lorebookPromptAft:   DEFAULT_LOREBOOK_PROMPT_AFT,
    changelog:           [],
    autoTriggerEvery:       10,
    autoTriggerSnoozeTurns: 5,
    autoTriggerModal:       false,
});

// ─── Session State ────────────────────────────────────────────────────────────
// Cleared at the start of each chapterize invocation.

let _transcript              = '';
let _originalDescription     = '';
let _priorSituation          = '';
let _baseScenario            = '';  // text above SITUATION_SEP in char.scenario; preserved on write
let _stagedProsePairs        = [];  // [{user: msg, ai: msg}] built on click, used at Finalize
let _suggestionsLoading      = false;
let _situationLoading        = false;
let _isChapterMode           = false;   // true when current char already has a (ChX) suffix
let _nextChNum               = 1;       // chapter number to assign on next chapterize
let _cloneName               = '';      // display name for the chapter card (e.g. "CharName (Ch2)")
// Per-call generation IDs — incremented on each new call, checked in callbacks
// to discard results from superseded calls. All three incremented on closeModal.
let _suggestionsGenId        = 0;
let _situationGenId          = 0;
let _lorebookGenId           = 0;

// Character Workshop state
let _cardSuggestions         = [];      // parsed suggestion objects from last card AI call
let _ingesterSnapshot        = '';      // AI suggestion text at selection time; powers Revert to AI
let _ingesterDebounceTimer   = null;    // setTimeout handle for diff update debounce
let _activeIngesterIndex     = 0;       // last-viewed suggestion index; restored on Ingester tab re-entry

// Finalize commit state — set during card save step, persisted for retries
let _chapterName             = '';      // derived chat file name (e.g. "ch2")
let _cloneAvatarUrl          = '';      // clone path only: avatar URL of the created clone

// Step completion flags — reset only on fresh session start, NOT between retry attempts
const _finalizeSteps = {
    cardSaved:     false,
    ragSaved:      false,
    lorebookSaved: false,
    chatSaved:     false,
};

// ─── Lorebook Session State ───────────────────────────────────────────────────
// Cleared on closeModal. _draftLorebook persists across lorebook modal open/close
// within the same chapterize session so staged changes are not lost.

let _lorebookName    = '';    // base character name used as lorebook filename
let _lorebookData    = null;  // {entries:{}} — server copy, loaded on first open
let _draftLorebook   = null;  // working copy — deep clone of _lorebookData; Apply mutates this only
let _lorebookLoading = false;

// ─── Lorebook Ingester State ──────────────────────────────────────────────────
// Persists across Freeform ↔ Ingester tab switches within a session.

let _lorebookSuggestions        = [];   // enriched suggestion objects (see enrichLbSuggestions)
let _lbActiveIngesterIndex      = 0;    // current selection in lorebook ingester dropdown
let _lbDebounceTimer            = null; // setTimeout handle for lorebook diff update debounce
let _lorebookFreeformLastParsed = null; // freeform text at last enrichment; null forces re-enrich

// ─── RAG Workshop State (Step 4) ──────────────────────────────────────────────
// Chunk statuses: 'pending' | 'in-flight' | 'complete' | 'stale' | 'manual'
// _ragChunks: [{chunkIndex, pairStart, turnLabel, content, header, status, genId}]

let _ragChunks             = [];   // one entry per sliding-window chunk
let _ragRawDetached        = false; // true when the Combined Raw textarea has been edited
let _lastSummaryUsedForRag = null;  // summary string used to fire the last batch of calls
let _ragInFlightCount      = 0;    // count of calls currently awaiting a response
let _ragCallQueue          = [];   // chunk indices queued but not yet fired
let _ragGlobalGenId        = 0;    // incremented only on closeModal to kill all in-flight

// ─── Blade State ──────────────────────────────────────────────────────────────
// The "Blade" enforces zero-overlap between the RAG archive and the carry window.
// _splitPairIdx is the exclusive upper bound: only _stagedProsePairs[0.._splitPairIdx)
// are eligible for the RAG file. Everything from that boundary onward is Continuity.

let _splitPairIdx           = 0;    // exclusive upper bound for archive pairs (Blade position)
let _splitIndexWhenRagBuilt = null; // _splitPairIdx value when _ragChunks were last built; null = never

// ─── Wizard State ─────────────────────────────────────────────────────────────

let _currentStep     = 1;    // active wizard step (1–5)
let _lorebookRawText = '';   // buffered AI result text for Step 3 freeform
let _lorebookRawError = '';  // buffered AI error message for Step 3

// ─── Repair Mode State ────────────────────────────────────────────────────────
// Cleared on closeModal. _repairSourceMessages holds the fetched source chat
// array so buildLastN can re-slice it with the user's chosen turns value.

let _isRepairMode         = false;  // true while the repair wizard is open
let _sourceChatId         = '';     // filename (no .jsonl) of the chat being closed
let _lastRagUrl           = '';     // server path of the most recently uploaded RAG file
let _repairSourceMessages = [];     // source chat messages fetched in onRepairClick

// ─── Narrative Ledger State ───────────────────────────────────────────────────
// These three variables span the modal lifecycle — set at open, cleared at close.
// initWizardSession() MUST NOT reset them; closeModal() MUST reset them to null.

let _ledgerManifest  = null;  // in-memory manifest fetched/bootstrapped at modal open
let _sessionStartId  = null;  // headNodeId captured at open; used for exit freshness lock
let _lorebookDelta   = null;  // {createdUids, modifiedEntries} built during lorebook save

// ─── Auto-trigger State ───────────────────────────────────────────────────────
// Not reset by closeModal() — persists across wizard open/close cycles.
// Reset by onChatChanged() when the user switches chats.

let _autoTriggerLastChatLen   = 0;  // chat.length at last successful commit (or last chat switch)
let _autoTriggerSuppressUntil = 0;  // suppress banner until chat.length exceeds this (snooze)

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettings() {
    return extension_settings[EXT_NAME];
}

function initSettings() {
    extension_settings[EXT_NAME] = Object.assign(
        {},
        SETTINGS_DEFAULTS,
        extension_settings[EXT_NAME],
    );
    // Guard: changelog must always be an array
    if (!Array.isArray(getSettings().changelog)) {
        getSettings().changelog = [];
    }
}

// ─── Transcript ───────────────────────────────────────────────────────────────

function buildTranscript(messages) {
    return messages
        .filter(m => !m.is_system)
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n');
}

// ─── Narrative Memory (RAG) ───────────────────────────────────────────────────

/**
 * Pairs user+AI messages from a chat into turn objects.
 * Skips system messages. Only complete user→AI pairs are included.
 * @param {object[]} messages
 * @returns {{user: object, ai: object, userId: *, aiId: *, validIdx: number}[]}
 */
function buildProsePairs(messages) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const pairs = [];
    for (let i = 0; i < valid.length - 1; i++) {
        if (valid[i].is_user && !valid[i + 1].is_user) {
            pairs.push({
                user:     valid[i],
                ai:       valid[i + 1],
                userId:   valid[i].id ?? i,
                aiId:     valid[i + 1].id ?? (i + 1),
                validIdx: i,
            });
        }
    }
    return pairs;
}

/**
 * Builds the final RAG document from the workshop chunk state.
 * Each chunk uses its current semantic header (AI-generated or user-edited).
 * Chunks are separated by `---` so ST's recursive splitter treats each as a
 * discrete vector entry.
 * @param {Array} ragChunks  _ragChunks array from session state.
 * @returns {string}
 */
function buildRagDocument(ragChunks) {
    if (!ragChunks.length) return '';
    return ragChunks
        .map(c => `### ${c.header}\n\n${c.content}`)
        .join('\n\n***\n\n');
}

/**
 * Builds the _ragChunks state array from the staged prose pairs.
 * Uses the same sliding window of 2 pairs (stride 1) as the original
 * buildRagDocument. The content body is the formatted dialogue; header starts
 * as the turn-range label (fallback) and is later replaced by AI classification.
 * @param {Array} pairs  _stagedProsePairs array.
 * @returns {Array}
 */
function buildRagChunks(pairs) {
    const chunks = [];
    for (let i = 0; i < pairs.length; i++) {
        const window = pairs.slice(i, i + 2);
        const turnA = i + 1;
        const turnB = Math.min(i + 2, pairs.length);
        const turnLabel = turnA === turnB
            ? `Chunk ${i + 1} (Turn ${turnA})`
            : `Chunk ${i + 1} (Turns ${turnA}–${turnB})`;
        const content = window
            .map(p => `[${p.user.name.toUpperCase()}]\n${p.user.mes}\n\n[${p.ai.name.toUpperCase()}]\n${p.ai.mes}`)
            .join('\n\n');
        chunks.push({
            chunkIndex: i,
            pairStart:  i,
            turnLabel,
            content,
            header:  turnLabel,   // replaced by AI on successful classification
            status:  'pending',
            genId:   0,
        });
    }
    return chunks;
}

/**
 * Compiles the Combined Raw text from current _ragChunks state.
 * Pure data function — reads _ragChunks only, no DOM access.
 * @returns {string}
 */
function compileRagFromChunks() {
    return _ragChunks
        .map(c => `### ${c.header}\n\n${c.content}`)
        .join('\n\n***\n\n');
}

/**
 * Fires a single RAG classifier call for the chunk at chunkIndex.
 * Respects per-chunk genId and global ragGlobalGenId for staleness detection.
 * Captures summaryAtCallTime to detect summary changes while in-flight.
 * @param {number} chunkIndex
 */
async function ragFireChunk(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;
    const localGenId       = ++chunk.genId;
    const globalGenId      = _ragGlobalGenId;
    const summaryAtCall    = _lastSummaryUsedForRag;
    const lookback         = getSettings().classifierLookback ?? DEFAULT_LOOKBACK;

    chunk.status = 'in-flight';
    _ragInFlightCount++;
    console.log(`[CHZ-DBG] ragFireChunk START chunk=${chunkIndex} localGenId=${localGenId} globalGenId=${globalGenId} inFlight=${_ragInFlightCount} queue=${_ragCallQueue.length}`);
    renderRagCard(chunkIndex);

    try {
        const contextPairs = _stagedProsePairs.slice(Math.max(0, chunkIndex - lookback), chunkIndex);
        // Clamp to _splitPairIdx so the classifier never reads carry-window pairs
        const targetPairs  = _stagedProsePairs.slice(chunkIndex, Math.min(chunkIndex + 2, _splitPairIdx));
        const header       = await runRagClassifierCall(summaryAtCall, contextPairs, targetPairs);

        const globalStale = _ragGlobalGenId !== globalGenId;
        const localStale  = chunk.genId !== localGenId;
        console.log(`[CHZ-DBG] ragFireChunk RESPONSE chunk=${chunkIndex} globalStale=${globalStale} localStale=${localStale} inFlight=${_ragInFlightCount}`);
        if (globalStale || localStale) return;

        // If the summary changed since this call was fired, mark as stale
        if (_lastSummaryUsedForRag !== summaryAtCall) {
            chunk.status = 'stale';
        } else {
            chunk.header = header.trim() || chunk.turnLabel;
            chunk.status = 'complete';
        }
    } catch (err) {
        const globalStale = _ragGlobalGenId !== globalGenId;
        const localStale  = chunk.genId !== localGenId;
        console.error(`[CHZ-DBG] ragFireChunk ERROR chunk=${chunkIndex} globalStale=${globalStale} localStale=${localStale} inFlight=${_ragInFlightCount}`, err);
        if (err.cause) console.error(`[CHZ-DBG] ragFireChunk ERROR cause:`, err.cause);
        if (globalStale || localStale) return;
        chunk.status = 'pending';   // allow retry via regen button
    } finally {
        const globalStale = _ragGlobalGenId !== globalGenId;
        console.log(`[CHZ-DBG] ragFireChunk FINALLY chunk=${chunkIndex} globalStale=${globalStale} inFlight(before)=${_ragInFlightCount} — will decrement: ${!globalStale}`);
        if (!globalStale) {
            _ragInFlightCount = Math.max(0, _ragInFlightCount - 1);
            ragDrainQueue();
        }
    }

    if (_ragGlobalGenId === globalGenId) {
        renderRagCard(chunkIndex);
    }
}

/**
 * Fires queued chunks up to the maxConcurrentCalls limit.
 */
function ragDrainQueue() {
    const max = getSettings().maxConcurrentCalls ?? DEFAULT_CONCURRENCY;
    console.log(`[CHZ-DBG] ragDrainQueue inFlight=${_ragInFlightCount} max=${max} queue=${JSON.stringify(_ragCallQueue)}`);
    while (_ragInFlightCount < max && _ragCallQueue.length > 0) {
        const idx = _ragCallQueue.shift();
        ragFireChunk(idx);
    }
    if (_ragInFlightCount >= max && _ragCallQueue.length > 0) {
        console.warn(`[CHZ-DBG] ragDrainQueue BLOCKED — inFlight=${_ragInFlightCount} >= max=${max}, ${_ragCallQueue.length} chunks still queued`);
    }
}

/**
 * Re-fires the classifier for a single card. If the card is in-flight,
 * its in-flight slot is reclaimed and a fresh call is started immediately
 * (bypassing the concurrency queue). Per-card regen always fires right away.
 * @param {number} chunkIndex
 */
function ragRegenCard(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    console.log(`[CHZ-DBG] ragRegenCard chunk=${chunkIndex} chunkExists=${!!chunk} hasSummary=${!!_lastSummaryUsedForRag} prevStatus=${chunk?.status} inFlight=${_ragInFlightCount} queue=${JSON.stringify(_ragCallQueue)}`);
    if (!chunk || !_lastSummaryUsedForRag) {
        console.warn(`[CHZ-DBG] ragRegenCard ABORTED — chunk=${!!chunk} hasSummary=${!!_lastSummaryUsedForRag}`);
        return;
    }

    if (chunk.status === 'in-flight') {
        // Reclaim the in-flight slot — the old call result will be discarded via genId mismatch
        _ragInFlightCount = Math.max(0, _ragInFlightCount - 1);
        console.log(`[CHZ-DBG] ragRegenCard reclaimed in-flight slot, inFlight now=${_ragInFlightCount}`);
    }
    // Remove from pending queue if it was queued but not fired
    _ragCallQueue = _ragCallQueue.filter(i => i !== chunkIndex);

    chunk.status = 'pending';
    renderRagCard(chunkIndex);
    // Fire immediately, outside the concurrency queue
    ragFireChunk(chunkIndex);
}

/**
 * Builds and fires the prompt for a single RAG classification call.
 * @param {string} summaryText  The finalized situation summary.
 * @param {Array}  contextPairs Pairs to use as look-back context (may be empty).
 * @param {Array}  targetPairs  The chunk pairs to classify.
 * @returns {Promise<string>}   The raw AI response (header text).
 */
async function runRagClassifierCall(summaryText, contextPairs, targetPairs) {
    const formatPairs = pairs => pairs
        .map(p => `[${p.user.name.toUpperCase()}]\n${p.user.mes}\n\n[${p.ai.name.toUpperCase()}]\n${p.ai.mes}`)
        .join('\n\n');

    const contextBlock = contextPairs.length > 0
        ? `CONTEXT TURNS (for background only — do NOT classify these):\n${formatPairs(contextPairs)}\n\n`
        : '';

    const promptTemplate = getSettings().ragClassifierPrompt || DEFAULT_RAG_CLASSIFIER_PROMPT;
    const prompt = interpolate(promptTemplate, {
        summary:       summaryText,
        context_block: contextBlock,
        target_turns:  formatPairs(targetPairs),
    });

    return generateWithRagProfile(prompt);
}

/**
 * Runs a lightweight heuristic on an edited raw document and emits a
 * non-blocking toastr if the structure looks unusual.
 * @param {string} rawText
 */
function maybeWarnRawDocument(rawText) {
    const sections = rawText.split(/\n\*\*\*\n/).filter(s => s.trim()); 
    const hasEmptyHeader = sections.some(s => {
        const first = s.trim().split('\n')[0] ?? '';
        return first === '###' || first.trim() === '';
    });
    const countDiff = Math.abs(sections.length - _ragChunks.length);
    if (countDiff > 2 || hasEmptyHeader) {
        toastr.warning('The edited RAG document looks unusual — some sections may be missing or malformed. Review before finalizing.');
    }
}

/**
 * UTF-8–safe base64 encoding for the /api/files/upload payload.
 * @param {string} str
 * @returns {string}
 */
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return btoa(binary);
}

/**
 * Uploads a text string to the ST Data Bank as a plain-text file.
 * @param {string} text     Full document content.
 * @param {string} fileName Desired filename (e.g. "Seraphina (Ch1).txt").
 * @returns {Promise<string>} The server-assigned URL for the uploaded file.
 */
async function uploadRagFile(text, fileName) {
    const safeName = fileName.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-.]/g, '');

    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name: safeName, data: utf8ToBase64(text) }),
    });
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`RAG file upload failed (HTTP ${res.status}): ${errorText}`);
    }
    const json = await res.json();
    if (!json.path) throw new Error('RAG file upload returned no path');
    return json.path;
}

/**
 * Registers a Data Bank file as a character attachment so ST's vector engine
 * picks it up during generation. Mirrors the FileAttachment typedef from chats.js.
 * @param {string} avatarKey  character.avatar of the target card.
 * @param {string} url        File URL returned by uploadRagFile.
 * @param {string} fileName   Human-readable file name.
 * @param {number} byteSize   Byte length of the uploaded text.
 */
function registerCharacterAttachment(avatarKey, url, fileName, byteSize) {
    if (!extension_settings.character_attachments) {
        extension_settings.character_attachments = {};
    }
    if (!Array.isArray(extension_settings.character_attachments[avatarKey])) {
        extension_settings.character_attachments[avatarKey] = [];
    }
    extension_settings.character_attachments[avatarKey].push({
        url,
        size:    byteSize,
        name:    fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
}

// ─── Prompt Interpolation ─────────────────────────────────────────────────────

function interpolate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// ─── LLM Calls ───────────────────────────────────────────────────────────────

async function generateWithProfile(prompt, maxTokens = null) {
    const profileId = getSettings().profileId;
    if (profileId) {
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens);
        return result.content;
    }
    return generateRaw({ prompt, trimNames: false, responseLength: maxTokens });
}

/**
 * Like generateWithProfile but uses the RAG-specific connection profile
 * (ragProfileId). Falls back to the main profile, then to the global connection.
 * Capped at ragMaxTokens (configurable in settings) to prevent runaway outputs.
 */
async function generateWithRagProfile(prompt) {
    const ragMaxTokens = getSettings().ragMaxTokens ?? 100;
    const ragProfileId = getSettings().ragProfileId;
    if (ragProfileId) {
        const result = await ConnectionManagerRequestService.sendRequest(ragProfileId, prompt, ragMaxTokens);
        return result.content;
    }
    return generateWithProfile(prompt, ragMaxTokens);
}

async function runSuggestionsCall(bioText) {
    const fore = interpolate(getSettings().cardPrompt, {
        original_description: bioText,
        transcript:           _transcript,
    });
    const aft    = getSettings().cardPromptAft?.trim();
    const prompt = aft ? `${fore}\n\n${aft}` : fore;
    return generateWithProfile(prompt);
}

async function runSituationCall() {
    const fore = interpolate(getSettings().situationPrompt, {
        transcript:           _transcript,
        original_description: _originalDescription,
    });
    const aft        = getSettings().situationPromptAft?.trim();
    const priorBlock = _priorSituation
        ? `PRIOR CHAPTER SUMMARY (events before this session):\n${_priorSituation}\n\n`
        : '';
    const prompt = aft ? `${priorBlock}${fore}\n\n${aft}` : `${priorBlock}${fore}`;
    return generateWithProfile(prompt);
}

async function runLorebookCall() {
    const fore = interpolate(getSettings().lorebookPrompt, {
        lorebook_entries: formatLorebookEntries(_lorebookData),
        transcript:       _transcript,
    });
    const aft    = getSettings().lorebookPromptAft?.trim();
    const prompt = aft ? `${fore}\n\n${aft}` : fore;
    return generateWithProfile(prompt);
}

// ─── Lorebook Entries Format ──────────────────────────────────────────────────

function formatLorebookEntries(data) {
    const entries = data?.entries ?? {};
    const items   = Object.values(entries);
    if (!items.length) return '(no entries yet)';
    return items.map(e => {
        const label = e.comment || String(e.uid);
        const keys  = Array.isArray(e.key) ? e.key.join(', ') : (e.key || '');
        return `--- Entry: ${label} ---\nKeys: ${keys}\n${e.content || ''}`;
    }).join('\n\n');
}

// ─── Chapter-Character Detection ──────────────────────────────────────────────

const CHAPTER_RE = /^(.+?)\s\(Ch(\d+)\)$/i;

/**
 * Parses a character name for a (ChX) suffix.
 * Returns { isChapter, baseName, chNum } where chNum is 0 for non-chapter chars.
 */
function parseChapter(name) {
    const m = name.match(CHAPTER_RE);
    if (!m) return { isChapter: false, baseName: name, chNum: 0 };
    return { isChapter: true, baseName: m[1], chNum: parseInt(m[2], 10) };
}

// ─── Character Form Data ──────────────────────────────────────────────────────

/**
 * @section Persistence Layer
 * @architectural-role Data Access Layer
 * @description 
 * Encapsulates all direct communication with the SillyTavern server via fetch. 
 * Responsible for FormData construction, character cloning, lorebook 
 * synchronization, and chat file serialization.
 * @core-principles
 *   1. ATOMICITY: Functions should handle single-entity writes (e.g., just the 
 *      card, just the chat) to allow the Finalize Flow to manage retries.
 *   2. ABSTRACTION: Hides endpoint paths and request header complexity 
 *      from the workshop logic.
 * @api-declaration
 *   createCharacterClone, saveCharacter, lbSaveLorebook, saveNewChat, 
 *   lbEnsureLorebook, uploadRagFile.
 * @contract
 *   assertions:
 *     external_io: [ST /api/characters/*, /api/worldinfo/*, /api/chats/*, /api/files/*]
 */
function buildCharacterFormData(char, overrides = {}) {
    const name        = overrides.name        ?? char.name;
    const description = overrides.description ?? char.description;
    const scenario    = overrides.scenario    ?? char.scenario;

    const formData = new FormData();
    formData.append('ch_name',                   name);
    formData.append('description',               description);
    formData.append('personality',               char.personality                     ?? '');
    formData.append('scenario',                  scenario                             ?? '');
    formData.append('first_mes',                 char.first_mes                       ?? '');
    formData.append('mes_example',               char.mes_example                     ?? '');
    formData.append('creator_notes',             char.data?.creator_notes             ?? '');
    formData.append('system_prompt',             char.data?.system_prompt             ?? '');
    formData.append('post_history_instructions', char.data?.post_history_instructions ?? '');
    formData.append('tags',                      JSON.stringify(char.tags             ?? []));
    formData.append('creator',                   char.data?.creator                   ?? '');
    formData.append('character_version',         char.data?.character_version         ?? '');
    formData.append('alternate_greetings',       JSON.stringify(char.data?.alternate_greetings ?? []));
    return formData;
}

// ─── Character Clone ──────────────────────────────────────────────────────────

/**
 * Creates a new character named `cloneName` with all fields copied from
 * `sourceChar` but with `newDescription`. Returns the avatar filename string
 * that the server assigned (plain text, e.g. "CharName_.png").
 */
async function createCharacterClone(sourceChar, cloneName, newDescription, newScenario) {
    const formData = buildCharacterFormData(sourceChar, { name: cloneName, description: newDescription, scenario: newScenario });

    // Copy the source avatar image so the clone inherits the same portrait.
    try {
        const imgRes = await fetch(`/characters/${sourceChar.avatar}`);
        if (imgRes.ok) {
            const blob = await imgRes.blob();
            formData.append('avatar', blob, sourceChar.avatar);
        }
    } catch (_) { /* non-fatal — clone will get a default avatar */ }

    const headers = getRequestHeaders();
    delete headers['Content-Type'];

    const res = await fetch('/api/characters/create', {
        method: 'POST',
        headers,
        body:   formData,
    });
    if (!res.ok) throw new Error(`Character clone failed (HTTP ${res.status})`);
    return res.text(); // plain-text avatar filename, e.g. "CharName_.png"
}

// ─── Character Save ───────────────────────────────────────────────────────────

async function saveCharacter(char, newDescription, newScenario, newName = null) {
    const updated = structuredClone(char);
    updated.description = newDescription;
    updated.scenario    = newScenario;
    if (newName) updated.name = newName;

    const formData = buildCharacterFormData(updated);
    formData.append('json_data',   JSON.stringify(updated));
    formData.append('avatar_url',  updated.avatar);
    formData.append('chat',        updated.chat);
    formData.append('create_date', updated.create_date);

    const headers = getRequestHeaders();
    delete headers['Content-Type']; // browser must set multipart boundary

    const res = await fetch('/api/characters/edit', {
        method: 'POST',
        headers,
        body:   formData,
    });
    if (!res.ok) {
        throw new Error(`Character save failed (HTTP ${res.status})`);
    }
}

// ─── Chapter Name ─────────────────────────────────────────────────────────────

async function deriveChapterName(avatarUrl) {
    const res = await fetch('/api/chats/search', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ avatar_url: avatarUrl }),
    });
    if (!res.ok) {
        throw new Error(`Chat list fetch failed (HTTP ${res.status})`);
    }
    const chats = await res.json();
    const nums = chats
        .map(c => c.file_name?.match(/^ch(\d+)(?:\.jsonl)?$/i)?.[1])
        .filter(Boolean)
        .map(Number);
    const nextN = nums.length ? Math.max(...nums) + 1 : 1;
    return `ch${nextN}`;
}

// ─── Changelog ────────────────────────────────────────────────────────────────

function persistChangelog(chapterName) {
    if (!getSettings().storeChangelog) return;
    getSettings().changelog.push({
        date: new Date().toISOString(),
        chapterName,
    });
    saveSettingsDebounced();
}

// ─── Chat Header ──────────────────────────────────────────────────────────────

function buildChatHeader(chatMetadata) {
    const meta = structuredClone(chatMetadata ?? {});
    meta.lastInContextMessageId = 0;
    meta.integrity = crypto.randomUUID();
    meta.tainted   = false;
    return {
        chat_metadata:  meta,
        user_name:      'unused',
        character_name: 'unused',
    };
}

// ─── Message Slice / Blade ────────────────────────────────────────────────────

/**
 * Computes the Blade split point: the boundary between Archive (RAG) messages
 * and Continuity (carry) messages.
 *
 * Returns:
 *   carryMessages  — the slice of non-system messages to carry into the new chat.
 *   splitValidIdx  — index in the valid-filtered array where the carry window starts.
 *                    The message at this index is always an AI reply (walkback guarantee).
 *   splitPairIdx   — exclusive upper bound for _stagedProsePairs that belong to the
 *                    Archive: only pairs[0 .. splitPairIdx) are eligible for the RAG file.
 *
 * Accessing _stagedProsePairs is intentional — this function is module-internal
 * and _stagedProsePairs is already built before this is ever called.
 *
 * @param {object[]} messages     Source message array (may include system messages).
 * @param {number}   turnsToCarry
 * @returns {{ carryMessages: object[], splitValidIdx: number, splitPairIdx: number }}
 */
function computeSplitIndex(messages, turnsToCarry) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const isLastUnmatched = valid.length > 0 && valid[valid.length - 1].is_user;
    const base = isLastUnmatched ? valid.slice(0, -1) : valid;
    // Step 1: go back to the N-turns boundary
    let start = Math.max(0, base.length - turnsToCarry * 2);
    // Step 2: walk back until we land on an AI reply (Tone Persistence guarantee)
    while (start > 0 && base[start].is_user) start--;
    const splitValidIdx = start;
    // Step 3: map splitValidIdx → pair boundary.
    // A pair belongs to the Archive iff its AI slot (validIdx + 1) falls before the split.
    const lastArchivePairIdx = _stagedProsePairs.findLastIndex(p => p.validIdx + 1 < splitValidIdx);
    const splitPairIdx = lastArchivePairIdx + 1;   // exclusive upper bound
    return { carryMessages: base.slice(start), splitValidIdx, splitPairIdx };
}

/**
 * Returns messages starting from the last `turnsToCarry` turn boundary, then
 * walked back until an AI reply is the first message in the slice.
 * 1 turn = 1 user message + 1 AI response = 2 array elements.
 * If the chat ends on an unanswered user message, it is stripped first so
 * only complete pairs are carried.
 */
function buildLastN(messages, turnsToCarry) {
    return computeSplitIndex(messages, turnsToCarry).carryMessages;
}

// ─── Chat Save ────────────────────────────────────────────────────────────────

async function saveNewChat(char, chapterName, chatMetadata, lastN) {
    const header = buildChatHeader(chatMetadata);
    const res = await fetch('/api/chats/save', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({
            ch_name:    char.name,
            avatar_url: char.avatar,
            file_name:  chapterName,
            chat:       [header, ...lastN],
            force:      true,
        }),
    });
    if (!res.ok) {
        throw new Error(`Chat save failed (HTTP ${res.status})`);
    }
}

// ─── Lorebook API ─────────────────────────────────────────────────────────────

async function lbListLorebooks() {
    const res = await fetch('/api/worldinfo/list', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Lorebook list failed (HTTP ${res.status})`);
    return res.json(); // [{file_id, name, extensions}]
}

async function lbGetLorebook(name) {
    const res = await fetch('/api/worldinfo/get', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Lorebook fetch failed (HTTP ${res.status})`);
    return res.json(); // {entries: {}}
}

async function lbSaveLorebook(name, data) {
    const res = await fetch('/api/worldinfo/edit', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(`Lorebook save failed (HTTP ${res.status})`);
    // Notify ST's world info module so the editor refreshes without an app reload
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}

/**
 * Ensures a lorebook named `name` exists, then returns its data.
 * If the list call fails, treats it as empty and attempts creation anyway.
 */
async function lbEnsureLorebook(name) {
    let list;
    try {
        list = await lbListLorebooks();
    } catch (_) {
        list = []; // treat list failure as empty — proceed to create
    }
    const exists = list.some(item => item.name === name);
    if (!exists) {
        await lbSaveLorebook(name, { entries: {} });
    }
    return lbGetLorebook(name);
}

// ─── Lorebook Parser ──────────────────────────────────────────────────────────

/**
 * Parses the raw text (always sourced from the freeform textarea) into an
 * array of suggestion objects. Splits on **UPDATE:** / **NEW:** block headers.
 * Returns [] if the text contains only "NO CHANGES NEEDED" or no valid blocks.
 */
function parseLbSuggestions(rawText) {
    const suggestions = [];
    // Split on UPDATE/NEW headers, preserving the delimiter via lookahead
    const parts = rawText.split(/(?=\*\*(UPDATE|NEW):\s)/i);
    for (const part of parts) {
        const headerMatch = part.match(/^\*\*(UPDATE|NEW):\s*(.+?)(?:\s*\*{0,2})?\s*[\r\n]/i);
        if (!headerMatch) continue;
        const type = headerMatch[1].toUpperCase();
        const name = headerMatch[2].trim().replace(/\*+$/, '').trim();
        if (!name) continue;

        const rest = part.slice(headerMatch[0].length);

        // Keys line (first line starting with "Keys:")
        const keysMatch = rest.match(/^Keys:\s*(.+)$/im);
        const keys = keysMatch
            ? keysMatch[1].split(',').map(k => k.trim()).filter(Boolean)
            : [];

        // Content: everything between the Keys line and *Reason:, or end of block
        const afterKeys = keysMatch
            ? rest.slice(rest.indexOf(keysMatch[0]) + keysMatch[0].length)
            : rest;
        const reasonIdx = afterKeys.search(/^\*Reason:/im);
        const content = (reasonIdx !== -1
            ? afterKeys.slice(0, reasonIdx)
            : afterKeys
        ).trim();

        if (!content) continue;
        suggestions.push({ type, name, keys, content });
    }
    return suggestions;
}

/**
 * Searches _draftLorebook.entries for an entry whose comment matches `name`
 * case-insensitively. Returns the string uid key, or null if not found.
 */
function matchEntryByComment(name) {
    const lower = name.toLowerCase();
    for (const [uid, entry] of Object.entries(_draftLorebook?.entries ?? {})) {
        if ((entry.comment ?? '').toLowerCase() === lower) return uid;
    }
    return null;
}

/**
 * Returns the next available numeric uid for a new lorebook entry.
 */
function nextLorebookUid() {
    const keys = Object.keys(_draftLorebook?.entries ?? {}).map(Number).filter(n => !isNaN(n));
    return keys.length ? Math.max(...keys) + 1 : 0;
}

/**
 * Returns the count of entries in _draftLorebook that differ from _lorebookData
 * (content or keys changed, or entry is new). Used to populate the Step 4 summary.
 */
function countDraftChanges() {
    if (!_draftLorebook || !_lorebookData) return 0;
    const orig  = _lorebookData.entries  ?? {};
    const draft = _draftLorebook.entries ?? {};
    return Object.values(draft).filter(e => {
        const o = orig[String(e.uid)];
        return !o || o.content !== e.content || JSON.stringify(o.key) !== JSON.stringify(e.key);
    }).length;
}

// ─── Lorebook Virtual Document ────────────────────────────────────────────────

/**
 * Builds a "Virtual Document" string from a lorebook entry's three editable
 * fields. Keys are sorted alphabetically before rendering so that reordering
 * keys does not produce false diffs.
 * Pure function — no DOM or module dependencies.
 */
function toVirtualDoc(name, keys, content) {
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    const keyLines   = sortedKeys.length ? sortedKeys.map(k => `KEY: ${k}`).join('\n') : 'KEY: (none)';
    return `NAME: ${name}\n${keyLines}\n\n${content}`;
}

/**
 * Builds a complete ST worldinfo entry object for a new lorebook entry.
 * Only the "Big Three" (name→comment, keys→key, content) are set from
 * arguments; all structural/config fields use ST defaults.
 * Pure function — no DOM or module dependencies.
 */
function makeLbDraftEntry(uid, name, keys, content) {
    return {
        uid,
        key:                       keys,
        keysecondary:              [],
        comment:                   name,
        content,
        constant:                  false,
        vectorized:                false,
        selective:                 true,
        selectiveLogic:            0,
        addMemo:                   true,
        order:                     100,
        position:                  0,
        disable:                   false,
        ignoreBudget:              false,
        excludeRecursion:          false,
        preventRecursion:          false,
        matchPersonaDescription:   false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario:             false,
        matchCreatorNotes:         false,
        delayUntilRecursion:       0,
        probability:               100,
        useProbability:            true,
        depth:                     4,
        outletName:                '',
        group:                     '',
        groupOverride:             false,
        groupWeight:               100,
        scanDepth:                 null,
        caseSensitive:             null,
        matchWholeWords:           null,
        useGroupScoring:           null,
        automationId:              '',
        role:                      0,
        sticky:                    null,
        cooldown:                  null,
        delay:                     null,
        triggers:                  [],
        displayIndex:              uid,
    };
}

// ─── Lorebook Enrichment & Reconciliation ─────────────────────────────────────

/**
 * Reconciles a freshly-parsed suggestion list against the existing
 * _lorebookSuggestions array, preserving UID anchors, applied/rejected flags,
 * and AI snapshots across freeform text changes (e.g. regen or manual edits).
 *
 * Matching is done by _aiSnapshot.name so that user-renamed suggestions
 * (where the live name differs from the original AI name) still match
 * correctly after a regen that produces the original AI name again.
 *
 * Snapshot update policy:
 *   - Not applied: update snapshot to new AI content (regen produced new text).
 *   - Applied: keep old snapshot (preserves what was actually applied).
 *
 * After matching, a collision guard ensures no two suggestions share the same
 * linkedUid (the second is demoted to null, treated as a NEW entry).
 */
function enrichLbSuggestions(freshParsed) {
    const enriched = freshParsed.map(fresh => {
        // Match by the original AI name (snapshot), not the live (possibly user-edited) name.
        const existing = _lorebookSuggestions.find(
            s => s._aiSnapshot.name.toLowerCase() === fresh.name.toLowerCase(),
        );

        if (existing) {
            if (existing._applied) {
                // Preserve live values and snapshot — user already committed this suggestion.
                return {
                    type:        fresh.type,
                    name:        existing.name,
                    keys:        [...existing.keys],
                    content:     existing.content,
                    linkedUid:   existing.linkedUid,
                    _applied:    true,
                    _rejected:   false,
                    _aiSnapshot: {
                        name:    existing._aiSnapshot.name,
                        keys:    [...existing._aiSnapshot.keys],
                        content: existing._aiSnapshot.content,
                    },
                };
            } else {
                // Not yet applied: use fresh AI content, update snapshot, preserve UID anchor and rejection.
                return {
                    type:        fresh.type,
                    name:        fresh.name,
                    keys:        [...fresh.keys],
                    content:     fresh.content,
                    linkedUid:   existing.linkedUid,
                    _applied:    false,
                    _rejected:   existing._rejected,
                    _aiSnapshot: {
                        name:    fresh.name,
                        keys:    [...fresh.keys],
                        content: fresh.content,
                    },
                };
            }
        } else {
            // No existing match — fresh enrichment: look up UID in the draft.
            const uidStr    = matchEntryByComment(fresh.name);
            const linkedUid = uidStr !== null ? parseInt(uidStr, 10) : null;
            return {
                type:        fresh.type,
                name:        fresh.name,
                keys:        [...fresh.keys],
                content:     fresh.content,
                linkedUid,
                _applied:    false,
                _rejected:   false,
                _aiSnapshot: {
                    name:    fresh.name,
                    keys:    [...fresh.keys],
                    content: fresh.content,
                },
            };
        }
    });

    // Collision guard: if two suggestions resolved to the same UID, demote the second to null.
    const seenUids = new Set();
    for (const s of enriched) {
        if (s.linkedUid === null) continue;
        if (seenUids.has(s.linkedUid)) {
            console.warn(`[Chapterize] Two lorebook suggestions resolved to uid ${s.linkedUid}; treating second as NEW.`);
            s.linkedUid = null;
        } else {
            seenUids.add(s.linkedUid);
        }
    }

    return enriched;
}

/**
 * @section Character Description Parser
 * @architectural-role Domain Logic / Parser
 * @description Normalizes raw bio text into addressable sections and maps AI snippets. 
 *              Returns true if the line consists entirely of decorator characters
 *              (-, *, ━, spaces) and is non-empty — i.e. a horizontal rule or separator line.
 * @core-principles
 *   1. Must remain synchronous and deterministic.
 *   2. Must not interact with the DOM or global session state.
 * @api-declaration parseDescriptionSections, applyDescriptionSection
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: none
 */

function isDecoratorLine(line) {
    return line.trim().length > 0 && /^[\s\-*━]+$/.test(line);
}

/**
 * Strips leading/trailing decorator and punctuation characters from a line to
 * expose the core header text. Handles patterns like:
 *   **Appearance**, ━━━ Appearance ━━━, Appearance:, --- Appearance ---
 * Pure function — no DOM or module dependencies.
 */
function stripHeaderDecorators(line) {
    return line
        .replace(/^[\s*\-_#━]+/, '')    // leading decorator chars
        .replace(/[\s*\-_#━:]+$/, '')   // trailing decorator/punctuation
        .trim();
}

/**
 * Returns true if the line should be treated as a section header.
 * After stripping decorator characters, the remaining text must be 1–3 words.
 * Decorator-only lines (empty after stripping) are excluded.
 * Pure function — no DOM or module dependencies.
 */
function isHeaderLine(line) {
    if (isDecoratorLine(line)) return false;
    const core = stripHeaderDecorators(line);
    if (!core) return false;
    const wordCount = core.split(/\s+/).filter(Boolean).length;
    return wordCount >= 1 && wordCount <= 3;
}

/**
 * Parses a character description string into an ordered list of sections.
 * Each entry: { header, index, headerLine, startLine, endLine }
 *   header     — normalised header text (e.g. "Appearance")
 *   index      — 1-based occurrence index for duplicate headers
 *   headerLine — line index of the header line itself
 *   startLine  — first line of section content (after header + optional decorator)
 *   endLine    — last line of section content (inclusive, before next header)
 * Pure function — no DOM or module dependencies.
 */
function parseDescriptionSections(text) {
    const lines = text.split('\n');
    const rawHeaders = [];
    let dividerLineIdx = -1;

    // 1. Scan for headers AND the divider simultaneously
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Use a trimmed version of SITUATION_SEP for matching 
        // to avoid newline detection issues
        if (line.includes('*** Chapterize Divider — Do Not Edit ***')) {
            dividerLineIdx = i;
            break; // Stop looking for bio sections once we hit the divider
        }

        if (isHeaderLine(line)) {
            rawHeaders.push({ lineIdx: i, header: stripHeaderDecorators(line) });
        }
    }

    const seenCounts = {};
    const sections   = [];

    for (let i = 0; i < rawHeaders.length; i++) {
        const { lineIdx, header } = rawHeaders[i];
        seenCounts[header] = (seenCounts[header] || 0) + 1;
        const index = seenCounts[header];

        let startLine = lineIdx + 1;

        // 2. Determine the hard boundary for this section
        // It ends at the next header OR the divider, whichever comes first
        const nextHeaderIdx = i + 1 < rawHeaders.length ? rawHeaders[i + 1].lineIdx : lines.length;
        
        let boundaryIdx = nextHeaderIdx;
        if (dividerLineIdx !== -1 && dividerLineIdx < boundaryIdx) {
            boundaryIdx = dividerLineIdx;
        }

        let endLine = boundaryIdx - 1;

        // 3. Trim leading/trailing blank lines within the section
        // This makes the diffs much cleaner and prevents "empty" matches
        while (startLine <= endLine && lines[startLine].trim() === '') {
            startLine++;
        }
        while (endLine >= startLine && lines[endLine].trim() === '') {
            endLine--;
        }

        // Handle completely empty sections (header with no text)
        if (startLine > endLine) {
            endLine = startLine - 1; 
        }

        sections.push({ header, index, headerLine: lineIdx, startLine, endLine });
    }

    return sections;
}

/**
 * Replaces the content lines of a section in a description string.
 * startLine/endLine are the content range from parseDescriptionSections.
 * Returns the modified string.
 * Pure function — no DOM or module dependencies.
 */
function applyDescriptionSection(text, startLine, endLine, newContent) {
    const lines = text.split('\n');
    return [
        ...lines.slice(0, startLine),
        ...newContent.split('\n'),
        ...lines.slice(endLine + 1),
    ].join('\n');
}

// ─── RAG Workshop UI (Step 4) ─────────────────────────────────────────────────

/**
 * @section Narrative Memory (RAG) Workshop
 * @architectural-role Component Workshop Logic
 * @description 
 * Manages the transformation of the session transcript into a structured RAG 
 * document. Orchestrates a pipeline of semantic classification calls that 
 * transform dialogue chunks into descriptive headers. Implements a "detached" 
 * architecture where users can switch between a sectioned view (AI-driven) 
 * and a raw text view (manual override).
 * @core-principles
 *   1. CONCURRENCY: Must throttle AI calls via a queue to avoid provider rate limits.
 *   2. STALENESS: Must detect if the Situation Summary (used as context) changes 
 *      while classification calls are in-flight.
 *   3. PRESERVATION: Manual edits to the raw document must "detach" the workshop, 
 *      preventing AI results from overwriting user changes.
 * @api-declaration
 *   UI: buildRagCardHTML, renderRagWorkshop, renderRagCard, onRagTabSwitch.
 *   State: onRagRawInput, onRagRevertRaw, ragFireChunk, ragDrainQueue.
 * @contract
 *   assertions:
 *     purity: impure (DOM & State mutation)
 *     state_ownership: [_ragChunks, _ragRawDetached, _lastSummaryUsedForRag, 
 *       _ragInFlightCount, _ragCallQueue, _ragGlobalGenId]
 *     external_io: [generateWithRagProfile]
 */
function buildRagCardHTML(chunk) {
    const i          = chunk.chunkIndex;
    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    const queuePos   = _ragCallQueue.indexOf(i);
    const queueText  = queuePos >= 0 ? `queued ${queuePos + 1}` : 'pending';
    return `
<div class="chz-rag-card" data-chunk-index="${i}" data-status="${chunk.status}">
  <div class="chz-rag-card-header-row">
    <textarea class="chz-input chz-rag-card-header"
              data-chunk-index="${i}"
              ${isInFlight || _ragRawDetached ? 'disabled' : ''}>${escapeHtml(chunk.header)}</textarea>
    <span class="chz-rag-card-spinner fa-solid fa-spinner fa-spin${isInFlight ? '' : ' chz-hidden'}"></span>
    <span class="chz-rag-queue-label${isPending ? '' : ' chz-hidden'}">${queueText}</span>
    <button class="chz-btn chz-btn-secondary chz-btn-sm chz-rag-card-regen"
            data-chunk-index="${i}"
            title="Regenerate this chunk's semantic header"
            ${_ragRawDetached ? 'disabled' : ''}>&#x21bb;</button>
  </div>
  <div class="chz-rag-card-body">${escapeHtml(chunk.content)}</div>
</div>`;
}

/**
 * Renders all chunk cards into #chz-rag-cards. Called once on workshop entry
 * (or whenever _ragChunks is rebuilt). Use renderRagCard for incremental updates.
 */
function autoResizeRagCardHeader(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function renderRagWorkshop() {
    const $cards = $('#chz-rag-cards').empty();
    for (const chunk of _ragChunks) {
        $cards.append(buildRagCardHTML(chunk));
    }
    $cards.find('.chz-rag-card-header').each(function () { autoResizeRagCardHeader(this); });
}

/**
 * Updates the dynamic parts of a single card in place (status badge, spinner,
 * queue label, header input value) without rebuilding the whole list.
 * @param {number} chunkIndex
 */
function renderRagCard(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;
    const $card = $(`.chz-rag-card[data-chunk-index="${chunkIndex}"]`);
    if (!$card.length) return;

    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    const queuePos   = _ragCallQueue.indexOf(chunkIndex);
    const queueText  = queuePos >= 0 ? `queued ${queuePos + 1}` : 'pending';
    const disabled   = isInFlight || _ragRawDetached;

    $card.attr('data-status', chunk.status);
    const $header = $card.find('.chz-rag-card-header')
        .val(chunk.header)
        .prop('disabled', disabled);
    autoResizeRagCardHeader($header[0]);
    $card.find('.chz-rag-card-spinner').toggleClass('chz-hidden', !isInFlight);
    $card.find('.chz-rag-queue-label').toggleClass('chz-hidden', !isPending).text(queueText);
    $card.find('.chz-rag-card-regen').prop('disabled', _ragRawDetached);
}

/**
 * Handles tab switches within the Step 4 RAG Workshop.
 * Switching to 'raw' compiles from section state (unless already detached).
 * @param {string} tabName  'sectioned' | 'raw'
 */
function onRagTabSwitch(tabName) {
    $('#chz-rag-tab-bar .chz-tab-btn').each(function () {
        $(this).toggleClass('chz-tab-active', $(this).data('tab') === tabName);
    });
    $('#chz-rag-tab-sectioned').toggleClass('chz-hidden', tabName !== 'sectioned');
    $('#chz-rag-tab-raw').toggleClass('chz-hidden', tabName !== 'raw');

    if (tabName === 'raw' && !_ragRawDetached) {
        $('#chz-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }
}

/**
 * Fires when the user types in the Combined Raw textarea.
 * Marks the raw view as detached and locks the sectioned view.
 */
function onRagRawInput() {
    autoResizeRagRaw();
    if (!_ragRawDetached) {
        _ragRawDetached = true;
        $('#chz-rag-raw').addClass('chz-rag-detached');
        $('#chz-rag-raw-detached-label').removeClass('chz-hidden');
        // Show detached warning in sectioned tab
        $('#chz-rag-detached-warn').removeClass('chz-hidden');
        $('#chz-rag-detached-revert').removeClass('chz-hidden');
        // Disable all card header inputs and regen buttons
        $('.chz-rag-card-header, .chz-rag-card-regen').prop('disabled', true);
    }
}

/**
 * Recompiles the Raw textarea from current section state and clears detached mode.
 */
function onRagRevertRaw() {
    _ragRawDetached = false;
    $('#chz-rag-raw').val(compileRagFromChunks()).removeClass('chz-rag-detached');
    autoResizeRagRaw();
    $('#chz-rag-raw-detached-label').addClass('chz-hidden');
    $('#chz-rag-detached-warn').addClass('chz-hidden');
    $('#chz-rag-detached-revert').addClass('chz-hidden');
    // Re-enable card controls
    renderRagWorkshop();
}

/**
 * Shows the "missing summary" message and hides the tab bar and cards.
 */
function showRagNoSummaryMessage() {
    $('#chz-rag-no-summary').removeClass('chz-hidden');
    $('#chz-rag-tab-bar, #chz-rag-tab-sectioned, #chz-rag-tab-raw').addClass('chz-hidden');
    $('#chz-rag-detached-warn, #chz-rag-detached-revert').addClass('chz-hidden');
}

/**
 * Hides the "missing summary" message and restores the tab bar.
 */
function hideRagNoSummaryMessage() {
    $('#chz-rag-no-summary').addClass('chz-hidden');
    $('#chz-rag-tab-bar').removeClass('chz-hidden');
    // Re-show the active tab panel
    const activeTab = $('#chz-rag-tab-bar .chz-tab-active').data('tab') ?? 'sectioned';
    $('#chz-rag-tab-sectioned').toggleClass('chz-hidden', activeTab !== 'sectioned');
    $('#chz-rag-tab-raw').toggleClass('chz-hidden', activeTab !== 'raw');
}

// ─── Modal UI ─────────────────────────────────────────────────────────────────

function injectModal() {
    if ($('#chz-overlay').length) return;
    $('body').append(buildModalHTML(MIN_TURNS, MAX_TURNS, DEFAULT_TURNS_N));
    $('body').append(`
        <div id="chz-autotrigger-banner" class="chz-autotrigger-banner chz-hidden">
          <i class="fa-solid fa-forward-step"></i>
          <span id="chz-autotrigger-msg" data-i18n="chapterize.autotrigger_msg">0 turns ready to chapterize</span>
          <button id="chz-autotrigger-open" data-i18n="chapterize.autotrigger_open">Open Wizard</button>
          <button id="chz-autotrigger-dismiss" data-i18n="[title]chapterize.autotrigger_dismiss_title" title="Dismiss">✕</button>
        </div>`);

    // Step 1 — Character Workshop
    $('#chz-regen-suggestions').on('click', onRegenSuggestionsClick);
    $('#chz-revert-bio').on('click',        onRevertBioClick);
    $('#chz-ingester-select').on('change',      onIngesterSectionChange);
    $('#chz-ingester-editor').on('input',       onIngesterEditorInput);
    $('#chz-ingester-next').on('click',         onIngesterNextClick);
    $('#chz-ingester-revert').on('click',       onIngesterRevertClick);
    $('#chz-ingester-revert-bio').on('click',   onIngesterRevertBioClick);
    $('#chz-ingester-reject').on('click',       onIngesterRejectClick);
    $('#chz-ingester-apply').on('click',        onIngesterApplyClick);
    // Workshop tab switching — scoped to #chz-workshop-tab-bar to avoid matching lorebook tabs
    $('#chz-modal').on('click', '#chz-workshop-tab-bar .chz-tab-btn', function () {
        onWorkshopTabSwitch($(this).data('tab'));
    });

    // Step 2 — Situation Workshop
    $('#chz-regen-situation').on('click', onRegenSituationClick);

    // Step 3 — Lorebook Workshop
    $('#lbchz-regen').on('click',                 onLbRegenClick);
    $('#lbchz-suggestion-select').on('change',    onLbSuggestionSelectChange);
    $('#lbchz-editor-name').on('input',           onLbIngesterEditorInput);
    $('#lbchz-editor-keys').on('input',           onLbIngesterEditorInput);
    $('#lbchz-editor-content').on('input',        onLbIngesterEditorInput);
    $('#lbchz-ingester-next').on('click',         onLbIngesterNext);
    $('#lbchz-revert-ai').on('click',             onLbIngesterRevertAi);
    $('#lbchz-revert-draft').on('click',          onLbIngesterRevertDraft);
    $('#lbchz-reject-one').on('click',            onLbIngesterReject);
    $('#lbchz-apply-one').on('click',             onLbIngesterApply);
    $('#lbchz-apply-all-unresolved').on('click',  onLbApplyAllUnresolved);
    // Lorebook tab switching — scoped to #lbchz-tab-bar
    $('#chz-modal').on('click', '#lbchz-tab-bar .chz-tab-btn', function () {
        onLbTabSwitch($(this).data('tab'));
    });

    // Step 4 — Narrative Memory Workshop
    $('#chz-modal').on('click', '#chz-rag-tab-bar .chz-tab-btn', function () {
        onRagTabSwitch($(this).data('tab'));
    });
    $('#chz-modal').on('input', '.chz-rag-card-header', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        autoResizeRagCardHeader(this);
        if (!isNaN(idx) && _ragChunks[idx]) {
            _ragChunks[idx].header = $(this).val();
            _ragChunks[idx].status = 'manual';
            $(`.chz-rag-card[data-chunk-index="${idx}"]`).attr('data-status', 'manual');
        }
    });
    $('#chz-modal').on('click', '.chz-rag-card-regen', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        if (!isNaN(idx)) ragRegenCard(idx);
    });
    $('#chz-rag-raw').on('input', onRagRawInput);
    $('#chz-rag-revert-raw-btn').on('click', onRagRevertRaw);

    // Shared wizard footer
    $('#chz-cancel').on('click',    closeModal);
    $('#chz-move-back').on('click', () => updateWizard(_currentStep - 1));
    $('#chz-move-next').on('click', () => updateWizard(_currentStep + 1));
    $('#chz-confirm').on('click',   onConfirmClick);

    // Auto-trigger banner buttons
    $('#chz-autotrigger-open').on('click', () => {
        hideAutoTriggerBanner();
        onChapterizeClick();
    });
    $('#chz-autotrigger-dismiss').on('click', () => {
        const context     = SillyTavern.getContext();
        const len         = context?.chat?.length ?? 0;
        const snoozeTurns = getSettings().autoTriggerSnoozeTurns ?? 5;
        hideAutoTriggerBanner();
        _autoTriggerSuppressUntil = snoozeTurns > 0 ? len + snoozeTurns : Infinity;
    });
}

function showModal() {
    $('#chz-overlay').removeClass('chz-hidden');
}

function closeModal() {
    $('#chz-overlay').addClass('chz-hidden');
    // Increment all genIds to drop any in-flight AI callbacks
    _suggestionsGenId++;
    _situationGenId++;
    _lorebookGenId++;
    _ragGlobalGenId++;         // kills all in-flight RAG classifier results
    // Reset all session draft state
    _transcript              = '';
    _originalDescription     = '';
    _priorSituation          = '';
    _baseScenario            = '';
    _stagedProsePairs        = [];
    _cardSuggestions         = [];
    _ingesterSnapshot        = '';
    clearTimeout(_ingesterDebounceTimer);
    _ingesterDebounceTimer   = null;
    _activeIngesterIndex     = 0;
    _chapterName             = '';
    _cloneAvatarUrl          = '';
    _isRepairMode            = false;
    _lastRagUrl              = '';
    _sourceChatId            = '';
    _repairSourceMessages    = [];
    _suggestionsLoading      = false;
    _situationLoading        = false;
    _isChapterMode           = false;
    _nextChNum               = 1;
    _cloneName               = '';
    _finalizeSteps.cardSaved     = false;
    _finalizeSteps.ragSaved      = false;
    _finalizeSteps.lorebookSaved = false;
    _finalizeSteps.chatSaved     = false;
    _lorebookName    = '';
    _lorebookData    = null;
    _draftLorebook   = null;
    _lorebookLoading = false;
    _lorebookSuggestions        = [];
    _lbActiveIngesterIndex      = 0;
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer            = null;
    _lorebookFreeformLastParsed = null;
    _currentStep     = 1;
    _lorebookRawText  = '';
    _lorebookRawError = '';
    // RAG Workshop state
    _ragChunks             = [];
    _ragRawDetached        = false;
    _lastSummaryUsedForRag = null;
    _ragInFlightCount      = 0;
    _ragCallQueue          = [];
    // Ledger state — always cleared on modal close
    _ledgerManifest  = null;
    _sessionStartId  = null;
    _lorebookDelta   = null;
}

/**
 * @section Wizard Orchestration
 * @architectural-role State Controller
 * @description 
 * Manages the high-level wizard lifecycle, including session initialization, 
 * step-to-step navigation, and UI state synchronization. Acts as the 
 * "traffic controller" that triggers workshop-specific entry/exit logic.
 * @core-principles
 *   1. IDEMPOTENCY: Opening the wizard must reset all transient state but 
 *      preserve settings-based defaults.
 *   2. CLEANUP: Must ensure all background timers and pending AI genIds 
 *      are invalidated when the wizard closes.
 * @api-declaration
 *   initWizardSession, updateWizard, onEnterRagWorkshop, onLeaveRagWorkshop.
 * @contract
 *   assertions:
 *     purity: impure
 *     state_ownership: [_currentStep, _finalizeSteps, _suggestionsGenId, 
 *       _situationGenId, _lorebookGenId, _ragGlobalGenId]
 */
function initWizardSession() {
    _cardSuggestions     = [];
    _activeIngesterIndex = 0;
    _chapterName         = '';
    _cloneAvatarUrl      = '';

    const titleText = _isChapterMode ? `Update to ${_cloneName}` : `Create ${_cloneName}`;
    $('#chz-step1-title').text(titleText);
    $('#lbchz-title').text(`Lorebook: ${_lorebookName}`);

    // #chz-card-text is the authoritative draft bio; written here only — never reset by updateWizard
    $('#chz-card-text').val(_originalDescription);
    $('#chz-turns').val(getSettings().turnsN);

    $('#chz-pending-warning').addClass('chz-hidden');
    $('#chz-suggestions-raw').val('');
    $('#chz-raw-error').addClass('chz-hidden').text('');
    $('#chz-error-2').addClass('chz-hidden').text('');
    $('#chz-error-5').addClass('chz-hidden').text('');
    $('#chz-receipts').addClass('chz-hidden');
    $('#chz-receipts-content').empty();
    $('#chz-recovery-guide').addClass('chz-hidden');
    $('#chz-cancel').text('Cancel').prop('disabled', false);
    // RAG Workshop reset
    $('#chz-rag-cards').empty();
    $('#chz-rag-no-summary, #chz-rag-disabled').addClass('chz-hidden');
    $('#chz-rag-detached-warn, #chz-rag-detached-revert').addClass('chz-hidden');
    $('#chz-rag-raw').val('').removeClass('chz-rag-detached');
    $('#chz-rag-raw-detached-label').addClass('chz-hidden');
    // Reset RAG tab to Sectioned
    $('#chz-rag-tab-bar .chz-tab-btn').each(function () {
        $(this).toggleClass('chz-tab-active', $(this).data('tab') === 'sectioned');
    });
    $('#chz-rag-tab-sectioned').removeClass('chz-hidden');
    $('#chz-rag-tab-raw').addClass('chz-hidden');

    _lorebookSuggestions        = [];
    _lbActiveIngesterIndex      = 0;
    _lorebookFreeformLastParsed = null;
    _lorebookRawText  = '';
    _lorebookRawError = '';

    // Blade reset — recalculated on each entry to Step 4
    _splitPairIdx           = 0;
    _splitIndexWhenRagBuilt = null;

    onWorkshopTabSwitch('ingester');
    setSuggestionsLoading(true);
    setSituationLoading(true);
    setLbLoading(true);
}

/**
 * Shows the given wizard step (1–5), hides all others, and updates footer
 * button visibility. Triggers workshop/summary population on step entry.
 */
function updateWizard(n) {
    // Leaving Step 4 backward — flush the pending queue
    if (_currentStep === 4 && n < 4) {
        onLeaveRagWorkshop();
    }
    _currentStep = n;
    for (let i = 1; i <= 5; i++) {
        $(`#chz-step-${i}`).toggleClass('chz-hidden', i !== n);
    }
    $('#chz-move-back').toggleClass('chz-hidden', n === 1);
    $('#chz-move-next').toggleClass('chz-hidden', n === 5);
    $('#chz-confirm').toggleClass('chz-hidden',   n !== 5);
    if (n === 4) onEnterRagWorkshop();
    if (n === 5) populateStep5Summary();
}

/**
 * Called whenever the user enters Step 4 (Narrative Memory Workshop).
 * Builds chunk state on first entry, detects stale summaries on re-entry,
 * fires pending/stale classification calls.
 */
function onEnterRagWorkshop() {
    if (!getSettings().enableRag) {
        $('#chz-rag-disabled').removeClass('chz-hidden');
        $('#chz-rag-no-summary, #chz-rag-tab-bar, #chz-rag-tab-sectioned, #chz-rag-tab-raw').addClass('chz-hidden');
        $('#chz-rag-detached-warn, #chz-rag-detached-revert').addClass('chz-hidden');
        return;
    }
    $('#chz-rag-disabled').addClass('chz-hidden');

    const summaryText = $('#chz-situation-text').val().trim();
    const hasError    = !$('#chz-error-2').hasClass('chz-hidden');

    // ── Blade: compute the split from the current slider value ────────────────
    const rawTurnsRag  = parseInt($('#chz-turns').val(), 10);
    const turnsRag     = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurnsRag) ? DEFAULT_TURNS_N : rawTurnsRag));
    const sourceRag    = _isRepairMode ? _repairSourceMessages : (SillyTavern.getContext().chat ?? []);
    const { splitPairIdx: newSplitPairIdx } = computeSplitIndex(sourceRag, turnsRag);
    _splitPairIdx = newSplitPairIdx;

    // Discard existing chunks if the carry window has shifted since they were built
    if (_ragChunks.length > 0 && _splitPairIdx !== _splitIndexWhenRagBuilt) {
        toastr.warning('Carry window has changed — Narrative Memory chunks will be rebuilt.');
        _ragChunks = [];
        _splitIndexWhenRagBuilt = null;
    }

    // Build chunks from archive pairs only (Blade enforcement)
    const archivePairs = _stagedProsePairs.slice(0, _splitPairIdx);
    if (_ragChunks.length === 0 && archivePairs.length > 0) {
        _ragChunks = buildRagChunks(archivePairs);
        _splitIndexWhenRagBuilt = _splitPairIdx;
        renderRagWorkshop();
    } else if (_ragChunks.length > 0) {
        // Refresh card render in case detached state changed or queue positions shifted
        renderRagWorkshop();
    }

    // Simple mode — fallback labels only, no AI calls needed
    if (!getSettings().ragAiMode) {
        hideRagNoSummaryMessage();
        return;
    }

    if (!summaryText || hasError) {
        showRagNoSummaryMessage();
        return;
    }
    hideRagNoSummaryMessage();
    
    // we must ensure it's populated and sized correctly.
    const activeTab = $('#chz-rag-tab-bar .chz-tab-active').data('tab') ?? 'sectioned';
    if (activeTab === 'raw' && !_ragRawDetached) {
        $('#chz-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }

    // Detect summary change since last batch of calls
    const summaryChanged = _lastSummaryUsedForRag !== null && _lastSummaryUsedForRag !== summaryText;
    if (summaryChanged) {
        toastr.warning('Situation Summary has changed — stale headers will be refreshed.');
        for (const chunk of _ragChunks) {
            if (chunk.status === 'complete') chunk.status = 'stale';
        }
    }
    _lastSummaryUsedForRag = summaryText;

    // Enqueue all pending and stale chunks (manual and complete remain untouched)
    _ragCallQueue = [];
    for (let i = 0; i < _ragChunks.length; i++) {
        const s = _ragChunks[i].status;
        if (s === 'pending' || s === 'stale') _ragCallQueue.push(i);
    }
    console.log(`[CHZ-DBG] onEnterRagWorkshop enqueued=${JSON.stringify(_ragCallQueue)} totalChunks=${_ragChunks.length} inFlight=${_ragInFlightCount} globalGenId=${_ragGlobalGenId} summaryChanged=${summaryChanged}`);
    ragDrainQueue();
}

/**
 * Called when the user navigates backward from Step 4.
 * Flushes the pending queue; in-flight calls complete but results are
 * discarded or marked stale depending on summary state at completion time.
 */
function onLeaveRagWorkshop() {
    _ragCallQueue = [];
}

/**
 * Populates the Step 5 (Review & Commit) summary rows from current wizard state.
 * Called each time the user enters Step 5 so it reflects any Back edits.
 */
function populateStep5Summary() {
    const rawTurns     = parseInt($('#chz-turns').val(), 10);
    const turnsToCarry = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurns) ? DEFAULT_TURNS_N : rawTurns));
    // In repair mode use the fetched source messages; otherwise use the live chat.
    const sourceForLastN = _isRepairMode ? _repairSourceMessages : (SillyTavern.getContext().chat ?? []);
    const lastN          = buildLastN(sourceForLastN, turnsToCarry);
    const loreCount      = countDraftChanges();
    const mode           = _isRepairMode ? 'repair' : _isChapterMode ? 'edit-in-place' : 'clone';
    const loreLabel      = loreCount === 1 ? '1 entry' : `${loreCount} entries`;
    const pendingLb      = _lorebookSuggestions.filter(s => !s._applied && !s._rejected).length;
    const pendingText    = pendingLb > 0
        ? ` \u26a0 ${pendingLb} suggestion${pendingLb !== 1 ? 's' : ''} pending review`
        : '';
    $('#chz-step5-target').text(`Target: ${_cloneName} (${mode})`);
    $('#chz-step5-context').text(`Context: ${lastN.length} messages being carried (${turnsToCarry} turns)`);
    $('#chz-step5-lore').text(`Lore: ${loreLabel} staged for update/creation${pendingText}`);
    // Show destructive-action warning in repair mode
    $('#chz-repair-warning').toggleClass('chz-hidden', !_isRepairMode);
    populateRagPanel();
}

/**
 * @section Character Workshop UI
 * @architectural-role UI Orchestration
 * @description Manages the tabbed Drafting/Ingester interface for character bios.
 * @core-principles
 *   1. The Draft Bio textarea is the authoritative source of truth.
 *   2. The Ingester re-parses AI Raw on every tab-switch unless generation is in progress.
 * @api-declaration onWorkshopTabSwitch, reparseSuggestions, populateIngesterDropdown,
 *   wordDiff, renderIngesterDetail, onIngesterEditorInput, onIngesterRevertClick,
 *   onIngesterRevertBioClick, onIngesterNextClick
 * @contract
 *   assertions:
 *     purity: impure (DOM)
 *     state_ownership: [_cardSuggestions, _ingesterSnapshot, _ingesterDebounceTimer,
 *       _activeIngesterIndex]
 *     external_io: none
 */

function onWorkshopTabSwitch(tabName) {
    $('#chz-workshop-tab-bar .chz-tab-btn').each(function () {
        $(this).toggleClass('chz-tab-active', $(this).data('tab') === tabName);
    });
    $('#chz-tab-bio').toggleClass('chz-hidden',      tabName !== 'bio');
    $('#chz-tab-raw').toggleClass('chz-hidden',      tabName !== 'raw');
    $('#chz-tab-ingester').toggleClass('chz-hidden', tabName !== 'ingester');

    // Re-parse AI Raw whenever switching to the Ingester tab (skip during generation
    // so an empty textarea does not clobber the in-flight _cardSuggestions array).
    // Guard: if the suggestion count changes after a reparse, reset to index 0 so
    // _activeIngesterIndex never points at a stale or out-of-bounds entry.
    if (tabName === 'ingester') {
        if (!_suggestionsLoading) {
            const prevCount = _cardSuggestions.length;
            reparseSuggestions();
            if (_cardSuggestions.length !== prevCount) _activeIngesterIndex = 0;
        }
        // Clamp in case the list shrank without a count change (e.g. partial re-parse)
        _activeIngesterIndex = Math.max(0, Math.min(_activeIngesterIndex, _cardSuggestions.length - 1));
        populateIngesterDropdown(); // sets select value to _activeIngesterIndex
        if (_cardSuggestions[_activeIngesterIndex]) {
            renderIngesterDetail(_cardSuggestions[_activeIngesterIndex]);
        }
    }
}

/**
 * Re-parses the current AI Raw textarea and updates _cardSuggestions.
 * Carries forward _applied flags where header, occurrence, and content match
 * (using trimEnd() so blank separator lines do not clear applied state).
 * Emits a toastr warning listing any applied sections whose content changed.
 */
function reparseSuggestions() {
    const text  = $('#chz-suggestions-raw').val();
    const lines = text.split('\n');
    const sections = parseDescriptionSections(text);

    const newSuggestions = sections.map(s => ({
        header:   s.header,
        content:  lines.slice(s.startLine, s.endLine + 1).join('\n'),
        _applied: false,
    }));

    const changedHeaders = [];

    // Pass 1: carry forward _applied by header + nth occurrence.
    // trimEnd() so added blank separator lines don't clear applied state.
    const newHeaderSeen = {};
    for (const newS of newSuggestions) {
        const key = newS.header.toLowerCase();
        newHeaderSeen[key] = (newHeaderSeen[key] || 0) + 1;
        const occurrence = newHeaderSeen[key];

        let oldOccurrenceCount = 0;
        const oldMatch = _cardSuggestions.find(oldS => {
            if (oldS.header.toLowerCase() === key) {
                oldOccurrenceCount++;
                return oldOccurrenceCount === occurrence;
            }
            return false;
        });

        if (oldMatch && (oldMatch._applied || oldMatch._rejected)) {
            if (oldMatch.content.trimEnd() === newS.content.trimEnd()) {
                newS._applied = oldMatch._applied;
                newS._rejected = oldMatch._rejected;
            } else if (oldMatch._applied) {
                // Only warn if they applied it and it changed. Ignored rejections don't matter.
                changedHeaders.push(newS.header);
            }
        }
    }

    // Pass 2: warn about applied entries that were deleted entirely from the new parse.
    const oldHeaderSeen = {};
    for (const oldS of _cardSuggestions) {
        if (!oldS._applied) continue;
        const key = oldS.header.toLowerCase();
        oldHeaderSeen[key] = (oldHeaderSeen[key] || 0) + 1;
        const occurrence = oldHeaderSeen[key];

        let newOccurrenceCount = 0;
        const stillPresent = newSuggestions.some(newS => {
            if (newS.header.toLowerCase() === key) {
                newOccurrenceCount++;
                return newOccurrenceCount === occurrence;
            }
            return false;
        });

        if (!stillPresent) {
            changedHeaders.push(oldS.header);
        }
    }

    if (changedHeaders.length > 0) {
        toastr.warning(`Applied sections no longer match generated output: ${changedHeaders.join(', ')}`);
    }
    _cardSuggestions = newSuggestions;
    updatePendingWarning();
}

/**
 * Rebuilds the Ingester dropdown from the current _cardSuggestions array.
 * Called on every Ingester tab open so newly parsed sections are always reflected.
 */
function populateIngesterDropdown() {
    const $sel = $('#chz-ingester-select').empty();
    if (!_cardSuggestions.length) {
        $sel.append('<option disabled selected>(no suggestions — check AI Raw tab)</option>');
        $('#chz-ingester-apply').prop('disabled', true);
        $('#chz-ingester-revert').prop('disabled', true);
        $('#chz-ingester-revert-bio').prop('disabled', true);
        $('#chz-ingester-diff').empty();
        $('#chz-ingester-editor').val('');
        $('#chz-ingester-warning').addClass('chz-hidden');
        return;
    }
    // Count total occurrences of each header so we know when to show "(n)" suffixes
    const headerTotals = {};
    _cardSuggestions.forEach(s => {
        const key = s.header.toLowerCase();
        headerTotals[key] = (headerTotals[key] || 0) + 1;
    });

    // Build options; add "(1)", "(2)" … when a header appears more than once
    const headerSeen = {};
    _cardSuggestions.forEach((s, i) => {
        const key = s.header.toLowerCase();
        headerSeen[key] = (headerSeen[key] || 0) + 1;
        const suffix = headerTotals[key] > 1 ? ` (${headerSeen[key]})` : '';
        const base   = `${s.header}${suffix}`;
        const labelPrefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        const label = labelPrefix + base;
        $sel.append(`<option value="${i}">${escapeHtml(label)}</option>`);
    });
    $sel.val(_activeIngesterIndex);
    $('#chz-ingester-apply').prop('disabled', false);
}

/**
 * Word-level LCS diff between two strings.
 * Groups punctuation and trailing whitespace into the word token to prevent
 * fragmented diffs and visual word-mashing.
 */
function wordDiff(base, proposed) {
    // Regex: Match one or more non-space characters (words/punctuation) 
    // followed by any amount of trailing whitespace.
    // This creates "semantic units" that prevent the algorithm from
    // anchoring on common punctuation or spaces in different contexts.
    const tokenise = str => str.match(/[^\s]+\s*|\s+/g) || [];
    const baseTokens = tokenise(base);
    const proposedTokens = tokenise(proposed);

    const m = baseTokens.length;
    const n = proposedTokens.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    // 1. Build LCS Matrix
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = baseTokens[i] === proposedTokens[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const out = [];
    let delBuffer = [];
    let insBuffer = [];

    // 2. Buffer Management
    const flushBuffers = () => {
        if (delBuffer.length > 0) {
            out.push(`<span class="chz-diff-del">${escapeHtml(delBuffer.join(''))}</span>`);
            delBuffer = [];
        }
        if (insBuffer.length > 0) {
            out.push(`<span class="chz-diff-ins">${escapeHtml(insBuffer.join(''))}</span>`);
            insBuffer = [];
        }
    };

    // 3. Reconstruction
    let i = 0, j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && baseTokens[i] === proposedTokens[j]) {
            flushBuffers();
            out.push(escapeHtml(baseTokens[i]));
            i++;
            j++;
        } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
            insBuffer.push(proposedTokens[j]);
            j++;
        } else {
            delBuffer.push(baseTokens[i]);
            i++;
        }
    }

    flushBuffers();
    return out.join('');
}

/**
 * Renders the ingester detail for the given suggestion: stores the AI snapshot,
 * populates the editor, and computes the initial diff against the matching bio section.
 */
function renderIngesterDetail(suggestion) {
    if (!suggestion) return;
    _ingesterSnapshot = suggestion.content;
    $('#chz-ingester-editor').val(suggestion.content);
    $('#chz-ingester-warning').addClass('chz-hidden');
    $('#chz-ingester-apply').prop('disabled', false);
    $('#chz-ingester-revert').prop('disabled', false);

    const bioText     = $('#chz-card-text').val();
    const sections    = parseDescriptionSections(bioText);
    const headerLower = suggestion.header.toLowerCase();

    // Determine which occurrence of this header the suggestion targets —
    // the nth suggestion for a given header maps to the nth bio section.
    const suggestionIdx    = _cardSuggestions.indexOf(suggestion);
    const targetOccurrence = _cardSuggestions
        .slice(0, suggestionIdx + 1)
        .filter(s => s.header.toLowerCase() === headerLower)
        .length;

    const match = sections.find(
        s => s.header.toLowerCase() === headerLower && s.index === targetOccurrence,
    );

    if (match) {
        const lines    = bioText.split('\n');
        const baseText = lines.slice(match.startLine, match.endLine + 1).join('\n');
        $('#chz-ingester-diff').html(wordDiff(baseText, suggestion.content));
        $('#chz-ingester-revert-bio').prop('disabled', false);
    } else {
        $('#chz-ingester-diff').empty();
        $('#chz-ingester-warning').removeClass('chz-hidden');
        $('#chz-ingester-apply').prop('disabled', true);
        $('#chz-ingester-revert-bio').prop('disabled', true);
    }
}

function onIngesterSectionChange() {
    const idx = parseInt($('#chz-ingester-select').val(), 10);
    if (!isNaN(idx) && _cardSuggestions[idx]) {
        _activeIngesterIndex = idx;
        renderIngesterDetail(_cardSuggestions[idx]);
    }
}

function onIngesterApplyClick() {
    const idx = parseInt($('#chz-ingester-select').val(), 10);
    if (isNaN(idx) || !_cardSuggestions[idx]) return;
    _activeIngesterIndex = idx;

    const suggestion  = _cardSuggestions[idx];
    const newContent  = $('#chz-ingester-editor').val();
    const bioText     = $('#chz-card-text').val();
    const sections    = parseDescriptionSections(bioText);
    const headerLower = suggestion.header.toLowerCase();

    // Match the correct occurrence: nth suggestion for header → nth bio section
    const targetOccurrence = _cardSuggestions
        .slice(0, idx + 1)
        .filter(s => s.header.toLowerCase() === headerLower)
        .length;
    const match = sections.find(
        s => s.header.toLowerCase() === headerLower && s.index === targetOccurrence,
    );

    if (!match) return; // button should be disabled; guard anyway

    const updated = applyDescriptionSection(bioText, match.startLine, match.endLine, newContent);
    $('#chz-card-text').val(updated);

    // Mark as applied in dropdown and on the suggestion object
    _cardSuggestions[idx]._applied = true;
    _cardSuggestions[idx]._rejected = false;
    const $opt = $(`#chz-ingester-select option[value="${idx}"]`);
    // Strip existing check or cross, then add check
    const baseText = $opt.text().replace(/^[\u2713\u2717]\s*/, '');
    $opt.text('\u2713 ' + baseText);

    // Refresh the diff pane to show the applied content as the new base
    renderIngesterDetail(_cardSuggestions[idx]);
    updatePendingWarning();
}

function onIngesterEditorInput() {
    clearTimeout(_ingesterDebounceTimer);
    _ingesterDebounceTimer = setTimeout(() => {
        const idx = parseInt($('#chz-ingester-select').val(), 10);
        if (isNaN(idx) || !_cardSuggestions[idx]) return;

        const suggestion   = _cardSuggestions[idx];
        const headerLower  = suggestion.header.toLowerCase();
        const bioText      = $('#chz-card-text').val();
        const sections     = parseDescriptionSections(bioText);

        const suggestionIdx    = _cardSuggestions.indexOf(suggestion);
        const targetOccurrence = _cardSuggestions
            .slice(0, suggestionIdx + 1)
            .filter(s => s.header.toLowerCase() === headerLower)
            .length;

        const match = sections.find(
            s => s.header.toLowerCase() === headerLower && s.index === targetOccurrence,
        );
        if (!match) return;

        const lines    = bioText.split('\n');
        const baseText = lines.slice(match.startLine, match.endLine + 1).join('\n');
        $('#chz-ingester-diff').html(wordDiff(baseText, $('#chz-ingester-editor').val()));
    }, 100);
}

function onIngesterRevertClick() {
    const idx = parseInt($('#chz-ingester-select').val(), 10);
    if (!isNaN(idx) && _cardSuggestions[idx]) {
        renderIngesterDetail(_cardSuggestions[idx]);
    }
}

/**
 * Scans from the item after the current selection for the first suggestion that
 * is neither applied nor rejected, then navigates to it.
 * Checks all other items (wrapping around) but never re-checks the current item —
 * if nothing else is unresolved, shows a "all reviewed" toastr notification.
 */
function onIngesterNextClick() {
    const total = _cardSuggestions.length;
    if (!total) return;
    for (let offset = 1; offset < total; offset++) {
        const i = (_activeIngesterIndex + offset) % total;
        if (!_cardSuggestions[i]._applied && !_cardSuggestions[i]._rejected) {
            _activeIngesterIndex = i;
            $('#chz-ingester-select').val(i);
            renderIngesterDetail(_cardSuggestions[i]);
            return;
        }
    }
    toastr.info('All suggestions have been reviewed.');
}

/**
 * Reverts the editor to the current content of the matching section in the
 * Draft Bio — i.e. what would be overwritten if the user clicked Apply now.
 * Reflects any earlier Apply operations already committed to the bio.
 * Note: for a full undo of all changes, cancel the wizard and restart.
 * Disabled when no matching section exists (same guard as Apply).
 */
function onIngesterRevertBioClick() {
    const idx = parseInt($('#chz-ingester-select').val(), 10);
    if (isNaN(idx) || !_cardSuggestions[idx]) return;

    const suggestion  = _cardSuggestions[idx];
    const bioText     = $('#chz-card-text').val();
    const sections    = parseDescriptionSections(bioText);
    const headerLower = suggestion.header.toLowerCase();

    const targetOccurrence = _cardSuggestions
        .slice(0, idx + 1)
        .filter(s => s.header.toLowerCase() === headerLower)
        .length;
    const match = sections.find(
        s => s.header.toLowerCase() === headerLower && s.index === targetOccurrence,
    );
    if (!match) return; // button should be disabled; guard anyway

    const lines      = bioText.split('\n');
    const bioSection = lines.slice(match.startLine, match.endLine + 1).join('\n');
    $('#chz-ingester-editor').val(bioSection);
    // Diff bio→editor is now empty (editor matches bio), which accurately shows
    // that clicking Apply would make no change.
    $('#chz-ingester-diff').html(wordDiff(bioSection, bioSection));
}

function onRevertBioClick() {
    $('#chz-card-text').val(_originalDescription);
}

function onIngesterRejectClick() {
    const idx = parseInt($('#chz-ingester-select').val(), 10);
    if (isNaN(idx) || !_cardSuggestions[idx]) return;
    _activeIngesterIndex = idx;

    _cardSuggestions[idx]._rejected = true;
    _cardSuggestions[idx]._applied = false;

    // Strip existing check or cross, then add cross
    const $opt = $(`#chz-ingester-select option[value="${idx}"]`);
    const baseText = $opt.text().replace(/^[\u2713\u2717]\s*/, '');
    $opt.text('\u2717 ' + baseText);

    updatePendingWarning();
}

// ─── Section Loading State ────────────────────────────────────────────────────

function setSuggestionsLoading(isLoading) {
    _suggestionsLoading = isLoading;
    $('#chz-spin-suggestions').toggleClass('chz-hidden', !isLoading);
    $('#chz-regen-suggestions').prop('disabled', isLoading);
    $('#chz-suggestions-raw').prop('disabled', isLoading);
    if (isLoading) {
        $('#chz-suggestions-raw').val('');
        $('#chz-raw-error').addClass('chz-hidden').text('');
        // _cardSuggestions intentionally kept alive during regen so reparseSuggestions
        // can carry _applied flags forward when the new result lands.
    }
    updateConfirmState();
}

function setSituationLoading(isLoading) {
    _situationLoading = isLoading;
    $('#chz-spin-situation').toggleClass('chz-hidden', !isLoading);
    $('#chz-regen-situation').prop('disabled', isLoading);
    $('#chz-situation-text').prop('disabled', isLoading);
    if (isLoading) $('#chz-situation-text').val('');
    updateConfirmState();
}

function updateConfirmState() {
    $('#chz-confirm').prop('disabled', _suggestionsLoading || _situationLoading);
}

function updatePendingWarning() {
    const hasPending = _cardSuggestions.length > 0 && _cardSuggestions.some(s => !s._applied && !s._rejected);
    $('#chz-pending-warning').toggleClass('chz-hidden', !hasPending);
}

function populateSuggestions(text) {
    setSuggestionsLoading(false);
    // On initial load _cardSuggestions is empty (cleared by initWizardSession).
    // On regen, _cardSuggestions holds the previous result; reparseSuggestions will carry _applied flags forward.
    $('#chz-raw-error').addClass('chz-hidden').text('');
    $('#chz-suggestions-raw').val(text);
    reparseSuggestions();
    // If the Ingester tab is currently open, refresh its dropdown and detail pane
    if (!$('#chz-tab-ingester').hasClass('chz-hidden')) {
        _activeIngesterIndex = Math.max(0, Math.min(_activeIngesterIndex, _cardSuggestions.length - 1));
        populateIngesterDropdown();
        if (_cardSuggestions[_activeIngesterIndex]) {
            renderIngesterDetail(_cardSuggestions[_activeIngesterIndex]);
        }
    }
}

function autoResizeRagRaw() {
    const el = document.getElementById('chz-rag-raw');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function populateSituation(text) {
    setSituationLoading(false);
    $('#chz-error-2').addClass('chz-hidden').text('');
    $('#chz-situation-text').val(text);
}

function showSuggestionsError(message) {
    setSuggestionsLoading(false);
    $('#chz-raw-error').text(message).removeClass('chz-hidden');
}

function showSituationError(message) {
    setSituationLoading(false);
    $('#chz-error-2').text(message).removeClass('chz-hidden');
}

// ─── Commit Receipts Panel ────────────────────────────────────────────────────

function showReceiptsPanel() {
    $('#chz-receipts').removeClass('chz-hidden');
}

function showRecoveryGuide() {
    $('#chz-recovery-guide').removeClass('chz-hidden');
    $('#chz-cancel').text('Close');
}

/**
 * Creates or updates a named receipt row in the receipts panel.
 * @param {string} id      - element ID for this row (e.g. 'chz-receipt-card')
 * @param {string} html    - inner HTML for the row
 */
function upsertReceiptItem(id, html) {
    if (!$(`#${id}`).length) {
        $('#chz-receipts-content').append(`<div id="${id}" class="chz-receipt-row"></div>`);
    }
    $(`#${id}`).html(html);
}

function receiptSuccess(text, hint = null) {
    return `<span class="chz-receipt-item success">&#x2713; ${escapeHtml(text)}</span>` +
           (hint ? `<div class="chz-receipt-hint">${escapeHtml(hint)}</div>` : '');
}

function receiptFailure(text) {
    return `<span class="chz-receipt-item failure">&#x2717; ${escapeHtml(text)}</span>`;
}

// ─── Lorebook Workshop UI ────────────────────────────────────────────────────

function setLbLoading(isLoading) {
    _lorebookLoading = isLoading;
    $('#lbchz-spinner').toggleClass('chz-hidden', !isLoading);
    $('#lbchz-regen').prop('disabled', isLoading);
    $('#lbchz-freeform').prop('disabled', isLoading);
    if (isLoading) $('#lbchz-freeform').val('');
}

function populateLbFreeform(text) {
    setLbLoading(false);
    $('#lbchz-freeform').val(text);
    _lorebookFreeformLastParsed = null; // force re-enrichment on next Ingester tab switch
    // If the Ingester tab is currently open, refresh it immediately
    if (!$('#lbchz-tab-ingester').hasClass('chz-hidden')) {
        const freshParsed = parseLbSuggestions(text);
        _lorebookSuggestions = enrichLbSuggestions(freshParsed);
        _lorebookFreeformLastParsed = text;
        _lbActiveIngesterIndex = Math.max(0, Math.min(_lbActiveIngesterIndex, _lorebookSuggestions.length - 1));
        populateLbIngesterDropdown();
        if (_lorebookSuggestions[_lbActiveIngesterIndex]) {
            renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
        }
    }
}

function showLbError(message) {
    setLbLoading(false);
    $('#lbchz-error').text(message).removeClass('chz-hidden');
}

/**
 * @section Lorebook Workshop
 * @architectural-role UI Orchestration / Staging
 * @description Handles lorebook suggestion enrichment, diffing, and in-memory drafting.
 *   Implements the Draft/Ingest pattern: suggestions are enriched with UID anchors and
 *   AI snapshots on Ingester tab entry. The Virtual Document (toVirtualDoc) flattens
 *   Name + Keys + Content into a single string for wordDiff comparison.
 * @core-principles
 *   1. MUST NOT commit writes to server; all changes must be staged in _draftLorebook.
 *   2. _lorebookSuggestions persists across tab switches; re-enrichment only when
 *      freeform text changes (detected via _lorebookFreeformLastParsed).
 *   3. linkedUid is the sole authority for entry identity; type (UPDATE/NEW) is
 *      informational only after enrichment.
 * @api-declaration
 *   Tab control:   onLbTabSwitch
 *   Enrichment:    enrichLbSuggestions (reconciliation loop)
 *   Dropdown:      populateLbIngesterDropdown
 *   Detail pane:   renderLbIngesterDetail, updateLbDiff
 *   Editor input:  onLbIngesterEditorInput (debounced, syncs all 3 boxes)
 *   Navigation:    onLbIngesterNext
 *   Revert:        onLbIngesterRevertAi, onLbIngesterRevertDraft
 *   Apply/Reject:  onLbIngesterApply, onLbIngesterReject, onLbApplyAllUnresolved
 * @contract
 *   assertions:
 *     purity: impure (DOM)
 *     state_ownership: [_draftLorebook, _lorebookData, _lorebookName,
 *       _lorebookSuggestions, _lbActiveIngesterIndex, _lbDebounceTimer,
 *       _lorebookFreeformLastParsed]
 *     external_io: callPopup # confirmation dialog for Apply All Unresolved
 */
function onLbTabSwitch(tabName) {
    $('#lbchz-tab-bar .chz-tab-btn').each(function () {
        $(this).toggleClass('chz-tab-active', $(this).data('tab') === tabName);
    });
    $('#lbchz-tab-freeform').toggleClass('chz-hidden', tabName !== 'freeform');
    $('#lbchz-tab-ingester').toggleClass('chz-hidden', tabName !== 'ingester');

    if (tabName === 'ingester') {
        if (!_lorebookLoading) {
            const currentText = $('#lbchz-freeform').val();
            if (currentText !== _lorebookFreeformLastParsed) {
                // Freeform text changed (or null sentinel) — re-parse and reconcile.
                const freshParsed = parseLbSuggestions(currentText);
                _lorebookSuggestions = enrichLbSuggestions(freshParsed);
                _lorebookFreeformLastParsed = currentText;
                if (_lbActiveIngesterIndex >= _lorebookSuggestions.length) {
                    _lbActiveIngesterIndex = 0;
                }
            }
        }
        _lbActiveIngesterIndex = Math.max(
            0,
            Math.min(_lbActiveIngesterIndex, _lorebookSuggestions.length - 1),
        );
        populateLbIngesterDropdown();
        if (_lorebookSuggestions[_lbActiveIngesterIndex]) {
            renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
        }
    }
}

function populateLbIngesterDropdown() {
    const $sel = $('#lbchz-suggestion-select').empty();
    if (!_lorebookSuggestions.length) {
        $sel.append('<option disabled selected>(no suggestions parsed — check Freeform tab)</option>');
        $('#lbchz-apply-one, #lbchz-apply-all-unresolved').prop('disabled', true);
        $('#lbchz-editor-name').val('');
        $('#lbchz-editor-keys').val('');
        $('#lbchz-editor-content').val('');
        $('#lbchz-ingester-diff').empty();
        return;
    }
    _lorebookSuggestions.forEach((s, i) => {
        const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        $sel.append(`<option value="${i}">${escapeHtml(`${prefix}${s.type}: ${s.name}`)}</option>`);
    });
    $sel.val(_lbActiveIngesterIndex);
    $('#lbchz-apply-one, #lbchz-apply-all-unresolved').prop('disabled', false);
}

/**
 * Populates the three editor boxes and diff pane from a suggestion object.
 * Called on dropdown selection change and after apply/revert operations.
 */
function renderLbIngesterDetail(suggestion) {
    if (!suggestion) return;
    $('#lbchz-editor-name').val(suggestion.name);
    $('#lbchz-editor-keys').val(suggestion.keys.join(', '));
    $('#lbchz-editor-content').val(suggestion.content);
    $('#lbchz-error-ingester').addClass('chz-hidden').text('');
    // Revert to Draft requires an existing linked entry in the draft
    $('#lbchz-revert-draft').prop('disabled', suggestion.linkedUid === null);
    updateLbDiff();
}

/**
 * Re-computes the Virtual Document diff and updates the diff pane.
 * Base: the current _draftLorebook entry (if linkedUid is set); empty string for NEW.
 * Proposed: the current values of the three editor boxes.
 * A NEW entry shows the entire Virtual Document as a green insertion.
 */
function updateLbDiff() {
    const suggestion = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!suggestion) return;

    const name    = $('#lbchz-editor-name').val();
    const keys    = $('#lbchz-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#lbchz-editor-content').val();
    const proposed = toVirtualDoc(name, keys, content);

    let base = '';
    if (suggestion.linkedUid !== null) {
        const entry = _draftLorebook?.entries?.[String(suggestion.linkedUid)];
        if (entry) {
            base = toVirtualDoc(
                entry.comment || '',
                Array.isArray(entry.key) ? entry.key : [],
                entry.content || '',
            );
        }
    }

    $('#lbchz-ingester-diff').html(wordDiff(base, proposed));
}

function onLbSuggestionSelectChange() {
    const idx = parseInt($('#lbchz-suggestion-select').val(), 10);
    if (!isNaN(idx) && _lorebookSuggestions[idx]) {
        _lbActiveIngesterIndex = idx;
        renderLbIngesterDetail(_lorebookSuggestions[idx]);
    }
}

/**
 * Handles input from any of the three editor boxes.
 * Syncs all three live values back onto the suggestion object (so Apply All
 * and tab-switch preservation see the latest edits), updates the dropdown
 * label by index when the name changes, then schedules a debounced diff update.
 */
function onLbIngesterEditorInput() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (s) {
        const newName = $('#lbchz-editor-name').val();
        s.name    = newName;
        s.keys    = $('#lbchz-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
        s.content = $('#lbchz-editor-content').val();
        // Update dropdown label by index — avoids text-match failure while name is being typed.
        const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        $('#lbchz-suggestion-select option').eq(_lbActiveIngesterIndex).text(
            escapeHtml(`${prefix}${s.type}: ${newName}`),
        );
    }
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer = setTimeout(updateLbDiff, 100);
}

/**
 * Reverts the three editor boxes to the original AI suggestion (_aiSnapshot).
 * If the suggestion was not yet applied, the snapshot reflects the most recent
 * AI generation. If applied, it reflects the AI text at the time of application.
 */
function onLbIngesterRevertAi() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;
    s.name    = s._aiSnapshot.name;
    s.keys    = [...s._aiSnapshot.keys];
    s.content = s._aiSnapshot.content;
    renderLbIngesterDetail(s);
    const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
    $('#lbchz-suggestion-select option').eq(_lbActiveIngesterIndex).text(
        escapeHtml(`${prefix}${s.type}: ${s.name}`),
    );
}

/**
 * Reverts the three editor boxes to whatever is currently in _draftLorebook
 * for the linked entry. Button is disabled when linkedUid is null (NEW, pre-apply).
 */
function onLbIngesterRevertDraft() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s || s.linkedUid === null) return;
    const entry = _draftLorebook?.entries?.[String(s.linkedUid)];
    if (!entry) return;
    s.name    = entry.comment || '';
    s.keys    = Array.isArray(entry.key) ? [...entry.key] : [];
    s.content = entry.content || '';
    renderLbIngesterDetail(s);
    const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
    $('#lbchz-suggestion-select option').eq(_lbActiveIngesterIndex).text(
        escapeHtml(`${prefix}${s.type}: ${s.name}`),
    );
}

/**
 * Scans from the item after the current selection for the first suggestion that
 * is neither applied nor rejected, then navigates to it.
 */
function onLbIngesterNext() {
    const total = _lorebookSuggestions.length;
    if (!total) return;
    for (let offset = 1; offset < total; offset++) {
        const i = (_lbActiveIngesterIndex + offset) % total;
        if (!_lorebookSuggestions[i]._applied && !_lorebookSuggestions[i]._rejected) {
            _lbActiveIngesterIndex = i;
            $('#lbchz-suggestion-select').val(i);
            renderLbIngesterDetail(_lorebookSuggestions[i]);
            return;
        }
    }
    toastr.info('All lorebook suggestions have been reviewed.');
}

function updateLbPendingWarning() {
    // Pending state is surfaced in the Step 4 summary (populateStep4Summary).
    // No inline warning banner in the Lorebook Ingester itself.
}

// ─── Lorebook Apply ───────────────────────────────────────────────────────────

/**
 * Applies the current editor values to _draftLorebook (no server write).
 * If linkedUid exists: mutates the existing entry's Big Three fields only.
 * If linkedUid is null (NEW): creates a new entry and promotes linkedUid so
 *   subsequent edits update that specific entry rather than creating a second.
 * Refreshes the diff pane so the newly-written draft becomes the new base.
 */
function onLbIngesterApply() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;

    const name    = $('#lbchz-editor-name').val().trim();
    const keys    = $('#lbchz-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#lbchz-editor-content').val().trim();
    if (!name || !content) return;

    // Sync live values onto the suggestion object
    s.name    = name;
    s.keys    = keys;
    s.content = content;

    if (s.linkedUid !== null) {
        const entry = _draftLorebook.entries[String(s.linkedUid)];
        if (entry) {
            entry.comment = name;
            entry.key     = keys;
            entry.content = content;
        }
    } else {
        const newUid = nextLorebookUid();
        _draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
        s.linkedUid = newUid;
        // Revert to Draft is now enabled since the entry exists
        $('#lbchz-revert-draft').prop('disabled', false);
    }

    s._applied  = true;
    s._rejected = false;
    $('#lbchz-suggestion-select option').eq(_lbActiveIngesterIndex).text(
        escapeHtml(`\u2713 ${s.type}: ${s.name}`),
    );

    // Refresh diff — draft (what we just wrote) is now the base
    updateLbDiff();
    updateLbPendingWarning();
}

function onLbIngesterReject() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;
    s._rejected = true;
    s._applied  = false;
    $('#lbchz-suggestion-select option').eq(_lbActiveIngesterIndex).text(
        escapeHtml(`\u2717 ${s.type}: ${s.name}`),
    );
    updateLbPendingWarning();
}

/**
 * Applies all unresolved (not applied, not rejected) suggestions in one pass
 * after a callPopup confirmation. Uses the live suggestion object values
 * (which reflect any editor edits via onLbIngesterEditorInput) for each entry.
 */
async function onLbApplyAllUnresolved() {
    const unresolved = _lorebookSuggestions.filter(s => !s._applied && !s._rejected);
    if (!unresolved.length) {
        toastr.info('No unresolved lorebook suggestions to apply.');
        return;
    }

    const count     = unresolved.length;
    const confirmed = await callPopup(
        `This will apply all ${count} unreviewed suggestion${count !== 1 ? 's' : ''} to the Lorebook using the AI's current text. Continue?`,
        'confirm',
    );
    if (!confirmed) return;

    for (const s of unresolved) {
        const name    = s.name.trim();
        const keys    = [...s.keys];
        const content = s.content.trim();
        if (!name || !content) continue;

        if (s.linkedUid !== null) {
            const entry = _draftLorebook.entries[String(s.linkedUid)];
            if (entry) {
                entry.comment = name;
                entry.key     = keys;
                entry.content = content;
            }
        } else {
            const newUid = nextLorebookUid();
            _draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
            s.linkedUid = newUid;
        }
        s._applied  = true;
        s._rejected = false;
    }

    populateLbIngesterDropdown();
    if (_lorebookSuggestions[_lbActiveIngesterIndex]) {
        renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
    }
    updateLbPendingWarning();
    toastr.success(
        `Applied ${count} lorebook suggestion${count !== 1 ? 's' : ''} — will be saved on Finalize.`,
    );
}

// ─── Narrative Ledger Engine ──────────────────────────────────────────────────

/**
 * Returns the sanitized Data Bank filename for a given character avatar key.
 * @param {string} avatarKey  e.g. "seraphina.png" or "seraphina.png"
 * @returns {string}          e.g. "chz_ledger_seraphina.png.json"
 */
function ledgerFileName(avatarKey) {
    const safe = avatarKey.replace(/[^A-Za-z0-9_\-.]/g, '_');
    return `chz_ledger_${safe}.json`;
}

/**
 * Fetches the ledger for `avatarKey` from the Data Bank (using the path stored
 * in settings), or bootstraps a fresh empty manifest if none exists yet.
 * Sets `_ledgerManifest` and `_sessionStartId`. Must be the first call in
 * both `onChapterizeClick` and `onRepairClick`.
 * @param {string} avatarKey
 */
async function fetchOrBootstrapLedger(avatarKey) {
    const storedPath = (getSettings().ledgerPaths ?? {})[avatarKey];
    if (storedPath) {
        try {
            const res = await fetch(storedPath);
            if (res.ok) {
                const manifest   = await res.json();
                _ledgerManifest  = manifest;
                _sessionStartId  = manifest.headNodeId;
                return;
            }
        } catch (_) { /* network error – fall through to bootstrap */ }
    }
    // No stored path or file gone — start fresh
    _ledgerManifest = { storyId: crypto.randomUUID(), headNodeId: null, nodes: {} };
    _sessionStartId = null;
}

/**
 * Re-fetches the ledger from the server and compares its `headNodeId` against
 * `_sessionStartId`. Returns true (and refreshes `_ledgerManifest`) only if
 * nothing committed between modal-open and now. Called as the first async op
 * in `onConfirmClick`. Never mutates `_sessionStartId`.
 * @param {string} avatarKey
 * @returns {Promise<boolean>}
 */
async function verifyFreshnessLock(avatarKey) {
    const storedPath = (getSettings().ledgerPaths ?? {})[avatarKey];
    if (!storedPath) {
        // Ledger never written — fresh bootstrap session; headNodeId is null on both sides
        return _sessionStartId === null;
    }
    try {
        const res = await fetch(storedPath);
        if (!res.ok) return false;
        const freshManifest = await res.json();
        if (freshManifest.headNodeId !== _sessionStartId) return false;
        _ledgerManifest = freshManifest;   // absorb any unrelated node additions
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Populates wizard module state from a ledger node's snapshot. When
 * `sourceNode` is null the caller is responsible for populating from
 * SillyTavern.getContext() (standard first-run path).
 * @param {object|null} sourceNode  A `LedgerNode` object, or null.
 */
function hydrateWizardSession(sourceNode) {
    if (!sourceNode) return;
    _originalDescription = sourceNode.snapshot.bio;
    _baseScenario        = sourceNode.snapshot.baseScenario;
    _priorSituation      = sourceNode.snapshot.priorSituation;
    _lorebookName        = sourceNode.filePointers.lorebookName;
    $('#chz-card-text').val(_originalDescription);
    $('#chz-suggestions-raw').val(sourceNode.snapshot.aiRawBio ?? '');
    $('#chz-situation-text').val(sourceNode.snapshot.stagedSituation ?? '');
    $('#lbchz-title').text(`Lorebook: ${_lorebookName}`);
}

/**
 * Diffs `_draftLorebook` against the original server copy `_lorebookData`
 * and stores the result in `_lorebookDelta`. Called during the Lorebook Save
 * step of `onConfirmClick` so the delta is available to `buildLedgerNode`.
 * Short-circuits to an empty delta when no lorebook was loaded this session.
 */
function recordLorebookDelta() {
    if (!_lorebookData || !_draftLorebook) {
        _lorebookDelta = { createdUids: [], modifiedEntries: {} };
        return;
    }
    const origEntries  = _lorebookData.entries  ?? {};
    const draftEntries = _draftLorebook.entries ?? {};
    const createdUids      = [];
    const modifiedEntries  = {};
    for (const [uid, draftEntry] of Object.entries(draftEntries)) {
        const orig = origEntries[uid];
        if (!orig) {
            createdUids.push(uid);
        } else if (
            orig.content !== draftEntry.content ||
            JSON.stringify(orig.key) !== JSON.stringify(draftEntry.key)
        ) {
            // Store the *original* values so Repair can revert to them
            modifiedEntries[uid] = { content: orig.content, key: [...(orig.key ?? [])] };
        }
    }
    _lorebookDelta = { createdUids, modifiedEntries };
}

/**
 * Constructs a new `LedgerNode` from the current session state.
 * Must be called after all `_finalizeSteps` have succeeded and after
 * `recordLorebookDelta()` has been called.
 * @param {string|null} parentNodeId    nodeId of the parent, or null for root.
 * @param {number}      sequenceNum     Chapter ordinal (1-based).
 * @param {object}      chatMetadata    ST chat metadata object captured at commit time.
 * @returns {object}  A fully-populated LedgerNode.
 */
function buildLedgerNode(parentNodeId, sequenceNum, chatMetadata) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    // Source identity: in repair mode inherit the original story's source fields
    // so future repairs can always reach back to the originating chat.
    const sourceFields = _isRepairMode
        ? {
            sourceChatId:   _ledgerManifest.nodes[_sessionStartId].filePointers.sourceChatId,
            sourceAvatar:   _ledgerManifest.nodes[_sessionStartId].filePointers.sourceAvatar,
            sourceCharName: _ledgerManifest.nodes[_sessionStartId].filePointers.sourceCharName,
        }
        : {
            sourceChatId:   _sourceChatId,
            sourceAvatar:   char.avatar,
            sourceCharName: char.name,
        };
    return {
        nodeId:      crypto.randomUUID(),
        parentId:    parentNodeId,
        sequenceNum,
        status:      'active',
        filePointers: {
            chatFile:     _chapterName,
            ragFile:      _lastRagUrl ?? '',
            lorebookName: _lorebookName,
            targetAvatar: _isRepairMode ? _cloneAvatarUrl
                : _isChapterMode ? char.avatar : _cloneAvatarUrl,
            ...sourceFields,
        },
        snapshot: {
            bio:             $('#chz-card-text').val(),
            baseScenario:    _baseScenario,
            priorSituation:  $('#chz-situation-text').val(),
            aiRawBio:        $('#chz-suggestions-raw').val(),
            stagedSituation: $('#chz-situation-text').val(),
            cloneName:       _cloneName,
            chatMetadata,
            lorebookDelta:   _lorebookDelta ?? { createdUids: [], modifiedEntries: {} },
        },
    };
}

/**
 * Deletes the old ledger file from the Data Bank (to prevent ST's "(1).json"
 * versioning), uploads the current `_ledgerManifest` as JSON, and stores the
 * new path in `getSettings().ledgerPaths`.
 * @param {string} avatarKey
 */
async function commitLedgerManifest(avatarKey) {
    const storedPaths = getSettings().ledgerPaths ?? {};
    const oldPath     = storedPaths[avatarKey];
    if (oldPath) {
        try {
            await fetch('/api/files/delete', {
                method:  'POST',
                headers: getRequestHeaders(),
                body:    JSON.stringify({ path: oldPath }),
            });
        } catch (_) { /* already gone */ }
    }
    const fileName = ledgerFileName(avatarKey);
    const jsonStr  = JSON.stringify(_ledgerManifest);
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name: fileName, data: utf8ToBase64(jsonStr) }),
    });
    if (!res.ok) throw new Error(`Ledger save failed (HTTP ${res.status})`);
    const { path } = await res.json();
    if (!getSettings().ledgerPaths) getSettings().ledgerPaths = {};
    getSettings().ledgerPaths[avatarKey] = path;
    saveSettingsDebounced();
}

/**
 * Reverts lorebook entries created or modified during a chapter that is being
 * repaired. Fetches the live lorebook, applies the reverse delta, and saves.
 * Best-endeavors: caller must wrap in try/catch.
 * @param {object} delta  `LedgerNode.snapshot.lorebookDelta` from the orphaned node.
 */
async function revertLorebookDelta(delta) {
    if (!delta || !_lorebookName) return;
    const lbData  = await lbGetLorebook(_lorebookName);
    const entries = lbData.entries ?? {};
    for (const uid of (delta.createdUids ?? [])) {
        delete entries[uid];
    }
    for (const [uid, original] of Object.entries(delta.modifiedEntries ?? {})) {
        if (entries[uid]) {
            entries[uid].content = original.content;
            entries[uid].key     = original.key;
        }
    }
    lbData.entries = entries;
    await lbSaveLorebook(_lorebookName, lbData);
}

/**
 * Deletes the orphaned RAG file from the Data Bank and removes its attachment
 * registration. Chat files are intentionally excluded — in repair mode the
 * chat is overwritten in-place by saveNewChat(force:true), not versioned.
 * Best-endeavors: caller must wrap in try/catch.
 * @param {object} filePointers  `LedgerNode.filePointers` of the orphaned node.
 */
async function scrubOrphanedArtifacts(filePointers) {
    if (!filePointers.ragFile) return;
    try {
        await fetch('/api/files/delete', {
            method:  'POST',
            headers: getRequestHeaders(),
            body:    JSON.stringify({ path: filePointers.ragFile }),
        });
    } catch (_) { /* already gone */ }
    const attachments = extension_settings.character_attachments;
    if (attachments?.[filePointers.targetAvatar]) {
        attachments[filePointers.targetAvatar] = attachments[filePointers.targetAvatar]
            .filter(a => a.url !== filePointers.ragFile);
        saveSettingsDebounced();
    }
}

/**
 * Fires when `verifyFreshnessLock` returns false. Shows an error message and
 * a "Download Draft" button so the user can rescue their work. Keeps the
 * Finalize button disabled — the stale session must not write to the server.
 */
function abortWithSyncError() {
    const draftText = [
        '=== Chapterize Draft (saved locally after sync conflict) ===',
        '',
        '--- Bio ---',
        $('#chz-card-text').val(),
        '',
        '--- Situation ---',
        $('#chz-situation-text').val(),
    ].join('\n');

    const blob = new Blob([draftText], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const $dl  = $('<a>')
        .attr('href', url)
        .attr('download', 'chapterize_draft.txt')
        .text('Download Draft');

    $('#chz-error-5')
        .empty()
        .append(
            document.createTextNode(
                'Sync conflict: another session committed a chapter while this modal was open. ' +
                'Your draft was not saved. ',
            ),
            $dl[0],
        )
        .removeClass('chz-hidden');

    $('#chz-cancel').prop('disabled', false).text('Close');
    // Finalize remains disabled — do not re-enable it
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

async function onChapterizeClick() {
    const context = SillyTavern.getContext();

    if (context.groupId) {
        toastr.warning('Chapterize does not support group chats.');
        return;
    }
    if (context.characterId == null) {
        toastr.warning('No character chat is open.');
        return;
    }

    const messages = context.chat;
    if (!messages || messages.length === 0) {
        toastr.warning('The current chat has no messages to chapterize.');
        return;
    }

    const char   = context.characters[context.characterId];
    await fetchOrBootstrapLedger(char.avatar);

    _sourceChatId = char.chat ?? '';
    const parsed = parseChapter(char.name);
    _isChapterMode = parsed.isChapter;
    _nextChNum     = parsed.chNum + 1;
    _cloneName     = parsed.isChapter
        ? `${parsed.baseName} (Ch${_nextChNum})`
        : `${char.name} (Ch1)`;
    _lorebookName  = parsed.baseName;

    // Description is now the pure character bio — no separator lives here.
    _originalDescription = char.description ?? '';

    // Scenario holds the narrative state: text above the divider is preserved
    // as _baseScenario; text below seeds _priorSituation for Step 2.
    const rawScenario    = char.scenario ?? '';
    const scenSepIdx     = rawScenario.indexOf(SITUATION_SEP);
    _baseScenario   = (scenSepIdx !== -1 ? rawScenario.slice(0, scenSepIdx) : rawScenario).trimEnd();
    _priorSituation = scenSepIdx !== -1 ? rawScenario.slice(scenSepIdx + SITUATION_SEP.length).trim() : '';
    _transcript          = buildTranscript(messages);
    _stagedProsePairs    = buildProsePairs(messages);

    initWizardSession();
    showModal();
    updateWizard(1);

    // Bio + Situation fire immediately — no dependencies on other calls.
    const sugId = ++_suggestionsGenId;
    const sitId = ++_situationGenId;

    runSuggestionsCall(_originalDescription)
        .then(text => { if (_suggestionsGenId !== sugId) return; populateSuggestions(text); })
        .catch(err => {
            if (_suggestionsGenId !== sugId) return;
            console.error('[Chapterize] Suggestions call failed:', err);
            showSuggestionsError(`Generation failed: ${err.message}`);
        });

    runSituationCall()
        .then(text => { if (_situationGenId !== sitId) return; populateSituation(text); })
        .catch(err => {
            if (_situationGenId !== sitId) return;
            console.error('[Chapterize] Situation call failed:', err);
            showSituationError(`Situation generation failed: ${err.message}`);
        });

    // Lorebook fetch must resolve first (runLorebookCall reads _lorebookData);
    // then the AI call fires. lbEnsureLorebook runs in parallel with the above two.
    const lbId = ++_lorebookGenId;
    lbEnsureLorebook(_lorebookName)
        .then(data => {
            _lorebookData = data;
            if (!_draftLorebook) _draftLorebook = structuredClone(data);
            return runLorebookCall();
        })
        .then(text => {
            if (_lorebookGenId !== lbId) return;
            _lorebookRawText = text;
            populateLbFreeform(text);
        })
        .catch(err => {
            if (_lorebookGenId !== lbId) return;
            console.error('[Chapterize] Lorebook call failed:', err);
            _lorebookRawError = err.message;
            showLbError(`Generation failed: ${err.message}`);
        });
}

/**
 * @section Repair Mode (Entry Point)
 * @architectural-role Workflow Controller
 * @description
 * Inflates the wizard from the Narrative Ledger without firing new AI calls.
 * Time-travels to the parent node's snapshot so the user edits from the
 * correct prior state. Fetches the parent chapter's chat as the transcript
 * source so the turns slider is fully functional.
 * All session variables are set AFTER initWizardSession() so they are not
 * cleared by its reset logic.
 * @contract
 *   assertions:
 *     purity: impure
 *     state_ownership: [_isRepairMode, _ledgerManifest, _sessionStartId,
 *       _transcript, _stagedProsePairs, _repairSourceMessages,
 *       _originalDescription, _priorSituation, _baseScenario,
 *       _chapterName, _cloneAvatarUrl, _cloneName, _lorebookName]
 *     external_io: [fetchOrBootstrapLedger, /api/chats/get, lbEnsureLorebook]
 */
async function onRepairClick() {
    const context = SillyTavern.getContext();
    if (context.characterId == null) {
        toastr.warning('No character chat is open.');
        return;
    }
    const char = context.characters[context.characterId];

    // ── 1. Load ledger and validate repair is possible ─────────────────────────
    await fetchOrBootstrapLedger(char.avatar);

    if (!_ledgerManifest.headNodeId) {
        toastr.error('No narrative history found for this character. Run a Chapterize first.');
        _ledgerManifest = null;
        _sessionStartId = null;
        return;
    }
    const targetNode = _ledgerManifest.nodes[_ledgerManifest.headNodeId];
    if (!targetNode?.parentId) {
        toastr.error('Cannot repair the initial chapter — no prior state to restore from.');
        _ledgerManifest = null;
        _sessionStartId = null;
        return;
    }
    const parentNode = _ledgerManifest.nodes[targetNode.parentId];
    if (!parentNode) {
        toastr.error('Ledger integrity error: parent node not found.');
        _ledgerManifest = null;
        _sessionStartId = null;
        return;
    }

    // ── 2. Fetch the parent chapter's chat as the transcript source ────────────
    // Uses parentNode.filePointers.chatFile + targetAvatar, not the original
    // source chat — we re-do the most recent transition, not the first one.
    const sourceChar = context.characters.find(c => c.avatar === parentNode.filePointers.targetAvatar);
    let sourceMessages;
    try {
        const res = await fetch('/api/chats/get', {
            method:  'POST',
            headers: getRequestHeaders(),
            body:    JSON.stringify({
                ch_name:    sourceChar?.name ?? parentNode.snapshot.cloneName,
                file_name:  parentNode.filePointers.chatFile,
                avatar_url: parentNode.filePointers.targetAvatar,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sourceMessages = await res.json();
        if (!Array.isArray(sourceMessages) || sourceMessages.length === 0) {
            throw new Error('Response was empty or not a chat array.');
        }
    } catch (err) {
        toastr.error('Cannot repair: parent chapter chat is missing or unavailable.');
        console.error('[Chapterize] Repair: source chat fetch failed:', err);
        _ledgerManifest = null;
        _sessionStartId = null;
        return;
    }

    // ── 3. Flag + session wipe ─────────────────────────────────────────────────
    _isRepairMode = true;
    initWizardSession();   // clears all transient _ vars; does NOT clear _ledgerManifest/_sessionStartId

    // ── 4. Set target identifiers — the chapter being replaced ────────────────
    // Must happen AFTER initWizardSession() so these are not cleared.
    _cloneAvatarUrl = targetNode.filePointers.targetAvatar;
    _chapterName    = targetNode.filePointers.chatFile.replace(/\.jsonl$/i, '');
    _cloneName      = targetNode.snapshot.cloneName;

    // ── 5. Hydrate wizard from parent snapshot (time travel) ───────────────────
    hydrateWizardSession(parentNode);

    // ── 6. Inflate transcript state from fetched source ───────────────────────
    _repairSourceMessages = sourceMessages;
    _transcript           = buildTranscript(sourceMessages);
    _stagedProsePairs     = buildProsePairs(sourceMessages);

    // ── 7. Post-hydration UI corrections ──────────────────────────────────────
    // initWizardSession() rendered titles with blank state; overwrite with repair labels.
    $('#chz-card-text').val(_originalDescription);
    $('#chz-step1-title').text(`Repair: ${_cloneName}`).css('color', 'var(--warning, orange)');
    $('#chz-confirm').css('color', 'var(--warning, orange)');

    // ── 8. Hydrate Steps 1 & 2 from parent snapshot (no AI calls) ─────────────
    populateSuggestions(parentNode.snapshot.aiRawBio ?? '');
    populateSituation(parentNode.snapshot.stagedSituation ?? '');

    // ── 9. Lorebook: fetch server data for Step 3 (no AI call in repair mode) ──
    lbEnsureLorebook(_lorebookName)
        .then(data => {
            _lorebookData  = data;
            if (!_draftLorebook) _draftLorebook = structuredClone(data);
            setLbLoading(false);
        })
        .catch(err => {
            console.error('[Chapterize] Repair: lorebook fetch failed:', err);
            setLbLoading(false);
        });

    // ── 10. Launch modal ───────────────────────────────────────────────────────
    showModal();
    updateWizard(1);
}

function onRegenSuggestionsClick() {
    setSuggestionsLoading(true);
    const sugId   = ++_suggestionsGenId;
    const bioText = $('#chz-card-text').val();
    runSuggestionsCall(bioText)
        .then(text => { if (_suggestionsGenId !== sugId) return; populateSuggestions(text); })
        .catch(err => {
            if (_suggestionsGenId !== sugId) return;
            console.error('[Chapterize] Suggestions regen failed:', err);
            showSuggestionsError(`Regeneration failed: ${err.message}`);
        });
}

function onRegenSituationClick() {
    setSituationLoading(true);
    const sitId = ++_situationGenId;
    runSituationCall()
        .then(text => { if (_situationGenId !== sitId) return; populateSituation(text); })
        .catch(err => {
            if (_situationGenId !== sitId) return;
            console.error('[Chapterize] Situation regen failed:', err);
            showSituationError(`Regeneration failed: ${err.message}`);
        });
}


function onLbRegenClick() {
    setLbLoading(true);
    $('#lbchz-error').addClass('chz-hidden').text('');
    const lbId = ++_lorebookGenId;
    runLorebookCall()
        .then(text => { if (_lorebookGenId !== lbId) return; populateLbFreeform(text); })
        .catch(err => {
            if (_lorebookGenId !== lbId) return;
            console.error('[Chapterize] Lorebook regen failed:', err);
            showLbError(`Regeneration failed: ${err.message}`);
        });
}

/**
 * @section Finalize Flow (The Committer)
 * @architectural-role Workflow Controller / Persistence
 * @description Executes the sequential commit of all staged data to the ST server.
 * @core-principles
 *   1. Must be idempotent via _finalizeSteps; skip already-succeeded steps on retry.
 *   2. Must provide explicit receipts for every attempted persistence operation.
 *   3. Must relabel Cancel to Close upon first successful partial commit.
 * @api-declaration onConfirmClick, upsertReceiptItem
 * @contract
 *   assertions:
 *     purity: impure
 *     state_ownership: [_finalizeSteps, _chapterName, _cloneAvatarUrl]
 *     external_io: [saveCharacter, lbSaveLorebook, saveNewChat]
 */
async function onConfirmClick() {
    // Read inputs fresh on every attempt (including retries)
    let cardText        = $('#chz-card-text').val().trim();
    const situationText = $('#chz-situation-text').val().trim();
    const rawTurns      = parseInt($('#chz-turns').val(), 10);
    const turnsToCarry  = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurns) ? DEFAULT_TURNS_N : rawTurns));

    // Last-resort guard: strip any situation block the user may have pasted into the bio box.
    const sepIdx2 = cardText.indexOf(SITUATION_SEP);
    if (sepIdx2 !== -1) cardText = cardText.slice(0, sepIdx2);

    // Defensive guard: if the user pasted a separator + preamble into the situation box,
    // keep only the text that follows the separator so the scenario field stays clean.
    const sitSepIdx = situationText.indexOf(SITUATION_SEP);
    const cleanSituationText = sitSepIdx !== -1 ? situationText.slice(sitSepIdx + SITUATION_SEP.length).trim() : situationText;

    // Description carries only the character bio (Step 1 output).
    // Scenario carries _baseScenario (original world text) + divider + situation summary.
    const newDescription = cardText;
    const newScenario    = `${_baseScenario}${SITUATION_SEP}${cleanSituationText}`;

    $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', true);
    $('#chz-error-5').addClass('chz-hidden').text('');
    showReceiptsPanel();

    // ── Freshness Lock (first async op) ────────────────────────────────────────
    // Re-fetches the ledger and confirms the server HEAD has not moved since
    // the modal was opened. Aborts with a sync-conflict message if stale.
    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!await verifyFreshnessLock(char.avatar)) {
        abortWithSyncError();
        return;
    }

    // Capture chat data before any character-switching operations.
    // In repair mode, chatMetadata comes from the ledger node captured at commit time.
    let chatMetadata;
    let lastN;
    {
        const sourceMessages = _isRepairMode ? _repairSourceMessages : (context.chat ?? []);
        if (_isRepairMode) {
            chatMetadata = _ledgerManifest.nodes[_sessionStartId].snapshot.chatMetadata;
        } else {
            chatMetadata = context.chatMetadata;
        }
        const { carryMessages, splitPairIdx } = computeSplitIndex(sourceMessages, turnsToCarry);
        lastN = carryMessages;
        _splitPairIdx = splitPairIdx;   // keep Blade state current at finalize time

        // Zero-Overlap assertion: no archive pair may reference a carry-window message.
        // Guards against off-by-one errors in computeSplitIndex. Development-time only.
        if (getSettings().enableRag && lastN.length > 0) {
            const firstCarryMsg  = lastN[0];
            const archivePairs   = _stagedProsePairs.slice(0, splitPairIdx);
            const overlapDetected = archivePairs.some(p => p.user === firstCarryMsg || p.ai === firstCarryMsg);
            console.assert(!overlapDetected, '[CHZ] Blade invariant violated: an archive pair references a carry-window message');
            if (_splitIndexWhenRagBuilt !== null && splitPairIdx !== _splitIndexWhenRagBuilt) {
                console.warn(`[CHZ] Blade: _splitPairIdx shifted from ${_splitIndexWhenRagBuilt} (RAG build) to ${splitPairIdx} (finalize) — RAG file may not match carry window.`);
            }
            const nonSystem = sourceMessages.filter(m => !m.is_system && m.mes !== undefined);
            const isLastUm  = nonSystem.length > 0 && nonSystem[nonSystem.length - 1].is_user;
            const totalBase = isLastUm ? nonSystem.length - 1 : nonSystem.length;
            console.log(`[CHZ] Blade: archive=${totalBase - lastN.length} carry=${lastN.length} total=${totalBase} rag_pairs=${archivePairs.length}`);
        }
    }

    // ── Step 1: Card Save ──────────────────────────────────────────────────────
    if (!_finalizeSteps.cardSaved) {
        try {
            if (_isRepairMode) {
                // Repair mode: surgical overwrite of the existing chapter card.
                // _cloneAvatarUrl was set in onRepairClick to targetNode.filePointers.targetAvatar.
                const allChars   = SillyTavern.getContext().characters;
                const targetChar = allChars.find(c => c.avatar === _cloneAvatarUrl);
                if (!targetChar) throw new Error('Repair failed: target character card not found.');
                await saveCharacter(targetChar, newDescription, newScenario, _cloneName);
                await getCharacters();
                const freshCtx = SillyTavern.getContext();
                const idx = freshCtx.characters.findIndex(c => c.avatar === _cloneAvatarUrl);
                if (idx === -1) throw new Error('Character was saved but could not be located after reload.');
                await selectCharacterById(idx);
            } else if (_isChapterMode) {
                // Chapter mode: save description + bump display name in place.
                // Sequential: derive name only after save succeeds, so a save
                // failure does not leave _chapterName set to a stale value.
                await saveCharacter(char, newDescription, newScenario, _cloneName);
                _chapterName = await deriveChapterName(char.avatar);
                await getCharacters();
                const freshCtx = SillyTavern.getContext();
                const idx = freshCtx.characters.findIndex(c => c.avatar === char.avatar);
                if (idx === -1) throw new Error('Character was saved but could not be located after reload.');
                await selectCharacterById(idx);
            } else {
                // Clone mode: create new character card as "CharName (Ch1)".
                _cloneAvatarUrl = await createCharacterClone(char, _cloneName, newDescription, newScenario);
                await getCharacters();
                const freshCtx = SillyTavern.getContext();
                if (freshCtx.characters.findIndex(c => c.avatar === _cloneAvatarUrl) === -1) {
                    throw new Error(`Created ${_cloneName} but could not locate it in the character list.`);
                }
                _chapterName = await deriveChapterName(_cloneAvatarUrl);
            }

            _finalizeSteps.cardSaved = true;
            if (!_isRepairMode) persistChangelog(_chapterName);
            upsertReceiptItem('chz-receipt-card', receiptSuccess(
                `Character card saved as "${_cloneName}"`,
                _isRepairMode ? 'repair overwrote existing card' : 'further edits will overwrite this on retry',
            ));
            // Relabel Cancel → Close once any step has committed
            $('#chz-cancel').text('Close');

        } catch (err) {
            upsertReceiptItem('chz-receipt-card', receiptFailure(`Card save failed: ${err.message}`));
            $('#chz-error-5').text(err.message).removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
            showRecoveryGuide();
            return;
        }
    }

    // ── Step 2: RAG Upload ─────────────────────────────────────────────────────
    if (getSettings().enableRag && !_finalizeSteps.ragSaved) {
        try {
            const ragText    = _ragRawDetached
                ? $('#chz-rag-raw').val()
                : buildRagDocument(_ragChunks);
            if (_ragRawDetached) maybeWarnRawDocument(ragText);
            const ragFileName = `${_cloneName}.txt`;

            if (_isRepairMode) {
                // Physical deletion of the old RAG file before re-uploading under
                // the same name, preventing ST's "(1).txt" versioning behaviour.
                const oldRagFile = _ledgerManifest.nodes[_sessionStartId]?.filePointers.ragFile;
                if (oldRagFile) {
                    try {
                        await fetch('/api/files/delete', {
                            method:  'POST',
                            headers: getRequestHeaders(),
                            body:    JSON.stringify({ path: oldRagFile }),
                        });
                    } catch (_) { /* file may already be gone — continue */ }
                    // Scrub the dead URL from the character's attachment list
                    const attachments = extension_settings.character_attachments;
                    if (attachments?.[_cloneAvatarUrl]) {
                        attachments[_cloneAvatarUrl] = attachments[_cloneAvatarUrl]
                            .filter(a => a.url !== oldRagFile);
                    }
                }
            }

            const ragUrl      = await uploadRagFile(ragText, ragFileName);
            _lastRagUrl       = ragUrl;
            // Avatar key: repair uses _cloneAvatarUrl (set to targetNode.filePointers.targetAvatar)
            const ragAvatarKey = _isRepairMode
                ? _cloneAvatarUrl
                : _isChapterMode ? char.avatar : _cloneAvatarUrl;
            const ragByteSize = new TextEncoder().encode(ragText).length;
            registerCharacterAttachment(ragAvatarKey, ragUrl, ragFileName, ragByteSize);
            _finalizeSteps.ragSaved = true;
            const totalLinked = (extension_settings.character_attachments?.[ragAvatarKey] ?? []).length;
            upsertReceiptItem('chz-receipt-rag', receiptSuccess(
                `Narrative Memory saved: "${ragFileName}" (${_ragChunks.length} chunks)`,
                `${totalLinked} Data Bank file${totalLinked !== 1 ? 's' : ''} now linked to this character`,
            ));
        } catch (err) {
            upsertReceiptItem('chz-receipt-rag', receiptFailure(`RAG save failed: ${err.message}`));
            $('#chz-error-5')
                .text(`Character card saved — RAG upload failed: ${err.message}`)
                .removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
            showRecoveryGuide();
            return;
        }
    }

    // ── Step 3: Lorebook Save ──────────────────────────────────────────────────
    if (!_finalizeSteps.lorebookSaved) {
        if (_draftLorebook && _lorebookName) {
            try {
                // Capture the diff before the save so the delta reflects the
                // original server state, not the just-written draft.
                recordLorebookDelta();
                await lbSaveLorebook(_lorebookName, _draftLorebook);
                _finalizeSteps.lorebookSaved = true;

                // Report which entries were actually modified vs the original server copy
                const changedNames = Object.values(_draftLorebook.entries ?? {})
                    .filter(e => {
                        const orig = _lorebookData?.entries?.[String(e.uid)];
                        return !orig
                            || orig.content !== e.content
                            || JSON.stringify(orig.key) !== JSON.stringify(e.key);
                    })
                    .map(e => e.comment || String(e.uid));

                const nameList = changedNames.length
                    ? changedNames.map(n => `"${n}"`).join(', ')
                    : '(no changes staged)';

                upsertReceiptItem('chz-receipt-lorebook', receiptSuccess(
                    `Lorebook entries committed: ${nameList}`,
                    'additional staged entries will also be written on retry',
                ));
            } catch (err) {
                upsertReceiptItem('chz-receipt-lorebook', receiptFailure(
                    `Lorebook save failed: ${err.message}`,
                ));
                $('#chz-error-5')
                    .text(`Character card (and RAG) already saved — lorebook write failed: ${err.message}`)
                    .removeClass('chz-hidden');
                $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
                showRecoveryGuide();
                return;
            }
        } else {
            // No lorebook was opened this session — mark done and show neutral row
            _finalizeSteps.lorebookSaved = true;
            upsertReceiptItem('chz-receipt-lorebook', receiptSuccess('Lorebook: no changes staged'));
        }
    }

    // ── Step 4: Chat Save ──────────────────────────────────────────────────────
    if (!_finalizeSteps.chatSaved) {
        try {
            // Repair: _cloneAvatarUrl = targetNode.filePointers.targetAvatar (set in onRepairClick).
            const avatarKey = _isRepairMode
                ? _cloneAvatarUrl
                : _isChapterMode ? char.avatar : _cloneAvatarUrl;
            const freshCtx  = SillyTavern.getContext();
            const freshIdx  = freshCtx.characters.findIndex(c => c.avatar === avatarKey);
            if (freshIdx === -1) throw new Error('Could not locate character for chat save.');
            const freshChar = freshCtx.characters[freshIdx];

            await saveNewChat(freshChar, _chapterName, chatMetadata, lastN);
            _finalizeSteps.chatSaved      = true;
            _autoTriggerLastChatLen       = SillyTavern.getContext().chat.length;
            _autoTriggerSuppressUntil     = 0;
            upsertReceiptItem('chz-receipt-chat', receiptSuccess(
                `Chat saved: "${_chapterName}"`,
                _isRepairMode ? 'chapter chat reset to original turn 0' : undefined,
            ));
        } catch (err) {
            upsertReceiptItem('chz-receipt-chat', receiptFailure(
                `Chat save failed — retry will attempt this step only`,
            ));
            $('#chz-error-5')
                .text(`Character card, RAG, and lorebook already saved — chat creation failed: ${err.message}`)
                .removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
            showRecoveryGuide();
            return;
        }
    }

    // ── Ledger Commit ──────────────────────────────────────────────────────────
    // Build the new node from current session state and write the updated manifest.
    // In repair mode: tombstone the bad node before writing so a single POST
    // persists both the new head and the orphaned status in one round-trip.
    {
        const parentNodeId = _isRepairMode
            ? _ledgerManifest.nodes[_sessionStartId].parentId
            : _sessionStartId;
        const parentNode   = parentNodeId ? _ledgerManifest.nodes[parentNodeId] : null;
        const sequenceNum  = (parentNode?.sequenceNum ?? 0) + 1;

        const newNode = buildLedgerNode(parentNodeId, sequenceNum, chatMetadata);

        if (_isRepairMode) {
            _ledgerManifest.nodes[_sessionStartId].status = 'orphaned';
        }
        _ledgerManifest.nodes[newNode.nodeId] = newNode;
        _ledgerManifest.headNodeId = newNode.nodeId;

        try {
            await commitLedgerManifest(char.avatar);
            upsertReceiptItem('chz-receipt-ledger', receiptSuccess('Narrative Ledger updated'));
        } catch (err) {
            console.error('[Chapterize] Ledger commit failed:', err);
            // Non-fatal — chapter content is fully saved; only future repair is affected
            upsertReceiptItem('chz-receipt-ledger', receiptFailure(
                `Ledger save failed: ${err.message} (chapter content saved)`,
            ));
        }

        // ── Post-Commit Janitor (Repair mode only) ────────────────────────────
        // Runs after the manifest is committed so the story is in a valid state
        // even if cleanup fails. Reverts lorebook entries from the orphaned chapter
        // and scrubs its RAG attachment. Best-endeavors — never blocks navigation.
        if (_isRepairMode) {
            const badNode = _ledgerManifest.nodes[_sessionStartId];
            try {
                await revertLorebookDelta(badNode.snapshot.lorebookDelta);
            } catch (err) {
                console.warn('[Chapterize] Janitor: lorebook revert failed (best endeavors):', err);
            }
            try {
                await scrubOrphanedArtifacts(badNode.filePointers);
            } catch (err) {
                console.warn('[Chapterize] Janitor: artifact scrub failed (best endeavors):', err);
            }
        }
    }

    // ── Step 5: Navigate ───────────────────────────────────────────────────────
    try {
        // Repair mode: _isChapterMode is false and _cloneAvatarUrl holds the target avatar,
        // so this branch fires for all repairs (harmless re-select for chapter-mode originals).
        // Normal clone mode: same condition, selects the newly created clone.
        if (!_isChapterMode && _cloneAvatarUrl) {
            const freshCtx = SillyTavern.getContext();
            const idx = freshCtx.characters.findIndex(c => c.avatar === _cloneAvatarUrl);
            if (idx !== -1) await selectCharacterById(idx);
        }
        await openCharacterChat(_chapterName);
    } catch (err) {
        console.error('[Chapterize] Navigation failed:', err);
        closeModal();
        toastr.warning(`Chapter created. Could not auto-open — open "${_chapterName}" manually from the chat list.`);
        return;
    }

    // All steps succeeded — show the Close button so the user can review receipts
    // before dismissing. The chat is already open in the background.
    $('#chz-confirm').addClass('chz-hidden');
    $('#chz-cancel').text('Close').prop('disabled', false);
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Escapes a string for safe embedding in a RegExp pattern. */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Populates the #chz-step4-rag panel from the current character's
 * extension_settings.character_attachments. Read-only — no server writes.
 * Shows existing chapterize files, the pending entry, and any warnings
 * (duplicate filename, gap in chapter sequence).
 */
function populateRagPanel() {
    if (!getSettings().enableRag) {
        $('#chz-step5-rag').addClass('chz-hidden');
        return;
    }

    const context  = SillyTavern.getContext();
    const char     = context.characters[context.characterId];
    const pending  = `${_cloneName}.txt`;
    const basePat  = new RegExp(`^${escapeRegex(_lorebookName)} \\(Ch(\\d+)\\)\\.txt$`, 'i');

    // Gather chapterize-pattern files from the source character's Data Bank attachments
    const allAttachments = extension_settings.character_attachments?.[char?.avatar] ?? [];
    const existing = allAttachments
        .filter(a => basePat.test(a.name))
        .sort((a, b) => {
            const na = Number(a.name.match(basePat)?.[1] ?? 0);
            const nb = Number(b.name.match(basePat)?.[1] ?? 0);
            return na - nb;
        });

    const isDuplicate = existing.some(a => a.name === pending);

    // Build the timeline list
    const rows = existing.map(a => {
        if (a.name === pending) {
            return `<div class="chz-rag-item chz-rag-item--duplicate">\u26a0 ${escapeHtml(a.name.replace(/\.txt$/i, ''))}</div>`;
        }
        return `<div class="chz-rag-item chz-rag-item--existing">\u2713 ${escapeHtml(a.name.replace(/\.txt$/i, ''))}</div>`;
    });
    rows.push(`<div class="chz-rag-item chz-rag-item--pending">+ ${escapeHtml(pending.replace(/\.txt$/i, ''))} (Pending)</div>`);
    $('#chz-rag-timeline').html(rows.join(''));

    // Warnings
    const warnings = [];
    if (isDuplicate) {
        warnings.push(`"${pending}" already exists — Finalize will add a duplicate entry.`);
    }
    const existingNums = existing
        .map(a => Number(a.name.match(basePat)?.[1]))
        .filter(Boolean);
    for (let n = 1; n < _nextChNum - 1; n++) {
        if (!existingNums.includes(n)) warnings.push(`Ch ${n} is missing from this character's memory.`);
    }
    if (warnings.length) {
        $('#chz-rag-warning').text(warnings.join(' ')).removeClass('chz-hidden');
    } else {
        $('#chz-rag-warning').addClass('chz-hidden');
    }

    $('#chz-step5-rag').removeClass('chz-hidden');
}

/**
 * Reflects the current enableRag / ragAiMode settings onto the settings panel
 * by adding or removing the .chz-disabled class from the two subgroup containers.
 * Called on init and whenever either toggle changes.
 */
function updateRagSettingsState() {
    const ragEnabled = getSettings().enableRag;
    const aiEnabled  = ragEnabled && getSettings().ragAiMode;
    $('#chz-rag-settings-body').toggleClass('chz-disabled', !ragEnabled);
    $('#chz-rag-ai-controls').toggleClass('chz-disabled', !aiEnabled);
}

function bindSettingsHandlers() {
    $('#chz-repair-btn').on('click', onRepairClick);

    $('#chz-set-turns').on('input', () => {
        const val = parseInt($('#chz-set-turns').val(), 10);
        if (!isNaN(val) && val >= MIN_TURNS && val <= MAX_TURNS) {
            getSettings().turnsN = val;
            saveSettingsDebounced();
        }
    });

    $('#chz-set-autotrigger').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().autoTriggerEvery = val;
        saveSettingsDebounced();
    });

    $('#chz-set-snooze').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().autoTriggerSnoozeTurns = val;
        saveSettingsDebounced();
    });

    $('#chz-set-autotrigger-modal').on('change', () => {
        getSettings().autoTriggerModal = $('#chz-set-autotrigger-modal').is(':checked');
        saveSettingsDebounced();
    });

    $('#chz-set-changelog').on('change', () => {
        getSettings().storeChangelog = $('#chz-set-changelog').is(':checked');
        saveSettingsDebounced();
    });

    $('#chz-set-rag').on('change', () => {
        getSettings().enableRag = $('#chz-set-rag').is(':checked');
        saveSettingsDebounced();
        updateRagSettingsState();
    });

    $('#chz-set-rag-ai-mode').on('change', () => {
        getSettings().ragAiMode = $('#chz-set-rag-ai-mode').is(':checked');
        saveSettingsDebounced();
        updateRagSettingsState();
    });

    // Reflect initial state on panel load
    updateRagSettingsState();

    $('#chz-set-lookback').on('input', () => {
        const val = parseInt($('#chz-set-lookback').val(), 10);
        if (!isNaN(val) && val >= MIN_LOOKBACK && val <= MAX_LOOKBACK) {
            getSettings().classifierLookback = val;
            saveSettingsDebounced();
        }
    });

    $('#chz-set-concurrency').on('input', () => {
        const val = parseInt($('#chz-set-concurrency').val(), 10);
        if (!isNaN(val) && val >= MIN_CONCURRENCY && val <= MAX_CONCURRENCY) {
            getSettings().maxConcurrentCalls = val;
            saveSettingsDebounced();
        }
    });

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#chz-set-profile',
            getSettings().profileId ?? '',
            (profile) => {
                getSettings().profileId = profile?.id ?? null;
                saveSettingsDebounced();
            },
        );
    } catch (e) {
        console.warn('[Chapterize] Could not initialize profile dropdown:', e);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#chz-set-rag-profile',
            getSettings().ragProfileId ?? '',
            (profile) => {
                getSettings().ragProfileId = profile?.id ?? null;
                saveSettingsDebounced();
            },
        );
    } catch (e) {
        console.warn('[Chapterize] Could not initialize RAG profile dropdown:', e);
    }

    $('#chz-set-rag-max-tokens').on('input', () => {
        const val = parseInt($('#chz-set-rag-max-tokens').val(), 10);
        if (!isNaN(val) && val >= 1) {
            getSettings().ragMaxTokens = val;
            saveSettingsDebounced();
        }
    });

    $('#chz-set-prompt-card').on('input', () => {
        getSettings().cardPrompt = $('#chz-set-prompt-card').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-card-aft').on('input', () => {
        getSettings().cardPromptAft = $('#chz-set-prompt-card-aft').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-situation').on('input', () => {
        getSettings().situationPrompt = $('#chz-set-prompt-situation').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-situation-aft').on('input', () => {
        getSettings().situationPromptAft = $('#chz-set-prompt-situation-aft').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-lorebook').on('input', () => {
        getSettings().lorebookPrompt = $('#chz-set-prompt-lorebook').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-lorebook-aft').on('input', () => {
        getSettings().lorebookPromptAft = $('#chz-set-prompt-lorebook-aft').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-rag-classifier').on('input', () => {
        getSettings().ragClassifierPrompt = $('#chz-set-prompt-rag-classifier').val();
        saveSettingsDebounced();
    });

    $('.chz-reset-btn').on('click', function () {
        const targetId   = $(this).data('target');
        const key        = $(this).data('key');
        const defaultVal = SETTINGS_DEFAULTS[key];
        $(`#${targetId}`).val(defaultVal);
        getSettings()[key] = defaultVal;
        saveSettingsDebounced();
    });
}

function injectSettingsPanel() {
    if ($('.chz-settings-block').length) return;
    $('#extensions_settings').append(
        buildSettingsHTML(
            MIN_TURNS, MAX_TURNS,
            MIN_LOOKBACK, MAX_LOOKBACK,
            MIN_CONCURRENCY, MAX_CONCURRENCY,
            getSettings(), escapeHtml,
        ),
    );
    bindSettingsHandlers();
}

// ─── Button ───────────────────────────────────────────────────────────────────

function injectButton() {
    if ($('#chz-btn').length) return;
    const btn = $(
        '<div id="chz-btn" class="list-group-item flex-container flexGap5" title="Chapterize">' +
        '<i class="fa-solid fa-forward-step"></i>' +
        '<span>Chapterize</span>' +
        '</div>'
    );
    btn.on('click', onChapterizeClick);
    $('#extensionsMenu').append(btn);
}

// ─── Auto-trigger ─────────────────────────────────────────────────────────────

function showAutoTriggerBanner(count) {
    $('#chz-autotrigger-msg').text(`${count} turns ready to chapterize`);
    $('#chz-autotrigger-banner').removeClass('chz-hidden');
}

function hideAutoTriggerBanner() {
    $('#chz-autotrigger-banner').addClass('chz-hidden');
}

function checkAutoTrigger() {
    const threshold = getSettings().autoTriggerEvery ?? 10;
    if (!threshold) return;

    const context = SillyTavern.getContext();
    if (!context?.chat) return;
    if (context.groupId) return;
    if (context.characterId == null) return;

    const len = context.chat.length;
    if (len <= _autoTriggerSuppressUntil) return;

    const sinceLast = len - _autoTriggerLastChatLen;
    if (sinceLast < threshold) return;

    const snoozeTurns = getSettings().autoTriggerSnoozeTurns ?? 5;
    _autoTriggerSuppressUntil = snoozeTurns > 0 ? len + snoozeTurns : Infinity;

    if (getSettings().autoTriggerModal) {
        onChapterizeClick();
    } else {
        toastr.warning(`${sinceLast} turns ready to chapterize`, 'Chapterize', { timeOut: 8000 });
    }
}

function onMessageReceived() {
    checkAutoTrigger();
}

function onChatChanged() {
    hideAutoTriggerBanner();
    _autoTriggerLastChatLen   = 0;
    _autoTriggerSuppressUntil = 0;
    setTimeout(checkAutoTrigger, 0);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    initSettings();
    injectModal();
    injectSettingsPanel();
    injectButton();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'chapterize',
            helpString: 'Close the current chapter and transition to a new one',
            callback: () => { onChapterizeClick(); return ''; },
        }));
    } catch (e) {
        console.warn('[Chapterize] Could not register slash command:', e);
    }
}

await init();
