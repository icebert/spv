/**
 * Inline SVG icons for the few buttons that need a symbol rather than a word. Drawn in
 * currentColor so they follow the ink of the surrounding control in both themes.
 */
export type IconName = 'menu' | 'step-back' | 'step-forward' | 'play' | 'pause';

const PATHS: Record<IconName, string> = {
  menu: '<path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  'step-back':
    '<path d="M12 3 6 8l6 5z" fill="currentColor"/><path d="M4 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'step-forward':
    '<path d="M4 3l6 5-6 5z" fill="currentColor"/><path d="M12 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  play: '<path d="M4 3l9 5-9 5z" fill="currentColor"/>',
  pause:
    '<path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
};

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = PATHS[name];
  return svg;
}
