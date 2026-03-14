/**
 * @file data/default-user/extensions/chapterize/ui.js
 * @stamp {"utc":"2026-03-14T00:00:00.000Z"}
 * @architectural-role Modal HTML Builder
 * @description
 * Builds and returns the full HTML string for the Chapterize 4-step wizard
 * modal. Extracted from index.js to reduce file length.
 * The three numeric turn-count constants are received as parameters so this
 * module carries no imports and remains a pure HTML factory with no side
 * effects.
 * @core-principles
 * 1. OWNS only the static structure of the wizard modal; contains no logic.
 * 2. MUST NOT import from index.js or any ST module — caller passes all
 *    runtime values as arguments.
 * 3. IS NOT responsible for injecting the HTML into the DOM; that is done
 *    by injectModal() in index.js.
 * @api-declaration
 * Exported symbols: buildModalHTML(minTurns, maxTurns, defaultTurns) → string
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
        <button class="chz-tab-btn chz-tab-active" data-tab="bio"
                data-i18n="chapterize.tab_bio">Draft Bio</button>
        <button class="chz-tab-btn" data-tab="raw"
                data-i18n="chapterize.tab_raw">AI Raw</button>
        <button class="chz-tab-btn" data-tab="ingester"
                data-i18n="chapterize.tab_ingester">Ingester</button>
      </div>

      <div id="chz-tab-bio" class="chz-tab-panel">
        <textarea id="chz-card-text" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
        <div class="chz-buttons chz-buttons-left">
          <button id="chz-revert-bio" class="chz-btn chz-btn-secondary chz-btn-sm"
                  data-i18n="chapterize.revert_bio">Revert to Original</button>
        </div>
      </div>

      <div id="chz-tab-raw" class="chz-tab-panel chz-hidden">
        <span class="chz-info-icon" title="Any line with 1–3 words is treated as a section header. If a line is incorrectly detected as a header, add a word to make it 4+ words.">&#9432;</span>
        <textarea id="chz-suggestions-raw" class="chz-textarea chz-textarea-tall" spellcheck="false"></textarea>
        <div id="chz-raw-error" class="chz-error-banner chz-hidden"></div>
      </div>

      <div id="chz-tab-ingester" class="chz-tab-panel chz-hidden">
        <div class="chz-settings-row">
          <label for="chz-ingester-select" data-i18n="chapterize.suggestion_label">Suggestion</label>
          <div class="chz-select-with-nav">
            <select id="chz-ingester-select" class="chz-select"></select>
            <button id="chz-ingester-next" class="chz-btn chz-btn-secondary chz-btn-sm"
                    title="Jump to next unresolved suggestion"
                    data-i18n="[title]chapterize.ingester_next_title">&#x27A1;</button>
          </div>
        </div>
        <span class="chz-label" data-i18n="chapterize.ingester_diff_label">Diff (bio → edit)</span>
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
        <button id="lbchz-tab-btn-freeform" class="chz-tab-btn chz-tab-active" data-tab="freeform"
                data-i18n="chapterize.tab_freeform">Freeform</button>
        <button id="lbchz-tab-btn-ingester" class="chz-tab-btn" data-tab="ingester"
                data-i18n="chapterize.tab_ingester">Ingester</button>
      </div>

      <div id="lbchz-tab-freeform" class="chz-tab-panel">
        <textarea id="lbchz-freeform" class="chz-textarea chz-textarea-tall" spellcheck="false"
                  data-i18n="[placeholder]chapterize.lb_freeform_placeholder"
                  placeholder="AI suggestions appear here. Edit freely before switching to Ingester."></textarea>
      </div>

      <div id="lbchz-tab-ingester" class="chz-tab-panel chz-hidden">
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

    <!-- ── Step 4: Review & Commit ── -->
    <div id="chz-step-4" class="chz-step chz-hidden">
      <h3 class="chz-title" data-i18n="chapterize.review_title">Review &amp; Commit</h3>

      <div id="chz-step4-summary" class="chz-step4-summary">
        <div id="chz-step4-target"  class="chz-step4-row"></div>
        <div id="chz-step4-context" class="chz-step4-row"></div>
        <div id="chz-step4-lore"    class="chz-step4-row"></div>
      </div>

      <div id="chz-receipts" class="chz-receipts chz-hidden">
        <div class="chz-receipts-title" data-i18n="chapterize.receipts_title">Commit Receipts</div>
        <div id="chz-receipts-content" class="chz-receipts-content"></div>
      </div>

      <div id="chz-error-4" class="chz-error-banner chz-hidden"></div>
    </div>

    <!-- ── Shared Wizard Footer ── -->
    <div class="chz-buttons chz-wizard-footer">
      <button id="chz-cancel"    class="chz-btn chz-btn-secondary" data-i18n="chapterize.cancel">Cancel</button>
      <button id="chz-move-back" class="chz-btn chz-btn-secondary chz-hidden" data-i18n="chapterize.back">&lt; Back</button>
      <button id="chz-move-next" class="chz-btn chz-btn-secondary" data-i18n="chapterize.next">Next &gt;</button>
      <button id="chz-confirm"   class="chz-btn chz-btn-primary chz-hidden" data-i18n="chapterize.finalize">Finalize</button>
    </div>

  </div>
</div>`;
}
