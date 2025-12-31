/**
 * Character Resolver for SillyTavern-Ensemble
 *
 * Intercepts character lookups and resolves from multiple sources,
 * creating characters on-demand when needed.
 *
 * Resolution Priority (5 layers):
 * 1. ST Character Cards - Existing SillyTavern characters
 * 2. Lorebook Characters - Parsed from ensemble_character:* entries (stub)
 * 3. Session Memory - In-memory Map + sessionStorage backup
 * 4. Template Match - Generated from archetype templates (stub)
 * 5. Minimal Stub - Generic fallback for unknown characters
 *
 * @module character-resolver
 */

import { logger } from './logger.js';
import { findCharacterByName } from './orchestrator.js';
import { inferTier } from './router.js';

const MODULE_NAME = 'Ensemble';

/**
 * Maximum number of generated responses to retain per session character.
 * @type {number}
 */
const MAX_RESPONSE_HISTORY = 10;

/**
 * Session characters stored in memory.
 * Key: lowercase character name, Value: SessionCharacter object
 * @type {Map<string, SessionCharacter>}
 */
const sessionCharacters = new Map();

/**
 * @typedef {Object} SessionCharacter
 * @property {string} name - Display name of the character
 * @property {string} identity - Character description/personality for prompts
 * @property {string} tier - Assigned tier ('major'|'standard'|'minor')
 * @property {'template'|'lorebook'|'stub'} source - How this character was created
 * @property {string|null} templateId - Template archetype if from template
 * @property {number} spawnCount - Number of times this character has been spawned
 * @property {number} createdAt - Timestamp when character was created
 * @property {string[]} generatedResponses - Recent response history
 * @property {Object} metadata - Additional character data (descriptor, motivation, etc.)
 * @property {Object} ephemeralState - Transient state (mood, injuries, lastInteraction)
 */

/**
 * @typedef {Object} ResolvedCharacter
 * @property {string} name - Display name of the character
 * @property {string} identity - Full text for prompts
 * @property {string} tier - Character tier for backend selection
 * @property {'card'|'lorebook'|'session'|'template'|'stub'} source - Resolution source
 * @property {number|null} stCharacterId - ST character index if from card
 * @property {string[]} knowledgeEntries - Filtered lorebook content
 * @property {0|1|2} persistenceLevel - 0=session, 1=lorebook, 2=card
 */

/**
 * Get the current chat ID for sessionStorage keying.
 * Falls back to a generated ID if no chat is active.
 *
 * @returns {string} Chat identifier
 */
function getCurrentChatId() {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;

        // Try to get chat file name or first message ID
        if (context.chatId) {
            return context.chatId;
        }

        if (chat && chat.length > 0) {
            // Use first message's ID or create hash from content
            if (chat[0]?.id) {
                return String(chat[0].id);
            }
        }

        // Fallback: use group ID if in group chat
        if (context.groupId) {
            return `group_${context.groupId}`;
        }

        // Last resort: use character ID
        if (context.characterId !== undefined) {
            return `char_${context.characterId}`;
        }

        return 'default_session';
    } catch (error) {
        logger.warn({
            event: 'chat_id_fallback',
            error: error.message,
        });
        return 'default_session';
    }
}

/**
 * Get the sessionStorage key for the current chat.
 *
 * @returns {string} Storage key
 */
function getStorageKey() {
    const chatId = getCurrentChatId();
    return `ensemble_session_${chatId}`;
}

// ============================================================================
// Session Character Management
// ============================================================================

/**
 * Get a session character by name.
 *
 * @param {string} name - Character name (case-insensitive)
 * @returns {SessionCharacter|null} The session character or null if not found
 */
export function getSessionCharacter(name) {
    if (!name || typeof name !== 'string') {
        return null;
    }
    return sessionCharacters.get(name.toLowerCase()) || null;
}

/**
 * Store or update a session character.
 *
 * @param {string} name - Character name
 * @param {Partial<SessionCharacter>} data - Character data to store
 */
export function setSessionCharacter(name, data) {
    if (!name || typeof name !== 'string') {
        logger.warn({ event: 'set_session_invalid_name', name });
        return;
    }

    const key = name.toLowerCase();
    const existing = sessionCharacters.get(key);

    /** @type {SessionCharacter} */
    const character = {
        name: data.name || name,
        identity: data.identity || '',
        tier: data.tier || 'minor',
        source: data.source || 'stub',
        templateId: data.templateId || null,
        spawnCount: data.spawnCount ?? (existing?.spawnCount || 0),
        createdAt: data.createdAt || existing?.createdAt || Date.now(),
        generatedResponses: data.generatedResponses || existing?.generatedResponses || [],
        metadata: data.metadata || existing?.metadata || {},
        ephemeralState: {
            mood: data.ephemeralState?.mood || existing?.ephemeralState?.mood || null,
            injuries: data.ephemeralState?.injuries || existing?.ephemeralState?.injuries || [],
            lastInteraction: data.ephemeralState?.lastInteraction || Date.now(),
        },
    };

    sessionCharacters.set(key, character);

    logger.debug({
        event: 'session_character_set',
        name: character.name,
        source: character.source,
        tier: character.tier,
    });

    // Auto-save to sessionStorage
    saveSessionToStorage();
}

