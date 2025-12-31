/**
 * Template System for SillyTavern-Ensemble
 *
 * Provides tier-based character templates for generating on-demand NPCs.
 * Templates are stored as lorebook entries with key `ensemble_template:<tier>`,
 * with hardcoded defaults as fallback.
 *
 * Three tiers map directly to the tier system:
 * - commoner (minor): Thugs, peasants, basic shopkeepers, guards
 * - elite (standard): Captains, lieutenants, master craftsmen
 * - boss (major): Crime lords, guild masters, commanders
 *
 * @module templates
 */

import { logger } from './logger.js';
import { getAllLorebookEntries } from './context.js';

/**
 * Hardcoded default templates used when lorebook templates aren't found.
 * @type {Object.<string, Template>}
 */
const DEFAULT_TEMPLATES = {
    commoner: {
        tier: 'minor',
        voice: 'simple, uneducated, deferential OR rough, threatening',
        personality: 'A {{descriptor}} individual of low station. {{motivation}}. {{quirk}}',
        descriptors: ['weathered', 'nervous', 'scarred', 'burly', 'shifty', 'gaunt', 'stocky'],
        motivations: ['Just trying to survive', 'Fears those above them', 'Looking for an opportunity', 'Following orders', 'Hiding something'],
        quirks: ['Avoids eye contact', 'Fidgets constantly', 'Speaks in short sentences', 'Looks over their shoulder', 'Mumbles under breath'],
    },
    elite: {
        tier: 'standard',
        voice: 'confident, professional, measured',
        personality: 'A {{descriptor}} figure of authority. {{motivation}}. {{quirk}}',
        descriptors: ['seasoned', 'stern', 'calculating', 'imposing', 'refined', 'battle-hardened'],
        motivations: ['Maintains order and discipline', 'Seeks advancement', 'Protects their people', 'Owes a debt to someone powerful', 'Harbors secret ambitions'],
        quirks: ['Speaks with military precision', 'Always assessing threats', 'Rarely smiles', 'Touches a scar unconsciously', 'Names their weapon'],
    },
    boss: {
        tier: 'major',
        voice: 'commanding, charismatic, dangerous',
        personality: 'A {{descriptor}} power player. {{motivation}}. {{quirk}}',
        descriptors: ['legendary', 'ruthless', 'cunning', 'charismatic', 'feared', 'enigmatic'],
        motivations: ['Controls everything within reach', 'Building an empire', 'Settling an old score', 'Testing worthy opponents', 'Preparing for something bigger'],
        quirks: ['Never raises their voice', 'Collects trophies from victories', 'Has an unnerving calm', 'Speaks in metaphors', 'Shows unexpected kindness to specific people'],
    },
};

/**
 * Maps system tiers to template tiers.
 * @type {Object.<string, string>}
 */
const TIER_ALIASES = {
    minor: 'commoner',
    standard: 'elite',
    major: 'boss',
};

/**
 * Name patterns that suggest template tiers.
 * @type {Array<{pattern: RegExp, tier: string}>}
 */
const NAME_PATTERNS = [
    // Boss tier patterns
    { pattern: /\b(lord|boss|master|commander|chief|king|queen|emperor|warlord|overlord)\b/i, tier: 'boss' },
    // Elite tier patterns
    { pattern: /\b(captain|lieutenant|sergeant|officer|knight|champion|elite|veteran|master)\b/i, tier: 'elite' },
    // Commoner tier patterns (default for generic roles)
    { pattern: /\b(guard|thug|peasant|merchant|shopkeeper|servant|minion|lackey|grunt|soldier|worker)\b/i, tier: 'commoner' },
];

/**
 * Parse simple YAML content from lorebook entry.
 * Handles key: value pairs and arrays (- item lines).
 *
 * @param {string} content - YAML-like content string
 * @returns {Object|null} Parsed object or null on failure
 */
