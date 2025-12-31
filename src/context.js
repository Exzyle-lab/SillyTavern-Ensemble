/**
 * Context Builder for SillyTavern-Ensemble
 *
 * Implements lorebook filtering and knowledge hardening so NPCs
 * only see context appropriate to their character.
 *
 * Key concepts:
 * - Knowledge hardening: NPCs never see entries they're unaware of
 * - characterFilter: Lorebook entries can be restricted to specific characters
 * - Scene state: Shared context about location, time, and present characters
 *
 * @module context
 */

import { logger } from './logger.js';

const MODULE_NAME = 'Ensemble';

/**
 * Default scene state when ensemble_scene_state entry is missing.
 * @type {Object}
 */
const DEFAULT_SCENE_STATE = Object.freeze({
    location: 'Unknown',
    time: 'Present',
    present_npcs: [],
    tension: 5,
    recent_events: [],
});

/**
 * NPC prompt template with Handlebars-style placeholders.
 * This is inlined to avoid async file loading complexity.
 * @type {string}
 */
const NPC_TEMPLATE = `# {{npc_name}}

## Identity
{{identity}}

## Your Knowledge
{{knowledge}}

## Current Scene
Location: {{scene.location}}
Time: {{scene.time}}
Present: {{scene.present_npcs}}

---

React to the following situation. {{format_instruction}}

{{situation}}`;

/**
 * Format instructions based on response format type.
 * @type {Object.<string, string>}
 */
const FORMAT_INSTRUCTIONS = Object.freeze({
    dialogue: 'Respond with dialogue only. No action descriptions or narration.',
    action: 'Respond with actions only. Describe what you do, no spoken dialogue.',
    full: 'Respond with both dialogue and actions as appropriate.',
});

/**
 * Attempt lenient JSON parsing for scene state.
 *
 * LLMs often produce JSON with minor syntax errors like trailing commas.
 * This function tries strict parsing first, then attempts trailing comma cleanup.
 *
 * Note: Single-quote replacement was removed as it risks corrupting
 * natural language content containing apostrophes.
 *
 * @param {string} str - JSON string to parse
 * @returns {Object|null} Parsed object or null on failure
 */
function lenientJSONParse(str) {
    // First try strict parsing
    try {
        return JSON.parse(str);
    } catch (strictError) {
        // Strict parse failed, attempt cleanup
    }

    try {
        let cleaned = str;

        // Remove trailing commas before } and ]
        // Matches: comma followed by optional whitespace and then } or ]
        cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

        return JSON.parse(cleaned);
    } catch (lenientError) {
        // Both strict and lenient parsing failed
        return null;
    }
}

/**
 * Get all lorebook entries from SillyTavern.
 *
 * Attempts to use window.getSortedEntries() which returns all entries
 * across global, character, chat, and persona lore sources.
 * Falls back to empty array if unavailable.
 *
 * @returns {Promise<Array>} Array of lorebook entry objects
 */
export async function getAllLorebookEntries() {
    try {
        // getSortedEntries is a global function in ST that returns
        // all lorebook entries sorted by their configured strategy
        if (typeof window.getSortedEntries === 'function') {
            const entries = await window.getSortedEntries();

            if (Array.isArray(entries)) {
                logger.debug({
                    event: 'lorebook_entries_loaded',
                    count: entries.length,
                });
                return entries;
            }

            logger.warn({
                event: 'lorebook_unexpected_format',
                type: typeof entries,
            });
            return [];
        }

        // Fallback: try to access through alternative methods
        // Some ST versions expose world info differently
        const context = SillyTavern.getContext();

        // Check for worldInfo in chat metadata
        if (context.chatMetadata?.world_info?.entries) {
            const entries = Object.values(context.chatMetadata.world_info.entries);
            logger.debug({
                event: 'lorebook_entries_from_metadata',
                count: entries.length,
            });
            return entries;
        }

        logger.warn({
            event: 'lorebook_unavailable',
            message: 'getSortedEntries() not available and no fallback found',
        });
        return [];

    } catch (error) {
        logger.error({
            event: 'lorebook_error',
            error: error.message,
        });
        return [];
    }
}