/**
 * Update specific fields of a session character.
 *
 * @param {string} name - Character name
 * @param {Partial<SessionCharacter>} updates - Fields to update
 */
export function updateSessionCharacter(name, updates) {
    if (!name || typeof name !== 'string') {
        logger.warn({ event: 'update_session_invalid_name', name });
        return;
    }

    const key = name.toLowerCase();
    const existing = sessionCharacters.get(key);

    if (!existing) {
        logger.warn({
            event: 'update_session_not_found',
            name,
        });
        return;
    }

    // Merge updates into existing character
    const updated = {
        ...existing,
        ...updates,
        ephemeralState: {
            ...existing.ephemeralState,
            ...(updates.ephemeralState || {}),
            lastInteraction: Date.now(),
        },
    };

    sessionCharacters.set(key, updated);

    logger.debug({
        event: 'session_character_updated',
        name: updated.name,
        updatedFields: Object.keys(updates),
    });

    saveSessionToStorage();
}

/**
 * Increment the spawn count for a session character.
 *
 * @param {string} name - Character name
 * @returns {number} New spawn count, or 0 if character not found
 */
export function incrementSpawnCount(name) {
    const character = getSessionCharacter(name);

    if (!character) {
        logger.warn({ event: 'increment_spawn_not_found', name });
        return 0;
    }

    character.spawnCount += 1;
    character.ephemeralState.lastInteraction = Date.now();

    logger.debug({
        event: 'spawn_count_incremented',
        name: character.name,
        newCount: character.spawnCount,
    });

    saveSessionToStorage();
    return character.spawnCount;
}

/**
 * Add a generated response to a session character's history.
 * Maintains a rolling window of MAX_RESPONSE_HISTORY responses.
 *
 * @param {string} name - Character name
 * @param {string} response - The generated response text
 */
export function addGeneratedResponse(name, response) {
    const character = getSessionCharacter(name);

    if (!character) {
        logger.warn({ event: 'add_response_not_found', name });
        return;
    }

    character.generatedResponses.push(response);

    // Trim to max history size
    if (character.generatedResponses.length > MAX_RESPONSE_HISTORY) {
        character.generatedResponses = character.generatedResponses.slice(-MAX_RESPONSE_HISTORY);
    }

    character.ephemeralState.lastInteraction = Date.now();

    logger.debug({
        event: 'response_added',
        name: character.name,
        historySize: character.generatedResponses.length,
    });

    saveSessionToStorage();
}

/**
 * Check if a character exists in session memory.
 *
 * @param {string} name - Character name (case-insensitive)
 * @returns {boolean} True if character exists in session
 */
export function isSessionCharacter(name) {
    if (!name || typeof name !== 'string') {
        return false;
    }
    return sessionCharacters.has(name.toLowerCase());
}

/**
 * Get the count of session characters.
 *
 * @returns {number} Number of characters in session memory
 */
export function getSessionCharacterCount() {
    return sessionCharacters.size;
}

/**
 * Get a copy of all session characters.
 *
 * @returns {Map<string, SessionCharacter>} Copy of the session characters map
 */
export function getAllSessionCharacters() {
    return new Map(sessionCharacters);
}

// ============================================================================
// sessionStorage Persistence
// ============================================================================

/**
 * Save all session characters to sessionStorage.
 * Provides crash/refresh safety net.
 */
export function saveSessionToStorage() {
    try {
        const key = getStorageKey();
        const data = {
            chatId: getCurrentChatId(),
            savedAt: Date.now(),
            characters: Object.fromEntries(sessionCharacters),
        };

        sessionStorage.setItem(key, JSON.stringify(data));

        logger.debug({
            event: 'session_saved_to_storage',
            key,
            characterCount: sessionCharacters.size,
        });
    } catch (error) {
        logger.error({
            event: 'session_storage_save_error',
            error: error.message,
        });
    }
}

/**
 * Load session characters from sessionStorage.
 * Called on extension initialization to restore state after page refresh.
 */
