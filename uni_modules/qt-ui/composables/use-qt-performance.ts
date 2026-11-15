import { reactive } from "vue";

/** System accessibility and power signals; defaults preserve the existing presentation. */
export const qtPerformance = reactive({ reduceMotion: false, expensiveEffects: true });
export function applyQtPerformance(lowMemory: boolean, powerSave: boolean, animationsDisabled: boolean): void {
  qtPerformance.reduceMotion = animationsDisabled || powerSave || lowMemory;
  qtPerformance.expensiveEffects = !lowMemory && !powerSave && !animationsDisabled;
}
