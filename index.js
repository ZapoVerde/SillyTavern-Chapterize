/**
 * @file extensions/chapterize/index.js
 * @stamp {"utc":"2026-03-11T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern extension that closes a roleplay chapter. On user command it:
 * generates an AI change list from the transcript (Call 1, user reviews);
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
 *     state_ownership: [_transcript, _originalDescription, _changeListContent, extension_settings.chapterize]
 *     external_io: https_apis
 */

import { generateRaw, saveSettingsDebounced, getRequestHeaders, openCharacterChat, getContext } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME    = 'chapterize';
const MIN_TURNS   = 1;
const MAX_TURNS   = 10;
const DEFAULT_TURNS_N = 4;

const DEFAULT_CHANGE_LIST_PROMPT = `You are analysing a collaborative fiction roleplay transcript.
Below is a character description as it stood at the start of this chapter,
followed by the full transcript of what happened.

List the narratively significant changes to this character.
Consider: emotional shifts, relationship developments, secrets revealed,
knowledge gained, goals changed, trust earned or lost, physical changes if any.

Write as a simple bullet list. Be specific — reference actual events.
Do not write prose. Do not add preamble or explanation.
Output only the bullet list.

ORIGINAL DESCRIPTION:
{{original_description}}

TRANSCRIPT:
{{transcript}}`;

const DEFAULT_CARD_PROMPT = `You are updating a character description for a collaborative fiction character.
Below is the original character description and a list of changes that occurred
during the most recent chapter.

Write an updated character description that reflects who this character is RIGHT NOW.
Write in the same style and format as the original description.
Do not summarise events. Write the character, not the story.
Do not add preamble or explanation. Output only the updated description text.

ORIGINAL DESCRIPTION:
{{original_description}}

CHANGES THIS CHAPTER:
{{edited_change_list}}`;

const DEFAULT_SITUATION_PROMPT = `You are writing a scene-setting summary for the opening of a new chapter
in a collaborative fiction story.
Below is a transcript of the chapter so far.

Write a concise situation summary: where we are, what has just happened,
what is unresolved or hanging in the air.
Tone should match the story. This will be read by the AI at the start of
the next session as grounding context, not as narrative prose for the player.
Write in present tense. Be specific. Aim for 150-250 words.
Do not add preamble or explanation. Output only the summary text.

TRANSCRIPT:
{{transcript}}`;

const DEFAULT_SELFCHECK_PROMPT = `Review the following output for a collaborative fiction character/situation description.
Flag any hallucinations, contradictions with the source material, or missing critical information.
If the output is acceptable, reply only with: OK
If not, reply with a brief note of what needs fixing.

OUTPUT:
{{generated_text}}

SOURCE:
{{transcript_or_change_list}}`;

const SETTINGS_DEFAULTS = Object.freeze({
    turnsN:           DEFAULT_TURNS_N,
    selfcheck:        true,
    storeChangelog:   true,
    changeListPrompt: DEFAULT_CHANGE_LIST_PROMPT,
    cardPrompt:       DEFAULT_CARD_PROMPT,
    situationPrompt:  DEFAULT_SITUATION_PROMPT,
    changelog:        [],
});

// ─── Session State ────────────────────────────────────────────────────────────
// Cleared at the start of each chapterize invocation.

let _transcript          = '';
let _originalDescription = '';
let _changeListContent   = '';

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

// ─── Selfcheck ────────────────────────────────────────────────────────────────

/** Returns { ok, feedback } — ok is false if AI flagged issues; feedback is the AI's note. */
async function runSelfcheck(generatedText, source) {
    const prompt = interpolate(DEFAULT_SELFCHECK_PROMPT, {
        generated_text:            generatedText,
        transcript_or_change_list: source,
    });
    try {
        const result = await generateRaw({ prompt });
        const trimmed = result.trim();
        return { ok: trimmed === 'OK', feedback: trimmed === 'OK' ? '' : trimmed };
    } catch (err) {
        console.warn('[Chapterize] Selfcheck call failed, treating as OK:', err);
        return { ok: true, feedback: '' };
    }
}

// ─── Step 2 LLM Calls ────────────────────────────────────────────────────────

