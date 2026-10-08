function reportError(error) {
  console.error('System popup:', error);
  const element = document.getElementById('popup-error');
  element.textContent = error.message ?? String(error);
  element.hidden = false;
  // Startup failures must still be visible, even before the first resize.
  document.documentElement.setAttribute('data-popup-ready', 'true');
}
const mainTemplate = document.querySelector('main').cloneNode(true);
Promise.all([
  import('../shared/popup-controller.mjs'),
  import('./calendar.mjs'),
  import('./system.mjs'),
]).then(([{ initialisePopup }, { renderCalendar }, { renderSystemPopup }]) =>
  initialisePopup(type => {
    // Fresh session DOM drops all old button handlers and pending views.
    document.querySelector('main').replaceWith(mainTemplate.cloneNode(true));
    document.getElementById('popup-error').hidden = true;
    document.documentElement.dataset.popupType = type;
    const calendar = type === 'calendar';
    document.getElementById('calendar-content').hidden = !calendar;
    document.getElementById('system-content').hidden = calendar;
    document.getElementById('previous-month').hidden = !calendar;
    document.getElementById('next-month').hidden = !calendar;
    return calendar ? renderCalendar() : renderSystemPopup(type, reportError);
  }, reportError),
).catch(reportError);