/**
 * Get character filename (avatar without extension) for filter matching.
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
    // e.g., "harley_quinn.png" -> "harley_quinn"
    return character.avatar.replace(/\.[^/.]+$/, '');
}

/**
 * Get character name for display and filter matching.
 *
 * @param {number} characterId - Index into the characters array
 * @returns {string|null} The character name, or null if invalid
 */
export function getCharacterName(characterId) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];
    return character?.name || null;
}

/**
 * Filter lorebook entries for a specific NPC using knowledge hardening.
 *
 * Filter logic:
 * - No filter = common knowledge (include for all)
 * - characterFilter.names with isExclude=false: include ONLY for these characters
 * - characterFilter.names with isExclude=true: exclude these characters (include for everyone else)
 *
 * Knowledge hardening principle:
 * - Entries the NPC is unaware of are simply not included in their context
 * - This prevents the "pink elephant effect" where mentioning something makes it leak
 * - false_beliefs entries appear as facts (NPC believes them sincerely)
 *
 * @param {Array} entries - All lorebook entries
 * @param {string} npcFilename - The NPC's filename for filter matching
 * @param {string} [npcName] - The NPC's display name (optional, for name-based matching)
 * @returns {Array} Filtered entries visible to this NPC
 */
export function filterEntriesForNPC(entries, npcFilename, npcName = null) {
    if (!Array.isArray(entries)) {
        logger.warn({
            event: 'filter_invalid_entries',
            type: typeof entries,
        });
        return [];
    }

    if (!npcFilename && !npcName) {
        logger.warn({
            event: 'filter_no_identifier',
            message: 'No filename or name provided for NPC filtering',
        });
        return [];
    }

    const filtered = entries.filter(entry => {
        const filter = entry.characterFilter;

        // No filter = common knowledge, visible to all
        if (!filter) {
            return true;
        }

        // Check if filter has any constraints
        const hasNameFilter = filter.names && filter.names.length > 0;
        const hasTagFilter = filter.tags && filter.tags.length > 0;

        // No constraints = common knowledge
        if (!hasNameFilter && !hasTagFilter) {
            return true;
        }

        // Handle character name filter
        if (hasNameFilter) {
            // Check both filename and display name for flexibility
            const isInList = filter.names.includes(npcFilename) ||
                           (npcName && filter.names.includes(npcName));

            if (filter.isExclude) {
                // isExclude=true: entry is visible to everyone EXCEPT these names
                // If NPC is in the exclude list, they don't see it
                return !isInList;
            } else {
                // isExclude=false (default): entry is visible ONLY to these names
                // If NPC is not in the include list, they don't see it
                return isInList;
            }
        }

        // Tag filter only - Phase 3 implementation
        // For now, if only tags are specified and no names, exclude the entry
        // This prevents accidental information leakage
        if (hasTagFilter && !hasNameFilter) {
            logger.debug({
                event: 'filter_tag_only_skipped',
                entryKey: entry.key?.[0] || entry.comment || 'unknown',
            });
            return false;
        }

        return true;
    });

    logger.debug({
        event: 'entries_filtered',
        npc: npcFilename || npcName,
        total: entries.length,
        visible: filtered.length,
    });

    return filtered;
}

/**
 * Get scene state from the ensemble_scene_state lorebook entry.
 *
 * The scene state entry should have:
 * - Key containing "ensemble_scene_state"
 * - Content as valid JSON with location, time, present_npcs, etc.
 *
 * @param {Array} entries - All lorebook entries
 * @returns {Object} Scene state object (defaults if not found or invalid)
 */
