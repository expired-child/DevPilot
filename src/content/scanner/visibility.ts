import { closestComposed, composedParent } from './composed-dom';

/** Check ancestors too: display:none and opacity:0 are not inherited styles. */
export const isRendered = (element: HTMLElement): boolean => {
  if (!element.isConnected || closestComposed(element, '[hidden], [aria-hidden="true"], [inert], dialog:not([open])')) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = composedParent(current)) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') {
      return false;
    }
  }
  return typeof element.checkVisibility === 'function'
    ? element.checkVisibility()
    : element.getClientRects().length > 0;
};
