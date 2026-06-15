#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const RESUME_WASM_URL =
  "https://static.zhipin.com/assets/zhipin/wasm/resume/wasm_canvas-1.0.2-5081.js";

function requirePuppeteerCore() {
  try {
    return require("puppeteer-core");
  } catch (firstError) {
    const appData = process.env.APPDATA;
    if (appData) {
      const bossCliNodeModules = path.join(
        appData,
        "npm",
        "node_modules",
        "@joohw",
        "boss-cli",
        "node_modules"
      );
      try {
        return require(path.join(bossCliNodeModules, "puppeteer-core"));
      } catch (_) {}
    }
    throw firstError;
  }
}

function parseArgs(argv) {
  const args = {
    browserUrl: process.env.BOSS_BROWSER_URL || "http://127.0.0.1:53470",
    position: "",
    out: `online_resumes_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`,
    limit: 0,
    onlyUnread: false,
    scanOnly: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--browser-url") args.browserUrl = argv[++i];
    else if (arg === "--position") args.position = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i] || "0");
    else if (arg === "--only-unread") args.onlyUnread = true;
    else if (arg === "--scan-only") args.scanOnly = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/read-current-chat-online-resumes.js --position "R&D Director La Forge" --out online_resumes.json
  node scripts/read-current-chat-online-resumes.js --position "活动支持实习生" --limit 5
  node scripts/read-current-chat-online-resumes.js --browser-url http://127.0.0.1:53470 --scan-only

Prerequisites:
  - BOSS recruiting browser is logged in.
  - The current page is https://www.zhipin.com/web/chat/index.
  - The recruiter has selected the target position and unread-greetings list when unread-only work is required.

Safety:
  This script reads rows and online resumes only. It never sends messages or clicks disposition actions.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function safePageEval(page, fn, arg) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      if (String(error).includes("Execution context was destroyed")) {
        await sleep(350);
        continue;
      }
      throw error;
    }
  }
  return null;
}

async function stabilizeChatPage(page) {
  const install = async () => {
    await page.evaluate(() => {
      if (window.top !== window || window.__bossBriefStabilized) return;
      window.__bossBriefStabilized = true;

      const shouldBlockBossNavigation = (url) => {
        const target = String(url || "");
        if (!target) return false;
        if (target.includes("/web/chat/index")) return false;
        return target.includes("zhipin.com") || target.startsWith("/") || target.startsWith("#");
      };

      try {
        const assign = window.location.assign.bind(window.location);
        const replace = window.location.replace.bind(window.location);
        window.location.assign = (url) => {
          if (shouldBlockBossNavigation(url)) return undefined;
          return assign(url);
        };
        window.location.replace = (url) => {
          if (shouldBlockBossNavigation(url)) return undefined;
          return replace(url);
        };
      } catch (_) {}

      try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        Object.defineProperty(document, "webkitHidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "webkitVisibilityState", { configurable: true, get: () => "visible" });
      } catch (_) {}

      try {
        const originalAddEventListener = document.addEventListener.bind(document);
        document.addEventListener = function patchedAddEventListener(type, listener, options) {
          if (type === "visibilitychange" && window.top === window) return undefined;
          return originalAddEventListener(type, listener, options);
        };
      } catch (_) {}
    });
  };

  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    try {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(document, "webkitHidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "webkitVisibilityState", { configurable: true, get: () => "visible" });
    } catch (_) {}
  });

  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    if (!frame.url().includes("/web/chat/index")) return;
    try {
      await install();
    } catch (_) {}
  });

  try {
    await install();
  } catch (_) {}
}

async function patchCanvasTextCapture(page) {
  await page.evaluateOnNewDocument(() => {
    window.__bossResumeTexts = [];
    const patch = () => {
      try {
        const proto = CanvasRenderingContext2D.prototype;
        if (proto.__bossBriefFillTextPatched) return;
        proto.__bossBriefFillTextPatched = true;
        const oldFillText = proto.fillText;
        proto.fillText = function patchedFillText(text, ...rest) {
          try {
            window.__bossResumeTexts.push(String(text));
          } catch (_) {}
          return oldFillText.call(this, text, ...rest);
        };
      } catch (_) {}
    };
    patch();
  });
}

async function findChatPage(browser) {
  const pages = await browser.pages();
  return (
    pages.find((p) => p.url().includes("zhipin.com/web/chat/index")) ||
    pages.find((p) => p.url().includes("zhipin.com") && !p.url().includes("login")) ||
    pages[0]
  );
}

