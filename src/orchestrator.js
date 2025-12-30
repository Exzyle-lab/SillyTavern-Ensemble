/**
 * SillyTavern-Ensemble Orchestrator Module
 *
 * Handles parallel NPC response generation by:
 * 1. Resolving NPC names to character IDs
 * 2. Inferring tier and selecting appropriate backend profile
 * 3. Executing requests in parallel via Promise.allSettled()
 * 4. Aggregating results for GM narrative weaving
 *
 * @module orchestrator
 */

import { logger, generateCorrelationId } from './logger.js';
import { inferTier, getProfileForTier, directGenerate } from './router.js';

/**
 * Find a character's index by name (case-insensitive).
 *
 * @param {string} name - The character name to search for
 * @returns {number|null} The character index, or null if not found
 */
export function findCharacterByName(name) {
    const context = SillyTavern.getContext();
    const characters = context.characters || [];

    if (!name || typeof name !== 'string') {
        return null;
    }

    const normalizedName = name.toLowerCase().trim();

    const index = characters.findIndex(
        char => char?.name?.toLowerCase().trim() === normalizedName
    );

    return index >= 0 ? index : null;
}

/**
 * Build a minimal prompt for an NPC response.
 *
 * Phase 1 implementation - uses basic character info.
 * Phase 2 will add lorebook context and knowledge hardening.
 *
 * @param {Object} character - The character object from SillyTavern
 * @param {string} situation - Description of what happened
 * @param {string} format - Response format: 'dialogue', 'action', or 'full'
 * @returns {Array<{role: string, content: string}>} Messages array for API call
 */
export function buildNPCPrompt(character, situation, format) {
    // Build character context from available fields
    const personality = character.personality || '';
    const description = character.description || '';
    const characterContext = personality || description || 'No character information available.';

    // System prompt establishes the NPC identity
    const systemPrompt = `You are ${character.name}. ${characterContext}

Stay in character. Respond naturally based on your personality and the situation presented.`;

    // Format instructions
    let formatInstruction = '';
    switch (format) {
        case 'dialogue':
            formatInstruction = 'Respond with dialogue only. No action descriptions or narration.';
            break;
        case 'action':
            formatInstruction = 'Respond with actions only. Describe what you do, no spoken dialogue.';
            break;
        case 'full':
        default:
            formatInstruction = 'Respond with both dialogue and actions as appropriate.';
            break;
    }

    // User prompt presents the situation
    const userPrompt = `React to the following situation. ${formatInstruction}

${situation}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
}

/**
 * Execute a single NPC generation request.
 *
 * @param {string} npcName - The NPC name
 * @param {number} characterId - The character index
 * @param {string} situation - The situation to react to
 * @param {string} format - Response format
 * @param {string} correlationId - Correlation ID for logging
 * @returns {Promise<Object>} Result object with response or error
 */
async function executeNPCRequest(npcName, characterId, situation, format, correlationId) {
    const context = SillyTavern.getContext();
    const character = context.characters[characterId];
    const startTime = Date.now();

    try {
        // Infer tier for this character
        const tier = await inferTier(characterId);
        const profile = getProfileForTier(tier);

        logger.debug({
            event: 'request_sent',
            npc: npcName,
            tier: tier,
            profile: profile?.name || 'current',
        }, correlationId);

        // Build prompt for this NPC
        const messages = buildNPCPrompt(character, situation, format);

        // Make the API call
        const result = await directGenerate(messages, profile, {
            npcId: npcName,
            tier: tier,
            max_tokens: 500,
            temperature: 0.8,
        });

        const latency = Date.now() - startTime;

        logger.info({
            event: 'response_received',
            npc: npcName,
            latency: latency,
        }, correlationId);

        // Extract the response text from the API result
        // The structure depends on the API, but typically it's in choices[0].message.content
        let responseText = '';
        if (result?.choices?.[0]?.message?.content) {
            responseText = result.choices[0].message.content;
        } else if (result?.content) {
            responseText = result.content;
        } else if (typeof result === 'string') {
            responseText = result;
        } else {
            responseText = JSON.stringify(result);
        }

        return {
            npc: npcName,
            success: true,
            response: responseText.trim(),
            error: null,
            latency: latency,
            tier: tier,
        };

    } catch (error) {
        const latency = Date.now() - startTime;

        logger.error({
            event: 'request_failed',
            npc: npcName,
            error: error.message,
            latency: latency,
        }, correlationId);

        return {
            npc: npcName,
            success: false,
            response: null,
            error: error.message,
            latency: latency,
            tier: null,
        };
    }
}

/**
 * Aggregate Promise.allSettled results into formatted output.
 *
 * @param {Array<PromiseSettledResult>} results - Results from Promise.allSettled
 * @param {Array<string>} npcs - Original NPC name list
 * @param {string} correlationId - Correlation ID for logging
 * @returns {Object} Aggregated results with formatted markdown
 */
export function aggregateResults(results, npcs, correlationId) {
    const processed = results.map((result, index) => {
        if (result.status === 'fulfilled') {
            return result.value;
        } else {
            // Promise rejected (shouldn't happen with our try/catch, but handle it)
            return {
                npc: npcs[index] || `NPC_${index}`,
                success: false,
                response: null,
                error: result.reason?.message || 'Unknown error',
                latency: 0,
                tier: null,
            };
        }
    });

    // Calculate statistics
    const successCount = processed.filter(r => r.success).length;
    const failCount = processed.filter(r => !r.success).length;
    const totalLatency = processed.reduce((sum, r) => sum + (r.latency || 0), 0);
    const avgLatency = processed.length > 0 ? Math.round(totalLatency / processed.length) : 0;

    logger.info({
        event: 'spawn_complete',
        success: successCount,
        failed: failCount,
        avgLatency: avgLatency,
    }, correlationId);

    // Build formatted markdown output for GM
    let markdown = '## NPC Responses\n\n';

    for (const result of processed) {
        markdown += `### ${result.npc}\n`;

        if (result.success) {
            markdown += `${result.response}\n\n`;
        } else {
            markdown += `*[Generation failed: ${result.error}]*\n\n`;
        }
    }

    return {
        results: processed,
        markdown: markdown.trim(),
        stats: {
            total: processed.length,
            success: successCount,
            failed: failCount,
            avgLatency: avgLatency,
        },
    };
}

