/**
 * SillyTavern-Ensemble Backend Router
 *
 * Handles:
 * - Dynamic tier inference based on character complexity
 * - Connection profile lookup and selection
 * - Direct API calls bypassing ST's sequential queue
 * - Session tier overrides for Tier Debugger UI
 *
 * @module router
 */

import { checkRateLimit, recordSuccess, recordRateLimit } from './rate-limiter.js';
import { logger } from './logger.js';

const MODULE_NAME = 'Ensemble';

/**
 * Session-only tier overrides. Lost on page refresh.
 * Key: characterId (number), Value: tier (string)
 * @type {Map<number, string>}
 */
const sessionTierOverrides = new Map();

/**
 * Valid tier values for NPC categorization
 * @type {readonly string[]}
 */
export const TIERS = Object.freeze(['orchestrator', 'major', 'standard', 'minor', 'utility']);

/**
 * Set a session-only tier override for a character.
 * This override is temporary and will be lost on page refresh.
 *
 * @param {number} characterId - Index into the characters array
 * @param {string} tier - The tier to assign
 * @returns {boolean} True if the override was set successfully
 */
export function setSessionTierOverride(characterId, tier) {
    if (!TIERS.includes(tier)) {
        logger.warn({ event: 'invalid_session_tier_override', characterId, tier });
        return false;
    }
    sessionTierOverrides.set(characterId, tier);
    logger.info({ event: 'session_tier_override_set', characterId, tier });
    return true;
}

/**
 * Clear a session tier override for a specific character.
 *
 * @param {number} characterId - Index into the characters array
 * @returns {boolean} True if an override was removed
 */
export function clearSessionTierOverride(characterId) {
    const deleted = sessionTierOverrides.delete(characterId);
    if (deleted) {
        logger.info({ event: 'session_tier_override_cleared', characterId });
    }
    return deleted;
}

/**
 * Clear all session tier overrides.
 */
export function clearAllSessionTierOverrides() {
    sessionTierOverrides.clear();
    logger.info({ event: 'all_session_tier_overrides_cleared' });
}

/**
 * Get a copy of all current session tier overrides.
 *
 * @returns {Map<number, string>} Copy of the session overrides map
 */
export function getSessionTierOverrides() {
    return new Map(sessionTierOverrides);
}

/**
 * Default tier-to-profile mapping (empty array = use current profile)
 * Values are arrays for fallback chain support.
 * @type {Object.<string, string[]>}
 */
const DEFAULT_TIER_PROFILES = {
    orchestrator: [],
    major: [],
    standard: [],
    minor: [],
    utility: [],
};

/**
 * Get the character's filename (avatar without extension) for filter matching.
 * This matches the format used in lorebook characterFilter.names[].
 *
 * @param {number} characterId - Index into the characters array
 * @returns {string|null} The filename without extension, or null if invalid
 */
export function getCharacterFilename(characterId) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];

    if (!character?.avatar) {
        return null;
    }

    // Strip file extension from avatar filename
    return character.avatar.replace(/\.[^/.]+$/, '');
}

/**
 * Get the count of lorebook entries that include this character in their filter.
 * Entries with no filter (common knowledge) are not counted as character-specific.
 *
 * @param {number} characterId - Index into the characters array
 * @returns {Promise<number>} Count of entries filtered to this character
 */