export function getSceneState(entries) {
    if (!Array.isArray(entries)) {
        return { ...DEFAULT_SCENE_STATE };
    }

    // Find the scene state entry by key
    const sceneEntry = entries.find(entry => {
        const keys = entry.key || entry.keys || [];
        const keyArray = Array.isArray(keys) ? keys : [keys];
        return keyArray.some(k =>
            typeof k === 'string' &&
            k.toLowerCase().includes('ensemble_scene_state')
        );
    });

    if (!sceneEntry) {
        logger.debug({
            event: 'scene_state_not_found',
            message: 'No ensemble_scene_state entry found, using defaults',
        });
        return { ...DEFAULT_SCENE_STATE };
    }

    // Parse the JSON content
    const content = sceneEntry.content || '';

    // Try to extract JSON from the content
    // It might be pure JSON or wrapped in markdown code blocks
    let jsonContent = content.trim();

    // Remove markdown code block if present
    const codeBlockMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        jsonContent = codeBlockMatch[1].trim();
    }

    const parsed = lenientJSONParse(jsonContent);

    if (!parsed) {
        logger.warn({
            event: 'scene_state_parse_error',
            error: 'Failed to parse scene state JSON (strict and lenient parsing both failed)',
            content: content.substring(0, 100),
        });
        toastr.warning('Scene state corrupted in Lorebook. Using defaults.');
        return { ...DEFAULT_SCENE_STATE };
    }

    // Merge with defaults to ensure all fields exist
    const sceneState = {
        location: parsed.location || DEFAULT_SCENE_STATE.location,
        time: parsed.time || DEFAULT_SCENE_STATE.time,
        present_npcs: Array.isArray(parsed.present_npcs)
            ? parsed.present_npcs
            : DEFAULT_SCENE_STATE.present_npcs,
        tension: typeof parsed.tension === 'number'
            ? parsed.tension
            : DEFAULT_SCENE_STATE.tension,
        recent_events: Array.isArray(parsed.recent_events)
            ? parsed.recent_events
            : DEFAULT_SCENE_STATE.recent_events,
    };

    logger.debug({
        event: 'scene_state_loaded',
        location: sceneState.location,
        presentCount: sceneState.present_npcs.length,
    });

    return sceneState;
}

/**
 * Filter scene state for NPC perspective.
 *
 * NPCs should only know about recent events they witnessed.
 * Events with character filters are applied here.
 *
 * @param {Object} sceneState - Full scene state
 * @param {string} npcFilename - The NPC's filename
 * @param {string} [npcName] - The NPC's display name
 * @param {Array} entries - All lorebook entries (for event filtering)
 * @returns {Object} Scene state filtered for this NPC's perspective
 */
export function filterSceneStateForNPC(sceneState, npcFilename, npcName = null, entries = []) {
    // For now, return scene state as-is
    // Phase 3 can add event-level filtering based on witness lists
    // stored in separate lorebook entries

    // Filter present_npcs to only include characters this NPC knows about
    // (all present characters are visible for now)
    return {
        ...sceneState,
        // Convert present_npcs array to comma-separated string for template
        present_npcs_display: Array.isArray(sceneState.present_npcs)
            ? sceneState.present_npcs.join(', ')
            : String(sceneState.present_npcs || ''),
    };
}

/**
 * Format knowledge entries into readable text.
 *
 * Combines lorebook entry contents into a coherent knowledge section
 * for the NPC prompt.
 *
 * @param {Array} entries - Filtered lorebook entries for this NPC
 * @returns {string} Formatted knowledge text
 */
export function formatKnowledge(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return 'No specific knowledge available.';
    }

    // Extract and clean content from each entry
    const knowledgePieces = entries
        .map(entry => {
            const content = entry.content || '';
            return content.trim();
        })
        .filter(content => content.length > 0);

    if (knowledgePieces.length === 0) {
        return 'No specific knowledge available.';
    }

    // Join with double newlines for readability
    return knowledgePieces.join('\n\n');
}

