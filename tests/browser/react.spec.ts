import { test, expect } from '@playwright/test';

test('React StrictMode preserves its API while applying options and latest callbacks', async ({ page }) => {
  await page.goto('/react-test.html');
  await expect(page.locator('canvas')).toHaveCount(2);
  expect(
    await page.evaluate(() => ({
      ready: window.testReact.ready,
      destroyed: window.testReact.destroyed,
      hasRef: !!window.testReact.ref.current,
      versions: window.testReact.readyVersions,
    })),
  ).toEqual({ ready: 2, destroyed: 1, hasRef: true, versions: ['dark', 'dark'] });
  await page.getByRole('button', { name: 'Change theme' }).click();
  await expect(page.getByRole('img', { name: 'Chart light' })).toBeVisible();
  const patched = await page.evaluate(async () => {
    const { ref, initialApi, ready } = window.testReact;
    const blob = await ref.current!.exportImage();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      sameApi: ref.current === initialApi,
      ready,
      background: [...context.getImageData(0, 0, 1, 1).data],
    };
  });
  expect(patched).toEqual({ sameApi: true, ready: 2, background: [241, 226, 211, 255] });
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      destroyed: window.testReact.destroyed,
      ref: window.testReact.ref.current,
      versions: window.testReact.destroyedVersions,
    })),
  ).toEqual({ destroyed: 2, ref: null, versions: ['dark', 'light'] });
  await page.getByRole('button', { name: 'Toggle chart' }).click();
  await expect(page.locator('canvas')).toHaveCount(2);
  expect(await page.evaluate(() => window.testReact.readyVersions)).toEqual([
    'dark',
    'dark',
    'light',
    'light',
  ]);
});
