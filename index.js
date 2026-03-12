/**
 * @file data/default-user/extensions/chapterize/index.js
 * @stamp {"utc":"2026-03-11T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern extension that closes a roleplay chapter. On button click, fires
 * two parallel AI calls — a card audit (bullet-point suggestions) and a
 * situation summary — both rendered inline with independent spinners in a single
 * review step. The user edits the character description prose directly, guided
 * by the suggestions. On Confirm, writes the combined description + situation
 * block to the character card and creates a new chapter chat seeded with the
 * last N turns. The original chat file is never modified.
 * @core-principles
 * 1. OWNS the full chapterize workflow from button click through new chat open.
 * 2. MUST NOT commit any server write until the user clicks Confirm.
 * 3. DELEGATES all disk persistence to ST server endpoints via fetch; IS NOT
 *    responsible for direct filesystem access.
 * @api-declaration
 * Side-effect module — no exported symbols.
 * Registers on load: Chapterize button in #extensionsMenu,
 *   settings panel in #extensions_settings, hidden modal in <body>.
 * Entry point: onChapterizeClick() (bound to button).
 * @contract
 *   assertions:
 *     purity: mutates # Modifies module-level session state on each invocation.
 *     state_ownership: [_transcript, _originalDescription, _suggestionsLoading, _situationLoading, extension_settings.chapterize] # Owns all session and settings state.
 *     external_io: https_apis # generateRaw (LLM) and ST /api/* endpoints.
 */

import { generateRaw, saveSettingsDebounced, getRequestHeaders, openCharacterChat, getCharacters, selectCharacterById } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

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
4. Maintain the exact existing structure, headers (━━━━━━━━), and formatting.

CONSTRAINTS:
- DO NOT invent new categories (e.g., "Update Status").
- DO NOT rewrite paragraphs that are still factually accurate. 
- People change slowly; keep edits minimal and integrated into the current prose style.
- If no changes are needed, return the description as-is.

### OUTPUT FORMAT
Identify specific sections of the description that need updating or new blocks that should be added. Format your response as a series of snippets:

**### [Section Name/Header]**
[The replacement text or new text section]
*Reason: [One sentence explaining the change and where it goes]*

CHARACTER DESCRIPTION:
{{original_description}}

SESSION TRANSCRIPT:
{{transcript}}


`;

const DEFAULT_CARD_PROMPT_AFT = `
Generate 2–4 specific prose snippets based on the recent events. Each snippet should be written as a "drop-in" replacement or a new addition to the character's description. Maintain the established tone and formatting exactly. Do not provide meta-advice; provide the actual text to be used.
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

const SETTINGS_DEFAULTS = Object.freeze({
    turnsN:             DEFAULT_TURNS_N,
    storeChangelog:     true,
    cardPrompt:         DEFAULT_CARD_PROMPT,
    cardPromptAft:      DEFAULT_CARD_PROMPT_AFT,
    situationPrompt:    DEFAULT_SITUATION_PROMPT,
    situationPromptAft: DEFAULT_SITUATION_PROMPT_AFT,
    changelog:          [],
});

// ─── Session State ────────────────────────────────────────────────────────────
// Cleared at the start of each chapterize invocation.

let _transcript          = '';
let _originalDescription = '';
let _suggestionsLoading  = false;
let _situationLoading    = false;
let _isChapterMode       = false;   // true when current char already has a (ChX) suffix
let _nextChNum           = 1;       // chapter number to assign on next chapterize
let _cloneName           = '';      // display name for the chapter card (e.g. "CharName (Ch2)")
let _generationId        = 0;       // incremented on each new invocation; guards stale promise callbacks

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

// ─── Prompt Interpolation ─────────────────────────────────────────────────────

function interpolate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// ─── LLM Calls ───────────────────────────────────────────────────────────────

async function runSuggestionsCall() {
    const fore = interpolate(getSettings().cardPrompt, {
        original_description: _originalDescription,
        transcript:           _transcript,
    });
    const aft    = getSettings().cardPromptAft?.trim();
    const prompt = aft ? `${fore}\n\n${aft}` : fore;
    return generateRaw({ prompt, trimNames: false });
}

