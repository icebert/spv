/** Small DOM helpers — the whole UI is plain DOM built with these. */
type Child = Node | string | number | null | undefined | false;
type Attrs = Record<
  string,
  string | number | boolean | EventListenerOrEventListenerObject | undefined | null
>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | string | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (typeof attrs === 'string') node.className = attrs;
  else if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (
        k.startsWith('on') &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
      ) {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'className') node.className = String(v);
      else if (k === 'style')
        node.style.cssText = String(v); // CSSOM, so no inline-style CSP allowance is needed
      else if (k === 'text') node.textContent = String(v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  append(node, ...children);
  return node;
}

export function append(node: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c,
    );
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A button. An icon (any Node) label gets `aria-label` from `ariaLabel` or the title. */
export function button(
  label: string | Node,
  onClick: (e: MouseEvent) => void,
  opts: { className?: string; title?: string; disabled?: boolean; ariaLabel?: string } = {},
): HTMLButtonElement {
  const b = el(
    'button',
    {
      className: `spv-btn ${opts.className ?? ''}`.trim(),
      type: 'button',
      title: opts.title ?? null,
      'aria-label': opts.ariaLabel ?? (typeof label === 'string' ? null : (opts.title ?? null)),
    },
    label,
  );
  b.disabled = Boolean(opts.disabled);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Make a non-button element operable from the keyboard: it joins the tab order and Enter or
 * Space fire its click handler (Shift is passed through, so Shift-click shortcuts keep working).
 */
export function pressable<T extends HTMLElement>(node: T, label?: string): T {
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    node.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: e.shiftKey }),
    );
  });
  return node;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  title?: string,
): HTMLLabelElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el(
    'label',
    { className: 'spv-check', title: title ?? null },
    input,
    el('span', null, label),
  );
}

export function radio(
  name: string,
  options: { value: string; label: string; title?: string }[],
  value: string,
  onChange: (v: string) => void,
): HTMLDivElement {
  const wrap = el('div', 'spv-radio');
  for (const o of options) {
    const input = el('input', { type: 'radio', name, value: o.value });
    input.checked = o.value === value;
    input.addEventListener('change', () => input.checked && onChange(o.value));
    wrap.appendChild(
      el(
        'label',
        { className: 'spv-radio-item', title: o.title ?? null },
        input,
        el('span', null, o.label),
      ),
    );
  }
  return wrap;
}

export function select(
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
  opts: { title?: string; className?: string } = {},
): HTMLSelectElement {
  const s = el('select', {
    className: `spv-select ${opts.className ?? ''}`.trim(),
    title: opts.title ?? null,
  });
  for (const o of options) s.appendChild(el('option', { value: o.value }, o.label));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  title?: string;
}

export interface SliderHandle {
  el: HTMLElement;
  set(v: number): void;
  setRange(min: number, max: number, step?: number): void;
}

export function slider(o: SliderOpts): SliderHandle {
  const input = el('input', { type: 'range', min: o.min, max: o.max, step: o.step });
  input.value = String(o.value);
  const fmt = o.format ?? ((v: number) => String(Math.round(v * 100) / 100));
  const out = el('span', 'spv-slider-value', fmt(o.value));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    o.onInput(v);
  });
  const root = el(
    'label',
    { className: 'spv-slider', title: o.title ?? null },
    el('span', 'spv-slider-label', o.label),
    input,
    out,
  );
  return {
    el: root,
    set(v) {
      input.value = String(v);
      out.textContent = fmt(v);
    },
    setRange(min, max, step) {
      input.min = String(min);
      input.max = String(max);
      if (step !== undefined) input.step = String(step);
    },
  };
}

export interface DualSliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  lo: number;
  hi: number;
  format?: (v: number) => string;
  onInput: (lo: number, hi: number) => void;
  title?: string;
}

export interface DualSliderHandle {
  el: HTMLElement;
  set(lo: number, hi: number): void;
  setRange(min: number, max: number, step?: number): void;
}

