/**
 * @file data/default-user/extensions/chapterize/index.js
 * @stamp {"utc":"2026-03-14T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern extension that closes a roleplay chapter using a Draft/Commit
 * architecture. On button click, opens a 4-step wizard modal and fires three
 * AI calls in the background: bio suggestions and situation summary fire
 * immediately; the lorebook AI call fires after the lorebook fetch resolves.
 * Steps: (1) Character Workshop — 3-tab bio editor (Update, Draft Bio,
 * AI Raw); (2) Situation Workshop — situation summary + turns slider;
 * (3) Lorebook Workshop — diff-based Update tab with freeform AI output,
 * UID-anchored suggestions, Virtual Document diffing, and regen reconciliation;
 * (4) Review & Commit — pre-flight summary with pending-review guard and
 * sequential server writes.
 * All edits are staged in memory. On Finalize, changes are committed sequentially:
 *   1. Character card (create clone or edit-in-place)
 *   2. RAG upload (optional) — chapter transcript uploaded as a Data Bank file
 *      and registered in extension_settings.character_attachments for the card
 *   3. Lorebook (deferred bulk write of _draftLorebook)
 *   4. New chapter chat (seeded with last N turns)
 * The Commit Receipts panel tracks step completion for safe retries. Cancel
 * before any commit wipes all state; Cancel after a partial commit relabels to
 * "Close" and keeps receipts visible.
 * @core-principles
 * 1. OWNS the full chapterize workflow from button click through new chat open.
 * 2. MUST NOT commit any server write until the user clicks Finalize.
 *    Lorebook Apply stages changes to _draftLorebook only; the bulk server write
 *    happens as step 2 of the Finalize sequence.
 * 3. DELEGATES all disk persistence to ST server endpoints via fetch; IS NOT
 *    responsible for direct filesystem access.
 * @api-declaration
 * Side-effect module — no exported symbols.
 * Registers on load: Chapterize button in #extensionsMenu,
 *   settings panel in #extensions_settings (HTML built by buildSettingsHTML in ui.js),
 *   a hidden modal in <body> (HTML built by buildModalHTML in ui.js).
 * Entry point: onChapterizeClick() (bound to button).
 * Key internal APIs (Character Workshop): wordDiff, parseDescriptionSections,
 *   applyDescriptionSection, reparseSuggestions.
 * Key internal APIs (Lorebook Workshop): toVirtualDoc, makeLbDraftEntry,
 *   enrichLbSuggestions, updateLbDiff, onLbIngesterApply, onLbApplyAllUnresolved.
 * Key internal APIs (Narrative Memory / RAG): buildProsePairs, buildRagDocument,
 *   uploadRagFile, registerCharacterAttachment.
 * @contract
 *   assertions:
 *     purity: mutates # Modifies module-level session state on each invocation.
 *     state_ownership: [_transcript, _originalDescription, _stagedProsePairs,
 *       _cardSuggestions, _ingesterSnapshot, _ingesterDebounceTimer,
 *       _activeIngesterIndex, _chapterName, _cloneAvatarUrl, _finalizeSteps,
 *       _suggestionsGenId, _situationGenId, _lorebookGenId,
 *       _lorebookName, _lorebookData, _draftLorebook, _lorebookLoading,
 *       _lorebookSuggestions, _lbActiveIngesterIndex, _lbDebounceTimer,
 *       _lorebookFreeformLastParsed,
 *       _currentStep, _lorebookRawText, _lorebookRawError,
 *       extension_settings.chapterize]
 *     external_io: https_apis # generateWithProfile (LLM, via generateRaw or
 *       ConnectionManagerRequestService) and ST /api/* endpoints.
 *       callPopup (ST UI — Apply All Unresolved confirmation dialog).
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

const SETTINGS_DEFAULTS = Object.freeze({
    turnsN:              DEFAULT_TURNS_N,
    storeChangelog:      true,
    enableRag:           false,
    profileId:           null,
    cardPrompt:          DEFAULT_CARD_PROMPT,
    cardPromptAft:       DEFAULT_CARD_PROMPT_AFT,
    situationPrompt:     DEFAULT_SITUATION_PROMPT,
    situationPromptAft:  DEFAULT_SITUATION_PROMPT_AFT,
    lorebookPrompt:      DEFAULT_LOREBOOK_PROMPT,
    lorebookPromptAft:   DEFAULT_LOREBOOK_PROMPT_AFT,
    changelog:           [],
});

// ─── Session State ────────────────────────────────────────────────────────────
// Cleared at the start of each chapterize invocation.

let _transcript              = '';
let _originalDescription     = '';
let _priorSituation          = '';
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

// ─── Wizard State ─────────────────────────────────────────────────────────────

let _currentStep     = 1;    // active wizard step (1–4)
let _lorebookRawText = '';   // buffered AI result text for Step 3 freeform
let _lorebookRawError = '';  // buffered AI error message for Step 3

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
 * @returns {{user: object, ai: object}[]}
 */
