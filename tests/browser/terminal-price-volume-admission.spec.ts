import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('default terminal history uses the owned price-to-volume copier; supplied factories do not', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto('/terminal-price-volume-admission.html');
  await page.waitForFunction(() => Boolean((window as any).terminalPriceVolumeAdmission));
  // run() reports discovery failure itself, so the baseline lacks no fixture entry or timeout ambiguity.
  const report = await page.evaluate(() => (window as any).terminalPriceVolumeAdmission.run());
  const artifact = testInfo.outputPath('terminal-price-volume-admission.json');
  writeFileSync(artifact, JSON.stringify(report, null, 2), { flag: 'wx' });
  await testInfo.attach('terminal-price-volume-admission', {
    path: artifact,
    contentType: 'application/json',
  });

  expect(report.primaryError, JSON.stringify(report)).toBeNull();
  expect(report.cleanupErrors, JSON.stringify(report)).toEqual([]);
  expect(report.scenarios.map((receipt: any) => receipt.scenario)).toEqual([
    'create',
    'prepare',
    'same-factories',
    'volume-off',
  ]);
  expect(report.calls.map((call: any) => [call.scenario, call.rows, call.returned])).toEqual([
    ['create', 0, true],
    ['create', 64, true],
    ['create', 128, true],
    ['prepare', 0, true],
    ['prepare', 64, true],
    ['prepare', 128, true],
  ]);
  for (const receipt of report.scenarios) {
    expect(receipt.feedBars).toEqual([64, 128]);
    expect(receipt.history).toHaveLength(2);
    expect(receipt.samples.map((sample: any) => sample.index)).toEqual([127, 63, 127]);
    expect(receipt.samples.every((sample: any) => sample.visibleRange !== null)).toBe(true);
    expect(receipt.subscriptionsBeforeDestroy).toBe(1);
    expect(receipt.subscriptionsAfterDestroy).toBe(0);
    expect(receipt.canvasesAfterDestroy).toBe(0);
    if (receipt.scenario === 'create' || receipt.scenario === 'prepare')
      expect(receipt.copierRows).toEqual([0, 64, 128]);
    else expect(receipt.copierRows).toEqual([]);
    if (receipt.scenario === 'volume-off')
      expect(receipt.samples.every((sample: any) => sample.volume === null)).toBe(true);
    else expect(receipt.samples[1].volumeNegativeZero).toBe(true);
  }
});
