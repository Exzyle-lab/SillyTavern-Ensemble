/**
 * Character Promotion System for SillyTavern-Ensemble
 *
 * Handles promotion of session characters to lorebook entries and character cards,
 * with threshold tracking and toast notifications.
 *
 * Promotion Levels:
 * - Level 0: Session (in-memory, lost on refresh)
 * - Level 1: Lorebook (persistent entry, survives refresh)
 * - Level 2: Card (full ST character with avatar)
 *
 * @module character-promoter
 */

import { logger } from './logger.js';
import {
    getSessionCharacter,
    getAllSessionCharacters,
} from './character-resolver.js';

const MODULE_NAME = 'Ensemble';

/**
 * Promotion thresholds for session -> lorebook.
 * Character is promotable if spawnCount >= 3 OR totalResponseLength > 500.
 * @type {Object}
 */
const SESSION_TO_LOREBOOK_THRESHOLD = {
    spawnCount: 3,
    responseLength: 500,
};

/**
 * Promotion thresholds for lorebook -> card.
 * Character is promotable if spawnCount >= 10 AND hasCustomKnowledge.
 * @type {Object}
 */
const LOREBOOK_TO_CARD_THRESHOLD = {
    spawnCount: 10,
    requiresCustomKnowledge: true,
};

/**
 * Prefix for ensemble character lorebook entries.
 * @type {string}
 */
const CHARACTER_ENTRY_PREFIX = 'ensemble_character:';

/**
 * @typedef {Object} PromotionStatus
 * @property {string} name - Character name
 * @property {0|1|2} currentLevel - 0=session, 1=lorebook, 2=card
 * @property {number} spawnCount - Number of times spawned
 * @property {number} totalResponseLength - Combined length of all responses
 * @property {boolean} meetsThreshold - True if ready for promotion
 * @property {'lorebook'|'card'|null} nextLevel - Next promotion level or null
 * @property {Object} requirements - Detailed requirement status
 */

/**
 * Calculate total response length for a session character.
 *
 * @param {Object} character - Session character object
 * @returns {number} Total length of all generated responses
 */
function calculateResponseLength(character) {
    if (!character?.generatedResponses || !Array.isArray(character.generatedResponses)) {
        return 0;
    }
    return character.generatedResponses.join('').length;
}

/**
 * Check if a session character meets promotion threshold.
 *
 * Session -> Lorebook threshold: spawnCount >= 3 OR totalResponseLength > 500
 *
 * @param {string} name - Character name
 * @returns {boolean} True if ready for promotion suggestion
 */
export function checkPromotionThreshold(name) {
    const character = getSessionCharacter(name);

    if (!character) {
        return false;
    }

    // Already promoted to lorebook or card
    if (character.source === 'lorebook' || character.source === 'card') {
        return false;
    }

    const responseLength = calculateResponseLength(character);

    // OR condition: either threshold met
    return character.spawnCount >= SESSION_TO_LOREBOOK_THRESHOLD.spawnCount ||
           responseLength > SESSION_TO_LOREBOOK_THRESHOLD.responseLength;
}

/**
 * Get promotion status and stats for a character.
 *
 * @param {string} name - Character name
 * @returns {PromotionStatus|null} Status object with thresholds and current values, or null if not found
 */
export function getPromotionStatus(name) {
    const character = getSessionCharacter(name);

    if (!character) {
        logger.debug({
            event: 'promotion_status_not_found',
            name,
        });
        return null;
    }

    const spawnCount = character.spawnCount || 0;
    const totalResponseLength = calculateResponseLength(character);

    // Determine current level
    let currentLevel = 0; // session
    if (character.source === 'lorebook') {
        currentLevel = 1;
    } else if (character.source === 'card') {
        currentLevel = 2;
    }

    // Check thresholds based on current level
    let meetsThreshold = false;
    let nextLevel = null;
    let requirements = {};

    if (currentLevel === 0) {
        // Session -> Lorebook check (OR condition)
        const spawnMet = spawnCount >= SESSION_TO_LOREBOOK_THRESHOLD.spawnCount;
        const responseMet = totalResponseLength > SESSION_TO_LOREBOOK_THRESHOLD.responseLength;

        meetsThreshold = spawnMet || responseMet;
        nextLevel = meetsThreshold ? 'lorebook' : null;

        requirements = {
            spawnCount: {
                required: SESSION_TO_LOREBOOK_THRESHOLD.spawnCount,
                current: spawnCount,
                met: spawnMet,
            },
            responseLength: {
                required: SESSION_TO_LOREBOOK_THRESHOLD.responseLength,
                current: totalResponseLength,
                met: responseMet,
            },
        };
    } else if (currentLevel === 1) {
        // Lorebook -> Card check (AND condition)
        const spawnMet = spawnCount >= LOREBOOK_TO_CARD_THRESHOLD.spawnCount;
        // For custom knowledge, check if character has metadata or specific lorebook entries
        const hasCustomKnowledge = Object.keys(character.metadata || {}).length > 0;

        meetsThreshold = spawnMet && (!LOREBOOK_TO_CARD_THRESHOLD.requiresCustomKnowledge || hasCustomKnowledge);
        nextLevel = meetsThreshold ? 'card' : null;

        requirements = {
            spawnCount: {
                required: LOREBOOK_TO_CARD_THRESHOLD.spawnCount,
                current: spawnCount,
                met: spawnMet,
            },
            customKnowledge: {
                required: LOREBOOK_TO_CARD_THRESHOLD.requiresCustomKnowledge,
                current: hasCustomKnowledge,
                met: hasCustomKnowledge,
            },
        };
    }
    // Level 2 (card) has no further promotion

    return {
        name: character.name,
        currentLevel,
        spawnCount,
        totalResponseLength,
        meetsThreshold,
        nextLevel,
        requirements,
    };
}