function buildProsePairs(messages) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const pairs = [];
    for (let i = 0; i < valid.length - 1; i++) {
        if (valid[i].is_user && !valid[i + 1].is_user) {
            pairs.push({ user: valid[i], ai: valid[i + 1] });
        }
    }
    return pairs;
}

/**
 * Builds the RAG document: one situation-summary chunk followed by per-turn-pair
 * chunks, each prefixed with a short context line. Chunks are separated by `\n\n`
 * so SillyTavern's recursive splitter treats each as a discrete boundary.
 * Uses a sliding window of 2 pairs (stride 1) for overlap continuity.
 * @param {string} situationText  Finalized Situation Summary text.
 * @param {{user: object, ai: object}[]} pairs
 * @returns {string}
 */
function buildRagDocument(situationText, pairs) {
    if (!pairs.length) return situationText || '';
    const chunks = [];
    // Chunk 0: full situation summary (retrieved for narrative-state queries)
    if (situationText) chunks.push(situationText);
    // Short one-line context prefix for every turn chunk (truncated to stay under chunk_size_db)
    const contextLine = situationText
        ? `[Context: ${situationText.slice(0, 250).replace(/\n/g, ' ')}]`
        : '';
    // Sliding window of 2 pairs, stride 1; last window may be 1 pair
    for (let i = 0; i < pairs.length; i++) {
        const window = pairs.slice(i, i + 2);
        const turnText = window
            .map(p => `${p.user.name}: ${p.user.mes}\n${p.ai.name}: ${p.ai.mes}`)
            .join('\n');
        chunks.push(contextLine ? `${contextLine}\n${turnText}` : turnText);
    }
    return chunks.join('\n\n');
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
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name: fileName, data: utf8ToBase64(text) }),
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

async function generateWithProfile(prompt) {
    const profileId = getSettings().profileId;
    if (profileId) {
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, null);
        return result.content;
    }
    return generateRaw({ prompt, trimNames: false });
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
 * Builds a FormData populated with the character fields that are common to both
 * /api/characters/create and /api/characters/edit. Callers append their own
 * endpoint-specific fields afterward.
 * @param {object} char      - character object to source fields from
 * @param {object} overrides - optional { name?, description? } to override char's values
 */
