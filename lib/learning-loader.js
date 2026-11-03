export {presentationFor} from './learning/presentations.js';

let pending;
export function loadLearningWorkspace() {
  // Keep lesson content, exercise rules and learning UI off the review startup path.
  return pending ||= import('./learning/workspace.js').catch(error => {
    pending = null;
    throw error;
  });
}
