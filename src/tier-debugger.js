/**
 * Tier Debugger UI for inspecting and overriding character tiers
 *
 * Provides a drawer panel UI that allows users to:
 * - View all characters with their inferred tiers
 * - Apply session-only tier overrides (temporary)
 * - Save tier overrides permanently to character cards
 *
 * @module tier-debugger
 */

import { logger } from './logger.js';
import {
    inferTier,
    setSessionTierOverride,
    clearSessionTierOverride,
    getSessionTierOverrides,
    TIERS,
} from './router.js';

/**
 * Get all characters with their current tier assignments
 * @returns {Promise<Array<{id: number, name: string, avatar: string|null, tier: string, source: string}>>}
 */
export async function getCharacterTiers() {
    const context = SillyTavern.getContext();
    const characters = context.characters || [];
    const sessionOverrides = getSessionTierOverrides();

    const results = [];
    for (let i = 0; i < characters.length; i++) {
        const char = characters[i];
        if (!char?.name) continue;

        const tier = await inferTier(i);
        let source = 'inferred';

        if (sessionOverrides.has(i)) {
            source = 'session';
        } else if (char.data?.extensions?.ensemble?.tier) {
            source = 'card';
        }

        results.push({
            id: i,
            name: char.name,
            avatar: char.avatar || null,
            tier,
            source,
        });
    }

    return results;
}

/**
 * Save tier override permanently to character card
 * @param {number} characterId - Index into the characters array
 * @param {string} tier - The tier to save
 * @returns {Promise<boolean>} True if saved successfully
 */
export async function saveTierToCard(characterId, tier) {
    try {
        const context = SillyTavern.getContext();

        if (!context.writeExtensionField) {
            logger.error({ event: 'write_extension_field_unavailable' });
            toastr.error('Cannot save to card: API unavailable');
            return false;
        }

        // Get the character's avatar (used as the identifier for writeExtensionField)
        const character = context.characters[characterId];
        if (!character) {
            logger.error({ event: 'character_not_found', characterId });
            toastr.error('Character not found');
            return false;
        }

        await context.writeExtensionField(characterId, 'ensemble', { tier });

        // Clear session override since it's now permanent
        clearSessionTierOverride(characterId);

        logger.info({ event: 'tier_saved_to_card', characterId, tier, characterName: character.name });
        toastr.success(`Tier saved to ${character.name}'s card`);
        return true;
    } catch (error) {
        logger.error({ event: 'tier_save_failed', characterId, error: error.message });
        toastr.error(`Failed to save tier: ${error.message}`);
        return false;
    }
}

/**
 * Build HTML for a single character row in the tier debugger
 * @param {Object} char - Character data object
 * @returns {string} HTML string for the row
 */
function buildCharacterRow(char) {
    const avatarSrc = char.avatar
        ? `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`
        : '/img/ai4.png';

    const tierOptions = TIERS.map(t =>
        `<option value="${t}" ${t === char.tier ? 'selected' : ''}>${t}</option>`
    ).join('');

    return `
        <div class="tier-debugger-row" data-char-id="${char.id}">
            <div class="tier-debugger-avatar">
                <img src="${avatarSrc}" alt="${char.name}" />
            </div>
            <div class="tier-debugger-name" title="${char.name}">${char.name}</div>
            <div class="tier-debugger-tier">
                <select class="tier-select text_pole" data-char-id="${char.id}">
                    ${tierOptions}
                </select>
            </div>
            <div class="tier-debugger-source">
                <span class="tier-source-badge tier-source-${char.source}">${char.source}</span>
            </div>
            <div class="tier-debugger-actions">
                <button class="tier-save-btn menu_button" data-char-id="${char.id}" title="Save to card (permanent)">
                    <i class="fa-solid fa-save"></i>
                </button>
            </div>
        </div>
    `;
}

/**
 * Build the complete drawer HTML
 * @param {Array} characters - Array of character tier data
 * @returns {string} HTML string for the drawer
 */
