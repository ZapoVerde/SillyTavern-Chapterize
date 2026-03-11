/**
 * @file extensions/chapterize/index.js
 * @stamp {"utc":"2026-03-11T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern extension that closes a roleplay chapter. On user command it:
 * generates an AI digest from the transcript (Call 1, user reviews);
 * then generates an updated character card prose and situation summary in
 * parallel (Calls 2+3, user reviews); then on Confirm writes the new
 * description to the character card and creates a new chapter chat file
 * seeded with the last N turns. Original chat file is never modified (a new
 * one is created), but the Character Card is updated.
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
 *     purity: mutates
 *     state_ownership: [_transcript, _originalDescription, _digestContent, extension_settings.chapterize]
 *     external_io: https_apis
 */

import { generateRaw, saveSettingsDebounced, getRequestHeaders, openCharacterChat } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME    = 'chapterize';
const MIN_TURNS   = 1;
const MAX_TURNS   = 10;
const DEFAULT_TURNS_N = 4;

const DEFAULT_DIGEST_PROMPT = `You are summarising a session of collaborative fiction for the player to review.

Below is a session transcript. Write a summary of what happened: where the story went, what the key moments were, how things stand at the end.

Write for a human reader who was there but wants a clear digest to review and correct. Be specific — name the moments that mattered, name what shifted. Aim for 150-250 words.

Do not add preamble. Output only the summary.

SESSION TRANSCRIPT:
{{transcript}}`;

const DEFAULT_DIGEST_PROMPT_AFT = `REMINDER: Your task is to summarise the transcript above, not continue it. Write a 150-250 word summary of what happened. Do not add preamble. Output only the summary.`;

const DEFAULT_CARD_PROMPT = `You are a precise editor making minimal corrections to a character description.

Below is a character description, a session transcript, and a player-reviewed summary of the session. Treat anything in the summary that does not appear in the transcript as a deliberate correction or addition by the player — weight it accordingly.

The description may contain a situation summary separated by ---. If so, ignore everything after --- — that will be handled separately.

Find the smallest possible edit that makes the character description accurate. Do not rewrite. Do not improve. Do not polish. Change only what is now factually wrong or critically missing.

Return the complete character description with the minimal edit applied, followed by a blank line, then ---CHANGES--- then a line diff showing only what changed. If nothing needed changing, return the description unchanged followed by ---CHANGES--- and "No changes."

CHARACTER DESCRIPTION:
{{original_description}}

SESSION TRANSCRIPT:
{{transcript}}

PLAYER-REVIEWED SUMMARY:
{{edited_digest}}`;

const DEFAULT_SITUATION_PROMPT = `You are writing the situation summary for the opening of the next session of a collaborative fiction story. This will be inserted into the character card and read by the AI at the start of the next session as a replacement for the full session — grounding it in where the story stands without replaying what happened.

Below is a session transcript and a player-reviewed summary. Treat anything in the summary that does not appear in the transcript as a deliberate correction or addition by the player — weight it accordingly.

Write in present tense. Be specific — name the location, who is present, what is unresolved, what the emotional temperature is. Aim for 100-150 words. Do not narrate. Do not editorialize. Do not add preamble. Output only the summary text.

SESSION TRANSCRIPT:
{{transcript}}

PLAYER-REVIEWED SUMMARY:
{{edited_digest}}`;

const DEFAULT_CARD_PROMPT_AFT = `REMINDER: Your task is to make the smallest possible edit to the character description above. Do not rewrite. Do not improve. Do not polish. Return the complete description with only what is factually wrong or critically missing corrected, followed by ---CHANGES--- and a line diff. If nothing needed changing, return it unchanged followed by ---CHANGES--- and "No changes."`;

const DEFAULT_SITUATION_PROMPT_AFT = `REMINDER: Your task is to write a 100-150 word situation summary in present tense. Do not narrate. Do not editorialize. Do not add preamble. Output only the summary text.`;

const SETTINGS_DEFAULTS = Object.freeze({
    turnsN:              DEFAULT_TURNS_N,
    storeChangelog:      true,
    digestPrompt:        DEFAULT_DIGEST_PROMPT,
    digestPromptAft:     DEFAULT_DIGEST_PROMPT_AFT,
    cardPrompt:          DEFAULT_CARD_PROMPT,
    cardPromptAft:       DEFAULT_CARD_PROMPT_AFT,
    situationPrompt:     DEFAULT_SITUATION_PROMPT,
    situationPromptAft:  DEFAULT_SITUATION_PROMPT_AFT,
    changelog:           [],
});

