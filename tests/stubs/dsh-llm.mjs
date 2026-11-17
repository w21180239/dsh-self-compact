/**
 * Minimal stand-in for `@deepseek-ai/dsh-llm` in offline tests.
 * @module dsh-self-compact/tests/stubs/dsh-llm
 */

let counter = 0;

/**
 * Build one user message the way the host constructor does.
 * @param {{content: object[], source: object}} input - content and source.
 * @returns {object} user message.
 */
export function createUserMessage(input) {
  counter += 1;
  return { id: `stub-user-${counter}`, role: 'user', time: Date.now(), ...input };
}