/**
 * Runs card prose and situation summary calls in parallel (Calls 2 + 3),
 * then selfchecks in parallel if enabled. Returns generated texts, ok flags, and feedback strings.
 */
async function runStep2Calls(editedChangeList) {
    const cardPrompt = interpolate(getSettings().cardPrompt, {
        original_description: _originalDescription,
        edited_change_list:   editedChangeList,
    });
    const situationPrompt = interpolate(getSettings().situationPrompt, {
        transcript: _transcript,
    });

    const [cardText, situationText] = await Promise.all([
        generateRaw({ prompt: cardPrompt }),
        generateRaw({ prompt: situationPrompt }),
    ]);

    let isCardOk      = true;
    let isSituationOk = true;
    let cardFeedback  = '';
    let sitFeedback   = '';

    if (getSettings().selfcheck) {
        const [cardCheck, situationCheck] = await Promise.all([
            runSelfcheck(cardText, editedChangeList),
            runSelfcheck(situationText, _transcript),
        ]);
        isCardOk      = cardCheck.ok;
        isSituationOk = situationCheck.ok;
        cardFeedback  = cardCheck.feedback;
        sitFeedback   = situationCheck.feedback;
    }

    return { cardText, situationText, isCardOk, isSituationOk, cardFeedback, sitFeedback };
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

function persistChangelog(chapterName, changeList) {
    if (!getSettings().storeChangelog) return;
    getSettings().changelog.push({
        date: new Date().toISOString(),
        chapterName,
        changeList,
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
      <h3 class="chz-title">Review narrative changes</h3>
      <textarea id="chz-change-list" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
      <div id="chz-error-1" class="chz-error-banner chz-hidden"></div>
      <div class="chz-buttons">
        <button id="chz-next"     class="chz-btn chz-btn-primary">Next \u2192</button>
        <button id="chz-cancel-1" class="chz-btn chz-btn-secondary">Cancel</button>
      </div>
    </div>

    <div id="chz-step-2" class="chz-step chz-hidden">
      <h3 class="chz-title">Review updated character and situation</h3>

      <span class="chz-label">Updated Character Description</span>
      <div id="chz-card-warn" class="chz-warn chz-hidden">\u26a0 AI flagged possible issues</div>
      <textarea id="chz-card-text" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>

      <span class="chz-label">Situation Summary</span>
      <div id="chz-sit-warn" class="chz-warn chz-hidden">\u26a0 AI flagged possible issues</div>
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
    _changeListContent   = '';
}

function showLoading(msg) {
    $('#chz-step-1, #chz-step-2').addClass('chz-hidden');
    $('#chz-loading-msg').text(msg ?? 'Generating...');
    $('#chz-loading').removeClass('chz-hidden');
}

function showStep1(changeList) {
    $('#chz-loading, #chz-step-2').addClass('chz-hidden');
    $('#chz-error-1').addClass('chz-hidden').text('');
    $('#chz-change-list').val(changeList);
    $('#chz-next').prop('disabled', false);
    $('#chz-step-1').removeClass('chz-hidden');
}

function showStep1WithError(message) {
    $('#chz-loading, #chz-step-2').addClass('chz-hidden');
    $('#chz-change-list').val('');
    $('#chz-error-1')
        .html(`${escapeHtml(message)} <button id="chz-retry" class="chz-btn chz-btn-secondary chz-btn-inline">Retry</button>`)
        .removeClass('chz-hidden');
    $('#chz-retry').on('click', retryChangeList);
    $('#chz-step-1').removeClass('chz-hidden');
}

function showStep2(cardText, situationText, isCardOk, isSituationOk, cardFeedback = '', sitFeedback = '') {
    $('#chz-loading, #chz-step-1').addClass('chz-hidden');
    $('#chz-card-text').val(cardText);
    $('#chz-situation-text').val(situationText);
    $('#chz-turns').val(getSettings().turnsN);
    $('#chz-card-warn').toggleClass('chz-hidden', isCardOk).attr('title', cardFeedback);
    $('#chz-sit-warn').toggleClass('chz-hidden', isSituationOk).attr('title', sitFeedback);
    $('#chz-error-2').addClass('chz-hidden').text('');
    setStep2Busy(false);
    $('#chz-step-2').removeClass('chz-hidden');
}

function showStep2WithError(message) {
    $('#chz-loading').addClass('chz-hidden');
    $('#chz-step-2').removeClass('chz-hidden');
    setStep2Busy(false);
    $('#chz-error-2').text(message).removeClass('chz-hidden');
}

function setStep2Busy(isBusy) {
    $('#chz-back, #chz-regen, #chz-confirm, #chz-cancel-2').prop('disabled', isBusy);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

async function onChapterizeClick() {
    const context = getContext();

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
    showLoading('Generating change list...');
    await runChangeListCall();
}

async function runChangeListCall() {
    try {
        const prompt = interpolate(getSettings().changeListPrompt, {
            original_description: _originalDescription,
            transcript:           _transcript,
        });
        const changeList = await generateRaw({ prompt });
        _changeListContent = changeList;
        showStep1(changeList);
    } catch (err) {
        console.error('[Chapterize] Change list generation failed:', err);
        showStep1WithError(`Generation failed: ${err.message}`);
    }
}

async function retryChangeList() {
    showLoading('Retrying...');
    await runChangeListCall();
}

async function onNextClick() {
    const editedChangeList = $('#chz-change-list').val();
    _changeListContent     = editedChangeList;
    $('#chz-next').prop('disabled', true);
    showLoading('Generating character card and situation...');
    await runAndShowStep2(editedChangeList);
}

function onBackClick() {
    showStep1(_changeListContent);
}

async function onRegenClick() {
    setStep2Busy(true);
    showLoading('Regenerating...');
    await runAndShowStep2(_changeListContent);
}

async function runAndShowStep2(editedChangeList) {
    try {
        const { cardText, situationText, isCardOk, isSituationOk, cardFeedback, sitFeedback } =
            await runStep2Calls(editedChangeList);
        showStep2(cardText, situationText, isCardOk, isSituationOk, cardFeedback, sitFeedback);
    } catch (err) {
        console.error('[Chapterize] Step 2 generation failed:', err);
        showStep2WithError(`Generation failed: ${err.message}. Edit the fields manually or use Regenerate.`);
    }
}

async function onConfirmClick() {
    const cardText      = $('#chz-card-text').val().trim();
    const situationText = $('#chz-situation-text').val().trim();
    const rawTurns      = parseInt($('#chz-turns').val(), 10);
    const turnsToCarry  = Math.max(MIN_TURNS, Math.min(MAX_TURNS, isNaN(rawTurns) ? DEFAULT_TURNS_N : rawTurns));

    setStep2Busy(true);
    showLoading('Saving...');

    const context        = getContext();
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
    persistChangelog(chapterName, _changeListContent);

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
          <input id="chz-set-selfcheck" type="checkbox" ${s.selfcheck ? 'checked' : ''}>
          Self-check enabled
        </label>
      </div>

      <div class="chz-settings-row">
        <label>
          <input id="chz-set-changelog" type="checkbox" ${s.storeChangelog ? 'checked' : ''}>
          Store changelog
        </label>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-change">Change List prompt</label>
        <textarea id="chz-set-prompt-change" class="chz-settings-textarea">${escapeHtml(s.changeListPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-card">Character Card prompt</label>
        <textarea id="chz-set-prompt-card" class="chz-settings-textarea">${escapeHtml(s.cardPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-prompt-situation">Situation Summary prompt</label>
        <textarea id="chz-set-prompt-situation" class="chz-settings-textarea">${escapeHtml(s.situationPrompt)}</textarea>
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

    $('#chz-set-selfcheck').on('change', () => {
        getSettings().selfcheck = $('#chz-set-selfcheck').is(':checked');
        saveSettingsDebounced();
    });

    $('#chz-set-changelog').on('change', () => {
        getSettings().storeChangelog = $('#chz-set-changelog').is(':checked');
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-change').on('input', () => {
        getSettings().changeListPrompt = $('#chz-set-prompt-change').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-card').on('input', () => {
        getSettings().cardPrompt = $('#chz-set-prompt-card').val();
        saveSettingsDebounced();
    });

    $('#chz-set-prompt-situation').on('input', () => {
        getSettings().situationPrompt = $('#chz-set-prompt-situation').val();
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