/**
 * Build complete NPC context object.
 *
 * Gathers all relevant information for an NPC:
 * - Character identity from card
 * - Filtered knowledge from lorebook
 * - Scene state (location, time, present characters)
 *
 * @param {number} characterId - Index into the characters array
 * @param {string} situation - The situation NPC is reacting to
 * @returns {Promise<Object>} Context object with all NPC-relevant data
 */
export async function buildNPCContext(characterId, situation) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];

    if (!character) {
        logger.error({
            event: 'context_build_failed',
            reason: 'Character not found',
            characterId: characterId,
        });
        throw new Error(`Character not found at index ${characterId}`);
    }

    const filename = getCharacterFilename(characterId);
    const name = character.name;

    logger.debug({
        event: 'context_build_start',
        npc: name,
        filename: filename,
    });

    // Get all lorebook entries
    const allEntries = await getAllLorebookEntries();

    // Filter entries for this NPC (knowledge hardening)
    const npcEntries = filterEntriesForNPC(allEntries, filename, name);

    // Get and filter scene state
    const rawSceneState = getSceneState(allEntries);
    const sceneState = filterSceneStateForNPC(rawSceneState, filename, name, allEntries);

    // Build identity from character card fields
    // Priority: personality > description > scenario
    let identity = '';
    if (character.personality) {
        identity = character.personality;
    } else if (character.description) {
        identity = character.description;
    }
    if (character.scenario && !identity.includes(character.scenario)) {
        identity += identity ? `\n\n${character.scenario}` : character.scenario;
    }

    // Format knowledge from filtered entries
    const knowledge = formatKnowledge(npcEntries);

    // Extract raw knowledge content for programmatic access
    const knowledgeEntries = npcEntries
        .map(entry => (entry.content || '').trim())
        .filter(content => content.length > 0);

    const contextData = {
        npc_name: name,
        identity: identity || 'No character information available.',
        knowledge: knowledge, // Formatted string for prompts
        knowledgeEntries: knowledgeEntries, // Raw array for queries
        scene: {
            location: sceneState.location,
            time: sceneState.time,
            present_npcs: sceneState.present_npcs_display || sceneState.present_npcs,
            tension: sceneState.tension,
        },
        situation: situation,
        // Metadata for debugging
        _meta: {
            characterId: characterId,
            filename: filename,
            entryCount: npcEntries.length,
            totalEntries: allEntries.length,
        },
    };

    logger.debug({
        event: 'context_build_complete',
        npc: name,
        knowledgeEntries: npcEntries.length,
        identityLength: identity.length,
    });

    return contextData;
}

/**
 * Apply template substitution using Handlebars-style placeholders.
 *
 * Replaces {{placeholder}} with values from the data object.
 * Supports nested paths like {{scene.location}}.
 *
 * @param {string} template - Template string with {{placeholders}}
 * @param {Object} data - Data object with values to substitute
 * @returns {string} Template with placeholders replaced
 */
export function applyTemplate(template, data) {
    return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
        // Handle nested paths like scene.location
        const keys = path.trim().split('.');
        let value = data;

        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                // Path not found, return empty string
                return '';
            }
        }

        // Convert arrays to comma-separated strings
        if (Array.isArray(value)) {
            return value.join(', ');
        }

        // Return stringified value
        return String(value ?? '');
    });
}

/**
 * Build messages array for API call from context.
 *
 * Creates the messages array expected by chat completion APIs,
 * with system prompt from template and user prompt for situation.
 *
 * @param {Object} contextData - Context from buildNPCContext
 * @param {string} [format='full'] - Response format: 'dialogue', 'action', or 'full'
 * @returns {Array<{role: string, content: string}>} Messages array for API
 */
