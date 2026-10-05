export const mobileLandscapeQuery = '(orientation: landscape) and (max-height: 500px) and (max-width: 1024px) and (pointer: coarse)';

export function createHeaderScroll() {
  let previous = 0, direction = 0, distance = 0, hidden = false;
  return {
    reset(y: number) { previous = Math.max(0, y); direction = distance = 0; hidden = y >= 72; return hidden; },
    sample(y: number) {
      y = Math.max(0, y);
      const delta = y - previous;
      previous = y;
      if (y <= 24) { hidden = false; direction = distance = 0; return hidden; }
      if (!delta) return hidden;
      const next = Math.sign(delta);
      distance = next === direction ? distance + Math.abs(delta) : Math.abs(delta);
      direction = next;
      if (distance >= 12) {
        if (next < 0) hidden = false;
        else if (y >= 72) hidden = true;
        distance = 0;
      }
      return hidden;
    },
  };
}
