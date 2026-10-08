// ---- Theme -------------------------------------------------------------

// The inline script in index.html's <head> has already set data-theme before
// first paint (saved choice, else the system setting). This only handles
// changes after load.
type Theme = 'dark' | 'light';

const THEME_KEY = 'legato-site-theme';
const themeButtons = document.querySelectorAll<HTMLButtonElement>('[data-set-theme]');

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  themeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.setTheme === theme)));
}

function savedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

themeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const theme: Theme = button.dataset.setTheme === 'light' ? 'light' : 'dark';
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private browsing in some browsers refuses storage; the page still switches.
    }
  });
});

// Until someone picks a side, keep following the system, including when it
// flips at sunset with the page already open.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (event) => {
  if (savedTheme() === null) applyTheme(event.matches ? 'light' : 'dark');
});

applyTheme(currentTheme());

// ---- Tabs (Articles, Library health) ------------------------------------

document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((tablist) => {
  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  function select(next: HTMLButtonElement) {
    for (const tab of tabs) {
      const active = tab === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !active;
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1;
      const target =
        event.key === 'ArrowRight' ? tabs[index === last ? 0 : index + 1]
        : event.key === 'ArrowLeft' ? tabs[index === 0 ? last : index - 1]
        : event.key === 'Home' ? tabs[0]
        : event.key === 'End' ? tabs[last]
        : undefined;
      if (!target) return;
      event.preventDefault();
      select(target);
      target.focus();
    });
  });
});

// Hidden tab panels are lazy images inside display: none, so they wouldn't
// load until clicked, and the first click would show an empty frame. Once a
// tab set is a screen or so away, flip the current theme's copies to eager,
// which starts their download.
const tabPreloader = new IntersectionObserver(
  (entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target
        .querySelectorAll<HTMLImageElement>(`[role="tabpanel"] img[data-for-theme="${currentTheme()}"]`)
        .forEach((img) => (img.loading = 'eager'));
    }
  },
  { rootMargin: '800px 0px' },
);

document.querySelectorAll('[data-preload-tabs]').forEach((tabSet) => tabPreloader.observe(tabSet));

// ---- Ink/paper comparison ---------------------------------------------------

const compare = document.querySelector<HTMLElement>('[data-compare]');
const compareHandle = compare?.querySelector<HTMLElement>('[role="slider"]');

if (compare && compareHandle) {
  let position = 50;

  const setPosition = (value: number) => {
    position = Math.min(100, Math.max(0, value));
    compare.style.setProperty('--compare-x', `${position}%`);
    const rounded = Math.round(position);
    compareHandle.setAttribute('aria-valuenow', String(rounded));
    compareHandle.setAttribute('aria-valuetext', `ink ${rounded}%, paper ${100 - rounded}%`);
  };

  const setFromPointer = (event: PointerEvent) => {
    const rect = compare.getBoundingClientRect();
    setPosition(((event.clientX - rect.left) / rect.width) * 100);
  };

  // Pointer capture doubles as the "is dragging" flag: it's held from
  // pointerdown until pointerup, and the browser drops it on pointercancel.
  compare.addEventListener('pointerdown', (event) => {
    compare.setPointerCapture(event.pointerId);
    setFromPointer(event);
  });
  compare.addEventListener('pointermove', (event) => {
    if (compare.hasPointerCapture(event.pointerId)) setFromPointer(event);
  });
  compare.addEventListener('pointerup', (event) => compare.releasePointerCapture(event.pointerId));

  compareHandle.addEventListener('keydown', (event) => {
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? position - 5
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? position + 5
      : event.key === 'Home' ? 0
      : event.key === 'End' ? 100
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setPosition(next);
  });
}

// ---- Waitlist ---------------------------------------------------------------

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
