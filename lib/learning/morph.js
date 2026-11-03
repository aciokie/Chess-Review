// Capture geometry and current opacity without duplicating live controls.
export function capturePanels(nodes) {
  return [...nodes].map(node => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    const opacity = parseFloat(style.opacity);
    return {node, rect:node.getBoundingClientRect(), opacity:Number.isFinite(opacity)?opacity:1};
  })
    .filter(({rect}) => rect.width > 1 && rect.height > 1);
}
