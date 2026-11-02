// ---- Theme -------------------------------------------------------------

// The inline script in index.html's <head> has already set data-theme before
// first paint (saved choice, else the system setting). This only handles
// changes after load.
type Theme = 'dark' | 'light';

const THEME_KEY = 'legato-site-theme';
const themeButtons = document.querySelectorAll<HTMLButtonElement>('[data-set-theme]');
const themeListeners: Array<(theme: Theme) => void> = [];

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  themeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.setTheme === theme)));
  themeListeners.forEach((listener) => listener(theme));
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

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const phoneLayout = matchMedia('(max-width: 720px)');

// ---- Phone menu ----------------------------------------------------------

// Under 720px the nav and the theme toggle move into a panel under the
// header row. Any link in it, the logo or the header's button closes it, and
// so do Escape and a tap outside, which hand focus back to the menu button.
const menuButton = document.querySelector<HTMLButtonElement>('.menu-button');
const menu = document.getElementById('lg-menu');
const header = menuButton?.closest('header');

function setMenu(open: boolean, returnFocus = false) {
  if (!menuButton || !menu) return;
  menu.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  if (!open && returnFocus) menuButton.focus();
}

const menuIsOpen = () => menu !== null && !menu.hidden;

menuButton?.addEventListener('click', () => setMenu(!menuIsOpen()));

document.querySelectorAll('[data-closes-menu]').forEach((element) => {
  element.addEventListener('click', () => setMenu(false));
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuIsOpen()) setMenu(false, true);
});

// A tap that lands on another control keeps its own focus; one on plain page
// returns focus to the menu button.
document.addEventListener('click', (event) => {
  if (!menuIsOpen() || !(event.target instanceof Element) || header?.contains(event.target)) return;
  setMenu(false, event.target.closest('a, button, input, select, textarea, [tabindex]') === null);
});

// The panel only exists on a phone; a window widened past 720px with it open
// shouldn't keep saying it's expanded.
phoneLayout.addEventListener('change', (event) => {
  if (!event.matches) setMenu(false);
});

// ---- Tabs (Tour, Install) ------------------------------------------------

interface TabSet {
  tabs: HTMLButtonElement[];
  current: () => number;
  select: (index: number) => void;
}

const tourTablist = document.querySelector<HTMLElement>('[role="tablist"][data-tour]');
let tour: TabSet | undefined;

// Scrolls a chip to the middle of its row, when the row is a sideways scroller.
function centreTab(tablist: HTMLElement, tab: HTMLElement) {
  if (tablist.scrollWidth <= tablist.clientWidth) return;
  const tabBox = tab.getBoundingClientRect();
  const listBox = tablist.getBoundingClientRect();
  tablist.scrollBy({
    left: tabBox.left + tabBox.width / 2 - (listBox.left + listBox.width / 2),
    behavior: reducedMotion.matches ? 'auto' : 'smooth',
  });
}

document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((tablist) => {
  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const isTour = tablist === tourTablist;

  const current = () => Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'));

  function select(index: number) {
    const next = tabs[(index + tabs.length) % tabs.length];
    for (const tab of tabs) {
      const active = tab === next;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !active;
    }
    if (isTour) centreTab(tablist, next);
  }

  // The Tour's list is vertical on a wide screen and a row of chips under
  // 860px, so it takes both pairs of arrows. The platform tabs are always a
  // row, so they take Left and Right only.
  const back = isTour ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft'];
  const forward = isTour ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight'];

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      const target =
        forward.includes(event.key) ? index + 1
        : back.includes(event.key) ? index - 1
        : event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
        : undefined;
      if (target === undefined) return;
      event.preventDefault();
      select(target);
      tabs[(target + tabs.length) % tabs.length].focus();
    });
  });

  if (isTour) tour = { tabs, current, select };
});

