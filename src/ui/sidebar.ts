import type { App } from '../app';
import { el } from './dom';

export interface Panel {
  id: string;
  title: string;
  el: HTMLElement;
  /** Return false to disable the tab (e.g. Sections for single-section data). */
  enabled?: () => boolean;
}

export function createSidebar(app: App, panels: Panel[]): HTMLElement {
  const tabs = el('nav', { className: 'spv-tabs', role: 'tablist' });
  const root = el('aside', 'spv-sidebar', tabs);
  const buttons = new Map<string, HTMLButtonElement>();
  for (const p of panels) {
    const b = el(
      'button',
      {
        className: 'spv-tab',
        role: 'tab',
        type: 'button',
        onClick: () => app.store.update('ui', { tab: p.id }),
      },
      p.title,
    );
    buttons.set(p.id, b);
    tabs.appendChild(b);
    p.el.classList.add('spv-panel');
    p.el.setAttribute('role', 'tabpanel');
    root.appendChild(p.el);
  }
  const refresh = () => {
    let tab = app.store.slice('ui').tab;
    for (const p of panels) {
      const enabled = p.enabled ? p.enabled() : true;
      buttons.get(p.id)!.disabled = !enabled;
      if (!enabled && tab === p.id) tab = 'dataset';
    }
    for (const p of panels) {
      buttons.get(p.id)!.classList.toggle('spv-active', p.id === tab);
      p.el.classList.toggle('spv-active', p.id === tab);
    }
  };
  app.store.on('ui', refresh);
  app.on((e) => {
    if (e.type === 'dataset' || e.type === 'sections') refresh();
  });
  refresh();
  return root;
}
