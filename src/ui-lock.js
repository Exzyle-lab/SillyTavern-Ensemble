import { logger } from './logger.js';

const LOCK_CLASS = 'ensemble-locked';
const SEND_BUTTON = '#send_but';
const SEND_TEXTAREA = '#send_textarea';

/**
 * Lock the UI input during generation.
 * Disables the send button and input field.
 *
 * @returns {boolean} True if lock was acquired, false if already locked
 */
export function lockInput() {
    if (isInputLocked()) {
        logger.warn({ event: 'lock_skipped', reason: 'already_locked' });
        return false;
    }

    const $button = $(SEND_BUTTON);
    const $textarea = $(SEND_TEXTAREA);

    if ($button.length === 0 && $textarea.length === 0) {
        logger.warn({ event: 'lock_failed', reason: 'elements_not_found' });
        return false;
    }

    $button.prop('disabled', true).addClass(LOCK_CLASS);
    $textarea.prop('disabled', true).addClass(LOCK_CLASS);

    logger.info({ event: 'input_locked' });
    return true;
}

/**
 * Unlock the UI input after generation completes.
 * Re-enables the send button and input field.
 *
 * @returns {boolean} True if unlock was performed, false if wasn't locked
 */
export function unlockInput() {
    if (!isInputLocked()) {
        logger.warn({ event: 'unlock_skipped', reason: 'not_locked' });
        return false;
    }

    const $button = $(SEND_BUTTON);
    const $textarea = $(SEND_TEXTAREA);

    $button.prop('disabled', false).removeClass(LOCK_CLASS);
    $textarea.prop('disabled', false).removeClass(LOCK_CLASS);

    logger.info({ event: 'input_unlocked' });
    return true;
}

/**
 * Check if input is currently locked.
 *
 * @returns {boolean} True if locked
 */
export function isInputLocked() {
    return $(SEND_BUTTON).hasClass(LOCK_CLASS) || $(SEND_TEXTAREA).hasClass(LOCK_CLASS);
}

/**
 * Validate that UI elements exist.
 * Call at startup to detect selector changes.
 *
 * @returns {boolean} True if UI elements found
 */
export function validateUI() {
    const $button = $(SEND_BUTTON);
    const $textarea = $(SEND_TEXTAREA);

    if ($button.length === 0 || $textarea.length === 0) {
        logger.warn({ event: 'ui_validation_failed', reason: 'selectors_not_found' });
        return false;
    }

    logger.debug({ event: 'ui_validation_passed' });
    return true;
}

/**
 * Safely execute a function with input locked.
 * Automatically unlocks even if the function throws.
 *
 * @param {Function} fn - Async function to execute
 * @returns {Promise<*>} Result of the function
 */
export async function withInputLock(fn) {
    lockInput();
    try {
        return await fn();
    } finally {
        unlockInput();
    }
}