function buildDrawerHtml(characters) {
    const rows = characters.map(char => buildCharacterRow(char)).join('');

    const emptyMessage = characters.length === 0
        ? '<div class="tier-debugger-empty">No characters found</div>'
        : '';

    return `
        <div id="tier-debugger-drawer" class="drawer">
            <div class="drawer-header">
                <h3>Tier Debugger</h3>
                <button id="tier-debugger-close" class="menu_button" title="Close">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="drawer-content">
                <div class="tier-debugger-legend">
                    <span class="tier-source-badge tier-source-inferred">inferred</span> = calculated from character data
                    <span class="tier-source-badge tier-source-session">session</span> = temporary override
                    <span class="tier-source-badge tier-source-card">card</span> = saved to character
                </div>
                <div class="tier-debugger-list">
                    ${emptyMessage}
                    ${rows}
                </div>
            </div>
        </div>
    `;
}

/**
 * Bind event handlers for the drawer
 */
function bindDrawerEvents() {
    // Close button
    $('#tier-debugger-close').on('click', closeTierDebugger);

    // Click outside drawer to close
    $('#tier-debugger-drawer').on('click', function (e) {
        if (e.target === this) {
            closeTierDebugger();
        }
    });

    // Tier select change - apply session override
    $('.tier-select').on('change', async function () {
        const charId = parseInt($(this).data('char-id'));
        const tier = $(this).val();

        setSessionTierOverride(charId, tier);

        // Update source badge
        $(this).closest('.tier-debugger-row').find('.tier-source-badge')
            .removeClass('tier-source-inferred tier-source-card')
            .addClass('tier-source-session')
            .text('session');

        toastr.info('Tier override applied (session only)');
    });

    // Save button - write to card
    $('.tier-save-btn').on('click', async function () {
        const charId = parseInt($(this).data('char-id'));
        const tier = $(`.tier-select[data-char-id="${charId}"]`).val();

        const success = await saveTierToCard(charId, tier);

        if (success) {
            // Update source badge
            $(this).closest('.tier-debugger-row').find('.tier-source-badge')
                .removeClass('tier-source-inferred tier-source-session')
                .addClass('tier-source-card')
                .text('card');
        }
    });

    // ESC key to close
    $(document).on('keydown.tierDebugger', function (e) {
        if (e.key === 'Escape') {
            closeTierDebugger();
        }
    });
}

/**
 * Show the drawer in the DOM
 * @param {string} html - The drawer HTML content
 */
function showDrawer(html) {
    // Remove existing drawer if any
    $('#tier-debugger-drawer').remove();

    // Add drawer to body
    $('body').append(html);

    // Bind events
    bindDrawerEvents();

    // Animate in (small delay to allow CSS transition)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            $('#tier-debugger-drawer').addClass('open');
        });
    });

    logger.debug({ event: 'tier_debugger_opened' });
}

/**
 * Open the tier debugger drawer
 */
export async function openTierDebugger() {
    try {
        const characters = await getCharacterTiers();
        const drawerHtml = buildDrawerHtml(characters);
        showDrawer(drawerHtml);
    } catch (error) {
        logger.error({ event: 'tier_debugger_open_failed', error: error.message });
        toastr.error(`Failed to open Tier Debugger: ${error.message}`);
    }
}

/**
 * Close and remove the tier debugger drawer
 */
export function closeTierDebugger() {
    const drawer = $('#tier-debugger-drawer');
    if (drawer.length === 0) return;

    drawer.removeClass('open');

    // Remove ESC key handler
    $(document).off('keydown.tierDebugger');

    // Remove after animation
    setTimeout(() => {
        drawer.remove();
    }, 300);

    logger.debug({ event: 'tier_debugger_closed' });
}

/**
 * Refresh the tier debugger content if it's currently open
 */
export async function refreshTierDebugger() {
    const drawer = $('#tier-debugger-drawer');
    if (drawer.length === 0) return;

    try {
        const characters = await getCharacterTiers();
        const rows = characters.map(char => buildCharacterRow(char)).join('');
        const emptyMessage = characters.length === 0
            ? '<div class="tier-debugger-empty">No characters found</div>'
            : '';

        $('.tier-debugger-list').html(emptyMessage + rows);

        // Re-bind events for new elements
        bindDrawerEvents();

        logger.debug({ event: 'tier_debugger_refreshed' });
    } catch (error) {
        logger.error({ event: 'tier_debugger_refresh_failed', error: error.message });
    }
}
