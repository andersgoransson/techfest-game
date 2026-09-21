// Local leaderboard store — persists scores in the browser (localStorage) on the
// machine running the game. No server: fits the client-only architecture, works
// offline, and survives reloads. Scores are per-machine.
//
// Player identity is the LEGO email local-part (the text before `@lego.com`) so
// organizers can reach out to winners afterward.

const KEY = 'wad.leaderboard.v1';
const NAME_MAX = 24;

// In-memory fallback used when localStorage is unavailable (private mode, node,
// blocked site data) so the game never breaks — it just won't persist.
let memory = null;

function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* access can throw in locked-down contexts */ }
  return null;
}

// Normalize arbitrary input to the email local-part: 'Jane.Doe@lego.com' -> 'jane.doe'.
export function normalizeName(raw) {
  return String(raw || '')
    .split('@')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '')
    .slice(0, NAME_MAX);
}

function sortEntries(entries) {
  // Highest score first; ties broken by whoever got there first (earlier date).
  entries.sort((a, b) => (b.score - a.score) || (a.date - b.date));
  return entries;
}

export function load() {
  if (memory) return memory;
  const s = storage();
  if (s) {
    try {
      const raw = s.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.entries)) {
          memory = sortEntries(data.entries.filter(
            (e) => e && typeof e.name === 'string' && Number.isFinite(e.score),
          ));
          return memory;
        }
      }
    } catch { /* corrupt payload — start fresh */ }
  }
  memory = [];
  return memory;
}

function persist() {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify({ v: 1, entries: memory }));
  } catch { /* quota / disabled — keep the in-memory copy */ }
}

export function all() {
  return load().slice();
}

export function top(n) {
  return load().slice(0, n);
}

// Insert a score, keep the list sorted, and report where it landed.
// Returns { entry, index, rank } (rank === index + 1).
export function add(rawName, score) {
  const entries = load();
  const entry = { name: normalizeName(rawName) || 'anon', score: Math.round(score) || 0, date: Date.now() };
  entries.push(entry);
  sortEntries(entries);
  persist();
  const index = entries.indexOf(entry);
  return { entry, index, rank: index + 1 };
}

// Rows around a given index, for the "focus on your position with surrounding
// results" view. Returns { rows:[{ entry, index, rank }], start }.
export function contextAround(index, before = 3, after = 3) {
  const entries = load();
  const start = Math.max(0, index - before);
  const end = Math.min(entries.length, index + after + 1);
  const rows = [];
  for (let i = start; i < end; i++) rows.push({ entry: entries[i], index: i, rank: i + 1 });
  return { rows, start };
}

export function count() {
  return load().length;
}

// Test/dev affordance — wipe the board.
export function clear() {
  memory = [];
  const s = storage();
  if (s) { try { s.removeItem(KEY); } catch { /* ignore */ } }
}
