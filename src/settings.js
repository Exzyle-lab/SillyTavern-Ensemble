/**
 * Settings management module for SillyTavern-Ensemble
 *
 * Handles extension settings persistence and connection profile access.
 */

import { logger } from './logger.js';

const EXTENSION_NAME = 'ensemble';

/**
 * Default settings for the Ensemble extension
 */
export const DEFAULT_SETTINGS = {
    enabled: true,
    tierProfiles: {
        orchestrator: '',
        major: '',
        standard: '',
        minor: '',
        utility: ''
    },
    debug: false
};

/**
 * Gets the current extension settings, merged with defaults
 * @returns {Object} Current settings object with all default values filled in
 */
export function getSettings() {
    const context = SillyTavern.getContext();
    const stored = context.extensionSettings[EXTENSION_NAME] || {};

    // Deep merge with defaults
    const settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        tierProfiles: {
            ...DEFAULT_SETTINGS.tierProfiles,
            ...(stored.tierProfiles || {})
        }
    };

    return settings;
}

/**
 * Saves settings to extension settings and persists to storage
 * @param {Object} settings - Settings object to save
 */
export function saveSettings(settings) {
    const context = SillyTavern.getContext();
    context.extensionSettings[EXTENSION_NAME] = settings;
    context.saveSettingsDebounced();
    logger.debug({ event: 'settings_saved', settings });
}

/**
 * Initializes settings on first load if not present
 * Creates default settings structure if none exists
 */
export function initSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        context.saveSettingsDebounced();
        logger.info('Initialized default settings');
    } else {
        // Ensure all default keys exist (handles upgrades)
        const current = context.extensionSettings[EXTENSION_NAME];
        let updated = false;

        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (current[key] === undefined) {
                current[key] = DEFAULT_SETTINGS[key];
                updated = true;
            }
        }

        // Ensure all tier profile keys exist
        if (!current.tierProfiles) {
            current.tierProfiles = structuredClone(DEFAULT_SETTINGS.tierProfiles);
            updated = true;
        } else {
            for (const tier of Object.keys(DEFAULT_SETTINGS.tierProfiles)) {
                if (current.tierProfiles[tier] === undefined) {
                    current.tierProfiles[tier] = DEFAULT_SETTINGS.tierProfiles[tier];
                    updated = true;
                }
            }
        }

        if (updated) {
            context.saveSettingsDebounced();
            logger.info('Updated settings with missing default values');
        }
    }
}

/**
 * Gets available connection profile names from SillyTavern
 * @returns {string[]} Array of profile names, empty if no profiles configured
 */
export function getAvailableProfiles() {
    try {
        const context = SillyTavern.getContext();
        const connectionManager = context.extensionSettings?.connectionManager;

        if (!connectionManager?.profiles || !Array.isArray(connectionManager.profiles)) {
            logger.debug('No connection profiles found');
            return [];
        }

        const profileNames = connectionManager.profiles
            .map(profile => profile.name)
            .filter(name => name && typeof name === 'string')
            .sort((a, b) => a.localeCompare(b));

        logger.debug({ event: 'profiles_loaded', count: profileNames.length });
        return profileNames;
    } catch (error) {
        logger.error({ event: 'profiles_load_error', error: error.message });
        return [];
    }
}

/**
 * Gets a specific tier's configured profile name
 * @param {string} tier - Tier name (orchestrator, major, standard, minor, utility)
 * @returns {string} Profile name for the tier, or empty string if using current profile
 */
export function getTierProfile(tier) {
    const settings = getSettings();
    return settings.tierProfiles[tier] || '';
}

/**
 * Sets a specific tier's profile configuration
 * @param {string} tier - Tier name (orchestrator, major, standard, minor, utility)
 * @param {string} profileName - Profile name to use, or empty string for current profile
 */
export function setTierProfile(tier, profileName) {
    const settings = getSettings();
    settings.tierProfiles[tier] = profileName;
    saveSettings(settings);
    logger.debug({ event: 'tier_profile_set', tier, profile: profileName || '(current)' });
}

/**
 * Checks if the extension is enabled
 * @returns {boolean} True if extension is enabled
 */
export function isEnabled() {
    return getSettings().enabled;
}

/**
 * Sets the extension enabled state
 * @param {boolean} enabled - Whether to enable the extension
 */
export function setEnabled(enabled) {
    const settings = getSettings();
    settings.enabled = enabled;
    saveSettings(settings);
    logger.info({ event: 'extension_enabled', enabled });
}

/**
 * Checks if debug mode is enabled
 * @returns {boolean} True if debug mode is enabled
 */
export function isDebugEnabled() {
    return getSettings().debug;
}

/**
 * Sets the debug mode state
 * @param {boolean} enabled - Whether to enable debug mode
 */
export function setDebugEnabled(enabled) {
    const settings = getSettings();
    settings.debug = enabled;
    saveSettings(settings);
    logger.info({ event: 'debug_mode_changed', enabled });
}
