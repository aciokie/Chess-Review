// Premade interface setups: each selects every panel design at once. The arrangement is deliberately
// not touched — this fork's automatic composition already places the panels the way upstream's Modern
// layout does, and Reorganize / the layout file own the arrangement. Picking an individual design (or
// importing a layout) after a preset marks the setup "Custom".
export const UI_SETUPS = {
  old: { label: 'Old', designs: {
    graphDesign: 'original', engineDesign: 'original', evalbarDesign: 'original',
    accuracyDesign: 'pages', accuracyQualityDesign: 'distribution', accuracyAdvancedDesign: 'original', movesDesign: 'original',
  }},
  modern: { label: 'Modern', designs: {
    graphDesign: 'bars3', engineDesign: 'minimal', evalbarDesign: 'original',
    accuracyDesign: 'pages', accuracyQualityDesign: 'distribution', accuracyAdvancedDesign: 'original', movesDesign: 'zoom20',
  }},
  custom: { label: 'Custom' },
};
