/**
 * SillyTavern-Ensemble Extension
 *
 * Enables GM/Narrator characters to orchestrate parallel NPC generation
 * via function calling, with structural knowledge isolation via lorebook filtering.
 */

import { logger, generateCorrelationId } from './src/logger.js';
import { registerTools, unregisterTools } from './src/tools.js';
import { validateUI } from './src/ui-lock.js';
import {
    getSettings,
    initSettings,
    getAvailableProfiles,
    setTierProfile,
    setEnabled,
    setDebugEnabled,
} from './src/settings.js';

/**
 * Extension folder path for loading resources
 */
const extensionFolderPath = 'scripts/extensions/third-party/SillyTavern-Ensemble';

/**
 * Extension name used for settings storage
 */
const EXTENSION_NAME = 'ensemble';

/**
 * Available tiers for the extension
 */
const TIERS = ['orchestrator', 'major', 'standard', 'minor', 'utility'];

/**
 * Creates a profile tag element from the template
 * @param {string} profileName - Name of the profile
 * @param {number} order - Position in the chain (1-indexed for display)
 * @returns {jQuery} The created tag element
 */
function createProfileTag(profileName, order) {
    const template = document.getElementById('ensemble_profile_tag_template');
    if (!template) {
        logger.error({ event: 'profile_tag_template_missing' });
        return null;
    }

    const clone = template.content.cloneNode(true);
    const tag = $(clone).find('.ensemble_profile_tag');

    tag.attr('data-profile', profileName);
    tag.find('.ensemble_profile_order').text(order);
    tag.find('.ensemble_profile_name').text(profileName);

    return tag;
}

/**
 * Renders the profile chain for a specific tier
 * @param {string} tier - Tier name
 * @param {string[]} chain - Array of profile names in order
 */
function renderProfileChain(tier, chain) {
    const listContainer = $(`.ensemble_profile_list[data-tier="${tier}"]`);
    const hintElement = $(`.ensemble_tier_row[data-tier="${tier}"] .ensemble_chain_hint`);

    if (!listContainer.length) {
        logger.debug({ event: 'profile_list_not_found', tier });
        return;
    }

    // Clear existing tags
    listContainer.empty();

    // Add tags for each profile in chain
    chain.forEach((profileName, index) => {
        const tag = createProfileTag(profileName, index + 1);
        if (tag) {
            listContainer.append(tag);
        }
    });

    // Show/hide the hint based on whether chain is empty
    if (hintElement.length) {
        hintElement.toggle(chain.length === 0);
    }
}

/**
 * Populates the add-profile dropdowns with available profiles
 * Excludes profiles already in the chain
 * @param {string} tier - Tier name
 * @param {string[]} chain - Current chain of profile names
 */
function populateAddProfileDropdown(tier, chain) {
    const profiles = getAvailableProfiles();
    const select = $(`.ensemble_profile_select[data-tier="${tier}"]`);

    if (!select.length) return;

    // Clear existing options except the first placeholder
    select.find('option:not(:first)').remove();

    // Add options for profiles not already in the chain
    const chainSet = new Set(chain);
    for (const profileName of profiles) {
        if (!chainSet.has(profileName)) {
            const option = $('<option>').val(profileName).text(profileName);
            select.append(option);
        }
    }

    // Reset to placeholder
    select.val('');
}

/**
 * Populates tier UI with available connection profiles and current chains
 */
function populateTierDropdowns() {
    const settings = getSettings();

    for (const tier of TIERS) {
        // Ensure chain is an array (backwards compatibility)
        const chain = Array.isArray(settings.tierProfiles[tier])
            ? settings.tierProfiles[tier]
            : settings.tierProfiles[tier]
                ? [settings.tierProfiles[tier]]
                : [];

        // Render the profile tags
        renderProfileChain(tier, chain);

        // Populate the add-profile dropdown
        populateAddProfileDropdown(tier, chain);
    }

    logger.debug({
        event: 'tier_ui_populated',
        profileCount: getAvailableProfiles().length,
    });
}

/**
 * Adds a profile to the end of a tier's fallback chain
 * @param {string} tier - Tier name
 * @param {string} profileName - Profile name to add
 */
