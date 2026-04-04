import { test, expect, type Page } from "@playwright/test";
import { startOriel, type OrielServer } from "./helpers/server";

// Inject WebSocket interceptor before navigation to capture messages and session ID
async function setupWsCapture(page: Page) {
  await page.addInitScript(() => {
    (window as any).__wsMessages = [];
    (window as any).__wsSessionId = null;
    const origWS = window.WebSocket;
    (window as any).WebSocket = class extends origWS {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        // Extract session ID from ws URL: /ws?session=<id>
        try {
          const u = new URL(url, window.location.href);
          const sid = u.searchParams.get("session");
          if (sid) (window as any).__wsSessionId = sid;
        } catch {}
        this.addEventListener("message", (e: MessageEvent) => {
          try {
            const msg = JSON.parse(e.data);
            (window as any).__wsMessages.push(msg);
          } catch {}
        });
      }
    };
  });
}

async function getSessionId(page: Page, timeout = 15_000): Promise<string> {
  await page.waitForFunction(
    () => (window as any).__wsSessionId !== null,
    { timeout }
  );
  return page.evaluate(() => (window as any).__wsSessionId as string);
}

async function waitForConversationReset(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__wsMessages.some((m: any) => m.type === "conversation_reset"),
    { timeout }
  );
}

async function clearWsMessages(page: Page) {
  await page.evaluate(() => { (window as any).__wsMessages = []; });
}

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

test.describe("/clear command resets conversation", () => {
  let server: OrielServer;

  test.afterEach(async ({}, testInfo) => {
    // Dump server logs on failure for diagnosis
    if (testInfo.status === "failed") {
      console.log("=== Oriel server logs ===");
      console.log(server?.logs.join(""));
      console.log("=========================");
    }
    await server?.stop();
  });

  test("server-side: direct POST to session-start triggers conversation_reset", async ({ browser }) => {
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();

    await setupWsCapture(page);
    await page.goto(server.url);
    await waitForTerminalText(page);

    // Wait for WS to connect and session ID to be captured
    const sessionId = await getSessionId(page);
    console.log("Session ID:", sessionId);

    // Wait for Claude to initialize so the session is registered
    await page.waitForTimeout(5000);

    // Clear WS messages, then POST directly to session-start endpoint
    await clearWsMessages(page);

    const hookUrl = `http://127.0.0.1:${server.port}/api/sessions/${sessionId}/session-start`;
    const resp = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "clear", hook_event_name: "SessionStart" }),
      });
      return { status: r.status, body: await r.text() };
    }, hookUrl);

    console.log("Hook response:", resp);
    expect(resp.status).toBe(200);

    // Assert conversation_reset arrives
    await waitForConversationReset(page, 10_000);

    await context.close();
  });

  test("full flow: typing /clear in terminal triggers conversation_reset", async ({ browser }) => {
    server = await startOriel();
    const context = await browser.newContext();
    const page = await context.newPage();

    await setupWsCapture(page);
    await page.goto(server.url);
    await waitForTerminalText(page);

    const sessionId = await getSessionId(page);
    console.log("Session ID:", sessionId);

    // Wait for Claude to fully initialize - wait for terminal to show prompt
    await page.waitForTimeout(8000);
    await clearWsMessages(page);

    // Take screenshot before typing
    await page.screenshot({ path: "test-clear-before.png" });

    // Type /clear in the terminal
    await page.click(".xterm-helper-textarea", { force: true });
    await page.keyboard.type("/clear", { delay: 50 });
    await page.waitForTimeout(500);

    // Take screenshot after typing (before Enter)
    await page.screenshot({ path: "test-clear-typed.png" });

    await page.keyboard.press("Enter");

    // Wait a bit then take screenshot
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "test-clear-after.png" });

    // Wait for conversation_reset (15s)
    try {
      await waitForConversationReset(page, 15_000);
      console.log("SUCCESS: conversation_reset received after /clear");
    } catch (e) {
      // Print server logs to diagnose why hook didn't fire
      console.log("FAILURE: conversation_reset not received");
      console.log("Server logs:\n", server.logs.join(""));
      throw e;
    }

    await context.close();
  });
});