function parseSimpleYAML(content) {
    if (!content || typeof content !== 'string') {
        return null;
    }

    try {
        const result = {};
        const lines = content.split('\n');
        let currentKey = null;
        let currentArray = null;

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            // Check for array item (- value)
            if (trimmed.startsWith('- ')) {
                if (currentKey && currentArray !== null) {
                    currentArray.push(trimmed.slice(2).trim());
                }
                continue;
            }

            // Check for key: value
            const colonIndex = trimmed.indexOf(':');
            if (colonIndex > 0) {
                // Save previous array if any
                if (currentKey && currentArray !== null) {
                    result[currentKey] = currentArray;
                }

                currentKey = trimmed.slice(0, colonIndex).trim();
                const value = trimmed.slice(colonIndex + 1).trim();

                // Check if this starts an array or multiline string
                if (value === '' || value === '|') {
                    currentArray = [];
                } else {
                    result[currentKey] = value;
                    currentArray = null;
                }
            }
        }

        // Save final array if any
        if (currentKey && currentArray !== null) {
            result[currentKey] = currentArray;
        }

        return Object.keys(result).length > 0 ? result : null;
    } catch (error) {
        logger.warn({
            event: 'yaml_parse_error',
            error: error.message,
        });
        return null;
    }
}

/**
 * Normalize template tier to canonical form.
 *
 * @param {string} tier - Template or system tier name
 * @returns {string} Canonical template tier (commoner/elite/boss)
 */
function normalizeTier(tier) {
    if (!tier || typeof tier !== 'string') {
        return 'commoner';
    }

    const lowerTier = tier.toLowerCase();

    // Check if it's a system tier that needs mapping
    if (TIER_ALIASES[lowerTier]) {
        return TIER_ALIASES[lowerTier];
    }

    // Check if it's already a valid template tier
    if (DEFAULT_TEMPLATES[lowerTier]) {
        return lowerTier;
    }

    // Default to commoner
    return 'commoner';
}

/**
 * Select a random item from an array.
 *
 * @param {Array} array - Array to select from
 * @returns {*} Random item or undefined if empty
 */
function randomChoice(array) {
    if (!Array.isArray(array) || array.length === 0) {
        return undefined;
    }
    return array[Math.floor(Math.random() * array.length)];
}

/**
 * Load template from lorebook, falling back to hardcoded default.
 *
 * Searches for lorebook entries with key containing `ensemble_template:<tier>`.
 * If not found, returns the corresponding hardcoded default template.
 *
 * @param {string} tier - Template tier: 'commoner', 'elite', 'boss' (or system tiers 'minor', 'standard', 'major')
 * @returns {Promise<Template|null>} Template object or null if tier is invalid
 */
export async function getTemplate(tier) {
    const normalizedTier = normalizeTier(tier);

    try {
        const entries = await getAllLorebookEntries();

        // Search for template entry
        const templateEntry = entries.find(entry => {
            const keys = entry.key || entry.keys || [];
            const keyArray = Array.isArray(keys) ? keys : [keys];
            return keyArray.some(k =>
                typeof k === 'string' &&
                k.toLowerCase().includes(`ensemble_template:${normalizedTier}`)
            );
        });

        if (templateEntry && templateEntry.content) {
            const parsed = parseSimpleYAML(templateEntry.content);

            if (parsed) {
                logger.debug({
                    event: 'template_loaded_from_lorebook',
                    tier: normalizedTier,
                });

                // Merge with defaults to ensure all fields exist
                const defaultTemplate = DEFAULT_TEMPLATES[normalizedTier];
                return {
                    tier: parsed.tier || defaultTemplate.tier,
                    voice: parsed.voice || defaultTemplate.voice,
                    personality: parsed.personality || defaultTemplate.personality,
                    descriptors: Array.isArray(parsed.descriptors) ? parsed.descriptors : defaultTemplate.descriptors,
                    motivations: Array.isArray(parsed.motivations) ? parsed.motivations : defaultTemplate.motivations,
                    quirks: Array.isArray(parsed.quirks) ? parsed.quirks : defaultTemplate.quirks,
                };
            }
        }
    } catch (error) {
        logger.warn({
            event: 'template_lorebook_error',
            tier: normalizedTier,
            error: error.message,
        });
    }

    // Fall back to hardcoded default
    logger.debug({
        event: 'template_using_default',
        tier: normalizedTier,
    });

    return DEFAULT_TEMPLATES[normalizedTier] || null;
}

