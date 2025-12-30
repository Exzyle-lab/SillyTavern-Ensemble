/**
 * SillyTavern-Ensemble Backend Router
 *
 * Handles:
 * - Dynamic tier inference based on character complexity
 * - Connection profile lookup and selection
 * - Direct API calls bypassing ST's sequential queue
 *
 * @module router
 */

const MODULE_NAME = 'Ensemble';

/**
 * Valid tier values for NPC categorization
 * @type {readonly string[]}
 */
export const TIERS = Object.freeze(['orchestrator', 'major', 'standard', 'minor', 'utility']);

/**
 * Default tier-to-profile mapping (empty = use current profile)
 * @type {Object.<string, string>}
 */
const DEFAULT_TIER_PROFILES = {
    orchestrator: '',
    major: '',
    standard: '',
    minor: '',
    utility: '',
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
 * Complexity is calculated from:
 * - Lorebook entries filtered to this character (weight: 2x)
 * - Message count in current chat history
 * - Character description length (>500 chars adds 3 points)
 *
 * @param {number} characterId - Index into the characters array
 * @returns {Promise<string>} The inferred tier: 'major', 'standard', or 'minor'
 */
export async function inferTier(characterId) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];

    if (!character) {
        console.warn(`[${MODULE_NAME}] Character not found at index ${characterId}, defaulting to 'minor'`);
        return 'minor';
    }

    // Check for explicit override in character extension data
    const tierOverride = character.data?.extensions?.ensemble?.tier;
    if (tierOverride && TIERS.includes(tierOverride)) {
        console.debug(`[${MODULE_NAME}] Using explicit tier override for ${character.name}: ${tierOverride}`);
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
    return 'minor';
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
 * Get the ST connection profile for a given tier.
 *
 * @param {string} tier - The tier name ('orchestrator', 'major', 'standard', 'minor', 'utility')
 * @returns {Object|null} The connection profile object, or null if not configured/found
 */
export function getProfileForTier(tier) {
    const settings = getEnsembleSettings();
    const profileName = settings.tierProfiles[tier];

    // If no profile configured for this tier (empty string), return null to use current profile
    if (!profileName) {
        console.debug(`[${MODULE_NAME}] No profile configured for tier '${tier}', using current profile`);
        return null;
    }

    // Access connection profiles from extension_settings
    const context = SillyTavern.getContext();
    const connectionManager = context.extensionSettings.connectionManager;

    if (!connectionManager?.profiles?.length) {
        console.warn(`[${MODULE_NAME}] No connection profiles available`);
        return null;
    }

    // Try exact match first
    let profile = connectionManager.profiles.find(p => p.name === profileName);

    if (profile) {
        return profile;
    }

    // Try fuzzy match using Fuse if available
    try {
        const { Fuse } = SillyTavern.libs;
        if (Fuse) {
            const fuse = new Fuse(connectionManager.profiles, { keys: ['name'] });
            const results = fuse.search(profileName);
            if (results.length > 0) {
                profile = results[0].item;
                console.debug(`[${MODULE_NAME}] Fuzzy matched profile '${profileName}' to '${profile.name}'`);
                return profile;
            }
        }
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Fuse not available for fuzzy matching`);
    }

    console.warn(`[${MODULE_NAME}] Profile '${profileName}' not found for tier '${tier}'`);
    return null;
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

    return apiMappings[profile.api] || 'openai';
}

/**
 * Perform a direct API call to generate a response, bypassing ST's sequential queue.
 *
 * This enables parallel NPC generation by making independent fetch requests
 * directly to the chat-completions endpoint.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages array
 * @param {Object|null} profile - Connection profile to use, or null for current settings
 * @param {Object} [options={}] - Additional generation options
 * @param {string} [options.model] - Model override
 * @param {number} [options.temperature=0.8] - Sampling temperature
 * @param {number} [options.max_tokens=500] - Maximum response tokens
 * @param {string} [options.npcId] - NPC identifier for error messages
 * @param {string} [options.tier] - Tier for error messages
 * @returns {Promise<Object>} The API response with generated content
 * @throws {Error} Descriptive error with profile name and status code on failure
 */
export async function directGenerate(messages, profile, options = {}) {
    const {
        model,
        temperature = 0.8,
        max_tokens = 500,
        npcId = 'unknown',
        tier = 'unknown',
    } = options;

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

    const profileName = profile?.name || 'current';

    try {
        // getRequestHeaders is a global function in ST
        const headers = typeof getRequestHeaders === 'function'
            ? getRequestHeaders()
            : { 'Content-Type': 'application/json' };

        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(generateData),
        });

        if (!response.ok) {
            const statusText = response.statusText || 'Unknown error';
            const status = response.status;

            // Build actionable error message
            let suggestion = '';
            if (status === 429) {
                suggestion = 'Rate limit exceeded - try again in a few minutes or switch to a different backend profile.';
            } else if (status === 401 || status === 403) {
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
        return result;

    } catch (error) {
        // Re-throw if already formatted
        if (error.message?.startsWith(`[${MODULE_NAME}]`)) {
            throw error;
        }

        // Wrap network errors with context
        throw new Error(
            `[${MODULE_NAME}] Network error generating response for ${npcId} (tier: ${tier}) ` +
            `using profile '${profileName}': ${error.message}`
        );
    }
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
 *
 * @param {string} tier - The tier to update
 * @param {string} profileName - The profile name to assign (empty string = use current)
 */
export function setTierProfile(tier, profileName) {
    if (!TIERS.includes(tier)) {
        console.warn(`[${MODULE_NAME}] Invalid tier '${tier}'`);
        return;
    }

    const settings = getEnsembleSettings();
    settings.tierProfiles[tier] = profileName;

    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();

    console.debug(`[${MODULE_NAME}] Updated tier '${tier}' to use profile '${profileName || '(current)'}'`);
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