export function buildNPCMessages(contextData, format = 'full') {
    // Get format instruction
    const formatInstruction = FORMAT_INSTRUCTIONS[format] || FORMAT_INSTRUCTIONS.full;

    // Build template data
    const templateData = {
        ...contextData,
        format_instruction: formatInstruction,
    };

    // Apply template substitution
    const systemContent = applyTemplate(NPC_TEMPLATE, templateData);

    // Build messages array
    // The template includes the situation, so we use it as the system prompt
    // and provide a simple user prompt to trigger the response
    const messages = [
        {
            role: 'system',
            content: systemContent,
        },
        {
            role: 'user',
            content: `As ${contextData.npc_name}, respond to this situation now.`,
        },
    ];

    return messages;
}

/**
 * Build NPC context and messages in one call.
 *
 * Convenience function that combines buildNPCContext and buildNPCMessages
 * for simpler integration with the orchestrator.
 *
 * @param {number} characterId - Index into the characters array
 * @param {string} situation - The situation NPC is reacting to
 * @param {string} [format='full'] - Response format
 * @returns {Promise<Array<{role: string, content: string}>>} Messages array
 */
export async function buildNPCPromptWithContext(characterId, situation, format = 'full') {
    const contextData = await buildNPCContext(characterId, situation);
    return buildNPCMessages(contextData, format);
}

/**
 * Check if lorebook access is available.
 *
 * Utility function to verify that getSortedEntries is available
 * before attempting lorebook operations.
 *
 * @returns {boolean} True if lorebook API is accessible
 */
export function isLorebookAvailable() {
    return typeof window.getSortedEntries === 'function';
}

/**
 * Get a summary of available knowledge for debugging.
 *
 * Returns counts and sample keys for all lorebook entries,
 * useful for verifying knowledge hardening is working.
 *
 * @param {number} characterId - Character to analyze
 * @returns {Promise<Object>} Summary of knowledge visibility
 */
export async function getKnowledgeSummary(characterId) {
    const filename = getCharacterFilename(characterId);
    const name = getCharacterName(characterId);
    const allEntries = await getAllLorebookEntries();
    const visibleEntries = filterEntriesForNPC(allEntries, filename, name);
    const hiddenCount = allEntries.length - visibleEntries.length;

    return {
        character: name,
        filename: filename,
        totalEntries: allEntries.length,
        visibleEntries: visibleEntries.length,
        hiddenEntries: hiddenCount,
        visibleKeys: visibleEntries
            .slice(0, 10)
            .map(e => e.key?.[0] || e.comment || 'unnamed'),
        sceneState: getSceneState(allEntries),
    };
}

// ============================================================================
// Lorebook Character Parsing (Phase 5.3 - Character Lifecycle System)
// ============================================================================

/**
 * @typedef {Object} LorebookCharacter
 * @property {string} name - Display name of the character
 * @property {'major'|'standard'|'minor'} tier - Character tier for routing
 * @property {string|null} template - Optional template hint
 * @property {string} voice - Voice/speaking style description
 * @property {string} personality - Personality description
 * @property {string} background - Background/history
 * @property {string[]} quirks - Character quirks and mannerisms
 * @property {string} _entryKey - Original lorebook key for reference
 * @property {string} _entryUid - Lorebook entry UID
 */

/**
 * Prefix used to identify ensemble character entries in lorebook.
 * @type {string}
 */
const CHARACTER_ENTRY_PREFIX = 'ensemble_character:';

/**
 * Valid tier values for ensemble characters.
 * @type {Set<string>}
 */
const VALID_TIERS = new Set(['major', 'standard', 'minor']);

/**
 * Parse simple YAML content into an object.
 *
 * Handles:
 * - Key-value pairs: `key: value` or `key: "quoted value"`
 * - Arrays with `- item` syntax
 * - Multiline indicator `|` (content on following lines)
 * - Comments starting with #
 *
 * This is a minimal parser for character definitions, not full YAML spec.
 *
 * @param {string} content - YAML content to parse
 * @returns {Object} Parsed object with string and array values
 */
