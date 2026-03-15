/**
 * @file data/default-user/extensions/chapterize/ui.js
 * @stamp {"utc":"2026-03-15T00:00:00.000Z"}
 * @architectural-role HTML Builder
 * @description
 * Builds and returns HTML strings for the Chapterize wizard modal and the
 * extensions settings panel. Extracted from index.js to reduce file length.
 * All runtime values are received as parameters so this module carries no
 * imports and remains a pure HTML factory with no side effects.
 * @core-principles
 * 1. OWNS only the static structure of the modal and settings panel; contains no logic.
 * 2. MUST NOT import from index.js or any ST module — caller passes all
 *    runtime values as arguments.
 * 3. IS NOT responsible for injecting the HTML into the DOM; that is done
 *    by injectModal() / injectSettingsPanel() in index.js.
 * @api-declaration
 * Exported symbols:
 *   buildModalHTML(minTurns, maxTurns, defaultTurns) → string
 *   buildSettingsHTML(minTurns, maxTurns, minLookback, maxLookback, minConcurrency, maxConcurrency, settings, escapeHtml) → string
 * @contract
 *   assertions:
 *     purity: pure # No side effects; same inputs always produce same output.
 *     state_ownership: [] # No module-level state.
 *     external_io: none
 */

/**
 * Returns the full modal HTML for the Chapterize wizard.
 * @param {number} minTurns
 * @param {number} maxTurns
 * @param {number} defaultTurns
 * @returns {string}
 */
