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
    stabilize: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--browser-url") args.browserUrl = argv[++i];
    else if (arg === "--position") args.position = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i] || "0");
    else if (arg === "--only-unread") args.onlyUnread = true;
    else if (arg === "--scan-only") args.scanOnly = true;
    else if (arg === "--stabilize") args.stabilize = true;
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
  This script reads rows and online resumes only. It never sends messages or clicks disposition actions.
  The page-stabilizing patch is OFF by default. Add --stabilize only as a last-resort fallback.`);
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
        const reload = window.location.reload.bind(window.location);
        const assign = window.location.assign.bind(window.location);
        const replace = window.location.replace.bind(window.location);
        window.__bossBriefOriginalReload = reload;
        window.location.assign = (url) => {
          if (shouldBlockBossNavigation(url)) return undefined;
          return assign(url);
        };
        window.location.replace = (url) => {
          if (shouldBlockBossNavigation(url)) return undefined;
          return replace(url);
        };
        window.location.reload = () => undefined;
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

      try {
        const originalWindowAddEventListener = window.addEventListener.bind(window);
        window.addEventListener = function patchedWindowAddEventListener(type, listener, options) {
          if ((type === "blur" || type === "pagehide") && window.top === window) return undefined;
          return originalWindowAddEventListener(type, listener, options);
        };
      } catch (_) {}
    });
  };

  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    try {
      window.location.reload = () => undefined;
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

  try {
    const client = await page.target().createCDPSession();
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await client.detach();
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

async function getVisibleRows(page, args) {
  return safePageEval(
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
          const r = row.getBoundingClientRect();
          return {
            index,
            name,
            text,
            signature: `${name}|${text}`,
            unreadHint,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          };
        })
        .filter((row) => row.name)
        .filter((row) => row.rect.width > 30 && row.rect.height > 20)
        .filter((row) => !position || row.text.includes(position))
        .filter((row) => !onlyUnread || row.unreadHint);
    },
    { position: args.position, onlyUnread: args.onlyUnread }
  );
}

async function resetListToTop(page) {
  await safePageEval(page, () => {
    const list =
      document.querySelector(".user-list.b-scroll-stable") ||
      document.querySelector(".user-list") ||
      document.scrollingElement;
    if (list) list.scrollTop = 0;
  });
  await sleep(700);
}

async function scrollCandidateList(page) {
  const state = await safePageEval(page, () => {
    const list =
      document.querySelector(".user-list.b-scroll-stable") ||
      document.querySelector(".user-list") ||
      document.scrollingElement;
    if (!list) return { moved: false, reason: "candidate list not found" };
    const before = list.scrollTop;
    list.scrollTop += Math.max(480, Math.floor((list.clientHeight || 700) * 0.75));
    return {
      moved: list.scrollTop !== before,
      top: list.scrollTop,
      height: list.scrollHeight,
      client: list.clientHeight,
    };
  });
  await sleep(500);
  return state || { moved: false, reason: "scroll failed" };
}

async function clickVisibleRow(page, row) {
  const target = await safePageEval(page, ({ signature, name, text }) => {
    const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const rows = [...document.querySelectorAll(".geek-item-wrap,.geek-item")];
    const match =
      rows.find((el) => `${normalize(el.querySelector(".geek-name")?.innerText || "")}|${normalize(el.innerText || el.textContent || "")}` === signature) ||
      rows.find((el) => {
        const rowText = normalize(el.innerText || el.textContent || "");
        const rowName = normalize(el.querySelector(".geek-name")?.innerText || "");
        return rowName === name && rowText === text;
      }) ||
      rows.find((el) => {
        const rowText = normalize(el.innerText || el.textContent || "");
        const rowName = normalize(el.querySelector(".geek-name")?.innerText || "");
        return rowName === name && rowText.includes(text.slice(0, 80));
      });
    if (!match) return { ok: false, reason: "visible row disappeared before click" };
    match.scrollIntoView({ block: "center" });
    const clickTarget =
      match.querySelector(".geek-name") ||
      match.querySelector(".content") ||
      match.querySelector(".info-primary") ||
      match;
    const r = clickTarget.getBoundingClientRect();
    const rowRect = match.getBoundingClientRect();
    return {
      ok: true,
      text: normalize(match.innerText || match.textContent || ""),
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      rowRect: { left: rowRect.left, top: rowRect.top, width: rowRect.width, height: rowRect.height },
    };
  }, row);

  if (!target || !target.ok) return target || { ok: false, reason: "visible row not found" };
  const rect = target.rect && target.rect.width > 0 && target.rect.height > 0 ? target.rect : target.rowRect;
  if (!rect || rect.width <= 0 || rect.height <= 0) return { ...target, ok: false, reason: "visible row has no clickable rect" };

  const x = rect.left + Math.min(Math.max(rect.width / 2, 18), Math.max(rect.width - 8, 18));
  const y = rect.top + rect.height / 2;
  try {
    await page.mouse.move(x, y);
    await sleep(100);
    await page.mouse.click(x, y, { delay: 140 });
  } catch (error) {
    return { ...target, ok: false, reason: `trusted row click failed: ${error.message || error}` };
  }
  const panel = await waitForCandidatePanel(page, row.name);
  return { ...target, panelReady: panel.ready, panelText: panel.text, panelReason: panel.reason };
}

async function readCandidateFromVisibleRow(page, row) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(350);

  const clicked = await clickVisibleRow(page, row);
  if (!clicked || !clicked.ok) {
    return { name: row.name, row, error: clicked ? clicked.reason : "candidate row click failed" };
  }
  await sleep(clicked.panelReady ? 700 : 1600);

  const headerText = await safePageEval(page, () => {
    const box =
      document.querySelector(".base-info-single-container") ||
      document.querySelector(".conversation-main") ||
      document.body;
    return String(box.innerText || box.textContent || "").replace(/\s+/g, " ").trim().slice(0, 3000);
  }).catch(() => "");

  const opened = await openOnlineResume(page);
  if (!opened || !opened.ok) {
    return {
      name: row.name,
      row,
      clickedText: clicked.text,
      panelReady: clicked.panelReady,
      panelReason: clicked.panelReason,
      panelText: clicked.panelText,
      headerText,
      resumeButtonProbe: opened,
      error: opened ? opened.reason : "online resume button not found",
    };
  }

  await sleep(3000);
  const detail = await readWasmResumeDetail(page, row.name);
  const canvasText = await readCanvasText(page, row.name);
  await closeResume(page);
  await sleep(600);

  return {
    name: row.name,
    row,
    clickedText: clicked.text,
    headerText,
    detail: summarizeDetail(detail),
    rawDetail: detail,
    canvasText,
    error: detail || canvasText ? undefined : "online resume opened but no structured/canvas content captured",
  };
}

async function readVisibleRowsSinglePass(page, args, output) {
  const seen = new Set();
  let stagnant = 0;
  await resetListToTop(page);

  for (let step = 0; step < 120 && stagnant < 10; step += 1) {
    const visibleRows = (await getVisibleRows(page, args)) || [];
    let processedThisStep = 0;
    for (const row of visibleRows) {
      if (args.limit > 0 && output.results.length >= args.limit) return;
      if (!row.signature || seen.has(row.signature)) continue;
      seen.add(row.signature);
      output.rows.push(row);
      console.error(`reading visible row: ${row.name}`);
      const result = await readCandidateFromVisibleRow(page, row);
      output.results.push(result);
      fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");
      processedThisStep += 1;
    }

    if (processedThisStep > 0) stagnant = 0;
    else stagnant += 1;

    const scrollState = await scrollCandidateList(page);
    console.error(`single-pass step ${step}: visible ${visibleRows.length}, processed ${processedThisStep}, total ${output.results.length}`);
    if (!scrollState.moved) stagnant += 1;
  }
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
        const clickTarget =
          row.querySelector(".geek-name") ||
          row.querySelector(".content") ||
          row.querySelector(".info-primary") ||
          row;
        const r = clickTarget.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return {
          ok: true,
          text: normalize(row.innerText || row.textContent || ""),
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          rowRect: { left: rowRect.left, top: rowRect.top, width: rowRect.width, height: rowRect.height },
        };
      },
      { targetName: target.name, targetText: target.text, positionText: position }
    );
    if (clicked && clicked.ok) {
      if (clicked.rect && clicked.rect.width > 0 && clicked.rect.height > 0) {
        const x = clicked.rect.left + Math.min(Math.max(clicked.rect.width / 2, 18), Math.max(clicked.rect.width - 8, 18));
        const y = clicked.rect.top + clicked.rect.height / 2;
        try {
          await page.mouse.move(x, y);
          await sleep(80);
          await page.mouse.click(x, y, { delay: 120 });
        } catch (_) {}
      }
      const panel = await waitForCandidatePanel(page, target.name);
      return { ...clicked, panelReady: panel.ready, panelText: panel.text, panelReason: panel.reason };
    }

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

async function waitForCandidatePanel(page, expectedName) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await safePageEval(page, (name) => {
      const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const detailRoots = [
        ".chat-conversation",
        ".conversation-main",
        ".chat-panel",
        ".base-info-single-container",
        ".dialog-container",
        ".boss-chat",
      ];
      const root =
        detailRoots.map((selector) => document.querySelector(selector)).find(Boolean) || document.body;
      const text = normalize(root.innerText || root.textContent || "");
      const hasOnlineResume = [...document.querySelectorAll("a,button,span,div")]
        .some((el) => {
          const content = String(el.innerText || el.textContent || "");
          const cls = String(el.className || "");
          return content.includes("在线简历") || cls.includes("resume-btn-online");
        });
      const activeText = normalize(
        document.querySelector(".geek-item-wrap.active,.geek-item.active,.geek-item-wrap.selected,.geek-item.selected")
          ?.innerText || ""
      );
      return {
        ready: text.includes(name) || activeText.includes(name) || hasOnlineResume,
        text: text.slice(0, 3000),
        hasOnlineResume,
        activeText,
      };
    }, expectedName);

    if (state && state.ready) return state;
    await sleep(350);
  }
  return { ready: false, text: "", reason: "candidate detail panel did not load after click" };
}

async function openOnlineResume(page) {
  const selector = 'a,button,span,div,[role="button"],[class*="resume"],[class*="Resume"]';
  const debugCandidates = [];

  for (const frame of page.frames()) {
    let handles = [];
    try {
      handles = await frame.$$(selector);
    } catch (_) {
      continue;
    }

    const scored = [];
    for (const handle of handles) {
      try {
        const info = await handle.evaluate((el) => {
          const text = String(el.innerText || el.textContent || "").replace(/\s+/g, "");
          const cls = String(el.className || "");
          const title = String(el.getAttribute("title") || "");
          const aria = String(el.getAttribute("aria-label") || "");
          const r = el.getBoundingClientRect();
          const visible = r.width > 12 && r.height > 12 && r.bottom > 0 && r.right > 0;
          const haystack = `${text} ${cls} ${title} ${aria}`.toLowerCase();
          let score = 0;
          if (text.includes("在线简历") || title.includes("在线简历") || aria.includes("在线简历")) score += 100;
          if (text.includes("查看简历") || title.includes("查看简历") || aria.includes("查看简历")) score += 80;
          if (cls.includes("resume-btn-online")) score += 90;
          if (haystack.includes("online") && haystack.includes("resume")) score += 70;
          if (haystack.includes("resume")) score += 30;
          if (text.includes("简历") || title.includes("简历") || aria.includes("简历")) score += 25;
          if (text.includes("附件简历") || title.includes("附件简历") || aria.includes("附件简历")) score -= 15;
          return {
            visible,
            score,
            text: text.slice(0, 80),
            cls: cls.slice(0, 120),
            title,
            aria,
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
          };
        });
        if (info.visible && info.score > 0) {
          scored.push({ handle, info, frameUrl: frame.url() });
          debugCandidates.push({ ...info, frameUrl: frame.url() });
        } else {
          await handle.dispose().catch(() => {});
        }
      } catch (_) {
        await handle.dispose().catch(() => {});
      }
    }

    scored.sort((a, b) => b.info.score - a.info.score);
    const best = scored[0];
    for (const item of scored.slice(1)) await item.handle.dispose().catch(() => {});
    if (!best) continue;

    try {
      await best.handle.hover();
      await sleep(120);
      await best.handle.click({ delay: 120 });
      await best.handle.dispose().catch(() => {});
      return { ok: true, frameUrl: best.frameUrl, button: best.info };
    } catch (error) {
      await best.handle.dispose().catch(() => {});
      return {
        ok: false,
        reason: `online resume candidate found but click failed: ${error.message || error}`,
        candidates: debugCandidates.slice(0, 20),
      };
    }
  }

  return {
    ok: false,
    reason: "online resume button not found",
    candidates: debugCandidates.slice(0, 20),
  };
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
  if (args.stabilize) {
    await stabilizeChatPage(page);
  }
  await patchCanvasTextCapture(page);
  await page.bringToFront();

  const pageInfo = await safePageEval(page, () => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 500),
  }));
  console.error(`connected: ${pageInfo.url}`);

  const output = {
    meta: {
      createdAt: new Date().toISOString(),
      position: args.position,
      browserUrl: args.browserUrl,
      onlyUnread: args.onlyUnread,
      pageUrl: pageInfo.url,
      scannedRows: 0,
      mode: args.scanOnly ? "scan-only" : "single-pass-read-visible-rows",
      bossSideActionsPerformed: 0,
    },
    rows: [],
    results: [],
  };

  fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");
  if (args.scanOnly) {
    const rows = await scanCurrentList(page, args);
    output.rows = rows;
    output.meta.scannedRows = rows.length;
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");
    console.error(`scan complete: ${rows.length} row(s)`);
    await browser.disconnect();
    return;
  }

  await readVisibleRowsSinglePass(page, args, output);
  output.meta.scannedRows = output.rows.length;
  fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2), "utf8");

  await browser.disconnect();
  console.error(`saved: ${path.resolve(args.out)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
