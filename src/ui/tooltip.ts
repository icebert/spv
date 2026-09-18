import type { App, TooltipInfo } from '../app';
import { clear, el } from './dom';

export function createTooltip(app: App): { el: HTMLElement } {
  const root = el('div', { className: 'spv-tooltip', style: 'display:none' });
  document.body.appendChild(root);
  let pinned: TooltipInfo | null = null;

  const render = (info: TooltipInfo, isPinned: boolean) => {
    clear(root);
    root.classList.toggle('spv-pinned', isPinned);
    const head = el('div', 'spv-tooltip-head', info.index ?? `cell #${info.id}`);
    if (isPinned) {
      head.appendChild(
        el(
          'button',
          {
            className: 'spv-btn spv-small',
            style: 'float:right;margin-left:8px',
            onClick: () => app.clearPin(),
            title: 'Unpin (Esc)',
          },
          '×',
        ),
      );
    }
    root.appendChild(head);
    const dl = el('dl');
    dl.appendChild(el('dt', null, 'index'));
    dl.appendChild(el('dd', null, `#${info.id.toLocaleString()}`));
    if (info.section) {
      dl.appendChild(el('dt', null, 'section'));
      dl.appendChild(el('dd', null, info.section));
    }
    if (info.colorLabel && info.colorValue !== null) {
      dl.appendChild(el('dt', null, info.colorLabel));
      dl.appendChild(el('dd', null, info.colorValue));
    }
    for (const [k, v] of info.fields) {
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    }
    root.appendChild(dl);
    root.style.display = 'block';
    const margin = 14;
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    // With a finger on the screen the point itself is covered, so the card goes above the touch;
    // with a mouse it sits below and to the right of the cursor.
    const coarse = matchMedia('(pointer: coarse)').matches;
    let x = coarse ? info.x - w / 2 : info.x + margin;
    let y = coarse ? info.y - h - 3 * margin : info.y + margin;
    if (x + w > window.innerWidth - 8) x = coarse ? window.innerWidth - w - 8 : info.x - w - margin;
    if (y + h > window.innerHeight - 8) y = info.y - h - margin;
    if (coarse && y < 4) y = info.y + 3 * margin;
    root.style.left = `${Math.max(4, x)}px`;
    root.style.top = `${Math.max(4, y)}px`;
  };

  app.on((e) => {
    if (e.type === 'pin') {
      pinned = e.info;
      if (pinned) render(pinned, true);
      else root.style.display = 'none';
    } else if (e.type === 'hover' && !pinned) {
      if (e.info) render(e.info, false);
      else root.style.display = 'none';
    } else if (e.type === 'dataset' && !pinned) {
      root.style.display = 'none';
    }
  });
  return { el: root };
}