/** Two overlaid range inputs acting as a min/max pair. */
export function dualSlider(o: DualSliderOpts): DualSliderHandle {
  const a = el('input', {
    type: 'range',
    min: o.min,
    max: o.max,
    step: o.step,
    'aria-label': `${o.label} minimum`,
  });
  const b = el('input', {
    type: 'range',
    min: o.min,
    max: o.max,
    step: o.step,
    'aria-label': `${o.label} maximum`,
  });
  a.value = String(o.lo);
  b.value = String(o.hi);
  const fmt = o.format ?? ((v: number) => String(Math.round(v * 1000) / 1000));
  const out = el('span', 'spv-slider-value', `${fmt(o.lo)} – ${fmt(o.hi)}`);
  const emit = () => {
    let lo = Number(a.value);
    let hi = Number(b.value);
    if (lo > hi) [lo, hi] = [hi, lo];
    out.textContent = `${fmt(lo)} – ${fmt(hi)}`;
    o.onInput(lo, hi);
  };
  a.addEventListener('input', emit);
  b.addEventListener('input', emit);
  const root = el(
    'div',
    { className: 'spv-slider spv-dual', title: o.title ?? null },
    el('span', 'spv-slider-label', o.label),
    el('div', 'spv-dual-track', a, b),
    out,
  );
  return {
    el: root,
    set(lo, hi) {
      a.value = String(lo);
      b.value = String(hi);
      out.textContent = `${fmt(lo)} – ${fmt(hi)}`;
    },
    setRange(min, max, step) {
      for (const i of [a, b]) {
        i.min = String(min);
        i.max = String(max);
        if (step !== undefined) i.step = String(step);
      }
    },
  };
}

export function textInput(
  placeholder: string,
  onEnter: (v: string) => void,
  opts: { value?: string; className?: string; onInput?: (v: string) => void } = {},
): HTMLInputElement {
  const i = el('input', {
    type: 'text',
    placeholder,
    className: `spv-input ${opts.className ?? ''}`.trim(),
    spellcheck: 'false',
    autocomplete: 'off',
  });
  if (opts.value) i.value = opts.value;
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onEnter(i.value.trim());
  });
  if (opts.onInput) i.addEventListener('input', () => opts.onInput!(i.value));
  return i;
}

export function row(...children: Child[]): HTMLDivElement {
  return el('div', 'spv-row', ...children);
}

export function group(title: string | null, ...children: Child[]): HTMLElement {
  return el('section', 'spv-group', title ? el('h3', 'spv-group-title', title) : null, ...children);
}

export function note(text: string, kind: 'info' | 'warn' = 'info'): HTMLElement {
  return el('p', `spv-note spv-note-${kind}`, text);
}

export function kv(pairs: [string, Child][]): HTMLElement {
  const dl = el('dl', 'spv-kv');
  for (const [k, v] of pairs) {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  }
  return dl;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtNum(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return 'NA';
  if (Number.isInteger(v)) return fmtInt(v);
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (a >= 1) return v.toFixed(Math.max(0, digits - 1));
  return v.toPrecision(digits);
}

export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let t = 0;
  return (...a: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export function throttle<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let last = 0;
  let pending: A | null = null;
  let timer = 0;
  return (...a: A) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else {
      pending = a;
      if (!timer) {
        timer = window.setTimeout(
          () => {
            timer = 0;
            if (pending) {
              last = performance.now();
              fn(...pending);
              pending = null;
            }
          },
          ms - (now - last),
        );
      }
    }
  };
}

/** Minimal virtualised list: renders only the rows in view (rowHeight px each). */
export function virtualList<T>(
  items: T[],
  rowHeight: number,
  render: (item: T, index: number) => HTMLElement,
  height = 320,
): HTMLElement {
  const viewport = el('div', {
    className: 'spv-vlist',
    style: `height:${Math.min(height, items.length * rowHeight)}px`,
  });
  const spacer = el('div', { style: `height:${items.length * rowHeight}px;position:relative` });
  viewport.appendChild(spacer);
  let first = -1;
  const draw = () => {
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 4);
    if (start === first) return;
    first = start;
    const end = Math.min(items.length, start + Math.ceil(viewport.clientHeight / rowHeight) + 8);
    clear(spacer);
    for (let i = start; i < end; i++) {
      const r = render(items[i], i);
      r.style.position = 'absolute';
      r.style.top = `${i * rowHeight}px`;
      r.style.left = '0';
      r.style.right = '0';
      r.style.height = `${rowHeight}px`;
      spacer.appendChild(r);
    }
  };
  viewport.addEventListener('scroll', draw);
  requestAnimationFrame(draw);
  draw();
  return viewport;
}
