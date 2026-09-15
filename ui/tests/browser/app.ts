import { beforeEach, afterEach, expect } from 'vitest';
import {
  page,
  locators,
  type Locator,
  type FrameLocator,
} from 'vitest/browser';

// Use Vitest's supported locator extension for existing plugin data attributes.
declare module 'vitest/browser' {
  interface LocatorSelectors {
    getByCSS(selector: string): Locator;
  }
}
locators.extend({ getByCSS: (selector: string) => `css=${selector}` });

export let frame: HTMLIFrameElement;
export let app: FrameLocator;
let errors: string[];
function captureError(event: MessageEvent) {
  if (
    event.source === frame.contentWindow &&
    event.origin === location.origin &&
    event.data?.type === 'ufi-test-error'
  ) {
    errors.push(event.data.message);
  }
}
beforeEach(async () => {
  // A Browser Mode page is shared within a test file. Reset only our fixture state.
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('ufi-mock-')) sessionStorage.removeItem(key);
  }
  errors = [];
  await page.viewport(1280, 900);
  frame = document.createElement('iframe');
  frame.dataset.testid = 'ufi-app';
  frame.title = 'UFI host';
  frame.style.cssText = 'width:1280px;height:900px;border:0;display:block';
  document.body.style.margin = '0';
  window.addEventListener('message', captureError);
  document.body.append(frame);
  app = page.frameLocator(page.getByTestId('ufi-app'));
});
afterEach(() => {
  window.removeEventListener('message', captureError);
  frame.remove();
  expect(errors).toEqual([]);
});
export function evaluate<T = unknown>(expression: string): T {
  return (frame.contentWindow as Window & typeof globalThis).eval(
    expression,
  ) as T;
}
export async function idle() {
  await expect
    .element(app.getByCSS('[data-gateway-body]'))
    .not.toHaveAttribute('aria-busy', 'true');
  const close = app.getByCSS(
    '[data-sonner-toast][data-removed=false] [data-close-button]',
  );
  while (close.elements().length) {
    await close.first().click();
    await expect
      .poll(
        () =>
          app.getByCSS('[data-sonner-toast][data-removed=true]').elements()
            .length,
      )
      .toBe(0);
  }
}
export async function closeModal(name = '关闭详情') {
  await app.getByRole('button', { name, exact: true }).click();
  if (name === '关闭详情') await expect.element(app.getByCSS('[data-log-panel]')).not.toBeVisible();
  else await expect.element(app.getByCSS('[data-dialog]')).not.toBeInTheDocument();
  await idle();
}
export async function open(state: string) {
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  );
  frame.src = `/tests/browser/host.html?state=${state}`;
  await loaded;
  await app.getByCSS('[data-plugin] > summary').click();
  await idle();
}
export async function reload() {
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  );
  frame.contentWindow!.location.reload();
  await loaded;
}