export function loadSessionFromStorage() {
    try {
        const key = getStorageKey();
        const raw = sessionStorage.getItem(key);

        if (!raw) {
            logger.debug({
                event: 'session_storage_empty',
                key,
            });
            return;
        }

        const data = JSON.parse(raw);

        if (!data.characters || typeof data.characters !== 'object') {
            logger.warn({
                event: 'session_storage_invalid_format',
                key,
            });
            return;
        }

        // Restore characters to map
        sessionCharacters.clear();
        for (const [name, character] of Object.entries(data.characters)) {
            sessionCharacters.set(name, character);
        }

        logger.info({
            event: 'session_loaded_from_storage',
            key,
            characterCount: sessionCharacters.size,
            savedAt: data.savedAt,
        });

        if (sessionCharacters.size > 0 && typeof toastr !== 'undefined') {
            toastr.info(`Restored ${sessionCharacters.size} session character(s)`);
        }
    } catch (error) {
        logger.error({
            event: 'session_storage_load_error',
            error: error.message,
        });
    }
}

/**
 * Clear all session characters from memory and storage.
 * Should be called on CHAT_CHANGED event.
 */
export function clearSessionCharacters() {
    const count = sessionCharacters.size;
    sessionCharacters.clear();

    // Also clear from sessionStorage
    try {
        const key = getStorageKey();
        sessionStorage.removeItem(key);
    } catch (error) {
        logger.warn({
            event: 'session_storage_clear_error',
            error: error.message,
        });
    }

    logger.info({
        event: 'session_characters_cleared',
        previousCount: count,
    });
}

// ============================================================================
// Resolution Stubs (Phase 5.2 and 5.3)
// ============================================================================

/**
 * Resolve a character from lorebook entries.
 * STUB: Will be implemented in Phase 5.3.
 *
 * @param {string} name - Character name to search for
 * @returns {Promise<ResolvedCharacter|null>} Resolved character or null
 */
async function resolveFromLorebook(name) {
    // Phase 5.3 will implement parsing of ensemble_character:* lorebook entries
    // For now, return null to continue to next resolution layer
    logger.debug({
        event: 'lorebook_resolution_stub',
        name,
        message: 'Lorebook character resolution not yet implemented (Phase 5.3)',
    });
    return null;
}

/**
 * Resolve a character from template matching.
 * STUB: Will be implemented in Phase 5.2.
 *
 * @param {string} name - Character name to match against templates
 * @returns {Promise<SessionCharacter|null>} Generated session character or null
 */
async function resolveFromTemplate(name) {
    // Phase 5.2 will implement template matching using templates.js
    // For now, return null to continue to next resolution layer
    logger.debug({
        event: 'template_resolution_stub',
        name,
        message: 'Template character resolution not yet implemented (Phase 5.2)',
    });
    return null;
}

// ============================================================================
// Hydration
// ============================================================================

/**
 * Hydrate a lorebook character into session memory.
 * Preserves ephemeral state across accesses while maintaining lorebook as source of truth.
 *
 * @param {Object} lorebookCharacter - Character data from lorebook
 * @param {string} lorebookCharacter.name - Character name
 * @param {string} lorebookCharacter.identity - Character description
 * @param {string} [lorebookCharacter.tier] - Optional tier override
 * @param {Object} [lorebookCharacter.metadata] - Additional metadata
 * @returns {SessionCharacter} The hydrated session character
 */
export function hydrateFromLorebook(lorebookCharacter) {
    if (!lorebookCharacter?.name) {
        logger.error({ event: 'hydrate_missing_name' });
        throw new Error('Cannot hydrate character without name');
    }

    const existing = getSessionCharacter(lorebookCharacter.name);

    /** @type {SessionCharacter} */
    const hydrated = {
        name: lorebookCharacter.name,
        identity: lorebookCharacter.identity || '',
        tier: lorebookCharacter.tier || existing?.tier || 'minor',
        source: 'lorebook',
        templateId: null,
        spawnCount: existing?.spawnCount || 0,
        createdAt: existing?.createdAt || Date.now(),
        generatedResponses: existing?.generatedResponses || [],
        metadata: {
            ...(existing?.metadata || {}),
            ...(lorebookCharacter.metadata || {}),
        },
        ephemeralState: {
            mood: existing?.ephemeralState?.mood || null,
            injuries: existing?.ephemeralState?.injuries || [],
            lastInteraction: Date.now(),
        },
    };

    // Store in session memory
    const key = lorebookCharacter.name.toLowerCase();
    sessionCharacters.set(key, hydrated);

    logger.debug({
        event: 'character_hydrated_from_lorebook',
        name: hydrated.name,
        preservedState: !!existing,
    });

    saveSessionToStorage();
    return hydrated;
}

// ============================================================================
// Main Resolution Function
// ============================================================================