async function scanCurrentList(page, args) {
  const seen = new Map();
  let stagnant = 0;

  await safePageEval(page, () => {
    const list =
      document.querySelector(".user-list.b-scroll-stable") ||
      document.querySelector(".user-list") ||
      document.scrollingElement;
    if (list) list.scrollTop = 0;
  });
  await sleep(700);

  for (let step = 0; step < 120 && stagnant < 10; step += 1) {
    const rows = await safePageEval(
      page,
      ({ position, onlyUnread }) => {
        const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
        return [...document.querySelectorAll(".geek-item-wrap,.geek-item")]
          .map((row, index) => {
            const text = normalize(row.innerText || row.textContent || "");
            const name = normalize(row.querySelector(".geek-name")?.innerText || "");
            const unreadHint = Boolean(
              row.querySelector(".unread,.badge,.badge-num,.message-count,.red-dot") ||
                /未读|new/i.test(text)
            );
            return { index, name, text, unreadHint };
          })
          .filter((row) => row.name)
          .filter((row) => !position || row.text.includes(position))
          .filter((row) => !onlyUnread || row.unreadHint);
      },
      { position: args.position, onlyUnread: args.onlyUnread }
    );

    let added = 0;
    for (const row of rows || []) {
      const signature = `${row.name}|${row.text}`;
      if (!seen.has(signature)) {
        seen.set(signature, { ...row, signature });
        added += 1;
      }
    }

    stagnant = added ? 0 : stagnant + 1;
    console.error(`scan step ${step}: visible ${rows ? rows.length : 0}, added ${added}, total ${seen.size}`);

    const moved = await safePageEval(page, () => {
      const list =
        document.querySelector(".user-list.b-scroll-stable") ||
        document.querySelector(".user-list") ||
        document.scrollingElement;
      if (!list) return false;
      const before = list.scrollTop;
      list.scrollTop += Math.max(480, Math.floor((list.clientHeight || 700) * 0.75));
      return list.scrollTop !== before;
    });
    if (!moved) stagnant += 1;
    await sleep(450);
  }

  let rows = [...seen.values()];
  if (args.limit > 0) rows = rows.slice(0, args.limit);
  return rows;
}

async function clickRow(page, target, position) {
  await safePageEval(page, () => {
    const list =
      document.querySelector(".user-list.b-scroll-stable") ||
      document.querySelector(".user-list") ||
      document.scrollingElement;
    if (list) list.scrollTop = 0;
  });
  await sleep(400);

  for (let step = 0; step < 140; step += 1) {
    const clicked = await safePageEval(
      page,
      ({ targetName, targetText, positionText }) => {
        const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
        const rows = [...document.querySelectorAll(".geek-item-wrap,.geek-item")];
        const row =
          rows.find((el) => normalize(el.innerText || el.textContent || "") === targetText) ||
          rows.find((el) => {
            const text = normalize(el.innerText || el.textContent || "");
            const name = normalize(el.querySelector(".geek-name")?.innerText || "");
            return name === targetName && (!positionText || text.includes(positionText));
          });
        if (!row) return { ok: false };
        row.scrollIntoView({ block: "center" });
        for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
          row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
        return { ok: true, text: normalize(row.innerText || row.textContent || "") };
      },
      { targetName: target.name, targetText: target.text, positionText: position }
    );
    if (clicked && clicked.ok) return clicked;

    const moved = await safePageEval(page, () => {
      const list =
        document.querySelector(".user-list.b-scroll-stable") ||
        document.querySelector(".user-list") ||
        document.scrollingElement;
      if (!list) return false;
      const before = list.scrollTop;
      list.scrollTop += Math.max(480, Math.floor((list.clientHeight || 700) * 0.7));
      return list.scrollTop !== before;
    });
    if (!moved) break;
    await sleep(300);
  }
  return { ok: false, reason: "candidate row not found after scrolling" };
}

async function openOnlineResume(page) {
  return safePageEval(page, () => {
    const btn = [...document.querySelectorAll("a,button")]
      .find((el) => {
        const text = String(el.innerText || el.textContent || "");
        const cls = String(el.className || "");
        return text.includes("在线简历") || cls.includes("resume-btn-online");
      });
    if (!btn) return { ok: false, reason: "online resume button not found" };
    btn.scrollIntoView({ block: "center" });
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return { ok: true };
  });
}

async function readWasmResumeDetail(page, expectedName) {
  let fallback = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const frames = page.frames().filter((frame) => frame.url().includes("/web/frame/c-resume/"));
    for (const frame of frames) {
      try {
        const detail = await frame.evaluate(
          async (wasmUrl) => {
            const mod = await import(wasmUrl);
            return mod.get_export_geek_detail_info();
          },
          RESUME_WASM_URL
        );
        if (detail && detail.geekBaseInfo && detail.geekBaseInfo.name === expectedName) return detail;
        if (detail && detail.geekBaseInfo && !fallback) fallback = detail;
      } catch (_) {}
    }
    await sleep(500);
  }
  return fallback;
}

