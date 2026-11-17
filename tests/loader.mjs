/**
 * Resolve hook that points the two host packages this plugin imports at local
 * stubs, so the logic tests run without an installed DeepSeek Harness.
 * @module dsh-self-compact/tests/loader
 */

/**
 * Redirect host package specifiers to the local stubs.
 * @param {string} specifier - requested specifier.
 * @param {object} context - resolver context.
 * @param {Function} next - default resolver.
 * @returns {Promise<object>} resolution.
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stubs/dsh-tools.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: new URL('./stubs/dsh-llm.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
