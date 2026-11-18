/**
 * Minimal stand-in for `@deepseek-ai/dsh-tools` in offline tests.
 * `defineTool` enforces the host's author-schema rules for parameters, so a
 * schema the real host would reject at registration fails here too.
 * @module dsh-self-compact/tests/stubs/dsh-tools
 */

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null'];

/**
 * Throw on any key outside the allowed set.
 * @param {object} node - author schema node.
 * @param {string} path - location for the message.
 * @param {string[]} allowed - permitted keys.
 */
function assertKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not allowed`);
  }
}

/**
 * Validate one value schema the way the host compiler does.
 * @param {object} node - author schema node.
 * @param {string} path - location for the message.
 * @param {boolean} allowRequired - whether `required: true` may appear.
 */
function checkValue(node, path, allowRequired) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${path} must be a value schema object`);
  const base = [...ANNOTATIONS, ...(allowRequired ? ['required'] : [])];
  if (allowRequired && 'required' in node && node.required !== true) throw new Error(`${path}.required must be true when present`);
  const { type } = node;
  if (type === 'json') return assertKeys(node, path, [...base, 'type']);
  if (type === 'object') {
    assertKeys(node, path, [...base, 'type', 'properties', 'additionalProperties']);
    if (typeof node.additionalProperties !== 'boolean') throw new Error(`${path}.additionalProperties must be explicitly true or false`);
    if (node.properties) checkMap(node.properties, `${path}.properties`);
    return;
  }
  if (type === 'array') {
    assertKeys(node, path, [...base, 'type', 'items']);
    if (node.items) checkValue(node.items, `${path}.items`, false);
    return;
  }
  if (SCALARS.includes(type)) return assertKeys(node, path, [...base, 'type', 'enum', 'const']);
  throw new Error(`${path}.type must be string/number/integer/boolean/null/array/object/json`);
}

/**
 * Validate a property map (top-level parameters or object properties).
 * @param {object} map - name -> value schema.
 * @param {string} path - location for the message.
 */
function checkMap(map, path) {
  for (const [key, node] of Object.entries(map)) checkValue(node, `${path}.${key}`, true);
}

/**
 * Validate the parameter schema, then return the definition marked for assertions.
 * @param {object} definition - tool definition.
 * @returns {object} the same definition, marked for assertions.
 */
export function defineTool(definition) {
  if (definition.parameters) checkMap(definition.parameters, 'parameters');
  return { ...definition, __stubbed: true };
}