async function readCanvasText(page, expectedName) {
  let targetFrame = null;
  let fallbackFrame = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const frames = page.frames().filter((frame) => frame.url().includes("/web/frame/c-resume/"));
    for (const frame of frames) {
      try {
        const text = await frame.evaluate(() => (window.__bossResumeTexts || []).join(""));
        if (text && !fallbackFrame) fallbackFrame = frame;
        if (text && text.includes(expectedName)) {
          targetFrame = frame;
          break;
        }
      } catch (_) {}
    }
    if (targetFrame) break;
    await sleep(500);
  }

  targetFrame = targetFrame || fallbackFrame;
  if (!targetFrame) return "";

  const scrollHeight = await targetFrame
    .evaluate(() => document.body.scrollHeight || document.documentElement.scrollHeight || 4000)
    .catch(() => 4000);

  for (let y = 0; y <= scrollHeight + 800; y += 500) {
    await targetFrame.evaluate((scrollY) => window.scrollTo(0, scrollY), y).catch(() => {});
    await sleep(220);
  }

  return targetFrame.evaluate(() => (window.__bossResumeTexts || []).join("")).catch(() => "");
}

async function closeResume(page) {
  await safePageEval(page, () => {
    const close = [...document.querySelectorAll("i,span,button,div")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const text = String(el.innerText || el.textContent || "").trim();
        const cls = String(el.className || "");
        return (
          r.width <= 80 &&
          r.height <= 80 &&
          r.top < 130 &&
          r.left > window.innerWidth * 0.45 &&
          (text === "×" || text.toLowerCase() === "x" || cls.includes("close"))
        );
      })[0];
    if (close) {
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        close.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    return false;
  });
}

function summarizeDetail(detail) {
  if (!detail || typeof detail !== "object") return {};
  return {
    base: detail.geekBaseInfo || null,
    work: detail.geekWorkExpList || [],
    education: detail.geekEduExpList || [],
    projects: detail.geekProjExpList || [],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  const puppeteer = requirePuppeteerCore();
  const browser = await puppeteer.connect({ browserURL: args.browserUrl, defaultViewport: null });
  const page = await findChatPage(browser);
  await stabilizeChatPage(page);
  await patchCanvasTextCapture(page);
  await page.bringToFront();

  const pageInfo = await safePageEval(page, () => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 500),
  }));
  console.error(`connected: ${pageInfo.url}`);

  const rows = await scanCurrentList(page, args);
  const output = {
    meta: {
      createdAt: new Date().toISOString(),
      position: args.position,
      browserUrl: args.browserUrl,
      onlyUnread: args.onlyUnread,
      pageUrl: pageInfo.url,
      scannedRows: rows.length,
      bossSideActionsPerformed: 0,
    },
    rows,
    results: [],
  };

  fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");
  console.error(`scan complete: ${rows.length} row(s)`);
  if (args.scanOnly) {
    await browser.disconnect();
    return;
  }

  for (const row of rows) {
    console.error(`reading: ${row.name}`);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);

    const clicked = await clickRow(page, row, args.position);
    if (!clicked.ok) {
      output.results.push({ name: row.name, row, error: clicked.reason || "candidate row not found" });
      fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");
      continue;
    }
    await sleep(1200);

    const headerText = await safePageEval(page, () => {
      const box =
        document.querySelector(".base-info-single-container") ||
        document.querySelector(".conversation-main") ||
        document.body;
      return String(box.innerText || box.textContent || "").replace(/\s+/g, " ").trim().slice(0, 3000);
    }).catch(() => "");

    const opened = await openOnlineResume(page);
    if (!opened || !opened.ok) {
      output.results.push({
        name: row.name,
        row,
        clickedText: clicked.text,
        headerText,
        error: opened ? opened.reason : "online resume button not found",
      });
      fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");
      continue;
    }

    await sleep(3000);
    const detail = await readWasmResumeDetail(page, row.name);
    const canvasText = await readCanvasText(page, row.name);

    output.results.push({
      name: row.name,
      row,
      clickedText: clicked.text,
      headerText,
      detail: summarizeDetail(detail),
      rawDetail: detail,
      canvasText,
      error: detail || canvasText ? undefined : "online resume opened but no structured/canvas content captured",
    });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");

    await closeResume(page);
    await sleep(600);
  }

  await browser.disconnect();
  console.error(`saved: ${path.resolve(args.out)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