// ─── Session State ────────────────────────────────────────────────────────────
// Cleared at the start of each chapterize invocation.

let _transcript          = '';
let _originalDescription = '';
let _digestContent       = '';

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

// ─── Step 2 LLM Calls ────────────────────────────────────────────────────────

/**
 * Runs card prose and situation summary calls in parallel (Calls 2 + 3).
 * Returns { cardText, situationText }.
 */
async function runStep2Calls(editedDigest) {
    const cardFore = interpolate(getSettings().cardPrompt, {
        original_description: _originalDescription,
        transcript:           _transcript,
        edited_digest:        editedDigest,
    });
    const cardAft  = getSettings().cardPromptAft?.trim();
    const cardPrompt = cardAft ? `${cardFore}\n\n${cardAft}` : cardFore;

    const situationFore = interpolate(getSettings().situationPrompt, {
        transcript:    _transcript,
        edited_digest: editedDigest,
    });
    const situationAft  = getSettings().situationPromptAft?.trim();
    const situationPrompt = situationAft ? `${situationFore}\n\n${situationAft}` : situationFore;

    const cardText      = await generateRaw({ prompt: cardPrompt,      trimNames: false });
    const situationText = await generateRaw({ prompt: situationPrompt, trimNames: false });

    return { cardText, situationText };
}

// ─── Character Save ───────────────────────────────────────────────────────────

