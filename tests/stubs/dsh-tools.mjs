/**
 * Minimal stand-in for `@deepseek-ai/dsh-tools` in offline tests.
 * @module dsh-self-compact/tests/stubs/dsh-tools
 */

/**
 * Identity helper: the plugin only relies on the tool being registered.
 * @param {object} definition - tool definition.
 * @returns {object} the same definition, marked for assertions.
 */
export function defineTool(definition) {
  return { ...definition, __stubbed: true };
}
