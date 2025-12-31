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
import { buildNPCPromptWithContext, buildNPCContext, buildNPCMessages } from './context.js';
import {
    resolveCharacter,
    incrementSpawnCount,
    addGeneratedResponse,
} from './character-resolver.js';

/**
 * Module-level AbortController for cancelling pending NPC generation requests.
 * Only one spawn operation can be active at a time - starting a new spawn
 * will automatically abort any previous pending spawn.
 * @type {AbortController|null}
 */
let currentAbortController = null;

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
 * Build prompt messages for a virtual character (not an ST card).
 *
 * Virtual characters include lorebook characters, session characters,
 * template-generated characters, and stubs.
 *
 * @param {Object} resolved - Resolved character object
 * @param {string} situation - The situation to react to
 * @param {string} format - Response format
 * @returns {Array<{role: string, content: string}>} Messages array for API
 */
function buildVirtualCharacterMessages(resolved, situation, format) {
    // Build a simple context from the resolved character
    const contextData = {
        npc_name: resolved.name,
        npc_voice: '',
        npc_personality: resolved.identity,
        knowledge: '', // Virtual characters have limited knowledge
        scene_state: '',
        situation: situation,
    };

    return buildNPCMessages(contextData, format);
}

/**
 * Execute a single NPC generation request.
 *
 * @param {string} npcName - The NPC name
 * @param {Object} resolved - Resolved character object from character-resolver
 * @param {string} situation - The situation to react to
 * @param {string} format - Response format
 * @param {string} correlationId - Correlation ID for logging
 * @param {AbortSignal} [signal] - Optional AbortSignal for cancellation
 * @returns {Promise<Object>} Result object with response or error
 */
