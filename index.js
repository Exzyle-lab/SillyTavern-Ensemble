/**
 * SillyTavern-Ensemble Extension
 *
 * Enables GM/Narrator characters to orchestrate parallel NPC generation
 * via function calling, with structural knowledge isolation via lorebook filtering.
 */

import { logger, generateCorrelationId } from './src/logger.js';
import { registerTools, unregisterTools } from './src/tools.js';
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
 * Populates tier dropdown selects with available connection profiles
 */
function populateTierDropdowns() {
    const profiles = getAvailableProfiles();
    const settings = getSettings();
    const tiers = ['orchestrator', 'major', 'standard', 'minor', 'utility'];

    for (const tier of tiers) {
        const select = $(`#ensemble_tier_${tier}`);
        if (!select.length) continue;

        // Clear existing options except the first "Use current profile" option
        select.find('option:not(:first)').remove();

        // Add profile options
        for (const profileName of profiles) {
            const option = $('<option>').val(profileName).text(profileName);
            select.append(option);
        }

        // Set current value
        const currentProfile = settings.tierProfiles[tier] || '';
        select.val(currentProfile);
    }

    logger.debug({ event: 'dropdowns_populated', profileCount: profiles.length });
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

    // Tier dropdowns
    $('.ensemble_tier_settings select[data-tier]').on('change', function () {
        const tier = $(this).data('tier');
        const profileName = $(this).val();
        setTierProfile(tier, profileName);
    });

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
