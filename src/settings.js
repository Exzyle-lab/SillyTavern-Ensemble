/**
 * Settings management module for SillyTavern-Ensemble
 *
 * Handles extension settings persistence and connection profile access.
 */

import { logger } from './logger.js';

const EXTENSION_NAME = 'ensemble';

/**
 * Default settings for the Ensemble extension
 * Note: tierProfiles values are arrays (fallback chains) as of Phase 4
 */
export const DEFAULT_SETTINGS = {
    enabled: true,
    tierProfiles: {
        orchestrator: [],
        major: [],
        standard: [],
        minor: [],
        utility: []
    },
    debug: false
};

/**
 * Normalizes a tier profile value to array format
 * Handles backwards compatibility with old single-string format
 * @param {string|string[]} value - Profile value (string or array)
 * @returns {string[]} Array of profile names
 */
function normalizeTierProfile(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === 'string' && value !== '') {
        return [value];
    }
    return [];
}

/**
 * Gets the current extension settings, merged with defaults
 * Ensures tierProfiles values are always arrays (fallback chains)
 * @returns {Object} Current settings object with all default values filled in
 */
export function getSettings() {
    const context = SillyTavern.getContext();
    const stored = context.extensionSettings[EXTENSION_NAME] || {};

    // Deep merge with defaults
    const storedTierProfiles = stored.tierProfiles || {};
    const normalizedTierProfiles = {};

    // Normalize each tier profile to array format
    for (const tier of Object.keys(DEFAULT_SETTINGS.tierProfiles)) {
        normalizedTierProfiles[tier] = normalizeTierProfile(
            storedTierProfiles[tier] !== undefined
                ? storedTierProfiles[tier]
                : DEFAULT_SETTINGS.tierProfiles[tier]
        );
    }

    const settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        tierProfiles: normalizedTierProfiles
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
 * Migrates old single-string tierProfiles to array format
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

        // Ensure all tier profile keys exist and migrate to array format
        if (!current.tierProfiles) {
            current.tierProfiles = structuredClone(DEFAULT_SETTINGS.tierProfiles);
            updated = true;
        } else {
            for (const tier of Object.keys(DEFAULT_SETTINGS.tierProfiles)) {
                if (current.tierProfiles[tier] === undefined) {
                    current.tierProfiles[tier] = structuredClone(DEFAULT_SETTINGS.tierProfiles[tier]);
                    updated = true;
                } else if (!Array.isArray(current.tierProfiles[tier])) {
                    // Migration: convert old single-string format to array
                    const oldValue = current.tierProfiles[tier];
                    current.tierProfiles[tier] = normalizeTierProfile(oldValue);
                    updated = true;
                    logger.info({
                        event: 'tier_profile_migrated',
                        tier,
                        from: oldValue,
                        to: current.tierProfiles[tier]
                    });
                }
            }
        }

        if (updated) {
            context.saveSettingsDebounced();
            logger.info('Updated settings with missing default values or migrated formats');
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
 * Gets a specific tier's configured profile fallback chain
 * @param {string} tier - Tier name (orchestrator, major, standard, minor, utility)
 * @returns {string[]} Array of profile names for the tier (fallback chain), empty if using current profile
 */
export function getTierProfileChain(tier) {
    const settings = getSettings();
    return settings.tierProfiles[tier] || [];
}

/**
 * Gets a specific tier's primary (first) profile name
 * Backwards compatible with code expecting a single profile string
 * @param {string} tier - Tier name (orchestrator, major, standard, minor, utility)
 * @returns {string} Primary profile name for the tier, or empty string if using current profile
 */
export function getTierProfile(tier) {
    const chain = getTierProfileChain(tier);
    return chain.length > 0 ? chain[0] : '';
}

/**
 * Sets a specific tier's profile configuration as a single-item fallback chain
 * Backwards compatible - wraps single profile in array
 * @param {string} tier - Tier name (orchestrator, major, standard, minor, utility)
 * @param {string} profileName - Profile name to use, or empty string for current profile
 */
export function setTierProfile(tier, profileName) {
    const chain = profileName ? [profileName] : [];
    setTierProfileChain(tier, chain);
}

/**
 * Sets a specific tier's full profile fallback chain
 * @param {string} tier - Tier name (orchestrator, major, standard, minor, utility)
 * @param {string[]} profileNames - Array of profile names in fallback order (first = primary)
 */
export function setTierProfileChain(tier, profileNames) {
    if (!Array.isArray(profileNames)) {
        throw new Error(`setTierProfileChain expects an array, got ${typeof profileNames}`);
    }

    const settings = getSettings();
    // Filter out empty strings and ensure all entries are strings
    settings.tierProfiles[tier] = profileNames
        .filter(name => typeof name === 'string' && name !== '');

    saveSettings(settings);
    logger.debug({
        event: 'tier_profile_chain_set',
        tier,
        profiles: settings.tierProfiles[tier].length > 0
            ? settings.tierProfiles[tier]
            : '(current)'
    });
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