function addProfileToChain(tier, profileName) {
    if (!profileName) return;

    const settings = getSettings();
    const chain = Array.isArray(settings.tierProfiles[tier])
        ? [...settings.tierProfiles[tier]]
        : settings.tierProfiles[tier]
            ? [settings.tierProfiles[tier]]
            : [];

    // Don't add duplicates
    if (chain.includes(profileName)) {
        logger.debug({ event: 'profile_already_in_chain', tier, profileName });
        return;
    }

    chain.push(profileName);
    setTierProfile(tier, chain);

    // Re-render the UI for this tier
    renderProfileChain(tier, chain);
    populateAddProfileDropdown(tier, chain);

    logger.info({ event: 'profile_added_to_chain', tier, profileName, chainLength: chain.length });
}

/**
 * Removes a profile from a tier's fallback chain
 * @param {string} tier - Tier name
 * @param {string} profileName - Profile name to remove
 */
function removeProfileFromChain(tier, profileName) {
    const settings = getSettings();
    const chain = Array.isArray(settings.tierProfiles[tier])
        ? [...settings.tierProfiles[tier]]
        : settings.tierProfiles[tier]
            ? [settings.tierProfiles[tier]]
            : [];

    const index = chain.indexOf(profileName);
    if (index === -1) {
        logger.debug({ event: 'profile_not_in_chain', tier, profileName });
        return;
    }

    chain.splice(index, 1);
    setTierProfile(tier, chain);

    // Re-render the UI for this tier
    renderProfileChain(tier, chain);
    populateAddProfileDropdown(tier, chain);

    logger.info({ event: 'profile_removed_from_chain', tier, profileName, chainLength: chain.length });
}

/**
 * Reorders a tier's fallback chain
 * @param {string} tier - Tier name
 * @param {string[]} newOrder - New array of profile names in desired order
 */
function reorderChain(tier, newOrder) {
    setTierProfile(tier, newOrder);

    // Re-render the UI for this tier (keeps dropdown unchanged since profiles are same)
    renderProfileChain(tier, newOrder);

    logger.info({ event: 'chain_reordered', tier, newOrder });
}

/**
 * State for drag-and-drop reordering
 */
let dragState = {
    tier: null,
    profileName: null,
    dragElement: null,
};

/**
 * Sets up drag-and-drop event handlers for profile tag reordering
 */
function setupDragAndDrop() {
    const container = $('.ensemble_tier_settings');

    // Use event delegation for dynamically created tags
    container.on('dragstart', '.ensemble_profile_tag', function (e) {
        const $tag = $(this);
        const tier = $tag.closest('.ensemble_profile_list').data('tier');
        const profileName = $tag.data('profile');

        dragState = {
            tier,
            profileName,
            dragElement: this,
        };

        $tag.addClass('dragging');

        // Required for Firefox
        e.originalEvent.dataTransfer.effectAllowed = 'move';
        e.originalEvent.dataTransfer.setData('text/plain', profileName);

        logger.debug({ event: 'drag_start', tier, profileName });
    });

    container.on('dragend', '.ensemble_profile_tag', function () {
        $(this).removeClass('dragging');
        $('.ensemble_profile_tag').removeClass('drag-over');
        dragState = { tier: null, profileName: null, dragElement: null };
    });

    container.on('dragover', '.ensemble_profile_tag', function (e) {
        e.preventDefault();
        e.originalEvent.dataTransfer.dropEffect = 'move';

        const $tag = $(this);
        const tier = $tag.closest('.ensemble_profile_list').data('tier');

        // Only allow drag-over within same tier
        if (tier === dragState.tier && this !== dragState.dragElement) {
            $tag.addClass('drag-over');
        }
    });

    container.on('dragleave', '.ensemble_profile_tag', function () {
        $(this).removeClass('drag-over');
    });

    container.on('drop', '.ensemble_profile_tag', function (e) {
        e.preventDefault();

        const $dropTarget = $(this);
        const tier = $dropTarget.closest('.ensemble_profile_list').data('tier');

        // Only process drops within same tier
        if (tier !== dragState.tier || this === dragState.dragElement) {
            return;
        }

        const settings = getSettings();
        const chain = Array.isArray(settings.tierProfiles[tier])
            ? [...settings.tierProfiles[tier]]
            : [];

        const draggedProfile = dragState.profileName;
        const targetProfile = $dropTarget.data('profile');

        const draggedIndex = chain.indexOf(draggedProfile);
        const targetIndex = chain.indexOf(targetProfile);

        if (draggedIndex === -1 || targetIndex === -1) {
            return;
        }

        // Remove from old position and insert at new position
        chain.splice(draggedIndex, 1);
        chain.splice(targetIndex, 0, draggedProfile);

        reorderChain(tier, chain);

        logger.debug({
            event: 'drag_drop',
            tier,
            draggedProfile,
            targetProfile,
            newOrder: chain,
        });
    });
}

