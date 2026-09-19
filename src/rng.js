// Seedable PRNG (mulberry32). All gameplay randomness MUST route through this —
// never Math.random() — so a seed reproduces a run exactly (see AGENTS.md).

export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,                                    // float in [0, 1)
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    reseed: (s) => { a = s >>> 0; },
  };
}
