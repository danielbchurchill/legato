const WAITLIST_ADDRESS = 'waitlist@legato.fm';

const form = document.querySelector<HTMLFormElement>('#waitlist-form');
const emailInput = document.querySelector<HTMLInputElement>('#waitlist-email');
const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const email = emailInput?.value.trim();
  if (!email || !submitButton) return;

  const subject = encodeURIComponent('Legato waitlist');
  const body = encodeURIComponent(`Please add ${email} to the Legato launch waitlist.`);
  window.location.href = `mailto:${WAITLIST_ADDRESS}?subject=${subject}&body=${body}`;

  const original = submitButton.textContent;
  submitButton.textContent = 'Opening your email client…';
  window.setTimeout(() => {
    submitButton.textContent = original;
  }, 2500);
});

const noteLink = document.querySelector<HTMLAnchorElement>('#waitlist-note-link');
const finePrint = noteLink?.closest('.fine-print');

noteLink?.addEventListener('click', (event) => {
  event.preventDefault();
  if (!finePrint || finePrint.querySelector('.note-detail')) return;

  const detail = document.createElement('span');
  detail.className = 'note-detail';
  detail.textContent =
    " legato.fm is a static site with no backend yet, so there's nothing to submit a form to. A mailto link is the honest version of a signup box until a real endpoint exists.";
  finePrint.append(detail);
});