async function saveCharacter(char, newDescription) {
    const updated = structuredClone(char);
    updated.description = newDescription;

    const formData = new FormData();
    formData.append('json_data',                 JSON.stringify(updated));
    formData.append('avatar_url',                updated.avatar);
    formData.append('ch_name',                   updated.name);
    formData.append('description',               updated.description);
    formData.append('personality',               updated.personality                     ?? '');
    formData.append('scenario',                  updated.scenario                        ?? '');
    formData.append('first_mes',                 updated.first_mes                       ?? '');
    formData.append('mes_example',               updated.mes_example                     ?? '');
    formData.append('creator_notes',             updated.data?.creator_notes             ?? '');
    formData.append('system_prompt',             updated.data?.system_prompt             ?? '');
    formData.append('post_history_instructions', updated.data?.post_history_instructions ?? '');
    formData.append('tags',                      JSON.stringify(updated.tags             ?? []));
    formData.append('creator',                   updated.data?.creator                   ?? '');
    formData.append('character_version',         updated.data?.character_version         ?? '');
    formData.append('alternate_greetings',       JSON.stringify(updated.data?.alternate_greetings ?? []));
    formData.append('chat',                      updated.chat);
    formData.append('create_date',               updated.create_date);

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

function persistChangelog(chapterName, digest) {
    if (!getSettings().storeChangelog) return;
    getSettings().changelog.push({
        date: new Date().toISOString(),
        chapterName,
        digest,
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
 * Returns the last `turnsToCarry` complete turn pairs from `messages`.
 * 1 turn = 1 user message + 1 AI response = 2 array elements.
 * If the chat ends on an unanswered user message, it is stripped first so
 * only complete pairs are carried.
 */
function buildLastN(messages, turnsToCarry) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const isLastUnmatched = valid.length > 0 && valid[valid.length - 1].is_user;
    const base = isLastUnmatched ? valid.slice(0, -1) : valid;
    return base.slice(-(turnsToCarry * 2));
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

    <div id="chz-loading" class="chz-loading chz-hidden">
      <span class="chz-spinner fa-solid fa-spinner fa-spin"></span>
      <span id="chz-loading-msg">Generating...</span>
    </div>

    <div id="chz-step-1" class="chz-step chz-hidden">
      <h3 class="chz-title">Review session digest</h3>
      <textarea id="chz-digest" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
      <div id="chz-error-1" class="chz-error-banner chz-hidden"></div>
      <div class="chz-buttons">
        <button id="chz-next"     class="chz-btn chz-btn-primary">Next \u2192</button>
        <button id="chz-regen-1"  class="chz-btn chz-btn-secondary">Regenerate</button>
        <button id="chz-cancel-1" class="chz-btn chz-btn-secondary">Cancel</button>
      </div>
    </div>

    <div id="chz-step-2" class="chz-step chz-hidden">
      <h3 class="chz-title">Review updated character and situation</h3>

      <span class="chz-label">Updated Character Description</span>
      <textarea id="chz-card-text" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
      <div id="chz-card-diff" class="chz-diff"></div>

      <span class="chz-label">Situation Summary</span>
      <textarea id="chz-situation-text" class="chz-textarea" spellcheck="false"></textarea>

      <div class="chz-turns-row">
        <span class="chz-label">Turns to carry into new chapter</span>
        <input id="chz-turns" class="chz-turns-input" type="number"
               min="${MIN_TURNS}" max="${MAX_TURNS}" value="${DEFAULT_TURNS_N}">
      </div>

      <div id="chz-error-2" class="chz-error-banner chz-hidden"></div>
      <div class="chz-buttons">
        <button id="chz-back"     class="chz-btn chz-btn-secondary">\u2190 Back</button>
        <button id="chz-regen"    class="chz-btn chz-btn-secondary">Regenerate</button>
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

    $('#chz-next').on('click',     onNextClick);
    $('#chz-regen-1').on('click',  onRegen1Click);
    $('#chz-cancel-1').on('click', closeModal);
    $('#chz-back').on('click',     onBackClick);
    $('#chz-regen').on('click',    onRegenClick);
    $('#chz-confirm').on('click',  onConfirmClick);
    $('#chz-cancel-2').on('click', closeModal);
}

function showModal() {
    $('#chz-overlay').removeClass('chz-hidden');
}

function closeModal() {
    $('#chz-overlay').addClass('chz-hidden');
    _transcript          = '';
    _originalDescription = '';
    _digestContent       = '';
}

function showLoading(msg) {
    $('#chz-step-1, #chz-step-2').addClass('chz-hidden');
    $('#chz-loading-msg').text(msg ?? 'Generating...');
    $('#chz-loading').removeClass('chz-hidden');
}

function showStep1(digest) {
    $('#chz-loading, #chz-step-2').addClass('chz-hidden');
    $('#chz-error-1').addClass('chz-hidden').text('');
    $('#chz-digest').val(digest);
    setStep1Busy(false);
    $('#chz-step-1').removeClass('chz-hidden');
}

function showStep1WithError(message) {
    $('#chz-loading, #chz-step-2').addClass('chz-hidden');
    $('#chz-digest').val('');
    $('#chz-error-1')
        .html(`${escapeHtml(message)} <button id="chz-retry" class="chz-btn chz-btn-secondary chz-btn-inline">Retry</button>`)
        .removeClass('chz-hidden');
    $('#chz-retry').on('click', retryDigest);
    $('#chz-step-1').removeClass('chz-hidden');
}

function showStep2(cardText, situationText) {
    $('#chz-loading, #chz-step-1').addClass('chz-hidden');

    // Parse ---CHANGES--- out of the card response.
    // The card prompt instructs the model to append ---CHANGES--- followed by a line diff.
    // Split here so the textarea shows only the clean description and the diff is display-only.
    const parts     = cardText.split('\n\n---CHANGES---');
    const cleanCard = parts[0].trim();
    const diffText  = parts.length > 1 ? parts[1].trim() : '(no diff returned)';

    $('#chz-card-text').val(cleanCard);
    $('#chz-card-diff').text(diffText);
    $('#chz-situation-text').val(situationText);
    $('#chz-turns').val(getSettings().turnsN);
    $('#chz-error-2').addClass('chz-hidden').text('');
    setStep2Busy(false);
    $('#chz-step-2').removeClass('chz-hidden');
}

function showStep2WithError(message) {
    $('#chz-loading').addClass('chz-hidden');
    $('#chz-step-2').removeClass('chz-hidden');
    setStep2Busy(false);
    $('#chz-card-diff').text('');
    $('#chz-error-2').text(message).removeClass('chz-hidden');
}

function setStep2Busy(isBusy) {
    $('#chz-back, #chz-regen, #chz-confirm, #chz-cancel-2').prop('disabled', isBusy);
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

    const char           = context.characters[context.characterId];
    _originalDescription = char.description ?? '';
    _transcript          = buildTranscript(messages);

    showModal();
    showLoading('Generating digest...');
    await runDigestCall();
}

async function runDigestCall() {
    try {
        const fore = interpolate(getSettings().digestPrompt, { transcript: _transcript });
        const aft  = getSettings().digestPromptAft?.trim();
        const prompt = aft ? `${fore}\n\n${aft}` : fore;
        const digest = await generateRaw({ prompt, trimNames: false });
        _digestContent = digest;
        showStep1(digest);
    } catch (err) {
        console.error('[Chapterize] Digest generation failed:', err);
        showStep1WithError(`Generation failed: ${err.message}`);
    }
}

async function retryDigest() {
    showLoading('Retrying...');
    await runDigestCall();
}

async function onRegen1Click() {
    setStep1Busy(true);
    showLoading('Regenerating digest...');
    await runDigestCall();
}

function setStep1Busy(isBusy) {
    $('#chz-next, #chz-regen-1, #chz-cancel-1').prop('disabled', isBusy);
}

async function onNextClick() {
    const editedDigest = $('#chz-digest').val();
    _digestContent     = editedDigest;
    $('#chz-next').prop('disabled', true);
    showLoading('Generating character card and situation...');
    await runAndShowStep2(editedDigest);
}

function onBackClick() {
    showStep1(_digestContent);
}

async function onRegenClick() {
    setStep2Busy(true);
    showLoading('Regenerating...');
    await runAndShowStep2(_digestContent);
}

async function runAndShowStep2(editedDigest) {
    try {
        const { cardText, situationText } = await runStep2Calls(editedDigest);
        showStep2(cardText, situationText);
    } catch (err) {
        console.error('[Chapterize] Step 2 generation failed:', err);
        showStep2WithError(`Generation failed: ${err.message}. Edit the fields manually or use Regenerate.`);
    }
}

async function onConfirmClick() {
    let cardText        = $('#chz-card-text').val().trim();
    const situationText = $('#chz-situation-text').val().trim();
    const rawTurns      = parseInt($('#chz-turns').val(), 10);
    const turnsToCarry  = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurns) ? DEFAULT_TURNS_N : rawTurns));

    // Last-resort guard: the card prompt instructs the model to exclude the old situation
    // block (separated by \n\n---\n\n), but strip it here in case of partial compliance.
    // Using \n\n---\n\n as the target to reduce the chance of clipping a legitimate markdown
    // thematic break that lacks a trailing blank line, though this is not a full guarantee.
    const separatorIndex = cardText.indexOf('\n\n---\n\n');
    if (separatorIndex !== -1) {
        cardText = cardText.slice(0, separatorIndex);
    }

    setStep2Busy(true);
    showLoading('Saving...');

    const context        = SillyTavern.getContext();
    const char           = context.characters[context.characterId];
    const newDescription = `${cardText}\n\n---\n\n${situationText}`;
    const lastN          = buildLastN(context.chat, turnsToCarry);

    // Both operations start immediately and run in parallel.
    // Awaited separately so we can attribute errors precisely.
    const charSavePromise    = saveCharacter(char, newDescription);
    const chapterNamePromise = deriveChapterName(char.avatar);
    chapterNamePromise.catch(() => {}); // Prevent unhandled rejection if it fails before charSavePromise settles

    let isCharacterSaved = false;
    let chapterName;

    try {
        await charSavePromise;
        isCharacterSaved = true;
        chapterName = await chapterNamePromise;
    } catch (err) {
        const suffix = isCharacterSaved ? ' (Character card was already saved.)' : '';
        showStep2WithError(`${err.message}${suffix}`);
        return;
    }

    // Persist changelog after chapterName is known, before remaining writes
    persistChangelog(chapterName, _digestContent);

    try {
        await saveNewChat(char, chapterName, context.chatMetadata, lastN);
    } catch (err) {
        showStep2WithError(`${err.message} The character card has already been saved.`);
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
        <label for="chz-set-prompt-digest">Digest prompt (before transcript)</label>
        <textarea id="chz-set-prompt-digest" class="chz-settings-textarea">${escapeHtml(s.digestPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-digest-aft">Digest prompt (after transcript)</label>
        <textarea id="chz-set-prompt-digest-aft" class="chz-settings-textarea">${escapeHtml(s.digestPromptAft)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-card">Character Card prompt (before content)</label>
        <textarea id="chz-set-prompt-card" class="chz-settings-textarea">${escapeHtml(s.cardPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-card-aft">Character Card prompt (after content)</label>
        <textarea id="chz-set-prompt-card-aft" class="chz-settings-textarea">${escapeHtml(s.cardPromptAft)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-situation">Situation Summary prompt (before content)</label>
        <textarea id="chz-set-prompt-situation" class="chz-settings-textarea">${escapeHtml(s.situationPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-situation-aft">Situation Summary prompt (after content)</label>
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

    $('#chz-set-prompt-digest').on('input', () => {
        getSettings().digestPrompt = $('#chz-set-prompt-digest').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-digest-aft').on('input', () => {
        getSettings().digestPromptAft = $('#chz-set-prompt-digest-aft').val();
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