async function getLorebookEntryCountForCharacter(characterId) {
    const filename = getCharacterFilename(characterId);
    if (!filename) {
        return 0;
    }

    try {
        // Access world info through the global getSortedEntries if available
        // Otherwise fall back to checking extension settings
        const context = SillyTavern.getContext();

        // Try to get entries from the world info module
        // Note: This may need adjustment based on how ST exposes world info
        let entries = [];

        // Check if we can access world info through context
        if (typeof window.getSortedEntries === 'function') {
            entries = await window.getSortedEntries();
        } else {
            // Fallback: try to access through extension settings or chat metadata
            // This is a simplified approach - actual implementation may need refinement
            console.debug(`[${MODULE_NAME}] getSortedEntries not available, using fallback`);
            return 0;
        }

        // Count entries where this character is in the characterFilter.names
        let count = 0;
        for (const entry of entries) {
            const filter = entry.characterFilter;
            if (filter?.names?.length > 0) {
                const nameIncluded = filter.names.includes(filename);
                // If isExclude is false and name is included, this entry is for this character
                // If isExclude is true and name is included, this entry excludes this character
                if (!filter.isExclude && nameIncluded) {
                    count++;
                }
            }
        }

        return count;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Error counting lorebook entries for character ${characterId}:`, error);
        return 0;
    }
}

/**
 * Get the count of messages from a specific character in the current chat.
 *
 * @param {number} characterId - Index into the characters array
 * @returns {number} Count of messages from this character
 */
function getMessageCountForCharacter(characterId) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];

    if (!character?.name) {
        return 0;
    }

    const chat = context.chat || [];
    return chat.filter(msg => !msg.is_user && msg.name === character.name).length;
}

/**
 * Infer the appropriate tier for a character based on complexity signals.
 *
 * Priority order:
 * 1. Session override (temporary, from Tier Debugger UI)
 * 2. Card extension data (permanent, saved to character)
 * 3. Dynamic inference from complexity signals
 *
 * Complexity is calculated from:
 * - Lorebook entries filtered to this character (weight: 2x)
 * - Message count in current chat history
 * - Character description length (>500 chars adds 3 points)
 *
 * @param {number} characterId - Index into the characters array
 * @returns {Promise<string>} The inferred tier: 'major', 'standard', or 'minor'
 */
export async function inferTier(characterId) {
    // 1. Check session overrides first (temporary, from Tier Debugger)
    if (sessionTierOverrides.has(characterId)) {
        const tier = sessionTierOverrides.get(characterId);
        logger.debug({ event: 'using_session_tier_override', characterId, tier });
        return tier;
    }

    const context = SillyTavern.getContext();
    const character = context.characters[characterId];

    if (!character) {
        console.warn(`[${MODULE_NAME}] Character not found at index ${characterId}, defaulting to 'minor'`);
        return 'minor';
    }

    // 2. Check for explicit override in character extension data (permanent)
    const tierOverride = character.data?.extensions?.ensemble?.tier;
    if (tierOverride && TIERS.includes(tierOverride)) {
        console.debug(`[${MODULE_NAME}] Using card tier override for ${character.name}: ${tierOverride}`);
        return tierOverride;
    }

    // Calculate complexity score
    const knowledgeEntries = await getLorebookEntryCountForCharacter(characterId);
    const messageCount = getMessageCountForCharacter(characterId);
    const descriptionLength = (character.description?.length || 0) + (character.personality?.length || 0);
    const hasLongDescription = descriptionLength > 500;

    const complexity = (knowledgeEntries * 2) + messageCount + (hasLongDescription ? 3 : 0);

    console.debug(`[${MODULE_NAME}] Tier inference for ${character.name}:`, {
        knowledgeEntries,
        messageCount,
        descriptionLength,
        complexity,
    });

    // Determine tier from complexity score
    if (complexity > 10) {
        return 'major';
    }
    if (complexity > 3) {
        return 'standard';
    }
    return 'standard';
}

/**
 * Get the extension settings, initializing defaults if needed.
 *
 * @returns {Object} The ensemble extension settings
 */
function getEnsembleSettings() {
    const context = SillyTavern.getContext();

    // Initialize settings if they don't exist
    if (!context.extensionSettings.ensemble) {
        context.extensionSettings.ensemble = {
            tierProfiles: { ...DEFAULT_TIER_PROFILES },
        };
        context.saveSettingsDebounced();
    }

    // Ensure tierProfiles exists
    if (!context.extensionSettings.ensemble.tierProfiles) {
        context.extensionSettings.ensemble.tierProfiles = { ...DEFAULT_TIER_PROFILES };
        context.saveSettingsDebounced();
    }

    return context.extensionSettings.ensemble;
}

/**
 * Resolve a profile name (or array of names) to an array of profile objects.
 * Supports both legacy single-string format and new array format.
 *
 * @param {string|string[]} profileConfig - Profile name or array of profile names
 * @returns {Object[]} Array of resolved profile objects (empty if none found)
 */
function resolveProfilesToArray(profileConfig) {
    const context = SillyTavern.getContext();
    const connectionManager = context.extensionSettings.connectionManager;

    if (!connectionManager?.profiles?.length) {
        console.warn(`[${MODULE_NAME}] No connection profiles available`);
        return [];
    }

    // Normalize to array
    const profileNames = Array.isArray(profileConfig) ? profileConfig : [profileConfig];
    const results = [];

    for (const profileName of profileNames) {
        if (!profileName) continue; // Skip empty strings

        // Try exact match first
        let profile = connectionManager.profiles.find(p => p.name === profileName);

        if (profile) {
            results.push(profile);
            continue;
        }

        // Try fuzzy match using Fuse if available
        try {
            const { Fuse } = SillyTavern.libs;
            if (Fuse) {
                const fuse = new Fuse(connectionManager.profiles, { keys: ['name'] });
                const fuzzyResults = fuse.search(profileName);
                if (fuzzyResults.length > 0) {
                    profile = fuzzyResults[0].item;
                    console.debug(`[${MODULE_NAME}] Fuzzy matched profile '${profileName}' to '${profile.name}'`);
                    results.push(profile);
                    continue;
                }
            }
        } catch (error) {
            console.debug(`[${MODULE_NAME}] Fuse not available for fuzzy matching`);
        }

        console.warn(`[${MODULE_NAME}] Profile '${profileName}' not found, skipping in fallback chain`);
    }

    return results;
}

/**
 * Get the ST connection profiles for a given tier as an ordered fallback chain.
 * Returns an array of profiles in priority order. Supports both legacy single-string
 * format (returns array with one profile) and new array format from settings.
 *
 * @param {string} tier - The tier name ('orchestrator', 'major', 'standard', 'minor', 'utility')
 * @returns {Object[]} Array of connection profile objects (empty array if not configured/found)
 */
export function getProfilesForTier(tier) {
    const settings = getEnsembleSettings();
    const profileConfig = settings.tierProfiles[tier];

    // If no profile configured for this tier (empty string or empty array), return empty array
    if (!profileConfig || (Array.isArray(profileConfig) && profileConfig.length === 0)) {
        console.debug(`[${MODULE_NAME}] No profiles configured for tier '${tier}', using current profile`);
        return [];
    }

    return resolveProfilesToArray(profileConfig);
}

/**
 * Get the ST connection profile for a given tier.
 * Returns the first profile in the fallback chain.
 *
 * @deprecated Use getProfilesForTier() for fallback chain support
 * @param {string} tier - The tier name ('orchestrator', 'major', 'standard', 'minor', 'utility')
 * @returns {Object|null} The connection profile object, or null if not configured/found
 */
export function getProfileForTier(tier) {
    const profiles = getProfilesForTier(tier);
    return profiles.length > 0 ? profiles[0] : null;
}

/**
 * Get the next available (non-rate-limited) profile for a given tier.
 * Iterates through the fallback chain and returns the first profile that can accept requests.
 *
 * @param {string} tier - The tier name ('orchestrator', 'major', 'standard', 'minor', 'utility')
 * @returns {{profile: Object|null, skipped: Array<{name: string, reason: string}>}}
 *          The first available profile and list of skipped profiles with reasons
 */
export function getNextAvailableProfile(tier) {
    const profiles = getProfilesForTier(tier);
    const skipped = [];

    // If no profiles configured, return null to use current profile
    if (profiles.length === 0) {
        console.debug(`[${MODULE_NAME}] No profiles in fallback chain for tier '${tier}', using current profile`);
        return { profile: null, skipped };
    }

    for (const profile of profiles) {
        const limitCheck = checkRateLimit(profile.name);

        if (!limitCheck.isLimited) {
            if (skipped.length > 0) {
                console.debug(
                    `[${MODULE_NAME}] Tier '${tier}': Using '${profile.name}' after skipping ${skipped.length} rate-limited profiles`,
                    skipped
                );
            }
            return { profile, skipped };
        }

        // Profile is rate limited, record and continue
        const reason = `Rate limited, retry in ${Math.ceil(limitCheck.retryIn / 1000)}s`;
        skipped.push({ name: profile.name, reason });
        console.debug(`[${MODULE_NAME}] Skipping rate-limited profile '${profile.name}' for tier '${tier}': ${reason}`);
    }

    // All profiles are rate limited
    console.warn(
        `[${MODULE_NAME}] All ${profiles.length} profiles exhausted for tier '${tier}'`,
        skipped
    );
    return { profile: null, skipped };
}

/**
 * Get the API type string for the request body based on profile settings.
 *
 * @param {Object|null} profile - The connection profile, or null for current settings
 * @returns {string} The chat completion source identifier
 */
function getChatCompletionSource(profile) {
    // If no profile, try to determine from current main_api
    if (!profile?.api) {
        // Default to openai-compatible for safety
        return 'openai';
    }

    // Map profile API types to chat completion sources
    const apiMappings = {
        'openai': 'openai',
        'claude': 'claude',
        'openrouter': 'openrouter',
        'mistralai': 'mistralai',
        'custom': 'custom',
        'cohere': 'cohere',
        'perplexity': 'perplexity',
        'groq': 'groq',
        'makersuite': 'makersuite',
        '01ai': '01ai',
        'deepseek': 'deepseek',
        'blockentropy': 'blockentropy',
        'infermaticai': 'infermaticai',
        'dreamgen': 'dreamgen',
        'zerooneai': 'zerooneai',
        'featherless': 'featherless',
        'huggingface': 'huggingface',
    };

    return apiMappings[profile.api] || profile.api;
}

/**
 * Perform a single API call to a specific profile.
 * Internal helper for directGenerate() - does not handle fallback logic.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages array
 * @param {Object|null} profile - Connection profile to use, or null for current settings
 * @param {Object} options - Generation options
 * @param {AbortSignal} [options.signal] - Optional AbortSignal for cancellation
 * @returns {Promise<Object>} The API response with generated content
 * @throws {Error} Error with isRateLimited flag set for 429 errors
 */
async function singleProfileGenerate(messages, profile, options) {
    const {
        model,
        temperature = 0.8,
        max_tokens = 500,
        npcId = 'unknown',
        tier = 'unknown',
        signal,
    } = options;

    const profileName = profile?.name || 'default';

    // Build the request body
    const generateData = {
        type: 'quiet',
        messages: messages,
        model: model || profile?.model || undefined,
        temperature: temperature,
        max_tokens: max_tokens,
        stream: false,
        chat_completion_source: getChatCompletionSource(profile),
    };

    // Add API URL if specified in profile
    if (profile?.['api-url']) {
        generateData.custom_url = profile['api-url'];
    }

    // Add proxy if specified in profile
    if (profile?.proxy) {
        generateData.proxy = profile.proxy;
    }

    // Check rate limit before proceeding
    const limitCheck = checkRateLimit(profileName);
    if (limitCheck.isLimited) {
        const error = new Error(
            `[${MODULE_NAME}] Rate limited: ${limitCheck.reason}. Retry in ${Math.ceil(limitCheck.retryIn / 1000)}s`
        );
        error.isRateLimited = true;
        error.profileName = profileName;
        throw error;
    }

    // getRequestHeaders is a global function in ST
    const headers = typeof getRequestHeaders === 'function'
        ? getRequestHeaders()
        : { 'Content-Type': 'application/json' };

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(generateData),
        signal: signal,
    });

    if (!response.ok) {
        const statusText = response.statusText || 'Unknown error';
        const status = response.status;

        // Handle rate limit (429) with exponential backoff
        if (status === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
            const limitInfo = recordRateLimit(profileName, retryAfterSeconds);
            const error = new Error(
                `[${MODULE_NAME}] Rate limit (429) from ${profileName} for ${npcId} (tier: ${tier}). ` +
                `Retry in ${Math.ceil(limitInfo.retryIn / 1000)}s`
            );
            error.isRateLimited = true;
            error.profileName = profileName;
            throw error;
        }

        // Build actionable error message for other errors
        let suggestion = '';
        if (status === 401 || status === 403) {
            suggestion = 'Authentication failed - check your API key in the connection profile.';
        } else if (status === 404) {
            suggestion = 'Endpoint not found - verify the API URL in your connection profile.';
        } else if (status >= 500) {
            suggestion = 'Server error - the API provider may be experiencing issues.';
        }

        throw new Error(
            `[${MODULE_NAME}] Failed to generate response for ${npcId} (tier: ${tier}): ` +
            `${profileName} returned ${status} ${statusText}. ${suggestion}`
        );
    }

    const result = await response.json();

    // Record successful request to reset backoff
    recordSuccess(profileName);

    return result;
}

/**
 * Perform a direct API call to generate a response, bypassing ST's sequential queue.
 *
 * This enables parallel NPC generation by making independent fetch requests
 * directly to the chat-completions endpoint. Supports fallback chains when
 * a tier is specified - on rate limit (429), tries the next profile in the chain.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages array
 * @param {Object|null} profile - Connection profile to use, or null for current settings
 * @param {Object} [options={}] - Additional generation options
 * @param {string} [options.model] - Model override
 * @param {number} [options.temperature=0.8] - Sampling temperature
 * @param {number} [options.max_tokens=500] - Maximum response tokens
 * @param {string} [options.npcId] - NPC identifier for error messages
 * @param {string} [options.tier] - Tier for fallback chain lookup and error messages
 * @param {boolean} [options.useFallback=true] - Whether to use fallback chain on rate limit
 * @param {AbortSignal} [options.signal] - Optional AbortSignal for cancellation
 * @returns {Promise<Object>} The API response with generated content
 * @throws {Error} Descriptive error with profile name and status code on failure
 */
export async function directGenerate(messages, profile, options = {}) {
    const {
        npcId = 'unknown',
        tier = 'unknown',
        useFallback = true,
    } = options;

    // If no tier specified or fallback disabled, use single profile directly
    if (!useFallback || tier === 'unknown' || !TIERS.includes(tier)) {
        try {
            return await singleProfileGenerate(messages, profile, options);
        } catch (error) {
            // Re-throw if already formatted
            if (error.message?.startsWith(`[${MODULE_NAME}]`)) {
                throw error;
            }
            // Wrap network errors with context
            const profileName = profile?.name || 'default';
            throw new Error(
                `[${MODULE_NAME}] Network error generating response for ${npcId} (tier: ${tier}) ` +
                `using profile '${profileName}': ${error.message}`
            );
        }
    }

    // Get the full fallback chain for this tier
    const profiles = getProfilesForTier(tier);

    // If no profiles configured, use the provided profile (or current settings)
    if (profiles.length === 0) {
        try {
            return await singleProfileGenerate(messages, profile, options);
        } catch (error) {
            if (error.message?.startsWith(`[${MODULE_NAME}]`)) {
                throw error;
            }
            const profileName = profile?.name || 'default';
            throw new Error(
                `[${MODULE_NAME}] Network error generating response for ${npcId} (tier: ${tier}) ` +
                `using profile '${profileName}': ${error.message}`
            );
        }
    }

    // Track which profiles we've tried
    const triedProfiles = [];
    let lastError = null;

    // Find the starting index - start from the provided profile or beginning
    let startIndex = 0;
    if (profile) {
        const providedIndex = profiles.findIndex(p => p.name === profile.name);
        if (providedIndex !== -1) {
            startIndex = providedIndex;
        }
    }

    // Try each profile in the fallback chain
    for (let i = startIndex; i < profiles.length; i++) {
        const currentProfile = profiles[i];
        triedProfiles.push(currentProfile.name);

        try {
            console.debug(
                `[${MODULE_NAME}] Attempting profile '${currentProfile.name}' for ${npcId} (tier: ${tier})` +
                (triedProfiles.length > 1 ? ` (fallback #${triedProfiles.length})` : '')
            );

            const result = await singleProfileGenerate(messages, currentProfile, options);

            if (triedProfiles.length > 1) {
                console.info(
                    `[${MODULE_NAME}] Successfully used fallback profile '${currentProfile.name}' ` +
                    `for ${npcId} after trying: ${triedProfiles.slice(0, -1).join(', ')}`
                );
            }

            return result;

        } catch (error) {
            lastError = error;

            // Only continue to next profile on rate limit errors
            if (error.isRateLimited) {
                console.debug(
                    `[${MODULE_NAME}] Profile '${currentProfile.name}' rate limited, ` +
                    `trying next in fallback chain for ${npcId}`
                );
                continue;
            }

            // For non-rate-limit errors, re-throw immediately
            if (error.message?.startsWith(`[${MODULE_NAME}]`)) {
                throw error;
            }
            throw new Error(
                `[${MODULE_NAME}] Network error generating response for ${npcId} (tier: ${tier}) ` +
                `using profile '${currentProfile.name}': ${error.message}`
            );
        }
    }

    // All profiles exhausted - throw comprehensive error
    throw new Error(
        `[${MODULE_NAME}] All ${triedProfiles.length} profiles exhausted for ${npcId} (tier: ${tier}). ` +
        `Tried: ${triedProfiles.join(', ')}. ` +
        `Last error: ${lastError?.message || 'Unknown error'}. ` +
        `Configure additional fallback profiles or wait for rate limits to reset.`
    );
}