export function buildModalHTML(minTurns, maxTurns, defaultTurns) {
    return `
<div id="chz-overlay" class="chz-overlay chz-hidden">
  <div id="chz-modal" class="chz-modal" role="dialog" aria-modal="true">

    <!-- ── Step 1: Character Workshop ── -->
    <div id="chz-step-1" class="chz-step chz-hidden">
      <h3 id="chz-step1-title" class="chz-title">Finalize Character</h3>

      <div class="chz-section-header">
        <span class="chz-label" data-i18n="chapterize.character_workshop">Character Workshop</span>
        <span id="chz-spin-suggestions" class="chz-section-spin fa-solid fa-spinner fa-spin chz-hidden"></span>
        <button id="chz-regen-suggestions" class="chz-btn chz-btn-secondary chz-btn-sm">&#x21bb;</button>
      </div>
      <div id="chz-pending-warning" class="chz-warn chz-warn-amber chz-hidden"
           data-i18n="chapterize.pending_warning">Changes pending — some suggestions not yet applied.</div>

      <div class="chz-tab-bar" id="chz-workshop-tab-bar">
        <button class="chz-tab-btn chz-tab-active" data-tab="ingester"
                data-i18n="chapterize.tab_update">Update</button>
        <button class="chz-tab-btn" data-tab="bio"
                data-i18n="chapterize.tab_bio">Draft Bio</button>
        <button class="chz-tab-btn" data-tab="raw"
                data-i18n="chapterize.tab_raw">AI Raw</button>
      </div>

      <div id="chz-tab-bio" class="chz-tab-panel chz-hidden">
        <textarea id="chz-card-text" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
        <div class="chz-buttons chz-buttons-left">
          <button id="chz-revert-bio" class="chz-btn chz-btn-secondary chz-btn-sm"
                  data-i18n="chapterize.revert_bio">Revert to Original</button>
        </div>
      </div>

      <div id="chz-tab-raw" class="chz-tab-panel chz-hidden">
        <span class="chz-info-icon" title="Any line with 1–3 words is treated as a section header. If a line is incorrectly detected as a header, add a word to make it 4+ words. A blank line ends a section's content — only text up to the first blank line is captured. If a section is being cut off, remove the blank line inside it.">&#9432;</span>
        <textarea id="chz-suggestions-raw" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
        <div id="chz-raw-error" class="chz-error-banner chz-hidden"></div>
      </div>

      <div id="chz-tab-ingester" class="chz-tab-panel">
        <div class="chz-settings-row">
          <label for="chz-ingester-select" data-i18n="chapterize.suggestion_label">Suggestion</label>
          <div class="chz-select-with-nav">
            <select id="chz-ingester-select" class="chz-select"></select>
            <button id="chz-ingester-next" class="chz-btn chz-btn-secondary chz-btn-sm"
                    title="Jump to next unresolved suggestion"
                    data-i18n="[title]chapterize.ingester_next_title">&#x27A1;</button>
          </div>
        </div>
        <span class="chz-label" data-i18n="chapterize.ingester_diff_label">Changes</span>
        <div id="chz-ingester-diff" class="chz-ingester-diff"></div>
        <span class="chz-label" data-i18n="chapterize.ingester_edit_label">Edit</span>
        <textarea id="chz-ingester-editor" class="chz-textarea" spellcheck="false"></textarea>
        <div id="chz-ingester-warning" class="chz-warn chz-hidden"
             data-i18n="chapterize.ingester_no_match">No matching section found in Draft Bio.</div>
        <div class="chz-buttons chz-buttons-split">
          <div class="chz-btn-group">
            <button id="chz-ingester-revert" class="chz-btn chz-btn-secondary"
                    data-i18n="chapterize.ingester_revert">Revert to AI</button>
            <button id="chz-ingester-revert-bio" class="chz-btn chz-btn-secondary"
                    data-i18n="chapterize.ingester_revert_bio">Revert to Bio</button>
          </div>
          <div class="chz-btn-group">
            <button id="chz-ingester-reject" class="chz-btn chz-btn-danger"
                    data-i18n="chapterize.ingester_reject">Reject</button>
            <button id="chz-ingester-apply" class="chz-btn chz-btn-success"
                    data-i18n="chapterize.ingester_apply">Apply</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Step 2: Situation Workshop ── -->
    <div id="chz-step-2" class="chz-step chz-hidden">
      <h3 class="chz-title" data-i18n="chapterize.situation_title">Situation Workshop</h3>

      <div class="chz-section-header">
        <span class="chz-label" data-i18n="chapterize.situation_summary">Situation Summary</span>
        <span id="chz-spin-situation" class="chz-section-spin fa-solid fa-spinner fa-spin chz-hidden"></span>
        <button id="chz-regen-situation" class="chz-btn chz-btn-secondary chz-btn-sm">&#x21bb;</button>
      </div>
      <textarea id="chz-situation-text" class="chz-textarea" spellcheck="false"></textarea>

      <div class="chz-turns-row">
        <span class="chz-label" data-i18n="chapterize.turns_label">Turns to carry into new chapter</span>
        <input id="chz-turns" class="chz-turns-input" type="number"
               min="${minTurns}" max="${maxTurns}" value="${defaultTurns}">
      </div>

      <div id="chz-error-2" class="chz-error-banner chz-hidden"></div>
    </div>

    <!-- ── Step 3: Lorebook Workshop ── -->
    <div id="chz-step-3" class="chz-step chz-hidden">
      <div class="chz-section-header">
        <h3 id="lbchz-title" class="chz-title" data-i18n="chapterize.lorebook_title">Lorebook</h3>
        <span id="lbchz-spinner" class="chz-section-spin fa-solid fa-spinner fa-spin chz-hidden"></span>
        <button id="lbchz-regen" class="chz-btn chz-btn-secondary chz-btn-sm">&#x21bb;</button>
      </div>

      <div class="chz-tab-bar" id="lbchz-tab-bar">
        <button id="lbchz-tab-btn-ingester" class="chz-tab-btn chz-tab-active" data-tab="ingester"
                data-i18n="chapterize.tab_update">Update</button>
        <button id="lbchz-tab-btn-freeform" class="chz-tab-btn" data-tab="freeform"
                data-i18n="chapterize.tab_freeform">Freeform</button>
      </div>

      <div id="lbchz-tab-freeform" class="chz-tab-panel chz-hidden">
        <textarea id="lbchz-freeform" class="chz-textarea chz-textarea-tall" spellcheck="false"
                  data-i18n="[placeholder]chapterize.lb_freeform_placeholder"
                  placeholder="AI suggestions appear here. Edit freely before switching to Update."></textarea>
      </div>

      <div id="lbchz-tab-ingester" class="chz-tab-panel">
        <div class="chz-settings-row">
          <label for="lbchz-suggestion-select" data-i18n="chapterize.suggestion_label">Suggestion</label>
          <div class="chz-select-with-nav">
            <select id="lbchz-suggestion-select" class="chz-select"></select>
            <button id="lbchz-ingester-next" class="chz-btn chz-btn-secondary chz-btn-sm"
                    title="Jump to next unresolved suggestion"
                    data-i18n="[title]chapterize.lb_ingester_next_title">&#x27A1;</button>
          </div>
        </div>

        <span class="chz-label" data-i18n="chapterize.lb_ingester_diff_label">Diff (draft &#x2192; edit)</span>
        <div id="lbchz-ingester-diff" class="chz-ingester-diff"></div>

        <div class="chz-settings-row">
          <label for="lbchz-editor-name" data-i18n="chapterize.lb_editor_name_label">Name</label>
          <input id="lbchz-editor-name" class="chz-input" type="text" spellcheck="false">
        </div>

        <div class="chz-settings-row">
          <label for="lbchz-editor-keys" data-i18n="chapterize.keys_label">Keys (comma-separated)</label>
          <input id="lbchz-editor-keys" class="chz-input" type="text" spellcheck="false">
        </div>

        <span class="chz-label" data-i18n="chapterize.lb_content_label">Content</span>
        <textarea id="lbchz-editor-content" class="chz-textarea" spellcheck="false"></textarea>

        <div id="lbchz-error-ingester" class="chz-error-banner chz-hidden"></div>

        <div class="chz-buttons chz-buttons-split">
          <div class="chz-btn-group">
            <button id="lbchz-revert-ai" class="chz-btn chz-btn-secondary"
                    data-i18n="chapterize.lb_revert_ai">Revert to AI</button>
            <button id="lbchz-revert-draft" class="chz-btn chz-btn-secondary"
                    data-i18n="chapterize.lb_revert_draft">Revert to Draft</button>
          </div>
          <div class="chz-btn-group">
            <button id="lbchz-reject-one" class="chz-btn chz-btn-danger"
                    data-i18n="chapterize.lb_reject_entry">Reject</button>
            <button id="lbchz-apply-one" class="chz-btn chz-btn-success"
                    data-i18n="chapterize.apply_entry">Apply</button>
          </div>
        </div>
        <div class="chz-buttons">
          <button id="lbchz-apply-all-unresolved" class="chz-btn chz-btn-secondary"
                  data-i18n="chapterize.lb_apply_all_unresolved">Apply All Unresolved</button>
        </div>
      </div>

      <div id="lbchz-error" class="chz-error-banner chz-hidden"></div>
    </div>

    <!-- ── Step 4: Narrative Memory Workshop ── -->
    <div id="chz-step-4" class="chz-step chz-hidden">
      <h3 class="chz-title" data-i18n="chapterize.rag_workshop_title">Narrative Memory Workshop</h3>

      <!-- No-summary warning (shown when summary is empty or errored) -->
      <div id="chz-rag-no-summary" class="chz-warn chz-hidden"
           data-i18n="chapterize.rag_no_summary">A Situation Summary is required to generate semantic headers. Return to Step 2 and complete the summary.</div>

      <!-- RAG disabled notice -->
      <div id="chz-rag-disabled" class="chz-warn chz-hidden"
           data-i18n="chapterize.rag_disabled">Narrative Memory (RAG) is disabled. Enable it in settings to generate semantic headers for each memory chunk.</div>

      <!-- Detached-raw warning shown in Sectioned tab -->
      <div id="chz-rag-detached-warn" class="chz-warn chz-warn-amber chz-hidden"
           data-i18n="chapterize.rag_detached_warn">Raw view has been edited. Per-card edits are disabled.</div>
      <div id="chz-rag-detached-revert" class="chz-buttons chz-buttons-left chz-hidden">
        <button id="chz-rag-revert-raw-btn" class="chz-btn chz-btn-secondary chz-btn-sm"
                data-i18n="chapterize.rag_revert_raw">Revert Raw</button>
      </div>

      <div class="chz-tab-bar" id="chz-rag-tab-bar">
        <button class="chz-tab-btn chz-tab-active" data-tab="sectioned"
                data-i18n="chapterize.rag_tab_sectioned">Sectioned</button>
        <button class="chz-tab-btn" data-tab="raw"
                data-i18n="chapterize.rag_tab_raw">Combined Raw</button>
      </div>

      <!-- Sectioned view -->
      <div id="chz-rag-tab-sectioned" class="chz-tab-panel">
        <div id="chz-rag-cards" class="chz-rag-cards"></div>
      </div>

      <!-- Combined Raw view -->
      <div id="chz-rag-tab-raw" class="chz-tab-panel chz-hidden">
        <div id="chz-rag-raw-detached-label" class="chz-warn chz-warn-amber chz-hidden"
             data-i18n="chapterize.rag_raw_detached_label">Raw (edited — sections frozen)</div>
        <textarea id="chz-rag-raw" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
      </div>
    </div>

    <!-- ── Step 5: Review & Commit ── -->
    <div id="chz-step-5" class="chz-step chz-hidden">
      <h3 class="chz-title" data-i18n="chapterize.review_title">Review &amp; Commit</h3>

      <div id="chz-step5-summary" class="chz-step4-summary">
        <div id="chz-step5-target"  class="chz-step4-row"></div>
        <div id="chz-step5-context" class="chz-step4-row"></div>
        <div id="chz-step5-lore"    class="chz-step4-row"></div>
        <div id="chz-step5-rag" class="chz-rag-panel chz-hidden">
          <span class="chz-label" data-i18n="chapterize.rag_panel_label">Narrative Memory (RAG)</span>
          <div id="chz-rag-timeline" class="chz-rag-timeline"></div>
          <div id="chz-rag-warning" class="chz-warn chz-hidden"></div>
        </div>
      </div>

      <div id="chz-receipts" class="chz-receipts chz-hidden">
        <div class="chz-receipts-title" data-i18n="chapterize.receipts_title">Commit Receipts</div>
        <div id="chz-receipts-content" class="chz-receipts-content"></div>
      </div>

      <div id="chz-error-5" class="chz-error-banner chz-hidden"></div>
    </div>

    <!-- ── Shared Wizard Footer ── -->
    <div class="chz-buttons chz-wizard-footer">
      <button id="chz-cancel"    class="chz-btn chz-btn-danger" data-i18n="chapterize.cancel">Cancel</button>
      <button id="chz-move-back" class="chz-btn chz-btn-secondary chz-hidden" data-i18n="chapterize.back">&lt; Back</button>
      <button id="chz-move-next" class="chz-btn chz-btn-secondary" data-i18n="chapterize.next">Next &gt;</button>
      <button id="chz-confirm"   class="chz-btn chz-btn-success chz-hidden" data-i18n="chapterize.finalize">Finalize</button>
    </div>

  </div>
</div>`;
}