/**
 * Apply variable substitution to template.
 *
 * Replaces {{descriptor}}, {{motivation}}, {{quirk}} placeholders with
 * random selections from pools or provided overrides.
 *
 * @param {Template} template - Template object with personality and pools
 * @param {Object} [overrides={}] - Override values for specific variables
 * @returns {AppliedTemplate} Applied template with resolved values
 */
export function applyTemplateVariables(template, overrides = {}) {
    if (!template) {
        return null;
    }

    // Select values (overrides take priority)
    const descriptor = overrides.descriptor || randomChoice(template.descriptors) || 'unremarkable';
    const motivation = overrides.motivation || randomChoice(template.motivations) || 'Has unclear goals';
    const quirk = overrides.quirk || randomChoice(template.quirks) || 'Seems ordinary';

    // Build substitution map
    const variables = {
        descriptor,
        motivation,
        quirk,
    };

    // Apply substitution to personality
    let identity = template.personality || '';
    for (const [key, value] of Object.entries(variables)) {
        identity = identity.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'gi'), value);
    }

    return {
        identity,
        voice: template.voice,
        tier: template.tier,
        metadata: {
            descriptor,
            motivation,
            quirk,
        },
    };
}

/**
 * Generate a character from template.
 *
 * Creates a full character object ready for session storage,
 * with randomly selected traits from the template pools.
 *
 * @param {string} name - Character name
 * @param {string} tier - Template tier to use
 * @returns {Promise<GeneratedCharacter>} Generated character object
 */
export async function generateFromTemplate(name, tier) {
    const normalizedTier = normalizeTier(tier);
    const template = await getTemplate(normalizedTier);

    if (!template) {
        logger.error({
            event: 'template_generation_failed',
            name,
            tier: normalizedTier,
            reason: 'Template not found',
        });
        return null;
    }

    // Check if name contains hints for overrides
    const overrides = {};
    const lowerName = name.toLowerCase();

    // Extract descriptor hints from name (e.g., "Scarred Thug" -> descriptor: "scarred")
    for (const descriptor of template.descriptors) {
        if (lowerName.includes(descriptor.toLowerCase())) {
            overrides.descriptor = descriptor;
            break;
        }
    }

    const applied = applyTemplateVariables(template, overrides);

    const character = {
        name,
        identity: applied.identity,
        tier: applied.tier,
        source: 'template',
        templateId: normalizedTier,
        spawnCount: 1,
        createdAt: Date.now(),
        generatedResponses: [],
        metadata: applied.metadata,
        ephemeralState: {
            mood: null,
            injuries: [],
            lastInteraction: null,
        },
    };

    logger.debug({
        event: 'character_generated_from_template',
        name,
        tier: normalizedTier,
        descriptor: applied.metadata.descriptor,
    });

    return character;
}

/**
 * Check if a name suggests a template tier.
 *
 * Analyzes the name for keywords that indicate character importance/type.
 *
 * @param {string} name - Character name to analyze
 * @returns {string|null} Suggested tier or null if no match
 */
export function suggestTemplateForName(name) {
    if (!name || typeof name !== 'string') {
        return null;
    }

    for (const { pattern, tier } of NAME_PATTERNS) {
        if (pattern.test(name)) {
            logger.debug({
                event: 'template_suggested_for_name',
                name,
                tier,
            });
            return tier;
        }
    }

    return null;
}

/**
 * Get all hardcoded default templates.
 *
 * Returns the built-in templates without checking lorebook.
 * Useful for displaying available templates in UI.
 *
 * @returns {Object.<string, Template>} Map of tier to template
 */
export function getDefaultTemplates() {
    // Return a deep copy to prevent modification
    return JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
}

/**
 * Get the system tier for a template tier.
 *
 * @param {string} templateTier - Template tier (commoner/elite/boss)
 * @returns {string} System tier (minor/standard/major)
 */
export function getSystemTier(templateTier) {
    const tierMap = {
        commoner: 'minor',
        elite: 'standard',
        boss: 'major',
    };
    return tierMap[templateTier] || 'minor';
}
