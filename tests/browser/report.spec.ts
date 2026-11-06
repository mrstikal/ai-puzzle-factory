import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

interface FixtureManifest {
  readonly runId: string;
  readonly htmlPath: string;
  readonly imageFiles: readonly string[];
}

interface Diagnostics {
  readonly externalRequests: string[];
  readonly consoleErrors: string[];
  readonly dialogs: string[];
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "data", "browser-report", "fixture.json"), "utf8"),
) as FixtureManifest;
const galleryUrl = pathToFileURL(manifest.htmlPath).href;

async function openGallery(page: Page): Promise<Diagnostics> {
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
  await page.goto(galleryUrl, { waitUntil: "load" });
  await page.waitForTimeout(300);
  return diagnostics;
}

async function expectClean(
  page: Page,
  diagnostics: Diagnostics,
): Promise<void> {
  await page.waitForTimeout(200);
  expect(diagnostics.externalRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.dialogs).toEqual([]);
}

function card(page: Page, slotId: string) {
  return page.locator(`article.card[data-slot-id="${slotId}"]`);
}

async function selectFilter(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await page.locator(selector).selectOption(value);
}

async function expectVisibleCards(page: Page, count: number): Promise<void> {
  await expect(page.locator("article.card:not([hidden])")).toHaveCount(count);
}

async function documentOverflow(page: Page): Promise<number> {
  return page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
}

async function imageNaturalWidth(
  page: Page,
  selector: string,
): Promise<number> {
  return page.evaluate<number>(
    `(() => { const img = document.querySelector(${JSON.stringify(
      selector,
    )}); return img ? img.naturalWidth : 0; })()`,
  );
}

test.describe("desktop offline gallery", () => {
  test("renders all planned cards, banners, and visible failure evidence", async ({
    page,
  }) => {
    const diagnostics = await openGallery(page);
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    await expect(page.locator("article.card")).toHaveCount(20);
    await expect(page.locator(".banner-mock")).toContainText("MOCK DATA");
    await expect(page.locator(".banner-incomplete")).toContainText(
      "INCOMPLETE RUN",
    );

    const generationError = card(page, "text-ranking-02");
    await expect(generationError).toContainText("generation_error");
    await expect(generationError.locator(".failures")).toBeVisible();
    await expect(generationError.locator(".failures")).toContainText("API_ERROR");

    const rejected = card(page, "text-truth-01");
    await expect(rejected).toContainText("rejected");
    await expect(rejected.locator(".failures")).toContainText("UNSAT");

    const incomplete = card(page, "text-matching-02");
    await expect(incomplete.locator(".badge-incomplete")).toContainText(
      "incomplete",
    );

    const unstarted = card(page, "text-arithmetic-02");
    await expect(unstarted).toContainText("unstarted");
    await expect(unstarted).toContainText(
      "No public presentation was committed for this slot.",
    );

    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
    await expectClean(page, diagnostics);
  });

  test("keeps reveal data hidden until keyboard activation", async ({ page }) => {
    const diagnostics = await openGallery(page);
    await expect(page.locator("details.reveal")).toHaveCount(80);
    await expect(page.locator("details.reveal[open]")).toHaveCount(0);

    const first = card(page, "text-ranking-01");
    const answer = first.locator('details[data-reveal="answer"]');
    await expect(answer.locator(".reveal-key")).toBeHidden();
    await answer.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(answer).toHaveAttribute("open", "");
    await expect(answer.locator(".reveal-key")).toBeVisible();
    await expect(answer.locator(".reveal-key")).toContainText(
      "Correct option: A",
    );

    await page.getByRole("button", { name: "Reveal all details" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("details.reveal[open]")).toHaveCount(80);

    await page.getByRole("button", { name: "Hide all details" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("details.reveal[open]")).toHaveCount(0);
    await expectClean(page, diagnostics);
  });

  test("filters cards from the keyboard and exposes all six filters", async ({
    page,
  }) => {
    const diagnostics = await openGallery(page);
    for (const name of [
      "Modality",
      "Family",
      "Lane",
      "Status",
      "Difficulty",
      "Disagreement",
    ]) {
      await expect(page.getByRole("combobox", { name })).toBeVisible();
    }

    const modality = page.getByRole("combobox", { name: "Modality" });
    await modality.focus();
    await page.keyboard.press("s");
    await page.keyboard.press("Enter");
    await expect(page.locator("#filter-status")).toHaveText(
      "Showing 10 of 20 cards.",
    );
    await expectVisibleCards(page, 10);

    await page.getByRole("button", { name: "Reset filters" }).focus();
    await page.keyboard.press("Enter");
    await expectVisibleCards(page, 20);

    await selectFilter(page, "#filter-family", "counting");
    await expectVisibleCards(page, 2);
    await selectFilter(page, "#filter-lane", "ai_spec");
    await expectVisibleCards(page, 1);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await selectFilter(page, "#filter-status-filter", "generation_error");
    await expectVisibleCards(page, 1);
    await selectFilter(page, "#filter-status-filter", "incomplete");
    await expectVisibleCards(page, 1);
    await selectFilter(page, "#filter-status-filter", "unstarted");
    await expectVisibleCards(page, 13);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await selectFilter(page, "#filter-difficulty", "1");
    await expectVisibleCards(page, 7);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await selectFilter(page, "#filter-disagreement", "yes");
    await expectVisibleCards(page, 1);
    await expect(card(page, "text-ranking-01")).toBeVisible();
    await expect(page.locator("#filter-status")).toHaveText(
      "Showing 1 of 20 cards.",
    );
    await expectClean(page, diagnostics);
  });

  test("zooms a local PNG in a modal dialog and closes with Escape", async ({
    page,
  }) => {
    const diagnostics = await openGallery(page);
    const svgCard = card(page, "svg-matrix-01");
    const image = svgCard.locator("img");
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        imageNaturalWidth(page, '[data-slot-id="svg-matrix-01"] img'),
      )
      .toBe(1024);

    const zoomButton = svgCard.getByRole("button", {
      name: "Zoom image for svg-matrix-01",
    });
    await zoomButton.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate<number>(
          "(() => { const img = document.getElementById('zoom-image'); return img ? img.naturalWidth : 0; })()",
        ),
      )
      .toBe(1024);
    const source = await page.locator("#zoom-image").getAttribute("src");
    expect(source).toMatch(/^file:.*\/images\/svg-matrix-01\.png$/);
    const zoomBox = await page.locator("#zoom-image").boundingBox();
    expect(zoomBox).not.toBeNull();
    expect(zoomBox?.width ?? 0).toBeGreaterThanOrEqual(600);
    expect(zoomBox?.height ?? 0).toBeGreaterThanOrEqual(600);
    expect(
      Math.abs((zoomBox?.width ?? 0) - (zoomBox?.height ?? 0)),
    ).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expectClean(page, diagnostics);
  });

  test("escapes hostile text and blocks external resources under CSP", async ({
    page,
  }) => {
    const diagnostics = await openGallery(page);
    const hostile = card(page, "text-ranking-01");
    await expect(hostile).toContainText(
      '</script><script>alert("question")</script>',
    );
    await expect(hostile.locator('img[src="x"]')).toHaveCount(0);
    await expect(hostile.locator("[onerror]")).toHaveCount(0);

    const embeddedText = await page.locator("#report-data").textContent();
    const embedded = JSON.parse(embeddedText ?? "null") as {
      cards: Array<{ slotId: string; question: string | null }>;
    };
    const hostileCard = embedded.cards.find(
      (item) => item.slotId === "text-ranking-01",
    );
    expect(hostileCard?.question).toContain("</script>");
    expect(hostileCard?.question).toContain('<img src=x onerror="alert(1)">');

    const csp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    await expectClean(page, diagnostics);
  });
});

test.describe("mobile offline gallery", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("keeps the gallery usable at 360x800 without horizontal overflow", async ({
    page,
  }) => {
    const diagnostics = await openGallery(page);
    expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
    await expect(page.locator("article.card")).toHaveCount(20);
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);

    await expect(page.locator("details.reveal[open]")).toHaveCount(0);
    const svgCard = card(page, "svg-matrix-01");
    await svgCard.locator("img").scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        imageNaturalWidth(page, '[data-slot-id="svg-matrix-01"] img'),
      )
      .toBe(1024);
    const boxes = await page.evaluate<{ card: number; image: number }>(
      `(() => { const card = document.querySelector(${JSON.stringify(
        '[data-slot-id="svg-matrix-01"]',
      )}); const image = card ? card.querySelector('img') : null; return { card: card ? card.getBoundingClientRect().width : 0, image: image ? image.getBoundingClientRect().width : 0 }; })()`,
    );
    expect(boxes.card).toBeGreaterThan(0);
    expect(boxes.card).toBeLessThanOrEqual(360);
    expect(boxes.image).toBeGreaterThan(0);
    expect(boxes.image).toBeLessThanOrEqual(boxes.card);
    await svgCard
      .locator('details[data-reveal="answer"] summary')
      .focus();
    await page.keyboard.press("Enter");
    await expect(svgCard.locator(".reveal-key")).toBeVisible();

    const modality = page.getByRole("combobox", { name: "Modality" });
    await modality.focus();
    await page.keyboard.press("s");
    await page.keyboard.press("Enter");
    await expectVisibleCards(page, 10);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expectVisibleCards(page, 20);

    await svgCard.locator("img").scrollIntoViewIfNeeded();
    await svgCard
      .getByRole("button", { name: "Zoom image for svg-matrix-01" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await documentOverflow(page)).toBeLessThanOrEqual(0);
    await expectClean(page, diagnostics);
  });
});
