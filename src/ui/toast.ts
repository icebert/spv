import { el } from './dom';

let container: HTMLElement | null = null;

export function toast(
  message: string,
  kind: 'error' | 'warn' | 'info' = 'info',
  ttl = kind === 'error' ? 12000 : 6000,
): void {
  if (!container) {
    container = el('div', 'spv-toasts');
    document.body.appendChild(container);
  }
  const close = el('button', { title: 'Dismiss', 'aria-label': 'Dismiss' }, '×');
  const t = el(
    'div',
    { className: `spv-toast spv-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', null, message),
    close,
  );
  const remove = () => t.remove();
  close.addEventListener('click', remove);
  container.appendChild(t);
  while (container.children.length > 4) container.firstElementChild?.remove();
  if (ttl > 0) setTimeout(remove, ttl);
}
