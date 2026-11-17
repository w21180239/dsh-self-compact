/**
 * Registers the test loader, so `node --import ./tests/register.mjs` resolves
 * the two host packages to the local stubs.
 * @module dsh-self-compact/tests/register
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
