import { calendarDays, dateKey, isoWeek, shiftMonth, yearProgress } from '../shared/popup-model.mjs';
import { createIcon } from '../shared/icons.mjs';

export function renderCalendar() {
  const locale = navigator.language;
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const daysElement = document.getElementById('calendar-days');
  const monthElement = document.getElementById('month-label');
  const heroDate = document.getElementById('hero-date');
  document.getElementById('calendar-icon').replaceChildren(createIcon('calendar'));
  let selected = new Date();
  let focused = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate(), 12);
  let view = new Date(focused);

  const weekdays = document.getElementById('weekdays');
  const weekHeader = document.createElement('th');
  weekHeader.scope = 'col';
  weekHeader.className = 'calendar-week';
  weekHeader.textContent = 'W';
  weekHeader.setAttribute('aria-label', 'ISO week number');
  weekdays.replaceChildren(weekHeader, ...Array.from({ length: 7 }, (_, index) => {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = weekdayFormat.format(new Date(2024, 0, 1 + index, 12));
    return header;
  }));

  function fitCalendar() {
    const root = document.documentElement;
    const main = document.querySelector('main');
    root.style.setProperty('--calendar-scale', '1');
    const maxHeight = parseFloat(getComputedStyle(root).getPropertyValue('--popup-max-height')) || innerHeight;
    const heightScale = (maxHeight - 6) / main.getBoundingClientRect().height;
    const widthScale = main.clientWidth / main.scrollWidth;
    root.style.setProperty('--calendar-scale', String(Math.max(0.01, Math.min(1, heightScale, widthScale))));
  }

  function draw(moveFocus = false) {
    const now = new Date();
    const today = dateKey(now);
    const focusedKey = dateKey(focused);
    monthElement.textContent = monthFormat.format(view);
    heroDate.textContent = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(now);
    const progress = yearProgress(now);
    const percent = Math.round(progress * 100);
    document.getElementById('calendar-year').textContent = String(now.getFullYear());
    document.getElementById('year-percent').textContent = `${percent}%`;
    const meter = document.getElementById('year-progress');
    meter.setAttribute('aria-valuenow', String(percent));
    meter.setAttribute('aria-label', `${now.getFullYear()} completed`);
    meter.firstElementChild.style.width = `${progress * 100}%`;
    const days = calendarDays(view.getFullYear(), view.getMonth());
    const rows = [];
    for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
      const row = document.createElement('tr');
      const week = document.createElement('th');
      week.scope = 'row';
      week.className = 'calendar-week';
      week.textContent = String(isoWeek(days[rowIndex * 7]));
      row.append(week);
      for (const date of days.slice(rowIndex * 7, rowIndex * 7 + 7)) {
        const key = dateKey(date);
        const cell = document.createElement('td');
        cell.setAttribute('aria-selected', String(key === dateKey(selected)));
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(date.getDate());
        button.dataset.date = key;
        button.dataset.outside = String(date.getMonth() !== view.getMonth());
        button.dataset.weekend = String(date.getDay() === 0 || date.getDay() === 6);
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
    fitCalendar();
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
  document.getElementById('calendar-content').addEventListener('wheel', event => {
    if (!event.deltaY || event.ctrlKey) return;
    const content = event.currentTarget;
    if (content.scrollHeight > content.clientHeight) return;
    event.preventDefault();
    changeMonth(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  window.addEventListener('resize', fitCalendar);
  document.fonts?.ready.then(fitCalendar);
  draw(true);
}