async function runSituationCall() {
    const fore = interpolate(getSettings().situationPrompt, {
        transcript:           _transcript,
        original_description: _originalDescription,
    });
    const aft    = getSettings().situationPromptAft?.trim();
    const prompt = aft ? `${fore}\n\n${aft}` : fore;
    return generateRaw({ prompt, trimNames: false });
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

// ─── Modal HTML ───────────────────────────────────────────────────────────────

const MODAL_HTML = `
<div id="chz-overlay" class="chz-overlay chz-hidden">
  <div id="chz-modal" class="chz-modal" role="dialog" aria-modal="true">

    <div id="chz-step-2" class="chz-step chz-hidden">
      <h3 class="chz-title">Finalize Character &amp; Situation</h3>

      <div class="chz-section-header">
        <span class="chz-label">AI Suggested Tweaks</span>
        <span id="chz-spin-suggestions" class="chz-section-spin fa-solid fa-spinner fa-spin chz-hidden"></span>
        <button id="chz-regen-suggestions" class="chz-btn chz-btn-secondary chz-btn-sm">&#x21bb;</button>
      </div>
      <div id="chz-suggestions" class="chz-suggestions-box"></div>

      <span class="chz-label">Edit Character Description</span>
      <textarea id="chz-card-text" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>

      <div class="chz-section-header">
        <span class="chz-label">Situation Summary</span>
        <span id="chz-spin-situation" class="chz-section-spin fa-solid fa-spinner fa-spin chz-hidden"></span>
        <button id="chz-regen-situation" class="chz-btn chz-btn-secondary chz-btn-sm">&#x21bb;</button>
      </div>
      <textarea id="chz-situation-text" class="chz-textarea" spellcheck="false"></textarea>

      <div class="chz-turns-row">
        <span class="chz-label">Turns to carry into new chapter</span>
        <input id="chz-turns" class="chz-turns-input" type="number"
               min="${MIN_TURNS}" max="${MAX_TURNS}" value="${DEFAULT_TURNS_N}">
      </div>

      <div id="chz-error-2" class="chz-error-banner chz-hidden"></div>
      <div class="chz-buttons">
        <button id="chz-confirm"  class="chz-btn chz-btn-primary">Confirm</button>
        <button id="chz-cancel-2" class="chz-btn chz-btn-secondary">Cancel</button>
      </div>
    </div>

  </div>
</div>`;

// ─── Modal UI ─────────────────────────────────────────────────────────────────

function injectModal() {
    if ($('#chz-overlay').length) return;
    $('body').append(MODAL_HTML);

    $('#chz-regen-suggestions').on('click', onRegenSuggestionsClick);
    $('#chz-regen-situation').on('click',   onRegenSituationClick);
    $('#chz-confirm').on('click',           onConfirmClick);
    $('#chz-cancel-2').on('click',          closeModal);
}

function showModal() {
    $('#chz-overlay').removeClass('chz-hidden');
}

function closeModal() {
    $('#chz-overlay').addClass('chz-hidden');
    _generationId++;
    _transcript          = '';
    _originalDescription = '';
    _suggestionsLoading  = false;
    _situationLoading    = false;
    _isChapterMode       = false;
    _nextChNum           = 1;
    _cloneName           = '';
}

function showStep2() {
    // Strip old situation block so user edits only the description prose
    $('#chz-card-text').val(_originalDescription);
    $('#chz-turns').val(getSettings().turnsN);
    $('#chz-error-2').addClass('chz-hidden').text('');
    setSuggestionsLoading(true);
    setSituationLoading(true);
    const titleText = _isChapterMode ? `Update to ${_cloneName}` : `Create ${_cloneName}`;
    $('#chz-step-2 .chz-title').text(titleText);
    $('#chz-step-2').removeClass('chz-hidden');
}

// ─── Section Loading State ────────────────────────────────────────────────────

function setSuggestionsLoading(isLoading) {
    _suggestionsLoading = isLoading;
    $('#chz-spin-suggestions').toggleClass('chz-hidden', !isLoading);
    $('#chz-regen-suggestions').prop('disabled', isLoading);
    if (isLoading) $('#chz-suggestions').empty();
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

function populateSuggestions(text) {
    setSuggestionsLoading(false);
    $('#chz-suggestions').html('<pre>' + escapeHtml(text) + '</pre>');
}

function populateSituation(text) {
    setSituationLoading(false);
    $('#chz-situation-text').val(text);
}

function showSuggestionsError(message) {
    setSuggestionsLoading(false);
    $('#chz-suggestions').html(`<span class="chz-error-inline">${escapeHtml(message)}</span>`);
}

function showSituationError(message) {
    setSituationLoading(false);
    $('#chz-error-2').text(message).removeClass('chz-hidden');
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

    const char = context.characters[context.characterId];

    const parsed   = parseChapter(char.name);
    _isChapterMode = parsed.isChapter;
    _nextChNum     = parsed.chNum + 1;
    _cloneName     = parsed.isChapter
        ? `${parsed.baseName} (Ch${_nextChNum})`
        : `${char.name} (Ch1)`;

    // Strip any existing situation block so the card editor shows only the prose.
    const raw    = char.description ?? '';
    const sepIdx = raw.indexOf(SITUATION_SEP);
    _originalDescription = sepIdx !== -1 ? raw.slice(0, sepIdx) : raw;
    _transcript          = buildTranscript(messages);

    showModal();
    showStep2();

    // Capture the generation ID for this invocation so that stale callbacks
    // from a previous invocation that is still in flight are silently dropped.
    const genId = ++_generationId;

    // Fire both calls in parallel — each resolves into its own section.
    runSuggestionsCall()
        .then(text => { if (_generationId !== genId) return; populateSuggestions(text); })
        .catch(err => {
            if (_generationId !== genId) return;
            console.error('[Chapterize] Suggestions call failed:', err);
            showSuggestionsError(`Generation failed: ${err.message}`);
        });

    runSituationCall()
        .then(text => { if (_generationId !== genId) return; populateSituation(text); })
        .catch(err => {
            if (_generationId !== genId) return;
            console.error('[Chapterize] Situation call failed:', err);
            showSituationError(`Situation generation failed: ${err.message}`);
        });
}

function onRegenSuggestionsClick() {
    setSuggestionsLoading(true);
    const genId = _generationId;
    runSuggestionsCall()
        .then(text => { if (_generationId !== genId) return; populateSuggestions(text); })
        .catch(err => {
            if (_generationId !== genId) return;
            console.error('[Chapterize] Suggestions regen failed:', err);
            showSuggestionsError(`Regeneration failed: ${err.message}`);
        });
}

function onRegenSituationClick() {
    setSituationLoading(true);
    const genId = _generationId;
    runSituationCall()
        .then(text => { if (_generationId !== genId) return; populateSituation(text); })
        .catch(err => {
            if (_generationId !== genId) return;
            console.error('[Chapterize] Situation regen failed:', err);
            showSituationError(`Regeneration failed: ${err.message}`);
        });
}

async function onConfirmClick() {
    let cardText        = $('#chz-card-text').val().trim();
    const situationText = $('#chz-situation-text').val().trim();
    const rawTurns      = parseInt($('#chz-turns').val(), 10);
    const turnsToCarry  = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurns) ? DEFAULT_TURNS_N : rawTurns));

    // Last-resort guard: strip any situation block the user may have left in
    // the description textarea (e.g. pasted from outside).
    const separatorIndex = cardText.indexOf(SITUATION_SEP);
    if (separatorIndex !== -1) {
        cardText = cardText.slice(0, separatorIndex);
    }

    $('#chz-confirm, #chz-cancel-2').prop('disabled', true);

    const context        = SillyTavern.getContext();
    const char           = context.characters[context.characterId];
    const newDescription = `${cardText}${SITUATION_SEP}${situationText}`;
    const lastN          = buildLastN(context.chat, turnsToCarry);

    if (_isChapterMode) {
        // ── Chapter card: update description AND bump display name in place ──
        // The avatar file (and all its chats) stays the same; only the display
        // name embedded in the PNG metadata changes (e.g. "(Ch2)" → "(Ch3)").

        const charSavePromise    = saveCharacter(char, newDescription, _cloneName);
        const chapterNamePromise = deriveChapterName(char.avatar);
        chapterNamePromise.catch(() => {});

        let isCharacterSaved = false;
        let chapterName;
        let freshChar;

        try {
            await charSavePromise;
            isCharacterSaved = true;
            // Reload character list so ST's in-memory state reflects the renamed card;
            // then re-select by avatar — mirrors what the clone path does.
            await getCharacters();
            const freshContext = SillyTavern.getContext();
            const updatedIdx   = freshContext.characters.findIndex(c => c.avatar === char.avatar);
            if (updatedIdx === -1) {
                throw new Error('Character was saved but could not be located after reload.');
            }
            await selectCharacterById(updatedIdx);
            freshChar   = SillyTavern.getContext().characters[updatedIdx];
            chapterName = await chapterNamePromise;
        } catch (err) {
            const suffix = isCharacterSaved ? ' (Character card was already saved.)' : '';
            $('#chz-error-2').text(`${err.message}${suffix}`).removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel-2').prop('disabled', false);
            return;
        }

        persistChangelog(chapterName);

        try {
            await saveNewChat(freshChar, chapterName, context.chatMetadata, lastN);
        } catch (err) {
            $('#chz-error-2').text(`${err.message} The character card has already been saved.`).removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel-2').prop('disabled', false);
            return;
        }

        try {
            await openCharacterChat(chapterName);
        } catch (err) {
            console.error('[Chapterize] openCharacterChat failed:', err);
            closeModal();
            toastr.warning("Chapter created. Could not auto-open — open it manually from the character's chat list.");
            return;
        }

        closeModal();

    } else {
        // ── Original character: clone it as "CharName (Ch1)" ─────────────────

        const cloneName = _cloneName || `${char.name} (Ch1)`;

        let cloneAvatarUrl;
        try {
            cloneAvatarUrl = await createCharacterClone(char, cloneName, newDescription);
        } catch (err) {
            $('#chz-error-2').text(err.message).removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel-2').prop('disabled', false);
            return;
        }

        // Refresh the character list so the clone is visible and selectable.
        await getCharacters();
        const freshContext = SillyTavern.getContext();
        const newCharIdx   = freshContext.characters.findIndex(c => c.avatar === cloneAvatarUrl);
        if (newCharIdx === -1) {
            $('#chz-error-2')
                .text(`Created ${cloneName} but could not locate it in the character list. Please select it manually.`)
                .removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel-2').prop('disabled', false);
            return;
        }

        const cloneChar   = freshContext.characters[newCharIdx];
        const chapterName = await deriveChapterName(cloneAvatarUrl);

        persistChangelog(chapterName);

        try {
            await saveNewChat(cloneChar, chapterName, context.chatMetadata, lastN);
        } catch (err) {
            $('#chz-error-2')
                .text(`${err.message} Character ${cloneName} was created but the chat could not be saved.`)
                .removeClass('chz-hidden');
            $('#chz-confirm, #chz-cancel-2').prop('disabled', false);
            return;
        }

        try {
            await selectCharacterById(newCharIdx);
            await openCharacterChat(chapterName);
        } catch (err) {
            console.error('[Chapterize] Character switch failed:', err);
            closeModal();
            toastr.warning(`${cloneName} created. Select it from the character list and open chat "${chapterName}".`);

            return;
        }

        closeModal();
    }
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildSettingsHtml() {
    const s = getSettings();
    return `
<div class="chz-settings-block inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Chapterize</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="chz-settings-group">

      <div class="chz-settings-row">
        <label for="chz-set-turns">Turns to carry over (default)</label>
        <input id="chz-set-turns" type="number"
               min="${MIN_TURNS}" max="${MAX_TURNS}" value="${s.turnsN}">
      </div>

      <div class="chz-settings-row">
        <label>
          <input id="chz-set-changelog" type="checkbox" ${s.storeChangelog ? 'checked' : ''}>
          Store changelog
        </label>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-card">Card/Suggestions prompt (before content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-card" data-key="cardPrompt">Reset</button>
        </div>
        <textarea id="chz-set-prompt-card" class="chz-settings-textarea">${escapeHtml(s.cardPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-card-aft">Card/Suggestions prompt (after content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-card-aft" data-key="cardPromptAft">Reset</button>
        </div>
        <textarea id="chz-set-prompt-card-aft" class="chz-settings-textarea">${escapeHtml(s.cardPromptAft)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-situation">Situation prompt (before content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-situation" data-key="situationPrompt">Reset</button>
        </div>
        <textarea id="chz-set-prompt-situation" class="chz-settings-textarea">${escapeHtml(s.situationPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-situation-aft">Situation prompt (after content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-situation-aft" data-key="situationPromptAft">Reset</button>
        </div>
        <textarea id="chz-set-prompt-situation-aft" class="chz-settings-textarea">${escapeHtml(s.situationPromptAft)}</textarea>
      </div>

    </div>
  </div>
</div>`;
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
    $('#extensions_settings').append(buildSettingsHtml());
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
}

await init();
