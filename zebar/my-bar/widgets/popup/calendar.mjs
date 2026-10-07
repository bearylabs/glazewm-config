import { calendarDays, dateKey, shiftMonth } from '../shared/popup-model.mjs';

export function renderCalendar() {
  const locale = navigator.language;
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const daysElement = document.getElementById('calendar-days');
  const monthElement = document.getElementById('month-label');
  const selectedElement = document.getElementById('selected-date');
  let selected = new Date();
  let focused = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 12);
  let view = new Date(focused);

  const weekdays = document.getElementById('weekdays');
  weekdays.replaceChildren(...Array.from({ length: 7 }, (_, index) => {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = weekdayFormat.format(new Date(2024, 0, 1 + index, 12));
    return header;
  }));

  function draw(moveFocus = false) {
    const today = dateKey(new Date());
    const focusedKey = dateKey(focused);
    monthElement.textContent = monthFormat.format(view);
    selectedElement.textContent = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(selected);
    const days = calendarDays(view.getFullYear(), view.getMonth());
    const rows = [];
    for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
      const row = document.createElement('tr');
      for (const date of days.slice(rowIndex * 7, rowIndex * 7 + 7)) {
        const key = dateKey(date);
        const cell = document.createElement('td');
        cell.setAttribute('aria-selected', String(key === dateKey(selected)));
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(date.getDate());
        button.dataset.date = key;
        button.dataset.outside = String(date.getMonth() !== view.getMonth());
        button.setAttribute('aria-label', dateFormat.format(date));
        if (key === today) button.setAttribute('aria-current', 'date');
        button.tabIndex = key === focusedKey ? 0 : -1;
        button.addEventListener('click', () => {
          selected = new Date(date);
          focused = new Date(date);
          view = new Date(date);
          draw(true);
        });
        button.addEventListener('keydown', event => navigate(event, date));
        button.addEventListener('focus', () => {
          focused = new Date(date);
          for (const day of daysElement.querySelectorAll('button')) {
            day.tabIndex = day === button ? 0 : -1;
          }
        });
        cell.append(button);
        row.append(cell);
      }
      rows.push(row);
    }
    daysElement.replaceChildren(...rows);
    if (moveFocus) daysElement.querySelector(`[data-date="${focusedKey}"]`)?.focus();
  }

  function navigate(event, date) {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next;
    if (Object.hasOwn(offsets, event.key)) {
      next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsets[event.key], 12);
    } else if (event.key === 'Home' || event.key === 'End') {
      const weekday = (date.getDay() + 6) % 7;
      next = new Date(date.getFullYear(), date.getMonth(),
        date.getDate() + (event.key === 'Home' ? -weekday : 6 - weekday), 12);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      next = shiftMonth(date, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
    } else {
      return;
    }
    event.preventDefault();
    focused = next;
    view = new Date(next);
    draw(true);
  }

  function changeMonth(delta) {
    focused = shiftMonth(focused, delta);
    view = new Date(focused);
    draw();
  }
  document.getElementById('previous-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => changeMonth(1));
  document.getElementById('today').addEventListener('click', () => {
    selected = new Date();
    focused = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 12);
    view = new Date(focused);
    draw(true);
  });
  draw(true);
}
