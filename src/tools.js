/**
 * Function Tools module for SillyTavern-Ensemble
 *
 * Registers function tools that allow the GM/Orchestrator to spawn
 * parallel NPC responses via function calling.
 *
 * @module tools
 */

import { logger } from './logger.js';

/**
 * Names of all tools registered by this extension.
 * Used for cleanup on unregister.
 * @type {readonly string[]}
 */
const REGISTERED_TOOL_NAMES = Object.freeze([
    'spawn_npc_responses',
    'query_npc_knowledge',
    'resolve_action',
    'audit_narrative',
]);

/**
 * Tracks whether tools are currently registered
 * @type {boolean}
 */
let toolsRegistered = false;

/**
 * spawn_npc_responses tool definition
 *
 * Generates dialogue and reactions from multiple NPCs in parallel.
 * The GM/Orchestrator calls this tool when a scene requires responses
 * from several NPCs at once.
 */
const spawnNPCResponsesTool = {
    name: 'spawn_npc_responses',
    displayName: 'Spawn NPC Responses',
    description: 'Generate dialogue and reactions from multiple NPCs in parallel. Use when the scene requires responses from several NPCs at once. Returns aggregated responses from all NPCs.',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            npcs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of NPC character names to generate responses from',
            },
            situation: {
                type: 'string',
                description: 'What happened that NPCs are reacting to',
            },
            format: {
                type: 'string',
                enum: ['dialogue', 'action', 'full'],
                description: 'Response format: dialogue only, actions only, or full response',
            },
        },
        required: ['npcs', 'situation'],
    },

    /**
     * Execute the tool - spawns parallel NPC responses via orchestrator
     * @param {Object} params - Tool parameters
     * @param {string[]} params.npcs - NPC character names
     * @param {string} params.situation - What happened
     * @param {string} [params.format='full'] - Response format
     * @returns {Promise<Object>} Aggregated NPC responses
     */
    action: async (params) => {
        logger.info({
            event: 'tool_invoked',
            tool: 'spawn_npc_responses',
            npcCount: params.npcs?.length || 0,
        });

        try {
            // Dynamic import to avoid circular dependencies
            const { spawnNPCResponses } = await import('./orchestrator.js');
            const result = await spawnNPCResponses(params);

            logger.info({
                event: 'tool_completed',
                tool: 'spawn_npc_responses',
                success: true,
            });

            return result;
        } catch (error) {
            logger.error({
                event: 'tool_error',
                tool: 'spawn_npc_responses',
                error: error.message,
            });
            throw error;
        }
    },

    /**
     * Format message for UI toast display
     * @param {Object} params - Tool parameters
     * @returns {string} User-facing message
     */
    formatMessage: (params) => {
        const count = params.npcs?.length || 0;
        const names = params.npcs?.slice(0, 3).join(', ') || 'NPCs';
        const suffix = count > 3 ? ` and ${count - 3} more...` : '';
        return `Generating responses from ${names}${suffix}`;
    },

    /**
     * Conditional registration check
     * Only registers if extension is enabled
     * @returns {boolean} Whether to register this tool
     */
    shouldRegister: () => {
        try {
            const context = SillyTavern.getContext();
            const settings = context.extensionSettings?.ensemble;
            // Register by default unless explicitly disabled
            return settings?.enabled !== false;
        } catch {
            // If we can't check settings, register anyway
            return true;
        }
    },

    // Don't hide tool calls from chat history
    stealth: false,
};

/**
 * query_npc_knowledge tool definition
 *
 * Queries what a specific NPC knows about a topic, using knowledge hardening
 * to ensure the NPC only sees lorebook entries they have access to.
 */
