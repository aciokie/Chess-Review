// Shared by review and learning boards. Speed 1..10 maps to 400..40 ms.
export function moveAnimationDuration(settings = {}) {
  return 440 - (settings.animSpeed ?? 7) * 40;
}

export const MOVE_ANIMATION_EASING = 'cubic-bezier(.22,.61,.36,1)';
