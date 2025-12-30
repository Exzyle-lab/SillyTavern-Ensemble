/**
 * Rate limiter for SillyTavern-Ensemble extension.
 * Tracks 429 errors per backend profile with exponential backoff.
 * @module rate-limiter
 */

/** @type {Map<string, {isLimited: boolean, nextAttemptTime: number, consecutiveErrors: number}>} */
const rateLimitState = new Map();

/** Base delay for exponential backoff in milliseconds */
const BASE_DELAY_MS = 5000;

/** Maximum backoff delay in milliseconds (5 minutes) */
const MAX_DELAY_MS = 300000;

/**
 * Gets the current state for a profile, creating default if not exists.
 * @param {string} profileName - The profile name to look up
 * @returns {{isLimited: boolean, nextAttemptTime: number, consecutiveErrors: number}}
 */
function getState(profileName) {
    if (!rateLimitState.has(profileName)) {
        rateLimitState.set(profileName, {
            isLimited: false,
            nextAttemptTime: 0,
            consecutiveErrors: 0,
        });
    }
    return rateLimitState.get(profileName);
}

/**
 * Calculates exponential backoff delay.
 * @param {number} errorCount - Number of consecutive errors
 * @returns {number} Delay in milliseconds
 */
function calculateBackoff(errorCount) {
    const delay = BASE_DELAY_MS * Math.pow(2, errorCount);
    return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Checks if a profile is currently rate limited.
 * @param {string} profileName - The profile name to check
 * @returns {{isLimited: boolean, retryIn: number|null, reason: string|null}}
 */
export function checkRateLimit(profileName) {
    const state = getState(profileName);
    const now = Date.now();

    if (!state.isLimited) {
        return { isLimited: false, retryIn: null, reason: null };
    }

    if (now >= state.nextAttemptTime) {
        // Rate limit window has passed, but keep state for backoff calculation
        state.isLimited = false;
        return { isLimited: false, retryIn: null, reason: null };
    }

    const retryIn = state.nextAttemptTime - now;
    return {
        isLimited: true,
        retryIn,
        reason: `Rate limited. Retry in ${Math.ceil(retryIn / 1000)} seconds (${state.consecutiveErrors} consecutive errors)`,
    };
}

/**
 * Records a successful request, resetting consecutive error count.
 * @param {string} profileName - The profile name that succeeded
 */
export function recordSuccess(profileName) {
    const state = getState(profileName);
    state.consecutiveErrors = 0;
    state.isLimited = false;
    state.nextAttemptTime = 0;
}

/**
 * Records a rate limit (429) error for a profile.
 * @param {string} profileName - The profile name that was rate limited
 * @param {string|number|null} [retryAfterHeader] - Optional Retry-After header value (seconds)
 * @returns {{retryIn: number, nextAttemptTime: number}}
 */
export function recordRateLimit(profileName, retryAfterHeader = null) {
    const state = getState(profileName);
    const now = Date.now();

    state.consecutiveErrors += 1;
    state.isLimited = true;

    let retryIn;

    if (retryAfterHeader !== null && retryAfterHeader !== undefined) {
        // Use Retry-After header if provided (convert seconds to ms)
        const headerValue = typeof retryAfterHeader === 'string'
            ? parseInt(retryAfterHeader, 10)
            : retryAfterHeader;

        if (!isNaN(headerValue) && headerValue > 0) {
            retryIn = headerValue * 1000;
        } else {
            retryIn = calculateBackoff(state.consecutiveErrors);
        }
    } else {
        retryIn = calculateBackoff(state.consecutiveErrors);
    }

    // Cap at maximum delay
    retryIn = Math.min(retryIn, MAX_DELAY_MS);

    state.nextAttemptTime = now + retryIn;

    return {
        retryIn,
        nextAttemptTime: state.nextAttemptTime,
    };
}

/**
 * Checks if all provided profiles are currently rate limited.
 * Used for graceful degradation check.
 * @param {string[]} configuredProfiles - Array of profile names to check
 * @returns {boolean} True if ALL profiles are limited
 */
export function allProfilesLimited(configuredProfiles) {
    if (!configuredProfiles || configuredProfiles.length === 0) {
        return false;
    }

    return configuredProfiles.every(profileName => {
        const result = checkRateLimit(profileName);
        return result.isLimited;
    });
}

/**
 * Clears rate limit state for a specific profile.
 * @param {string} profileName - The profile name to clear
 */
export function clearRateLimit(profileName) {
    rateLimitState.delete(profileName);
}

/**
 * Clears all rate limit state.
 */
export function clearAllRateLimits() {
    rateLimitState.clear();
}

/**
 * Gets the current state map for testing/debugging.
 * @returns {Map<string, {isLimited: boolean, nextAttemptTime: number, consecutiveErrors: number}>}
 */
export function _getStateForTesting() {
    return rateLimitState;
}