/**
 * Resolve a character by name through the 5-layer priority system.
 *
 * Resolution order:
 * 1. ST Character Cards - Check for existing SillyTavern character
 * 2. Lorebook Characters - Parse ensemble_character:* entries
 * 3. Session Memory - Check in-memory session characters
 * 4. Template Match - Generate from archetype templates
 * 5. Minimal Stub - Create generic fallback
 *
 * @param {string} name - Character name to resolve
 * @returns {Promise<ResolvedCharacter>} Resolved character (always returns, may be stub)
 */
export async function resolveCharacter(name) {
    if (!name || typeof name !== 'string') {
        logger.error({ event: 'resolve_invalid_name', name });
        throw new Error('Character name is required');
    }

    const normalizedName = name.trim();
    if (!normalizedName) {
        logger.error({ event: 'resolve_empty_name' });
        throw new Error('Character name cannot be empty');
    }

    logger.debug({
        event: 'resolve_character_start',
        name: normalizedName,
    });

    // Priority 1: ST Character Cards
    const stCharacterId = findCharacterByName(normalizedName);
    if (stCharacterId !== null) {
        const context = SillyTavern.getContext();
        const character = context.characters[stCharacterId];

        const tier = await inferTier(stCharacterId);

        /** @type {ResolvedCharacter} */
        const resolved = {
            name: character.name,
            identity: character.personality || character.description || '',
            tier,
            source: 'card',
            stCharacterId,
            knowledgeEntries: [], // Will be populated by context.js
            persistenceLevel: 2, // Card = highest persistence
        };

        logger.info({
            event: 'resolved_from_card',
            name: resolved.name,
            tier: resolved.tier,
        });

        return resolved;
    }

    // Priority 2: Lorebook Characters (stub)
    const lorebookChar = await resolveFromLorebook(normalizedName);
    if (lorebookChar) {
        // Hydrate into session for ephemeral state tracking
        const hydrated = hydrateFromLorebook(lorebookChar);

        /** @type {ResolvedCharacter} */
        const resolved = {
            name: lorebookChar.name,
            identity: lorebookChar.identity,
            tier: hydrated.tier,
            source: 'lorebook',
            stCharacterId: null,
            knowledgeEntries: [],
            persistenceLevel: 1, // Lorebook = medium persistence
        };

        logger.info({
            event: 'resolved_from_lorebook',
            name: resolved.name,
            tier: resolved.tier,
        });

        return resolved;
    }

    // Priority 3: Session Memory
    const sessionChar = getSessionCharacter(normalizedName);
    if (sessionChar) {
        // Update last interaction time
        sessionChar.ephemeralState.lastInteraction = Date.now();

        /** @type {ResolvedCharacter} */
        const resolved = {
            name: sessionChar.name,
            identity: sessionChar.identity,
            tier: sessionChar.tier,
            source: 'session',
            stCharacterId: null,
            knowledgeEntries: [],
            persistenceLevel: 0, // Session = lowest persistence
        };

        logger.info({
            event: 'resolved_from_session',
            name: resolved.name,
            tier: resolved.tier,
            spawnCount: sessionChar.spawnCount,
        });

        return resolved;
    }

    // Priority 4: Template Match (stub)
    const templateChar = await resolveFromTemplate(normalizedName);
    if (templateChar) {
        // Store in session for future access
        setSessionCharacter(normalizedName, templateChar);

        /** @type {ResolvedCharacter} */
        const resolved = {
            name: templateChar.name,
            identity: templateChar.identity,
            tier: templateChar.tier,
            source: 'template',
            stCharacterId: null,
            knowledgeEntries: [],
            persistenceLevel: 0, // Template-generated = session persistence
        };

        logger.info({
            event: 'resolved_from_template',
            name: resolved.name,
            tier: resolved.tier,
            templateId: templateChar.templateId,
        });

        return resolved;
    }

    // Priority 5: Minimal Stub
    logger.info({
        event: 'creating_stub_character',
        name: normalizedName,
    });

    /** @type {SessionCharacter} */
    const stubCharacter = {
        name: normalizedName,
        identity: `A character named ${normalizedName}.`,
        tier: 'minor',
        source: 'stub',
        templateId: null,
        spawnCount: 0,
        createdAt: Date.now(),
        generatedResponses: [],
        metadata: {},
        ephemeralState: {
            mood: null,
            injuries: [],
            lastInteraction: Date.now(),
        },
    };

    // Store stub in session for consistency
    setSessionCharacter(normalizedName, stubCharacter);

    /** @type {ResolvedCharacter} */
    const resolved = {
        name: stubCharacter.name,
        identity: stubCharacter.identity,
        tier: stubCharacter.tier,
        source: 'stub',
        stCharacterId: null,
        knowledgeEntries: [],
        persistenceLevel: 0,
    };

    if (typeof toastr !== 'undefined') {
        toastr.info(`Created stub character: ${normalizedName}`);
    }

    return resolved;
}