function buildCharacterFormData(char, overrides = {}) {
    const name        = overrides.name        ?? char.name;
    const description = overrides.description ?? char.description;

    const formData = new FormData();
    formData.append('ch_name',                   name);
    formData.append('description',               description);
    formData.append('personality',               char.personality                     ?? '');
    formData.append('scenario',                  char.scenario                        ?? '');
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
async function createCharacterClone(sourceChar, cloneName, newDescription) {
    const formData = buildCharacterFormData(sourceChar, { name: cloneName, description: newDescription });

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

async function saveCharacter(char, newDescription, newName = null) {
    const updated = structuredClone(char);
    updated.description = newDescription;
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

// ─── Message Slice ────────────────────────────────────────────────────────────

/**
 * Returns messages starting from the last `turnsToCarry` turn boundary, then
 * walked back until an AI reply is the first message in the slice.
 * 1 turn = 1 user message + 1 AI response = 2 array elements.
 * If the chat ends on an unanswered user message, it is stripped first so
 * only complete pairs are carried.
 */
function buildLastN(messages, turnsToCarry) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const isLastUnmatched = valid.length > 0 && valid[valid.length - 1].is_user;
    const base = isLastUnmatched ? valid.slice(0, -1) : valid;
    // Step 1: go back to the N-turns boundary
    let start = Math.max(0, base.length - turnsToCarry * 2);
    // Step 2: walk back from there until we land on an AI reply
    while (start > 0 && base[start].is_user) {
        start--;
    }
    return base.slice(start);
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
    const lines      = text.split('\n');
    const rawHeaders = [];

    for (let i = 0; i < lines.length; i++) {
        if (isHeaderLine(lines[i])) {
            rawHeaders.push({ lineIdx: i, header: stripHeaderDecorators(lines[i]) });
        }
    }

    const seenCounts = {};
    const sections   = [];

    for (let i = 0; i < rawHeaders.length; i++) {
        const { lineIdx, header } = rawHeaders[i];
        seenCounts[header] = (seenCounts[header] || 0) + 1;
        const index = seenCounts[header];

        // Content starts after the header; skip an immediately adjacent decorator line
        let startLine = lineIdx + 1;
        if (startLine < lines.length && isDecoratorLine(lines[startLine])) {
            startLine++;
        }

        // Content ends at the first blank line or the next header, whichever comes first
        const nextIdx = i + 1 < rawHeaders.length ? rawHeaders[i + 1].lineIdx : lines.length;

        let endLine;
        const firstBlank = lines.slice(startLine, nextIdx).findIndex(l => l.trim() === '');
        if (firstBlank !== -1) {
            endLine = startLine + firstBlank - 1;
        } else {
            // No blank line — walk back past any leading decorator of the next section
            endLine = nextIdx - 1;
            if (endLine >= startLine && isDecoratorLine(lines[endLine])) {
                endLine--;
            }
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

// ─── Modal UI ─────────────────────────────────────────────────────────────────

function injectModal() {
    if ($('#chz-overlay').length) return;
    $('body').append(buildModalHTML(MIN_TURNS, MAX_TURNS, DEFAULT_TURNS_N));

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

    // Shared wizard footer
    $('#chz-cancel').on('click',    closeModal);
    $('#chz-move-back').on('click', () => updateWizard(_currentStep - 1));
    $('#chz-move-next').on('click', () => updateWizard(_currentStep + 1));
    $('#chz-confirm').on('click',   onConfirmClick);
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
    // Reset all session draft state
    _transcript              = '';
    _originalDescription     = '';
    _priorSituation          = '';
    _stagedProsePairs        = [];
    _cardSuggestions         = [];
    _ingesterSnapshot        = '';
    clearTimeout(_ingesterDebounceTimer);
    _ingesterDebounceTimer   = null;
    _activeIngesterIndex     = 0;
    _chapterName             = '';
    _cloneAvatarUrl          = '';
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
}

/**
 * One-time per-session initialisation — called once inside onChapterizeClick,
 * never by updateWizard. Populates the bio textarea, resets all transient UI,
 * and sets loading spinners before the parallel AI calls fire.
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
    $('#chz-error-4').addClass('chz-hidden').text('');
    $('#chz-receipts').addClass('chz-hidden');
    $('#chz-receipts-content').empty();
    $('#chz-cancel').text('Cancel').prop('disabled', false);

    _lorebookSuggestions        = [];
    _lbActiveIngesterIndex      = 0;
    _lorebookFreeformLastParsed = null;
    _lorebookRawText  = '';
    _lorebookRawError = '';

    onWorkshopTabSwitch('ingester');
    setSuggestionsLoading(true);
    setSituationLoading(true);
    setLbLoading(true);
}

/**
 * Shows the given wizard step (1–4), hides all others, and updates footer
 * button visibility. Populates the Step 4 summary when entering step 4.
 */
function updateWizard(n) {
    _currentStep = n;
    for (let i = 1; i <= 4; i++) {
        $(`#chz-step-${i}`).toggleClass('chz-hidden', i !== n);
    }
    $('#chz-move-back').toggleClass('chz-hidden', n === 1);
    $('#chz-move-next').toggleClass('chz-hidden', n === 4);
    $('#chz-confirm').toggleClass('chz-hidden',   n !== 4);
    if (n === 4) populateStep4Summary();
}

/**
 * Populates the Step 4 summary rows from current wizard state.
 * Called each time the user enters Step 4 so it reflects any Back edits.
 */
function populateStep4Summary() {
    const context = SillyTavern.getContext();
    const rawTurns = parseInt($('#chz-turns').val(), 10);
    const turnsToCarry = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurns) ? DEFAULT_TURNS_N : rawTurns));
    const lastN = buildLastN(context.chat ?? [], turnsToCarry);
    const loreCount = countDraftChanges();
    const mode = _isChapterMode ? 'edit-in-place' : 'clone';
    const loreLabel = loreCount === 1 ? '1 entry' : `${loreCount} entries`;
    const pendingLb = _lorebookSuggestions.filter(s => !s._applied && !s._rejected).length;
    const pendingText = pendingLb > 0
        ? ` \u26a0 ${pendingLb} suggestion${pendingLb !== 1 ? 's' : ''} pending review`
        : '';
    $('#chz-step4-target').text(`Target: ${_cloneName} (${mode})`);
    $('#chz-step4-context').text(`Context: ${lastN.length} messages being carried (${turnsToCarry} turns)`);
    $('#chz-step4-lore').text(`Lore: ${loreLabel} staged for update/creation${pendingText}`);
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

function populateSituation(text) {
    setSituationLoading(false);
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
    const parsed = parseChapter(char.name);
    _isChapterMode = parsed.isChapter;
    _nextChNum     = parsed.chNum + 1;
    _cloneName     = parsed.isChapter
        ? `${parsed.baseName} (Ch${_nextChNum})`
        : `${char.name} (Ch1)`;
    _lorebookName  = parsed.baseName;

    // Strip any existing situation block so the card editor shows only the prose.
    const raw    = char.description ?? '';
    const sepIdx = raw.indexOf(SITUATION_SEP);
    _originalDescription = sepIdx !== -1 ? raw.slice(0, sepIdx) : raw;
    _priorSituation      = sepIdx !== -1 ? raw.slice(sepIdx + SITUATION_SEP.length).trim() : '';
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

    // Last-resort guard: strip any situation block the user may have pasted in
    const sepIdx2 = cardText.indexOf(SITUATION_SEP);
    if (sepIdx2 !== -1) cardText = cardText.slice(0, sepIdx2);

    const newDescription = `${cardText}${SITUATION_SEP}${situationText}`;

    $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', true);
    $('#chz-error-4').addClass('chz-hidden').text('');
    showReceiptsPanel();

    // Capture context and chat data before any character-switching operations
    const context      = SillyTavern.getContext();
    const char         = context.characters[context.characterId];
    const chatMetadata = context.chatMetadata;
    const lastN        = buildLastN(context.chat, turnsToCarry);

    // ── Step 1: Card Save ──────────────────────────────────────────────────────
    if (!_finalizeSteps.cardSaved) {
        try {
            if (_isChapterMode) {
                // Chapter mode: save description + bump display name in place.
                // Sequential: derive name only after save succeeds, so a save
                // failure does not leave _chapterName set to a stale value.
                await saveCharacter(char, newDescription, _cloneName);
                _chapterName = await deriveChapterName(char.avatar);
                await getCharacters();
                const freshCtx = SillyTavern.getContext();
                const idx = freshCtx.characters.findIndex(c => c.avatar === char.avatar);
                if (idx === -1) throw new Error('Character was saved but could not be located after reload.');
                await selectCharacterById(idx);
            } else {
                // Clone mode: create new character card as "CharName (Ch1)".
                _cloneAvatarUrl = await createCharacterClone(char, _cloneName, newDescription);
                await getCharacters();
                const freshCtx = SillyTavern.getContext();
                if (freshCtx.characters.findIndex(c => c.avatar === _cloneAvatarUrl) === -1) {
                    throw new Error(`Created ${_cloneName} but could not locate it in the character list.`);
                }
                _chapterName = await deriveChapterName(_cloneAvatarUrl);
            }

            _finalizeSteps.cardSaved = true;
            persistChangelog(_chapterName);
            upsertReceiptItem('chz-receipt-card', receiptSuccess(
                `Character card saved as "${_cloneName}"`,
                'further edits will overwrite this on retry',
            ));
            // Relabel Cancel → Close once any step has committed
            $('#chz-cancel').text('Close');

        } catch (err) {
            upsertReceiptItem('chz-receipt-card', receiptFailure(`Card save failed: ${err.message}`));
            $('#chz-error-4').text(err.message).removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
            return;
        }
    }

    // ── Step 2: RAG Upload ─────────────────────────────────────────────────────
    if (getSettings().enableRag && !_finalizeSteps.ragSaved) {
        try {
            const situationText = $('#chz-situation-text').val().trim();
            const ragText       = buildRagDocument(situationText, _stagedProsePairs);
            const ragFileName   = `${_cloneName}.txt`;
            const ragUrl        = await uploadRagFile(ragText, ragFileName);
            // After card save, _cloneAvatarUrl is set for clone mode; chapter mode keeps char.avatar
            const ragAvatarKey  = _isChapterMode ? char.avatar : _cloneAvatarUrl;
            const ragByteSize   = new TextEncoder().encode(ragText).length;
            registerCharacterAttachment(ragAvatarKey, ragUrl, ragFileName, ragByteSize);
            _finalizeSteps.ragSaved = true;
            const totalLinked = (extension_settings.character_attachments?.[ragAvatarKey] ?? []).length;
            upsertReceiptItem('chz-receipt-rag', receiptSuccess(
                `Narrative Memory saved: "${ragFileName}" (${_stagedProsePairs.length} turns)`,
                `${totalLinked} Data Bank file${totalLinked !== 1 ? 's' : ''} now linked to this character`,
            ));
        } catch (err) {
            upsertReceiptItem('chz-receipt-rag', receiptFailure(`RAG save failed: ${err.message}`));
            $('#chz-error-4')
                .text(`Character card saved — RAG upload failed: ${err.message}`)
                .removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
            return;
        }
    }

    // ── Step 3: Lorebook Save ──────────────────────────────────────────────────
    if (!_finalizeSteps.lorebookSaved) {
        if (_draftLorebook && _lorebookName) {
            try {
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
                $('#chz-error-4')
                    .text(`Character card (and RAG) already saved — lorebook write failed: ${err.message}`)
                    .removeClass('chz-hidden');
                $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
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
            const freshCtx   = SillyTavern.getContext();
            const avatarKey  = _isChapterMode ? char.avatar : _cloneAvatarUrl;
            const freshIdx   = freshCtx.characters.findIndex(c => c.avatar === avatarKey);
            if (freshIdx === -1) throw new Error('Could not locate character for chat save.');
            const freshChar  = freshCtx.characters[freshIdx];

            await saveNewChat(freshChar, _chapterName, chatMetadata, lastN);
            _finalizeSteps.chatSaved = true;
            upsertReceiptItem('chz-receipt-chat', receiptSuccess(
                `Chat saved: "${_chapterName}"`,
            ));
        } catch (err) {
            upsertReceiptItem('chz-receipt-chat', receiptFailure(
                `Chat save failed — retry will attempt this step only`,
            ));
            $('#chz-error-4')
                .text(`Character card, RAG, and lorebook already saved — chat creation failed: ${err.message}`)
                .removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel, #chz-move-back').prop('disabled', false);
            return;
        }
    }

    // ── Step 5: Navigate ───────────────────────────────────────────────────────
    try {
        // For clone mode: switch active character to the new clone before opening chat
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

    closeModal();
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
        $('#chz-step4-rag').addClass('chz-hidden');
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

    $('#chz-step4-rag').removeClass('chz-hidden');
}

function bindSettingsHandlers() {
    $('#chz-set-turns').on('input', () => {
        const val = parseInt($('#chz-set-turns').val(), 10);
        if (!isNaN(val) && val >= MIN_TURNS && val <= MAX_TURNS) {
            getSettings().turnsN = val;
            saveSettingsDebounced();
        }
    });

    $('#chz-set-changelog').on('change', () => {
        getSettings().storeChangelog = $('#chz-set-changelog').is(':checked');
        saveSettingsDebounced();
    });

    $('#chz-set-rag').on('change', () => {
        getSettings().enableRag = $('#chz-set-rag').is(':checked');
        saveSettingsDebounced();
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
    $('#extensions_settings').append(buildSettingsHTML(MIN_TURNS, MAX_TURNS, getSettings(), escapeHtml));
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

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    initSettings();
    injectModal();
    injectSettingsPanel();
    injectButton();

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