/**
 * Suggest promotion via toast notification with click handler.
 *
 * Shows a persistent toast that the user can click to accept promotion.
 *
 * @param {string} name - Character name
 * @param {Function} [onAccept] - Callback when user accepts (defaults to promoteToLorebook)
 */
export function suggestPromotion(name, onAccept = null) {
    const status = getPromotionStatus(name);

    if (!status || !status.meetsThreshold) {
        logger.debug({
            event: 'promotion_suggestion_skipped',
            name,
            reason: status ? 'threshold not met' : 'character not found',
        });
        return;
    }

    const targetLevel = status.nextLevel;
    const message = `${name} has earned persistence! Click to promote to ${targetLevel === 'card' ? 'Character Card' : 'Lorebook'}`;

    logger.info({
        event: 'promotion_suggested',
        name,
        targetLevel,
        spawnCount: status.spawnCount,
        responseLength: status.totalResponseLength,
    });

    // Use toastr with click handler
    if (typeof toastr !== 'undefined') {
        const toast = toastr.info(message, 'Character Promotion', {
            timeOut: 0, // Persistent until dismissed
            extendedTimeOut: 0,
            closeButton: true,
            tapToDismiss: false,
            onclick: async () => {
                if (onAccept) {
                    await onAccept(name);
                } else if (targetLevel === 'lorebook') {
                    await promoteToLorebook(name);
                } else if (targetLevel === 'card') {
                    await promoteToCard(name);
                }
            },
        });
    }
}

/**
 * Build YAML content for lorebook character entry.
 *
 * @param {Object} character - Session character object
 * @returns {string} YAML-formatted character definition
 */
function buildCharacterYAML(character) {
    const lines = [];

    lines.push(`name: "${character.name}"`);
    lines.push(`tier: ${character.tier || 'minor'}`);

    // Extract voice/personality from identity or metadata
    if (character.metadata?.voice) {
        lines.push(`voice: ${character.metadata.voice}`);
    } else {
        lines.push('voice: neutral');
    }

    if (character.identity) {
        lines.push(`personality: |`);
        // Indent multiline content
        const personalityLines = character.identity.split('\n');
        for (const line of personalityLines) {
            lines.push(`  ${line}`);
        }
    }

    // Add quirks if present
    if (character.metadata?.quirks && Array.isArray(character.metadata.quirks)) {
        lines.push('quirks:');
        for (const quirk of character.metadata.quirks) {
            lines.push(`  - ${quirk}`);
        }
    }

    return lines.join('\n');
}

/**
 * Promote a session character to lorebook entry.
 *
 * Creates a new lorebook entry with key `ensemble_character:name`.
 *
 * @param {string} name - Character name
 * @returns {Promise<boolean>} True if promotion succeeded
 */
