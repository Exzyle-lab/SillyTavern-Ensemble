/**
 * Slash command handlers for SillyTavern-Ensemble
 *
 * Commands:
 * /ensemble spawn [npcs...] - Spawn NPC responses
 * /ensemble status - Show rate limit status
 * /ensemble clear - Clear rate limit state
 * /ensemble stop - Abort pending requests
 * /ensemble promote [name] - Promote session character to lorebook/card
 *
 * @module commands
 */

import { logger } from './logger.js';
import { spawnNPCResponses, abortCurrentSpawn, getSceneCharacters } from './orchestrator.js';
import { clearAllRateLimits, getRateLimitState } from './rate-limiter.js';
import {
    getPromotionStatus,
    getPromotableCharacters,
    promoteToLorebook,
    promoteToCard,
} from './character-promoter.js';

/** Track whether commands have been registered */
let commandsRegistered = false;

/**
 * Handle /ensemble command with subcommands
 * @param {Object} namedArgs - Named arguments from ST
 * @param {string} unnamedArgs - Unnamed arguments (subcommand and args)
 * @returns {Promise<string>} Result message
 */
async function handleEnsembleCommand(namedArgs, unnamedArgs) {
    const args = unnamedArgs.trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase();
    const subArgs = args.slice(1);

    logger.debug({ event: 'slash_command', subcommand, args: subArgs });

    switch (subcommand) {
        case 'spawn':
            return await handleSpawn(subArgs);
        case 'status':
            return handleStatus();
        case 'clear':
            return handleClear();
        case 'stop':
            return handleStop();
        case 'promote':
            return await handlePromote(subArgs);
        default:
            return getHelpText();
    }
}

/**
 * /ensemble spawn [npcs...]
 * @param {string[]} npcs - Array of NPC names to spawn
 * @returns {Promise<string>} Result markdown
 */
async function handleSpawn(npcs) {
    // If no NPCs specified, use scene characters
    const targetNpcs = npcs.length > 0 ? npcs : getSceneCharacters();

    if (targetNpcs.length === 0) {
        return 'No NPCs specified and no characters in current scene.';
    }

    try {
        const result = await spawnNPCResponses({
            npcs: targetNpcs,
            situation: 'React to the current situation.',
            format: 'full',
        });

        return result.markdown;
    } catch (error) {
        logger.error({ event: 'spawn_command_error', error: error.message });
        return `Spawn failed: ${error.message}`;
    }
}

/**
 * /ensemble status
 * @returns {string} Rate limit status display
 */
function handleStatus() {
    const state = getRateLimitState();

    if (state.size === 0) {
        return 'No rate limit data. All profiles available.';
    }

    let status = '**Rate Limit Status:**\n';
    for (const [profile, data] of state.entries()) {
        const limited = data.isLimited ? 'LIMITED' : 'OK';
        const errors = data.consecutiveErrors > 0 ? ` (${data.consecutiveErrors} errors)` : '';
        status += `- ${profile}: ${limited}${errors}\n`;
    }
    return status;
}

/**
 * /ensemble clear
 * @returns {string} Confirmation message
 */
function handleClear() {
    clearAllRateLimits();
    logger.info({ event: 'rate_limits_cleared_by_command' });
    return 'Rate limit state cleared for all profiles.';
}

/**
 * /ensemble stop
 * @returns {string} Result message
 */
function handleStop() {
    const stopped = abortCurrentSpawn();
    if (stopped) {
        // Use toastr if available
        if (typeof toastr !== 'undefined' && toastr.info) {
            toastr.info('Generation stopped by user.');
        }
        return 'Stopped pending NPC generation. Completed responses preserved.';
    }
    return 'No active generation to stop.';
}

/**
 * /ensemble promote [name]
 * Promote a session character to lorebook or card.
 * Without name, shows promotable characters.
 * @param {string[]} args - Character name as array
 * @returns {Promise<string>} Result message
 */
