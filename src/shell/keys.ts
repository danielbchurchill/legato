/* ⌘ on a Mac, Ctrl everywhere else — the key the shortcuts actually use,
 * named the way each platform prints it on a keycap. */
export const MOD_KEY_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl '
