import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

interface DesignFixture {
  readonly runId: string;
  readonly reportPath: string;
  readonly solvePath: string;
  readonly revealPath: string;
  readonly labelsPath: string;
  readonly sampleHash: string;
  readonly slotCount: number;
  readonly tripletCount: number;
  readonly additionCount: number;
}

interface Diagnostics {
  readonly externalRequests: string[];
  readonly consoleErrors: string[];
  readonly dialogs: string[];
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(repoRoot, "data", "browser-design", "design-fixture.json"),
    "utf8",
  ),
) as DesignFixture;
const reportUrl = pathToFileURL(fixture.reportPath).href;
const solveUrl = pathToFileURL(fixture.solvePath).href;
const revealUrl = pathToFileURL(fixture.revealPath).href;

async function openPage(page: Page, url: string): Promise<Diagnostics> {
  const diagnostics: Diagnostics = {
    externalRequests: [],
    consoleErrors: [],
    dialogs: [],
  };
  await page.route(/^https?:\/\//, async (route) => {
    diagnostics.externalRequests.push(route.request().url());
    await route.abort();
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.consoleErrors.push(error.message);
  });
  page.on("dialog", async (dialog) => {
    diagnostics.dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(200);
  return diagnostics;
}

async function expectClean(diagnostics: Diagnostics): Promise<void> {
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.dialogs).toEqual([]);
}

async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
}

test.describe("designer offline report", () => {
  test("renders all cards, mock banner, inline assets, and working filters at desktop size", async ({
    page,
  }) => {
    const diagnostics = await openPage(page, reportUrl);
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    await expect(page.locator("article.card")).toHaveCount(fixture.slotCount);
    await expect(page.locator(".banner")).toContainText("MOCK DATA");
    await expect(page.locator("svg").first()).toBeVisible();
    expect(await page.locator("img").count()).toBe(0);

    await page.locator("#filter-arm").selectOption("ai_feedback");
    await expect(page.locator("article.card:not([hidden])")).toHaveCount(
      fixture.slotCount / 3,
    );
    await page.locator("#filter-status").selectOption("accepted");
    const accepted = await page
      .locator("article.card:not([hidden])")
      .count();
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(fixture.slotCount / 3);
    await page.locator("#filter-arm").selectOption("all");
    await page.locator("#filter-status").selectOption("all");
    await expect(page.locator("article.card:not([hidden])")).toHaveCount(
      fixture.slotCount,
    );
    await expectClean(diagnostics);
  });

  test("stays readable without horizontal overflow at mobile size", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = await openPage(page, reportUrl);
    await expect(page.locator("article.card")).toHaveCount(fixture.slotCount);
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
    await page.locator("#filter-arm").selectOption("baseline");
    await expect(page.locator("article.card:not([hidden])")).toHaveCount(
      fixture.slotCount / 3,
    );
    await expectClean(diagnostics);
  });
});

test.describe("blinded evaluation gallery", () => {
  test("shows only public puzzle content before reveal", async ({ page }) => {
    const diagnostics = await openPage(page, solveUrl);
    const cardCount = await page.locator("article.puzzle").count();
    expect(cardCount).toBeGreaterThanOrEqual(fixture.tripletCount);
    expect(cardCount).toBeLessThanOrEqual(
      fixture.tripletCount * 3 + fixture.additionCount,
    );
    const bodyText = await page.locator("body").innerText();
    for (const forbidden of [
      "ai_feedback",
      "ai_one_shot",
      "baseline",
      "repair",
      "novel",
      "design-text-",
      "design-svg-",
      fixture.runId,
    ]) {
      expect(bodyText).not.toContain(forbidden);
    }
    await expect(page.locator('a[href="reveal.html"]')).toBeVisible();
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
    await expectClean(diagnostics);
  });

  test("reveals private arm, assignment, answer, and hint only on the reveal page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = await openPage(page, revealUrl);
    await expect(page.locator("article.puzzle").first()).toBeVisible();
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).toMatch(/Private arm:/);
    expect(bodyText).toMatch(/Assignment:/);
    expect(bodyText).toMatch(/Correct option:/);
    expect(bodyText).toMatch(/Hint:/);
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
    await expectClean(diagnostics);
  });
});
