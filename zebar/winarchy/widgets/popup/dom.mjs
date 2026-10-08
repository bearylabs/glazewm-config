import { createIcon } from '../shared/icons.mjs';

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function hero(icon, title, meta, value) {
  const node = element('div', undefined, 'hero');
  const body = element('div', undefined, 'hero__body');
  body.append(element('p', title, 'hero__title'), element('div', meta, 'hero__meta'));
  const iconHolder = element('div', undefined, 'hero__icon');
  iconHolder.append(createIcon(icon));
  node.append(iconHolder, body);
  if (value) node.append(element('div', value, 'hero__value'));
  return node;
}

export function button(label, action) {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function unavailable(name, error) {
  return element('p', error ? `${name}: ${error.message ?? error}` : `${name}: waiting for data...`,
    error ? 'error' : 'note');
}
