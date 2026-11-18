/**
 * Learned profile: post-compact size P per project and globally, and per-skill
 * reference-miss counts. Several dsh processes can share one file, so every
 * read-modify-write runs under a lock directory and lands by atomic rename.
 *
 * @module dsh-self-compact/profile
 */
import fs from 'node:fs';
import path from 'node:path';
import { learnP } from './gate.js';

const LOCK_TRIES = 40;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 5000;

/**
 * Parse a profile, dropping anything malformed.
 * @param {string | undefined} text - file contents.
 * @returns {{byProject: Record<string, object>, global?: object, skills: Record<string, {compactions: number, refMisses: number}>}} profile.
 */
export function parseProfile(text) {
  const empty = { byProject: {}, skills: {} };
  if (!text) return empty;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  const validEst = (e) => e && Number.isFinite(e.p) && e.p > 0 && Number.isFinite(e.n);
  const out = { byProject: {}, skills: {} };
  for (const [key, est] of Object.entries(raw?.byProject ?? {})) if (validEst(est)) out.byProject[key] = est;
  if (validEst(raw?.global)) out.global = raw.global;
  for (const [name, prior] of Object.entries(raw?.skills ?? {})) {
    if (prior && Number.isFinite(prior.compactions) && prior.compactions >= 0 && Number.isFinite(prior.refMisses) && prior.refMisses >= 0) {
      out.skills[name] = { compactions: prior.compactions, refMisses: prior.refMisses };
    }
  }
  return out;
}

/**
 * Read the profile; a missing or unreadable file is an empty profile.
 * @param {string} file - profile path.
 * @returns {ReturnType<typeof parseProfile>} profile.
 */
export function loadProfile(file) {
  try {
    return parseProfile(fs.readFileSync(file, 'utf8'));
  } catch {
    return parseProfile(undefined);
  }
}

/**
 * Apply one mutation under the lock and return the saved profile.
 * @param {string} file - profile path.
 * @param {(profile: ReturnType<typeof parseProfile>) => void} mutate - in-place change.
 * @returns {ReturnType<typeof parseProfile> | null} the saved profile, or null when the lock was not won.
 */
export function updateProfile(file, mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  if (!acquire(lock)) return null;
  try {
    const profile = loadProfile(file);
    mutate(profile);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return profile;
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Fold one P sample into the project and global estimates.
 * @param {ReturnType<typeof parseProfile>} profile - profile to change.
 * @param {string} project - project key.
 * @param {number} sample - post-compact tokens.
 */
export function addPSample(profile, project, sample) {
  if (project) profile.byProject[project] = learnP(profile.byProject[project], sample);
  profile.global = learnP(profile.global, sample);
}

function acquire(lock) {
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock);
      } catch {
        // Raced with the owner releasing it.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  return false;
}