/**
 * Binds event handlers to settings UI elements
 */
function bindSettingsEventHandlers() {
    const settings = getSettings();

    // Enable checkbox
    const enabledCheckbox = $('#ensemble_enabled');
    enabledCheckbox.prop('checked', settings.enabled);
    enabledCheckbox.on('change', function () {
        const enabled = $(this).prop('checked');
        setEnabled(enabled);

        // Re-register or unregister tools based on enabled state
        if (enabled) {
            registerTools();
        } else {
            unregisterTools();
        }
    });

    // Debug checkbox
    const debugCheckbox = $('#ensemble_debug');
    debugCheckbox.prop('checked', settings.debug);
    debugCheckbox.on('change', function () {
        const debug = $(this).prop('checked');
        setDebugEnabled(debug);
    });

    // Add-profile dropdown change handlers (event delegation)
    $('.ensemble_tier_settings').on('change', '.ensemble_profile_select', function () {
        const tier = $(this).data('tier');
        const profileName = $(this).val();

        if (profileName) {
            addProfileToChain(tier, profileName);
            // Reset dropdown after adding
            $(this).val('');
        }
    });

    // Remove profile button handlers (event delegation for dynamic elements)
    $('.ensemble_tier_settings').on('click', '.ensemble_profile_remove', function () {
        const $tag = $(this).closest('.ensemble_profile_tag');
        const tier = $tag.closest('.ensemble_profile_list').data('tier');
        const profileName = $tag.data('profile');

        removeProfileFromChain(tier, profileName);
    });

    // Set up drag-and-drop for reordering
    setupDragAndDrop();

    // Refresh profiles button
    $('#ensemble_refresh_profiles').on('click', function () {
        populateTierDropdowns();
        logger.info('Connection profiles refreshed');
    });

    logger.debug({ event: 'event_handlers_bound' });
}

/**
 * Loads the settings HTML into the ST extensions settings panel
 * @returns {Promise<void>}
 */
async function loadSettingsUI() {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);

        // Populate dropdowns with available profiles
        populateTierDropdowns();

        // Bind event handlers
        bindSettingsEventHandlers();

        logger.debug({ event: 'settings_ui_loaded' });
    } catch (error) {
        logger.error({
            event: 'settings_ui_load_failed',
            error: error.message,
        });
    }
}

/**
 * Called when the extension loads
 */
async function onAppReady() {
    const correlationId = generateCorrelationId();

    try {
        // Initialize settings using the settings module
        initSettings();

        // Load settings UI into ST's extension settings panel
        await loadSettingsUI();

        // Validate UI selectors exist (Phase 3.1)
        validateUI();

        // Register function tools if extension is enabled
        const settings = getSettings();
        if (settings.enabled) {
            registerTools();
        }

        logger.info('[Ensemble] Loaded successfully', correlationId);
        logger.debug({
            event: 'app_ready',
            enabled: settings.enabled,
        }, correlationId);
    } catch (error) {
        logger.error({
            event: 'init_failed',
            error: error.message,
        }, correlationId);
    }
}

/**
 * Extension initialization function
 */
export function init() {
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    // Hook into APP_READY event
    eventSource.on(event_types.APP_READY, onAppReady);

    logger.debug({ event: 'init_registered' });
}

// Auto-initialize when module loads
init();
