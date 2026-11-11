// Stable design IDs keep saved choices intact as more panel iterations are added. The settings
// dropdowns follow this order: the recommended look is labelled "Default" and listed first, while
// the panel's own default value (below) stays what a user who never chose gets. A panel with one
// version gets no dropdown — its id is just recorded (upstream's shape, adapted to this fork).
export const PANEL_DESIGNS = [
  { panel: 'graph', label: 'Evaluation', setting: 'graphDesign', default: 'bars3', versions: [
    { id: 'bars3', label: 'Default' }, { id: 'original', label: 'Original' },
    { id: 'timeline', label: 'Timeline' }, { id: 'bars4', label: 'Colored bars' },
  ]},
  { panel: 'engine', label: 'Engine', setting: 'engineDesign', default: 'original', versions: [
    { id: 'minimal', label: 'Default' }, { id: 'original', label: 'Original' },
  ]},
  { panel: 'evalbar', label: 'Evaluation bar', setting: 'evalbarDesign', default: 'original', versions: [
    { id: 'original', label: 'Original' },
  ]},
  { panel: 'accuracy', label: 'Accuracy overview', setting: 'accuracyDesign', default: 'pages', versions: [
    { id: 'pages', label: 'Default' },
  ]},
  { panel: 'accuracyQuality', label: 'Accuracy move quality', setting: 'accuracyQualityDesign', default: 'distribution', versions: [
    { id: 'distribution', label: 'Default' },
  ]},
  { panel: 'accuracyAdvanced', label: 'Accuracy advanced', setting: 'accuracyAdvancedDesign', default: 'original', versions: [
    { id: 'original', label: 'Original' },
  ]},
  { panel: 'moves', label: 'Move list', setting: 'movesDesign', default: 'original', versions: [
    { id: 'zoom20', label: 'Default' }, { id: 'original', label: 'Original' },
    { id: 'full', label: 'Edge-to-edge' }, { id: 'zoomed', label: 'Large text' },
  ]},
];

// Retired renderers stay available to saved settings and previews; they are absent from the settings
// menu and migrate to a supported choice when the app loads.
const RETIRED_DESIGNS = {
  graph: ['bars', 'bars2', 'minimal'], engine: ['focus'],
};

export function panelDesign(panel, settings) {
  const definition = PANEL_DESIGNS.find(item => item.panel === panel);
  return definition.versions.some(version => version.id === settings[definition.setting])
    || RETIRED_DESIGNS[panel]?.includes(settings[definition.setting])
    ? settings[definition.setting] : definition.default;
}

export function normalizePanelDesigns(settings) {
  let changed = false;
  for (const definition of PANEL_DESIGNS) {
    const value = definition.versions.some(version => version.id === settings[definition.setting])
      ? settings[definition.setting] : definition.default;
    if (settings[definition.setting] !== value) { settings[definition.setting] = value; changed = true; }
  }
  return changed;
}