async function executeNPCRequest(npcName, resolved, situation, format, correlationId, signal) {
    const startTime = Date.now();

    try {
        // Get tier from resolved character (already inferred)
        // For ST cards, re-infer for accuracy; for virtual characters, use resolved tier
        let tier;
        if (resolved.stCharacterId !== null) {
            tier = await inferTier(resolved.stCharacterId);
        } else {
            tier = resolved.tier;
        }
        const profile = getProfileForTier(tier);

        logger.debug({
            event: 'request_sent',
            npc: npcName,
            tier: tier,
            source: resolved.source,
            profile: profile?.name || 'current',
        }, correlationId);

        // Build prompt for this NPC
        let messages;
        if (resolved.stCharacterId !== null) {
            // ST card: Use full lorebook context (Phase 2)
            messages = await buildNPCPromptWithContext(resolved.stCharacterId, situation, format);
        } else {
            // Virtual character: Build simpler prompt from identity
            messages = buildVirtualCharacterMessages(resolved, situation, format);
        }

        // Make the API call
        const result = await directGenerate(messages, profile, {
            npcId: npcName,
            tier: tier,
            max_tokens: 500,
            temperature: 0.8,
            signal: signal,
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

        const finalResponse = responseText.trim();

        // Track spawn count and response for virtual characters
        if (resolved.source !== 'card') {
            incrementSpawnCount(npcName);
            addGeneratedResponse(npcName, finalResponse);
        }

        return {
            npc: npcName,
            success: true,
            response: finalResponse,
            error: null,
            latency: latency,
            tier: tier,
            source: resolved.source,
        };

    } catch (error) {
        const latency = Date.now() - startTime;
        const isAborted = error.name === 'AbortError';

        if (isAborted) {
            logger.debug({
                event: 'request_aborted',
                npc: npcName,
            }, correlationId);
        } else {
            logger.error({
                event: 'request_failed',
                npc: npcName,
                error: error.message,
                latency: latency,
            }, correlationId);
        }

        return {
            npc: npcName,
            success: false,
            response: null,
            error: isAborted ? 'Aborted' : error.message,
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

    // Filter out aborted requests (user intentionally stopped)
    // Aborted requests should not count as failures since user cancelled them
    const nonAborted = processed.filter(r => {
        if (!r.success && r.error === 'Aborted') {
            return false; // Don't count as failure
        }
        return true;
    });

    // Calculate statistics (only for non-aborted requests)
    const successCount = nonAborted.filter(r => r.success).length;
    const failCount = nonAborted.filter(r => !r.success).length;
    const totalLatency = nonAborted.reduce((sum, r) => sum + (r.latency || 0), 0);
    const avgLatency = nonAborted.length > 0 ? Math.round(totalLatency / nonAborted.length) : 0;

    logger.info({
        event: 'spawn_complete',
        success: successCount,
        failed: failCount,
        avgLatency: avgLatency,
    }, correlationId);

    // Build formatted markdown output for GM (include non-aborted results only)
    let markdown = '## NPC Responses\n\n';

    for (const result of nonAborted) {
        markdown += `### ${result.npc}\n`;

        if (result.success) {
            markdown += `${result.response}\n\n`;
        } else {
            markdown += `*[Generation failed: ${result.error}]*\n\n`;
        }
    }

    return {
        results: processed, // Include all results for debugging/transparency
        markdown: markdown.trim(),
        stats: {
            total: nonAborted.length,
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

    // Auto-abort any existing spawn (prevents race condition from double-clicks)
    if (currentAbortController) {
        currentAbortController.abort();
        logger.info({ event: 'previous_spawn_aborted' }, correlationId);
    }
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

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

    // Resolve NPC names using the virtual character layer
    // resolveCharacter() always returns a character (falls back to template/stub)
    const npcRequests = npcs.map(async npcName => {
        const resolved = await resolveCharacter(npcName);

        logger.debug({
            event: 'character_resolved',
            npc: npcName,
            source: resolved.source,
            tier: resolved.tier,
        }, correlationId);

        // Execute the NPC request with resolved character
        return executeNPCRequest(npcName, resolved, situation, format, correlationId, signal);
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

/**
 * Query what an NPC knows about a specific topic.
 * Uses knowledge hardening - NPC only sees their filtered lorebook entries.
 *
 * @param {Object} params - Query parameters
 * @param {string} params.npc_id - NPC character name
 * @param {string} params.topic - Topic to query about
 * @returns {Promise<Object>} Result with relevant knowledge entries
 */
export async function queryNPCKnowledge({ npc_id, topic }) {
    const correlationId = generateCorrelationId();

    logger.info({
        event: 'knowledge_query_start',
        npc: npc_id,
        topic: topic,
    }, correlationId);

    // Find character by name
    const characterId = findCharacterByName(npc_id);
    if (characterId === null) {
        logger.warn({
            event: 'knowledge_query_failed',
            npc: npc_id,
            reason: 'Character not found',
        }, correlationId);

        return {
            npc: npc_id,
            success: false,
            knowledge: [],
            error: `Character "${npc_id}" not found`,
            correlationId: correlationId,
        };
    }

    // Get NPC's filtered context (uses knowledge hardening)
    const context = await buildNPCContext(characterId, '');

    // Use knowledgeEntries array for filtering, with defensive check
    const entries = Array.isArray(context.knowledgeEntries)
        ? context.knowledgeEntries
        : [];

    // Search knowledge entries for topic mentions (case-insensitive)
    const topicLower = topic.toLowerCase();
    const relevantKnowledge = entries.filter(entry =>
        typeof entry === 'string' && entry.toLowerCase().includes(topicLower)
    );

    logger.info({
        event: 'knowledge_query_complete',
        npc: npc_id,
        totalEntries: entries.length,
        matchCount: relevantKnowledge.length,
    }, correlationId);

    return {
        npc: npc_id,
        success: true,
        knowledge: relevantKnowledge,
        totalEntries: entries.length,
        matchCount: relevantKnowledge.length,
        correlationId: correlationId,
    };
}

/**
 * Resolve a mechanical action via the Judge sub-agent.
 *
 * @param {Object} params - Resolution parameters
 * @param {string} params.actor - Who is performing the action
 * @param {string} params.action - What action is being attempted
 * @param {Object} [params.context={}] - Additional context (stats, difficulty, etc.)
 * @returns {Promise<Object>} Verdict with success, outcome, and reasoning
 */
export async function resolveAction({ actor, action, context = {} }) {
    const correlationId = generateCorrelationId();

    logger.info({
        event: 'judge_start',
        actor,
        action,
    }, correlationId);

    // Judge system prompt (inline template)
    const judgePrompt = `You are the Judge, a mechanical arbiter for action resolution.

Given an action attempt, determine the outcome fairly based on:
- The actor's capabilities (if known from context)
- The difficulty of the action
- Environmental factors

Respond ONLY with valid JSON in this exact format:
{
  "success": true/false,
  "outcome": "Brief description of what happens",
  "reasoning": "Why this outcome was determined",
  "consequences": ["Any lasting effects"]
}`;

    const userMessage = `Actor: ${actor}
Action: ${action}
Context: ${JSON.stringify(context)}

Resolve this action.`;

    const messages = [
        { role: 'system', content: judgePrompt },
        { role: 'user', content: userMessage }
    ];

    try {
        // Use utility tier for Judge
        const profile = getProfileForTier('utility');
        const result = await directGenerate(messages, profile, {
            npcId: 'judge',
            tier: 'utility',
            max_tokens: 300,
            temperature: 0.3, // Low temp for consistent rulings
        });

        // Parse the JSON response
        let verdict;
        const responseText = result?.choices?.[0]?.message?.content ||
                            result?.content ||
                            (typeof result === 'string' ? result : '');

        try {
            verdict = JSON.parse(responseText.trim());
        } catch {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                verdict = JSON.parse(jsonMatch[1].trim());
            } else {
                throw new Error('Could not parse Judge response as JSON');
            }
        }

        logger.info({
            event: 'judge_complete',
            success: verdict.success,
        }, correlationId);

        return {
            actor,
            action,
            ...verdict,
            correlationId
        };
    } catch (error) {
        logger.error({
            event: 'judge_error',
            error: error.message,
        }, correlationId);

        return {
            actor,
            action,
            success: false,
            outcome: 'Resolution failed',
            reasoning: error.message,
            consequences: [],
            error: error.message,
            correlationId
        };
    }
}

/**
 * Audit a narrative against a mechanical verdict.
 * Guardian checks if the narrative faithfully represents the verdict.
 *
 * @param {Object} params - Audit parameters
 * @param {Object} params.verdict - The mechanical verdict to check against
 * @param {string} params.narrative - The narrative description to audit
 * @returns {Promise<Object>} Audit result with compliance status
 */
export async function auditNarrative({ verdict, narrative }) {
    const correlationId = generateCorrelationId();

    logger.info({
        event: 'guardian_start',
    }, correlationId);

    // Guardian system prompt (inline template)
    const guardianPrompt = `You are the Guardian, a quality auditor for narrative compliance.

Your job is to verify that a narrative faithfully represents a mechanical verdict.
Check for:
- Does the narrative match the success/failure of the verdict?
- Are the consequences properly reflected?
- Are there any contradictions or embellishments that violate the ruling?

Respond ONLY with valid JSON in this exact format:
{
  "compliant": true/false,
  "issues": ["List of specific issues found, if any"],
  "severity": "none" | "minor" | "major",
  "recommendation": "What should be changed, if anything"
}`;

    const userMessage = `Verdict: ${JSON.stringify(verdict)}

Narrative: "${narrative}"

Audit this narrative for compliance with the verdict.`;

    const messages = [
        { role: 'system', content: guardianPrompt },
        { role: 'user', content: userMessage }
    ];

    try {
        // Use utility tier for Guardian
        const profile = getProfileForTier('utility');
        const result = await directGenerate(messages, profile, {
            npcId: 'guardian',
            tier: 'utility',
            max_tokens: 300,
            temperature: 0.2, // Very low temp for consistent auditing
        });

        // Parse the JSON response
        let audit;
        const responseText = result?.choices?.[0]?.message?.content ||
                            result?.content ||
                            (typeof result === 'string' ? result : '');

        try {
            audit = JSON.parse(responseText.trim());
        } catch {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) {
                audit = JSON.parse(jsonMatch[1].trim());
            } else {
                throw new Error('Could not parse Guardian response as JSON');
            }
        }

        logger.info({
            event: 'guardian_complete',
            compliant: audit.compliant,
            severity: audit.severity,
        }, correlationId);

        return {
            ...audit,
            correlationId
        };
    } catch (error) {
        logger.error({
            event: 'guardian_error',
            error: error.message,
        }, correlationId);

        return {
            compliant: false,
            issues: ['Audit failed: ' + error.message],
            severity: 'major',
            recommendation: 'Re-run audit after fixing the error',
            error: error.message,
            correlationId
        };
    }
}

/**
 * Abort the current spawn operation if one is in progress.
 * This allows users to cancel pending NPC generation requests.
 *
 * @returns {boolean} True if an active spawn was aborted, false if none was active
 */
export function abortCurrentSpawn() {
    if (currentAbortController) {
        currentAbortController.abort();
        logger.info({ event: 'spawn_aborted_by_user' });
        currentAbortController = null;
        return true;
    }
    return false;
}
