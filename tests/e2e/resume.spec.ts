import { test, expect, type Page } from "@playwright/test";
import { startOriel, type OrielServer } from "./helpers/server";

// Helper: wait until the xterm terminal has rendered some text
async function waitForTerminalText(page: Page, timeout = 30_000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => {
      const rows = document.querySelectorAll(".xterm-rows > div");
      return Array.from(rows).map((r) => r.textContent ?? "").join("\n");
    });
    if (text.trim().length > 0) return text;
    await page.waitForTimeout(500);
  }
  throw new Error("Terminal did not render text within timeout");
}

async function getTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    return Array.from(rows).map((r) => r.textContent ?? "").join("\n");
  });
}

test.describe("Resume session across restarts", () => {
  let server: OrielServer;

  test.afterEach(async () => {
    await server?.stop();
  });

  test("new tab with no messages: restart should start fresh (no resume error)", async ({ browser }) => {
    // Start server, open page, wait for Claude to initialize
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Wait for watchConversation to discover UUID
    await page.waitForTimeout(5000);

    // Stop server
    const dbPath = server.stateDbPath;
    await server.stop();

    // Restart with same DB
    server = await startOriel({ stateDbPath: dbPath });
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Wait for any error to appear
    await page.waitForTimeout(5000);
    const text = await getTerminalText(page);
    expect(text).not.toContain("No conversation found with session ID");

    await context.close();
  });

  test("send a message then restart: should resume correctly", async ({ browser }) => {
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Focus terminal and type a message
    await page.click(".xterm-helper-textarea", { force: true });
    await page.keyboard.type("hello, just testing", { delay: 30 });
    await page.keyboard.press("Enter");

    // Wait for Claude to respond
    await page.waitForTimeout(15_000);

    // Stop server
    const dbPath = server.stateDbPath;
    await server.stop();

    // Restart with same DB
    server = await startOriel({ stateDbPath: dbPath });
    await page.goto(server.url);
    await waitForTerminalText(page);

    await page.waitForTimeout(5000);
    const text = await getTerminalText(page);
    expect(text).not.toContain("No conversation found with session ID");

    await context.close();
  });

});
