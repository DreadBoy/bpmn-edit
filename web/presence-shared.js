// Presence data shared by the host (src/presence.js) and the editor page (web/presence.js): the
// colour palette, display-name rules and the friendly-name generator. Plain ES module without
// dependencies, so Node and the browser load the very same file.

/**
 * User colours, without blue (the editor's own selection colour). A user's colour is an index into
 * this list (the "slot"); the connected-users list and the remote selection outline (CSS class
 * `remote-sel-<slot>`) both take the colour from here.
 */
export const PALETTE = Object.freeze([
  '#d62728', // red
  '#ff7f0e', // orange
  '#2ca02c', // green
  '#9467bd', // purple
  '#e377c2', // pink
  '#17becf', // cyan
  '#8c564b', // brown
  '#bcbd22', // olive
]);

/** Longest display name, in characters (code points). */
export const MAX_NAME_LENGTH = 32;

/** Most element ids one selection may have (more are cut off), and the longest id accepted. */
export const MAX_SELECTION = 500;
export const MAX_ID_LENGTH = 200;

const ADJECTIVES = [
  'Brave', 'Calm', 'Clever', 'Curious', 'Daring', 'Eager', 'Gentle', 'Happy', 'Jolly', 'Keen', 'Lively',
  'Lucky', 'Merry', 'Nimble', 'Patient', 'Plucky', 'Quick', 'Quiet', 'Sunny', 'Swift', 'Thoughtful',
  'Witty', 'Wise', 'Zesty',
];

const ANIMALS = [
  'Badger', 'Beaver', 'Crane', 'Dolphin', 'Falcon', 'Fox', 'Gecko', 'Hare', 'Heron', 'Ibex', 'Koala',
  'Lynx', 'Marmot', 'Narwhal', 'Otter', 'Owl', 'Panda', 'Puffin', 'Quokka', 'Raven', 'Seal', 'Tapir',
  'Walrus', 'Yak',
];

/** A random friendly name such as "Curious Otter". */
export function randomName(random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

// Control characters, zero-width characters and bidirectional overrides/isolates: invisible, or able
// to make a name look like something else.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * A display name as typed by a user, cleaned up: invisible characters removed, whitespace collapsed,
 * trimmed, at most MAX_NAME_LENGTH characters. Returns '' for anything unusable (not a string, empty).
 */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  const name = value.slice(0, MAX_NAME_LENGTH * 8).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** Whether `value` is a colour slot (an index into PALETTE). */
export function isColor(value) {
  return Number.isInteger(value) && value >= 0 && value < PALETTE.length;
}
