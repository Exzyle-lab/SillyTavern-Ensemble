/**
 * Structured logging module for SillyTavern-Ensemble
 *
 * Provides correlation IDs for tracing parallel requests and
 * structured log output with consistent formatting.
 */

/**
 * Generates an 8-character hexadecimal correlation ID
 * @returns {string} 8-char hex string (e.g., "a1b2c3d4")
 */
export function generateCorrelationId() {
    const array = new Uint8Array(4);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Formats log data into a consistent string
 * @param {string|Object} data - Log message or structured data
 * @param {string} [correlationId] - Optional correlation ID for request tracing
 * @returns {string} Formatted log string
 */
function formatLogMessage(data, correlationId) {
    const prefix = correlationId ? `[Ensemble] [${correlationId}]` : '[Ensemble]';

    if (typeof data === 'string') {
        return `${prefix} ${data}`;
    }

    const { event, ...rest } = data;
    const eventPart = event ? ` [${event}]` : '';
    const details = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';

    return `${prefix}${eventPart}${details}`;
}

/**
 * Checks if debug logging is enabled in extension settings
 * @returns {boolean} True if debug mode is enabled
 */
function isDebugEnabled() {
    try {
        const context = SillyTavern.getContext();
        return context.extensionSettings?.ensemble?.debug === true;
    } catch {
        return false;
    }
}

/**
 * Structured logger for Ensemble extension
 */
export const logger = {
    /**
     * Debug level logging - only outputs when debug mode is enabled
     * @param {string|Object} data - Log message or {event, ...details}
     * @param {string} [correlationId] - Optional correlation ID
     */
    debug(data, correlationId) {
        if (isDebugEnabled()) {
            console.debug(formatLogMessage(data, correlationId));
        }
    },

    /**
     * Info level logging
     * @param {string|Object} data - Log message or {event, ...details}
     * @param {string} [correlationId] - Optional correlation ID
     */
    info(data, correlationId) {
        console.info(formatLogMessage(data, correlationId));
    },

    /**
     * Warning level logging
     * @param {string|Object} data - Log message or {event, ...details}
     * @param {string} [correlationId] - Optional correlation ID
     */
    warn(data, correlationId) {
        console.warn(formatLogMessage(data, correlationId));
    },

    /**
     * Error level logging
     * @param {string|Object} data - Log message or {event, ...details}
     * @param {string} [correlationId] - Optional correlation ID
     */
    error(data, correlationId) {
        console.error(formatLogMessage(data, correlationId));
    },
};
