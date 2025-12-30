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
 * All tool definitions for the extension
 * @type {Object[]}
 */
const TOOL_DEFINITIONS = [
    spawnNPCResponsesTool,
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