/**
 * Spawn parallel NPC responses for a given situation.
 *
 * This is the main orchestration function that:
 * 1. Generates a correlation ID for request tracing
 * 2. Resolves NPC names to character IDs
 * 3. Builds prompts and infers tiers for each NPC
 * 4. Executes all requests in parallel
 * 5. Aggregates results into formatted output
 *
 * @param {Object} params - The spawn parameters
 * @param {string[]} params.npcs - Array of NPC names to generate responses for
 * @param {string} params.situation - Description of what happened/context
 * @param {string} [params.format='full'] - Response format: 'dialogue', 'action', or 'full'
 * @returns {Promise<Object>} Aggregated results with markdown and statistics
 */
export async function spawnNPCResponses({ npcs, situation, format = 'full' }) {
    const correlationId = generateCorrelationId();

    logger.info({
        event: 'spawn_start',
        npcs: npcs,
        format: format,
    }, correlationId);

    // Validate inputs
    if (!Array.isArray(npcs) || npcs.length === 0) {
        logger.warn({
            event: 'spawn_aborted',
            reason: 'No NPCs specified',
        }, correlationId);

        return {
            results: [],
            markdown: '*No NPCs specified for response generation.*',
            stats: { total: 0, success: 0, failed: 0, avgLatency: 0 },
            correlationId: correlationId,
        };
    }

    if (!situation || typeof situation !== 'string') {
        logger.warn({
            event: 'spawn_aborted',
            reason: 'No situation provided',
        }, correlationId);

        return {
            results: [],
            markdown: '*No situation provided for NPC responses.*',
            stats: { total: 0, success: 0, failed: 0, avgLatency: 0 },
            correlationId: correlationId,
        };
    }

    // Resolve NPC names to character IDs
    const npcRequests = npcs.map(npcName => {
        const characterId = findCharacterByName(npcName);

        if (characterId === null) {
            logger.warn({
                event: 'character_not_found',
                npc: npcName,
            }, correlationId);

            // Return a pre-failed result for missing characters
            return Promise.resolve({
                npc: npcName,
                success: false,
                response: null,
                error: `Character "${npcName}" not found`,
                latency: 0,
                tier: null,
            });
        }

        // Execute the NPC request
        return executeNPCRequest(npcName, characterId, situation, format, correlationId);
    });

    // Execute all requests in parallel
    const results = await Promise.allSettled(npcRequests);

    // Aggregate and format results
    const aggregated = aggregateResults(results, npcs, correlationId);

    return {
        ...aggregated,
        correlationId: correlationId,
    };
}

/**
 * Get the current characters present in the scene.
 *
 * This helper retrieves character names from the current group chat
 * or returns an empty array for 1-on-1 chats.
 *
 * @returns {string[]} Array of character names in current scene
 */
export function getSceneCharacters() {
    const context = SillyTavern.getContext();

    // Check if we're in a group chat
    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        if (group?.members) {
            // Get character names from member IDs
            return group.members
                .map(memberId => {
                    const char = context.characters?.find(c => c.avatar === memberId);
                    return char?.name;
                })
                .filter(name => name != null);
        }
    }

    // For 1-on-1 chats, return the current character
    if (context.characterId !== undefined) {
        const char = context.characters?.[context.characterId];
        if (char?.name) {
            return [char.name];
        }
    }

    return [];
}
