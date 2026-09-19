// Centralized input system. Entities read *intent* (isDown / consumePress),
// never raw key events (see AGENTS.md). Owns its listeners so it can be torn
// down cleanly on teardown — no leaks across restarts.

const KEY_MAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'fire',
  KeyP: 'pause',
  Enter: 'start',
};

export function createInput(target) {
  const down = new Set();      // actions currently held
  const pressed = new Set();   // actions pressed since last consume (edge)

  const onKeyDown = (e) => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (!down.has(action)) pressed.add(action);
    down.add(action);
  };
  const onKeyUp = (e) => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    down.delete(action);
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  return {
    isDown: (action) => down.has(action),
    // True once per physical press; clears the edge so it won't retrigger.
    consumePress: (action) => {
      if (pressed.has(action)) { pressed.delete(action); return true; }
      return false;
    },
    endFrame: () => pressed.clear(),
    destroy: () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      down.clear();
      pressed.clear();
    },
  };
}