async function handlePromote(args) {
    const name = args.join(' ').trim();

    // No name provided: list promotable characters
    if (!name) {
        const promotable = getPromotableCharacters();
        if (promotable.length === 0) {
            return 'No session characters ready for promotion.\n\nCharacters become promotable after 3+ spawns or 500+ total response characters.';
        }
        return `**Characters Ready for Promotion:**\n${promotable.map(n => `- ${n}`).join('\n')}\n\nUse \`/ensemble promote <name>\` to promote.`;
    }

    // Get promotion status
    const status = getPromotionStatus(name);

    if (!status) {
        return `Character "${name}" not found in session. Only session characters can be promoted.`;
    }

    // Already at max level
    if (status.currentLevel === 2) {
        return `${name} is already a full Character Card (max level).`;
    }

    // Check if meets threshold
    if (!status.meetsThreshold) {
        const reqs = status.requirements;
        let progress = '';

        if (status.currentLevel === 0) {
            progress = `Spawn count: ${reqs.spawnCount.current}/${reqs.spawnCount.required} | Response length: ${reqs.responseLength.current}/${reqs.responseLength.required}`;
        } else {
            progress = `Spawn count: ${reqs.spawnCount.current}/${reqs.spawnCount.required} | Custom knowledge: ${reqs.customKnowledge.current ? 'Yes' : 'No'}`;
        }

        return `${name} hasn't met promotion threshold yet.\n\n${progress}`;
    }

    // Attempt promotion
    logger.info({ event: 'promote_command', name, targetLevel: status.nextLevel });

    let success = false;
    if (status.nextLevel === 'lorebook') {
        success = await promoteToLorebook(name);
    } else if (status.nextLevel === 'card') {
        success = await promoteToCard(name);
    }

    if (success) {
        return `Successfully promoted ${name} to ${status.nextLevel === 'card' ? 'Character Card' : 'Lorebook'}!`;
    } else {
        return `Failed to promote ${name}. Check console for details.`;
    }
}

/**
 * Help text for /ensemble command
 * @returns {string} Help text
 */
function getHelpText() {
    return `**Ensemble Commands:**
/ensemble spawn [npcs...] - Generate NPC responses (defaults to scene characters)
/ensemble status - Show rate limit status per profile
/ensemble clear - Clear all rate limit state
/ensemble stop - Abort pending generation (keeps completed)
/ensemble promote [name] - Promote session character to lorebook/card`;
}

/**
 * Register slash commands with SillyTavern
 * @returns {boolean} True if registration succeeded
 */
export function registerSlashCommands() {
    if (commandsRegistered) {
        logger.debug({ event: 'slash_commands_already_registered' });
        return true;
    }

    try {
        const context = SillyTavern.getContext();

        if (!context.registerSlashCommand) {
            logger.warn({ event: 'slash_commands_unavailable' });
            return false;
        }

        context.registerSlashCommand(
            'ensemble',
            handleEnsembleCommand,
            [],
            '<spawn|status|clear|stop> [args] - Ensemble NPC orchestration',
            true,  // interruptsGeneration
            true   // purgeFromMessage
        );

        commandsRegistered = true;
        logger.info({ event: 'slash_commands_registered' });
        return true;
    } catch (error) {
        logger.error({ event: 'slash_command_registration_failed', error: error.message });
        return false;
    }
}

/**
 * Unregister slash commands (for cleanup)
 * Note: ST doesn't have an unregister API, but we track state
 */
export function unregisterSlashCommands() {
    logger.debug({ event: 'slash_commands_unregister_requested' });
    commandsRegistered = false;
}

/**
 * Check if commands are currently registered
 * @returns {boolean} Registration state
 */
export function areCommandsRegistered() {
    return commandsRegistered;
}

// Export handler functions for testing
export {
    handleEnsembleCommand,
    handleSpawn,
    handleStatus,
    handleClear,
    handleStop,
    handlePromote,
    getHelpText,
};