const queryNPCKnowledgeTool = {
    name: 'query_npc_knowledge',
    displayName: 'Query NPC Knowledge',
    description: 'Check what a specific NPC knows about a topic. Uses knowledge hardening - the NPC only sees lorebook entries they have access to. Returns matching knowledge entries.',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            npc_id: {
                type: 'string',
                description: 'The NPC character name to query',
            },
            topic: {
                type: 'string',
                description: 'The topic to search for in the NPC\'s knowledge',
            },
        },
        required: ['npc_id', 'topic'],
    },

    /**
     * Execute the tool - queries NPC knowledge via orchestrator
     * @param {Object} params - Tool parameters
     * @param {string} params.npc_id - NPC character name
     * @param {string} params.topic - Topic to search for
     * @returns {Promise<Object>} Matching knowledge entries
     */
    action: async (params) => {
        logger.info({
            event: 'tool_invoked',
            tool: 'query_npc_knowledge',
            npc: params.npc_id,
            topic: params.topic,
        });

        try {
            const { queryNPCKnowledge } = await import('./orchestrator.js');
            const result = await queryNPCKnowledge(params);

            logger.info({
                event: 'tool_completed',
                tool: 'query_npc_knowledge',
                success: result.success,
            });

            return result;
        } catch (error) {
            logger.error({
                event: 'tool_error',
                tool: 'query_npc_knowledge',
                error: error.message,
            });
            throw error;
        }
    },

    /**
     * Format message for UI toast display
     * @param {Object} params - Tool parameters
     * @returns {string} User-facing message
     */
    formatMessage: (params) => {
        return `Checking what ${params.npc_id} knows about "${params.topic}"`;
    },

    /**
     * Conditional registration check
     * Only registers if extension is enabled
     * @returns {boolean} Whether to register this tool
     */
    shouldRegister: () => {
        try {
            const context = SillyTavern.getContext();
            return context.extensionSettings?.ensemble?.enabled !== false;
        } catch {
            return true;
        }
    },

    // Don't hide tool calls from chat history
    stealth: false,
};

/**
 * resolve_action tool definition
 *
 * Resolves a mechanical action via the Judge sub-agent, determining
 * success/failure, outcome, and consequences.
 */
const resolveActionTool = {
    name: 'resolve_action',
    displayName: 'Resolve Action',
    description: 'Resolve a mechanical action via the Judge sub-agent. Determines success/failure, outcome, and consequences for an attempted action.',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            actor: {
                type: 'string',
                description: 'Who is performing the action',
            },
            action: {
                type: 'string',
                description: 'What action is being attempted',
            },
            context: {
                type: 'object',
                description: 'Additional context like stats, difficulty, environmental factors',
            },
        },
        required: ['actor', 'action'],
    },

    /**
     * Execute the tool - resolves action via orchestrator
     * @param {Object} params - Tool parameters
     * @param {string} params.actor - Who is performing the action
     * @param {string} params.action - What action is being attempted
     * @param {Object} [params.context] - Additional context
     * @returns {Promise<Object>} Resolution result with success/failure and consequences
     */
    action: async (params) => {
        logger.info({
            event: 'tool_invoked',
            tool: 'resolve_action',
            actor: params.actor,
        });

        try {
            const { resolveAction } = await import('./orchestrator.js');
            const result = await resolveAction(params);

            logger.info({
                event: 'tool_completed',
                tool: 'resolve_action',
                success: result.success,
            });

            return result;
        } catch (error) {
            logger.error({
                event: 'tool_error',
                tool: 'resolve_action',
                error: error.message,
            });
            throw error;
        }
    },

    /**
     * Format message for UI toast display
     * @param {Object} params - Tool parameters
     * @returns {string} User-facing message
     */
    formatMessage: (params) => {
        return `Resolving: ${params.actor} attempts to ${params.action}`;
    },

    /**
     * Conditional registration check
     * Only registers if extension is enabled
     * @returns {boolean} Whether to register this tool
     */
    shouldRegister: () => {
        try {
            const context = SillyTavern.getContext();
            return context.extensionSettings?.ensemble?.enabled !== false;
        } catch {
            return true;
        }
    },

    // Don't hide tool calls from chat history
    stealth: false,
};

/**
 * audit_narrative tool definition
 *
 * Guardian audit of a narrative against a mechanical verdict, checking
 * if the narrative faithfully represents the verdict without contradictions.
 */
const auditNarrativeTool = {
    name: 'audit_narrative',
    displayName: 'Audit Narrative',
    description: 'Guardian audit of a narrative against a mechanical verdict. Checks if the narrative faithfully represents the verdict without contradictions or embellishments.',
    parameters: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            verdict: {
                type: 'object',
                description: 'The mechanical verdict to check against (from resolve_action)',
            },
            narrative: {
                type: 'string',
                description: 'The narrative description to audit for compliance',
            },
        },
        required: ['verdict', 'narrative'],
    },

    /**
     * Execute the tool - audits narrative via orchestrator
     * @param {Object} params - Tool parameters
     * @param {Object} params.verdict - The mechanical verdict to check against
     * @param {string} params.narrative - The narrative to audit
     * @returns {Promise<Object>} Audit result with compliance status
     */
    action: async (params) => {
        logger.info({
            event: 'tool_invoked',
            tool: 'audit_narrative',
        });

        try {
            const { auditNarrative } = await import('./orchestrator.js');
            const result = await auditNarrative(params);

            logger.info({
                event: 'tool_completed',
                tool: 'audit_narrative',
                compliant: result.compliant,
            });

            return result;
        } catch (error) {
            logger.error({
                event: 'tool_error',
                tool: 'audit_narrative',
                error: error.message,
            });
            throw error;
        }
    },

    /**
     * Format message for UI toast display
     * @param {Object} params - Tool parameters
     * @returns {string} User-facing message
     */
    formatMessage: (params) => {
        return `Auditing narrative compliance...`;
    },

    /**
     * Conditional registration check
     * Only registers if extension is enabled
     * @returns {boolean} Whether to register this tool
     */
    shouldRegister: () => {
        try {
            const context = SillyTavern.getContext();
            return context.extensionSettings?.ensemble?.enabled !== false;
        } catch {
            return true;
        }
    },

    // Don't hide tool calls from chat history
    stealth: false,
};

