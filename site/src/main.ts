interface WaitlistResponse {
  ok: boolean;
  error?: string;
  alreadyJoined?: boolean;
}

const form = document.querySelector<HTMLFormElement>('#waitlist-form');
const emailInput = document.querySelector<HTMLInputElement>('#waitlist-email');
const honeypotInput = document.querySelector<HTMLInputElement>('#waitlist-company');
const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
const messageEl = document.querySelector<HTMLParagraphElement>('#waitlist-message');

function setMessage(text: string, isError = false) {
  if (!messageEl) return;
  messageEl.textContent = text;
  messageEl.classList.toggle('form-message-error', isError);
  messageEl.hidden = text.length === 0;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput?.value.trim();
  if (!email || !submitButton) return;

  const originalLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = 'Joining…';
  setMessage('');

  try {
    const response = await fetch('/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, company: honeypotInput?.value ?? '' }),
    });

    const result: WaitlistResponse | null = await response.json().catch(() => null);

    if (!response.ok || !result?.ok) {
      setMessage(result?.error ?? 'Something went wrong. Try again in a moment.', true);
      submitButton.textContent = originalLabel;
      submitButton.disabled = false;
      return;
    }

    form.reset();
    submitButton.textContent = result.alreadyJoined ? 'Already on the list' : "You're on the list";
    setMessage(
      result.alreadyJoined
        ? 'That email is already on the waitlist.'
        : "We'll email you when Legato is ready to install.",
    );
    window.setTimeout(() => {
      submitButton.textContent = originalLabel;
      submitButton.disabled = false;
    }, 4000);
  } catch {
    setMessage('Could not reach the server. Check your connection and try again.', true);
    submitButton.textContent = originalLabel;
    submitButton.disabled = false;
  }
});

const noteLink = document.querySelector<HTMLAnchorElement>('#waitlist-note-link');
const finePrint = noteLink?.closest('.fine-print');

noteLink?.addEventListener('click', (event) => {
  event.preventDefault();
  if (!finePrint || finePrint.querySelector('.note-detail')) return;

  const detail = document.createElement('span');
  detail.className = 'note-detail';
  detail.textContent =
    " Submitting stores your email in Cloudflare KV through a small serverless function. There's no mailing list provider, tracking, or resale, and you'll get one message when Legato is ready to install.";
  finePrint.append(detail);
});