// A tab row that scrolls sideways fades at its right edge while there's more
// of it to scroll to (style.css keys the fade off data-more).
document.querySelectorAll<HTMLElement>('.tour-tabs, .platform-tabs').forEach((row) => {
  const update = () => row.toggleAttribute('data-more', row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
  row.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(row);
  update();
});

// The Tour's list reads as vertical until it turns into a row of chips.
if (tourTablist) {
  const chips = matchMedia('(max-width: 860px)');
  const orient = () => tourTablist.setAttribute('aria-orientation', chips.matches ? 'horizontal' : 'vertical');
  chips.addEventListener('change', orient);
  orient();
}

// ---- Tour pager and swipe (phones) -------------------------------------

// Each tour panel carries its own ‹ 03 / 09 › pager, shown under 720px. They
// step through the tabs and wrap at the ends. A pager button that had focus
// hands it to the same button in the panel it opened, so focus never falls
// back to the page when its own panel hides.
function stepTour(by: number, focusStep?: string) {
  if (!tour) return;
  const next = (tour.current() + by + tour.tabs.length) % tour.tabs.length;
  tour.select(next);
  if (focusStep === undefined) return;
  const panel = document.getElementById(tour.tabs[next].getAttribute('aria-controls') ?? '');
  panel?.querySelector<HTMLButtonElement>(`[data-tour-step="${focusStep}"]`)?.focus();
}

document.querySelectorAll<HTMLButtonElement>('[data-tour-step]').forEach((button) => {
  button.addEventListener('click', () => {
    const step = button.dataset.tourStep ?? '1';
    stepTour(Number(step), document.activeElement === button ? step : undefined);
  });
});

// A sideways swipe on a tour image does the same. The frame's touch-action
// leaves vertical panning to the browser, which cancels the pointer as soon
// as it scrolls, so a swipe only counts when it's mostly sideways.
document.querySelectorAll<HTMLElement>('[data-swipe]').forEach((frame) => {
  let start: { x: number; y: number; id: number } | null = null;
  frame.addEventListener('pointerdown', (event) => {
    start = event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  });
  frame.addEventListener('pointercancel', () => (start = null));
  frame.addEventListener('pointerup', (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5) stepTour(dx < 0 ? 1 : -1);
  });
});

// ---- Preloading hidden tab images ---------------------------------------

// Hidden tab panels are lazy images inside display: none, so they wouldn't
// load until clicked, and the first click would show an empty frame. Once a
// tab set is a screen or so away, flip the current theme's copies to eager,
// which starts their download. A theme switch after that does the same for
// the other theme.
const reachedTabSets = new Set<Element>();

function preloadTabImages(tabSet: Element, theme: Theme) {
  tabSet
    .querySelectorAll<HTMLImageElement>(`[role="tabpanel"] img[data-for-theme="${theme}"]`)
    .forEach((img) => (img.loading = 'eager'));
}

const tabPreloader = new IntersectionObserver(
  (entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      reachedTabSets.add(entry.target);
      preloadTabImages(entry.target, currentTheme());
    }
  },
  { rootMargin: '800px 0px' },
);

document.querySelectorAll('[data-preload-tabs]').forEach((tabSet) => tabPreloader.observe(tabSet));
themeListeners.push((theme) => reachedTabSets.forEach((tabSet) => preloadTabImages(tabSet, theme)));

// ---- Copy buttons --------------------------------------------------------

// Copies the commands alone: no "$ " prompts, one per line. The buttons ship
// hidden and only appear where the Clipboard API exists.
if (typeof navigator.clipboard?.writeText === 'function') {
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => {
    const block = button.closest('.code');
    const status = block?.querySelector('[data-copy-status]');
    let reset = 0;
    button.hidden = false;
    button.addEventListener('click', async () => {
      const lines = Array.from(block?.querySelectorAll('.code-line') ?? [], (line) => {
        const copy = line.cloneNode(true) as Element;
        copy.querySelectorAll('.prompt').forEach((prompt) => prompt.remove());
        return copy.textContent ?? '';
      });
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
      } catch {
        return; // Refused (no permission, or the page isn't focused): nothing to report.
      }
      button.textContent = 'copied';
      if (status) status.textContent = 'Copied';
      window.clearTimeout(reset);
      reset = window.setTimeout(() => {
        button.textContent = 'copy';
        if (status) status.textContent = '';
      }, 1600);
    });
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
        : "We'll email you when your wave opens.",
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
    " Submitting stores your email in Cloudflare KV through a small serverless function. There's no mailing list provider, tracking, or resale, and you'll get one message when your wave opens.";
  finePrint.append(detail);
});