/**
 * Returns the settings panel HTML for the Chapterize extension.
 * @param {number} minTurns
 * @param {number} maxTurns
 * @param {number} minLookback
 * @param {number} maxLookback
 * @param {number} minConcurrency
 * @param {number} maxConcurrency
 * @param {object} settings  Current extension settings object (read-only).
 * @param {Function} escapeHtml  HTML-escape utility passed from caller.
 * @returns {string}
 */
export function buildSettingsHTML(minTurns, maxTurns, minLookback, maxLookback, minConcurrency, maxConcurrency, settings, escapeHtml) {
    const s = settings;
    return `
<div class="chz-settings-block inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b data-i18n="chapterize.settings_title">Chapterize</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <div class="chz-settings-group">

      <!-- ── General Settings ── -->
      <div class="chz-settings-section-header" data-i18n="chapterize.settings_general_header">General Settings</div>

      <div class="chz-settings-row">
        <label for="chz-set-turns" data-i18n="chapterize.settings_turns_label">Turns to carry over (default)</label>
        <input id="chz-set-turns" type="number"
               min="${minTurns}" max="${maxTurns}" value="${s.turnsN}">
      </div>

      <div class="chz-settings-row">
        <label>
          <input id="chz-set-changelog" type="checkbox" ${s.storeChangelog ? 'checked' : ''}>
          <span data-i18n="chapterize.settings_store_changelog">Store changelog</span>
        </label>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-profile" data-i18n="chapterize.settings_profile_label">Connection Profile</label>
        <select id="chz-set-profile" class="text_pole"></select>
        <small data-i18n="chapterize.settings_profile_hint" style="opacity:0.7">Override the active connection for Chapterize AI calls. Leave on default to use the global connection.</small>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-card" data-i18n="chapterize.settings_card_prompt">Card/Suggestions prompt (before content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-card" data-key="cardPrompt"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-card" class="chz-settings-textarea">${escapeHtml(s.cardPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-card-aft" data-i18n="chapterize.settings_card_prompt_aft">Card/Suggestions prompt (after content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-card-aft" data-key="cardPromptAft"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-card-aft" class="chz-settings-textarea">${escapeHtml(s.cardPromptAft)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-situation" data-i18n="chapterize.settings_situation_prompt">Situation prompt (before content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-situation" data-key="situationPrompt"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-situation" class="chz-settings-textarea">${escapeHtml(s.situationPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-situation-aft" data-i18n="chapterize.settings_situation_prompt_aft">Situation prompt (after content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-situation-aft" data-key="situationPromptAft"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-situation-aft" class="chz-settings-textarea">${escapeHtml(s.situationPromptAft)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-lorebook" data-i18n="chapterize.settings_lorebook_prompt">Lorebook prompt (before content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-lorebook" data-key="lorebookPrompt"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-lorebook" class="chz-settings-textarea">${escapeHtml(s.lorebookPrompt)}</textarea>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-lorebook-aft" data-i18n="chapterize.settings_lorebook_prompt_aft">Lorebook prompt (after content)</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-lorebook-aft" data-key="lorebookPromptAft"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-lorebook-aft" class="chz-settings-textarea">${escapeHtml(s.lorebookPromptAft)}</textarea>
      </div>

      <!-- ── Narrative Memory (RAG) Settings ── -->
      <div class="chz-settings-section-header" data-i18n="chapterize.settings_rag_header">Narrative Memory (RAG) Settings</div>

      <div class="chz-settings-row">
        <label>
          <input id="chz-set-rag" type="checkbox" ${s.enableRag ? 'checked' : ''}>
          <span data-i18n="chapterize.settings_enable_rag">Enable Narrative Memory (RAG)</span>
        </label>
        <small data-i18n="chapterize.settings_enable_rag_hint" style="opacity:0.7">On Finalize, upload the chapter transcript as a Data Bank file attached to the character. Requires a vector embedding source to be configured in SillyTavern.</small>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-lookback" data-i18n="chapterize.settings_lookback_label">AI Context Look-back (turns)</label>
        <input id="chz-set-lookback" type="number"
               min="${minLookback}" max="${maxLookback}" value="${s.classifierLookback}">
        <small data-i18n="chapterize.settings_lookback_hint" style="opacity:0.7">How many dialogue turns preceding each chunk are sent to the AI as context-only when generating semantic headers. 0 = no look-back.</small>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-concurrency" data-i18n="chapterize.settings_concurrency_label">Max Concurrent Classifier Calls</label>
        <input id="chz-set-concurrency" type="number"
               min="${minConcurrency}" max="${maxConcurrency}" value="${s.maxConcurrentCalls}">
        <small data-i18n="chapterize.settings_concurrency_hint" style="opacity:0.7">Maximum number of simultaneous AI calls when classifying memory chunks. Higher values are faster but may hit rate limits.</small>
      </div>

      <div class="chz-settings-row">
        <label for="chz-set-rag-profile" data-i18n="chapterize.settings_rag_profile_label">RAG Classifier Connection Profile</label>
        <select id="chz-set-rag-profile" class="text_pole"></select>
        <small data-i18n="chapterize.settings_rag_profile_hint" style="opacity:0.7">Connection profile used specifically for chunk header classification calls. Falls back to the General profile, then the global connection.</small>
      </div>

      <div class="chz-settings-row">
        <div class="chz-settings-label-row">
          <label for="chz-set-prompt-rag-classifier" data-i18n="chapterize.settings_rag_classifier_prompt">Classifier prompt</label>
          <button class="chz-btn chz-btn-secondary chz-btn-sm chz-reset-btn"
                  data-target="chz-set-prompt-rag-classifier" data-key="ragClassifierPrompt"
                  data-i18n="chapterize.reset">Reset</button>
        </div>
        <textarea id="chz-set-prompt-rag-classifier" class="chz-settings-textarea">${escapeHtml(s.ragClassifierPrompt)}</textarea>
        <small style="opacity:0.7">Placeholders: <code>{{summary}}</code>, <code>{{context_block}}</code>, <code>{{target_turns}}</code></small>
      </div>

    </div>
  </div>
</div>`;
}