/**
 * Generate a response for a specific character using their inferred tier.
 *
 * This is a convenience wrapper that:
 * 1. Infers the character's tier
 * 2. Gets the appropriate connection profile
 * 3. Makes the direct API call
 *
 * @param {number} characterId - Index into the characters array
 * @param {Array<{role: string, content: string}>} messages - Chat messages array
 * @param {Object} [options={}] - Additional generation options
 * @returns {Promise<Object>} The API response
 */
export async function generateForCharacter(characterId, messages, options = {}) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];
    const npcId = character?.name || `character_${characterId}`;

    const tier = await inferTier(characterId);
    const profile = getProfileForTier(tier);

    return directGenerate(messages, profile, {
        ...options,
        npcId,
        tier,
    });
}

/**
 * Update the tier-to-profile mapping in settings.
 * Supports both single profile (legacy) and array of profiles (fallback chain).
 *
 * @param {string} tier - The tier to update
 * @param {string|string[]} profiles - Profile name(s) to assign (empty string/array = use current)
 */
export function setTierProfile(tier, profiles) {
    if (!TIERS.includes(tier)) {
        console.warn(`[${MODULE_NAME}] Invalid tier '${tier}'`);
        return;
    }

    const settings = getEnsembleSettings();
    settings.tierProfiles[tier] = profiles;

    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();

    const displayValue = Array.isArray(profiles)
        ? (profiles.length > 0 ? profiles.join(' -> ') : '(current)')
        : (profiles || '(current)');

    console.debug(`[${MODULE_NAME}] Updated tier '${tier}' to use profiles: ${displayValue}`);
}

/**
 * Set a fallback chain of profiles for a tier.
 * Convenience wrapper for setTierProfile with array format.
 *
 * @param {string} tier - The tier to update
 * @param {string[]} profileNames - Ordered array of profile names (first = primary, rest = fallbacks)
 */
export function setTierFallbackChain(tier, profileNames) {
    if (!Array.isArray(profileNames)) {
        console.warn(`[${MODULE_NAME}] setTierFallbackChain requires an array of profile names`);
        return;
    }
    setTierProfile(tier, profileNames);
}

/**
 * Get all available connection profile names.
 *
 * @returns {string[]} Array of profile names
 */
export function getAvailableProfileNames() {
    const context = SillyTavern.getContext();
    const connectionManager = context.extensionSettings.connectionManager;

    if (!connectionManager?.profiles?.length) {
        return [];
    }

    return connectionManager.profiles.map(p => p.name).sort();
}