export async function promoteToLorebook(name) {
    const character = getSessionCharacter(name);

    if (!character) {
        logger.error({
            event: 'promotion_failed',
            name,
            reason: 'Character not found in session',
        });
        if (typeof toastr !== 'undefined') {
            toastr.error(`Cannot promote ${name}: character not found`);
        }
        return false;
    }

    try {
        const context = SillyTavern.getContext();

        // Build the entry key (lowercase, underscores)
        const entryKey = `${CHARACTER_ENTRY_PREFIX}${name.toLowerCase().replace(/ /g, '_')}`;

        // Build YAML content
        const content = buildCharacterYAML(character);

        logger.info({
            event: 'promotion_to_lorebook_start',
            name,
            entryKey,
        });

        // Try to use ST's createWorldInfoEntry if available
        if (typeof context.createWorldInfoEntry === 'function') {
            await context.createWorldInfoEntry({
                key: [entryKey],
                content: content,
                comment: `Ensemble character: ${name}`,
                disable: false,
                constant: false,
            });

            logger.info({
                event: 'promotion_to_lorebook_success',
                name,
                method: 'createWorldInfoEntry',
            });

            if (typeof toastr !== 'undefined') {
                toastr.success(`${name} promoted to Lorebook!`);
            }

            return true;
        }

        // Fallback: Use slash command
        if (typeof context.executeSlashCommands === 'function') {
            // Format: /createentry file=<world> key=<key> <content>
            // Without file, creates in currently active lorebook
            const command = `/createentry key=${entryKey} ${content}`;
            await context.executeSlashCommands(command);

            logger.info({
                event: 'promotion_to_lorebook_success',
                name,
                method: 'slash_command',
            });

            if (typeof toastr !== 'undefined') {
                toastr.success(`${name} promoted to Lorebook!`);
            }

            return true;
        }

        // No API available
        logger.error({
            event: 'promotion_failed',
            name,
            reason: 'No lorebook API available',
        });

        if (typeof toastr !== 'undefined') {
            toastr.error(`Cannot promote ${name}: Lorebook API unavailable`);
        }

        return false;

    } catch (error) {
        logger.error({
            event: 'promotion_to_lorebook_error',
            name,
            error: error.message,
        });

        if (typeof toastr !== 'undefined') {
            toastr.error(`Failed to promote ${name}: ${error.message}`);
        }

        return false;
    }
}

/**
 * Promote a lorebook character to full ST character card.
 *
 * Creates a new character via the ST characters API.
 *
 * @param {string} name - Character name
 * @returns {Promise<boolean>} True if promotion succeeded
 */
export async function promoteToCard(name) {
    const character = getSessionCharacter(name);

    if (!character) {
        logger.error({
            event: 'promotion_to_card_failed',
            name,
            reason: 'Character not found in session',
        });
        if (typeof toastr !== 'undefined') {
            toastr.error(`Cannot promote ${name}: character not found`);
        }
        return false;
    }

    try {
        logger.info({
            event: 'promotion_to_card_start',
            name,
        });

        // Build character card structure
        const characterData = {
            name: character.name,
            description: character.identity || `A character named ${name}.`,
            personality: character.metadata?.personality || '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: `Promoted from Ensemble session character. Spawned ${character.spawnCount} times.`,
            system_prompt: '',
            post_history_instructions: '',
            tags: ['ensemble', 'promoted'],
            creator: 'Ensemble Extension',
            character_version: '1.0',
            extensions: {
                ensemble: {
                    tier: character.tier,
                    promotedAt: Date.now(),
                    originalSource: character.source,
                },
            },
        };

        // Call ST's character creation API
        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(characterData),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error ${response.status}: ${errorText}`);
        }

        logger.info({
            event: 'promotion_to_card_success',
            name,
        });

        if (typeof toastr !== 'undefined') {
            toastr.success(`${name} promoted to Character Card!`);
        }

        return true;

    } catch (error) {
        logger.error({
            event: 'promotion_to_card_error',
            name,
            error: error.message,
        });

        if (typeof toastr !== 'undefined') {
            toastr.error(`Failed to create card for ${name}: ${error.message}`);
        }

        return false;
    }
}

/**
 * Get all characters that meet promotion threshold.
 *
 * Scans all session characters and returns those ready for promotion.
 *
 * @returns {string[]} Array of character names ready for promotion
 */
export function getPromotableCharacters() {
    const promotable = [];
    const sessionChars = getAllSessionCharacters();

    for (const [, character] of sessionChars) {
        // Skip non-session sources (already promoted)
        if (character.source === 'lorebook' || character.source === 'card') {
            continue;
        }

        if (checkPromotionThreshold(character.name)) {
            promotable.push(character.name);
        }
    }

    logger.debug({
        event: 'promotable_characters_check',
        total: sessionChars.size,
        promotable: promotable.length,
    });

    return promotable;
}

/**
 * Check and suggest promotions for all eligible characters.
 *
 * Utility function to run promotion checks on all session characters
 * and show toast notifications for those meeting thresholds.
 *
 * @param {Function} [onAccept] - Optional callback for promotion acceptance
 */
export function checkAllPromotions(onAccept = null) {
    const promotable = getPromotableCharacters();

    for (const name of promotable) {
        suggestPromotion(name, onAccept);
    }

    return promotable;
}