/**
 * All tool definitions for the extension
 * @type {Object[]}
 */
const TOOL_DEFINITIONS = [
    spawnNPCResponsesTool,
    queryNPCKnowledgeTool,
    resolveActionTool,
    auditNarrativeTool,
];

/**
 * Check if the current API connection supports function/tool calling
 * @returns {boolean} True if tool calling is supported
 */
function checkToolCallingSupport() {
    try {
        const context = SillyTavern.getContext();
        if (typeof context.isToolCallingSupported === 'function') {
            return context.isToolCallingSupported();
        }
        // If the method doesn't exist, assume not supported
        return false;
    } catch (error) {
        logger.warn({
            event: 'tool_support_check_error',
            error: error.message,
        });
        return false;
    }
}

/**
 * Register all Ensemble function tools with SillyTavern
 *
 * Should be called during extension initialization.
 * Checks for tool calling support and logs appropriate warnings.
 *
 * @returns {boolean} True if tools were registered successfully
 */
export function registerTools() {
    // Prevent double registration
    if (toolsRegistered) {
        logger.debug('Tools already registered, skipping');
        return true;
    }

    const context = SillyTavern.getContext();

    // Check if registerFunctionTool is available
    if (typeof context.registerFunctionTool !== 'function') {
        logger.error('registerFunctionTool not available - SillyTavern version may be too old');
        return false;
    }

    // Warn if tool calling is not currently supported by the API
    if (!checkToolCallingSupport()) {
        logger.warn(
            'Tool calling not supported by current API connection. ' +
            'Ensemble tools will be registered but may not work until you switch to a compatible API ' +
            '(OpenAI, Claude, MistralAI, Groq, Cohere, OpenRouter, AI21, Google AI Studio, Google Vertex AI, DeepSeek).'
        );
    }

    let registeredCount = 0;

    for (const toolDef of TOOL_DEFINITIONS) {
        try {
            // Check shouldRegister if defined
            if (typeof toolDef.shouldRegister === 'function' && !toolDef.shouldRegister()) {
                logger.debug({
                    event: 'tool_skip',
                    tool: toolDef.name,
                    reason: 'shouldRegister returned false',
                });
                continue;
            }

            context.registerFunctionTool(toolDef);
            registeredCount++;

            logger.info({
                event: 'tool_registered',
                tool: toolDef.name,
                displayName: toolDef.displayName,
            });
        } catch (error) {
            logger.error({
                event: 'tool_registration_error',
                tool: toolDef.name,
                error: error.message,
            });
        }
    }

    toolsRegistered = registeredCount > 0;

    logger.info({
        event: 'tools_registration_complete',
        registered: registeredCount,
        total: TOOL_DEFINITIONS.length,
    });

    return toolsRegistered;
}

/**
 * Unregister all Ensemble function tools from SillyTavern
 *
 * Should be called during extension cleanup/disable.
 */
export function unregisterTools() {
    if (!toolsRegistered) {
        logger.debug('Tools not registered, nothing to unregister');
        return;
    }

    const context = SillyTavern.getContext();

    // Check if unregisterFunctionTool is available
    if (typeof context.unregisterFunctionTool !== 'function') {
        logger.warn('unregisterFunctionTool not available - tools cannot be unregistered');
        return;
    }

    let unregisteredCount = 0;

    for (const toolName of REGISTERED_TOOL_NAMES) {
        try {
            context.unregisterFunctionTool(toolName);
            unregisteredCount++;

            logger.debug({
                event: 'tool_unregistered',
                tool: toolName,
            });
        } catch (error) {
            logger.warn({
                event: 'tool_unregister_error',
                tool: toolName,
                error: error.message,
            });
        }
    }

    toolsRegistered = false;

    logger.info({
        event: 'tools_unregistration_complete',
        unregistered: unregisteredCount,
    });
}

/**
 * Check if tools are currently registered
 * @returns {boolean} True if tools are registered
 */
export function areToolsRegistered() {
    return toolsRegistered;
}