function parseSimpleYAML(content) {
    const result = {};
    const lines = content.split('\n');
    let currentKey = null;
    let inArray = false;
    let inMultiline = false;
    let multilineContent = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines and comments (unless in multiline mode)
        if (!trimmed || trimmed.startsWith('#')) {
            if (inMultiline && currentKey) {
                // Empty line in multiline - preserve as paragraph break
                multilineContent.push('');
            }
            continue;
        }

        // Check indentation for context
        const indent = line.length - line.trimStart().length;

        // Array item: "  - value"
        if (trimmed.startsWith('- ') && inArray && currentKey) {
            let value = trimmed.substring(2).trim();
            // Remove surrounding quotes
            value = value.replace(/^["']|["']$/g, '');
            result[currentKey].push(value);
            continue;
        }

        // If we were in multiline mode and hit a non-indented line with a colon,
        // we've moved to a new key
        if (inMultiline && indent === 0 && trimmed.includes(':')) {
            // Finalize multiline content
            result[currentKey] = multilineContent.join('\n').trim();
            multilineContent = [];
            inMultiline = false;
            currentKey = null;
        }

        // Multiline continuation (indented content after |)
        if (inMultiline && currentKey && indent > 0) {
            multilineContent.push(trimmed);
            continue;
        }

        // Key-value: "key: value" or "key:" or "key: |"
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
            const key = trimmed.substring(0, colonIndex).trim();
            let value = trimmed.substring(colonIndex + 1).trim();

            // Remove surrounding quotes from value
            value = value.replace(/^["']|["']$/g, '');

            if (value === '|') {
                // Multiline string indicator
                currentKey = key;
                inMultiline = true;
                inArray = false;
                multilineContent = [];
            } else if (value === '') {
                // Empty value - could be array or multiline, check next line
                currentKey = key;
                result[key] = [];
                inArray = true;
                inMultiline = false;
            } else {
                // Simple key-value
                result[key] = value;
                currentKey = key;
                inArray = false;
                inMultiline = false;
            }
        }
    }

    // Finalize any pending multiline content
    if (inMultiline && currentKey && multilineContent.length > 0) {
        result[currentKey] = multilineContent.join('\n').trim();
    }

    // Convert empty arrays to empty strings for non-array fields
    // Keep arrays that actually have items
    for (const [key, value] of Object.entries(result)) {
        if (Array.isArray(value) && value.length === 0 && key !== 'quirks') {
            result[key] = '';
        }
    }

    return result;
}

/**
 * Convert a key segment to title case display name.
 *
 * Transforms underscore-separated lowercase to proper title case.
 * Example: "guard_captain_marcus" -> "Guard Captain Marcus"
 *
 * @param {string} keyPart - Key segment after the prefix
 * @returns {string} Title-cased display name
 */
function keyToDisplayName(keyPart) {
    return keyPart
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Extract the character ID from a lorebook entry key.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {string|null} Character ID or null if not a character entry
 */
function extractCharacterIdFromEntry(entry) {
    const keys = entry.key || entry.keys || [];
    const keyArray = Array.isArray(keys) ? keys : [keys];

    for (const key of keyArray) {
        if (typeof key !== 'string') continue;

        const lowerKey = key.toLowerCase();
        const prefixIndex = lowerKey.indexOf(CHARACTER_ENTRY_PREFIX.toLowerCase());

        if (prefixIndex !== -1) {
            // Extract the part after the prefix
            const afterPrefix = key.substring(prefixIndex + CHARACTER_ENTRY_PREFIX.length);
            return afterPrefix.trim() || null;
        }
    }

    return null;
}

/**
 * Check if a lorebook entry is an ensemble character definition.
 *
 * Character entries have a key containing "ensemble_character:" (case-insensitive).
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean} True if entry is a character definition
 */
export function isCharacterEntry(entry) {
    if (!entry) return false;

    const keys = entry.key || entry.keys || [];
    const keyArray = Array.isArray(keys) ? keys : [keys];

    return keyArray.some(key =>
        typeof key === 'string' &&
        key.toLowerCase().includes(CHARACTER_ENTRY_PREFIX.toLowerCase())
    );
}

/**
 * Parse a lorebook entry as an ensemble character definition.
 *
 * Expected lorebook entry format:
 * - Key: `ensemble_character:marcus` or `ensemble_character:guard_captain_marcus`
 * - Content: YAML format with name, tier, template, voice, personality, background, quirks
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {LorebookCharacter|null} Parsed character or null if not a character entry
 */
export function parseLorebookCharacter(entry) {
    if (!isCharacterEntry(entry)) {
        return null;
    }

    const characterId = extractCharacterIdFromEntry(entry);
    if (!characterId) {
        logger.warn({
            event: 'character_parse_no_id',
            message: 'Character entry found but could not extract ID',
            entryUid: entry.uid,
        });
        return null;
    }

    // Parse YAML content
    const content = entry.content || '';
    const parsed = parseSimpleYAML(content);

    // Determine name: explicit field or derive from key
    const name = parsed.name || keyToDisplayName(characterId);

    // Validate and default tier
    let tier = 'standard';
    if (parsed.tier && VALID_TIERS.has(parsed.tier.toLowerCase())) {
        tier = parsed.tier.toLowerCase();
    }

    // Build character object with defaults
    const character = {
        name: name,
        tier: tier,
        template: parsed.template || null,
        voice: parsed.voice || '',
        personality: parsed.personality || '',
        background: parsed.background || '',
        quirks: Array.isArray(parsed.quirks) ? parsed.quirks : [],
        // Metadata
        _entryKey: `${CHARACTER_ENTRY_PREFIX}${characterId}`,
        _entryUid: entry.uid || '',
    };

    logger.debug({
        event: 'character_parsed',
        name: character.name,
        tier: character.tier,
        entryKey: character._entryKey,
    });

    return character;
}

/**
 * Get all ensemble characters from lorebook.
 *
 * Scans all lorebook entries for character definitions and parses them.
 * Returns a Map keyed by lowercase name for case-insensitive lookup.
 *
 * @returns {Promise<Map<string, LorebookCharacter>>} Map of name.toLowerCase() -> character
 */
export async function getAllLorebookCharacters() {
    const characters = new Map();

    try {
        const entries = await getAllLorebookEntries();

        for (const entry of entries) {
            const character = parseLorebookCharacter(entry);
            if (character) {
                // Key by lowercase name for case-insensitive lookup
                const lookupKey = character.name.toLowerCase();

                // Warn on duplicate names
                if (characters.has(lookupKey)) {
                    logger.warn({
                        event: 'character_duplicate',
                        name: character.name,
                        existingKey: characters.get(lookupKey)._entryKey,
                        newKey: character._entryKey,
                    });
                }

                characters.set(lookupKey, character);
            }
        }

        logger.debug({
            event: 'characters_loaded',
            count: characters.size,
        });

    } catch (error) {
        logger.error({
            event: 'characters_load_error',
            error: error.message,
        });
    }

    return characters;
}

/**
 * Find a specific lorebook character by name.
 *
 * Performs case-insensitive lookup against character names.
 *
 * @param {string} name - Character name to find
 * @returns {Promise<LorebookCharacter|null>} Character or null if not found
 */
export async function findLorebookCharacter(name) {
    if (!name || typeof name !== 'string') {
        return null;
    }

    const characters = await getAllLorebookCharacters();
    const lookupKey = name.toLowerCase().trim();

    // Direct lookup
    if (characters.has(lookupKey)) {
        return characters.get(lookupKey);
    }

    // Try partial match if exact match fails
    // This handles cases like searching for "Marcus" when entry is "Guard Captain Marcus"
    for (const [key, character] of characters) {
        if (key.includes(lookupKey) || lookupKey.includes(key)) {
            logger.debug({
                event: 'character_partial_match',
                searched: name,
                found: character.name,
            });
            return character;
        }
    }

    logger.debug({
        event: 'character_not_found',
        searched: name,
    });

    return null;
}
