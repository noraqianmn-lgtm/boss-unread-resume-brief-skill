#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");

const RESUME_WASM_URL =
  "https://static.zhipin.com/assets/zhipin/wasm/resume/wasm_canvas-1.0.2-5081.js";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const browserUrl = arg("browser-url", process.env.BOSS_BROWSER_URL || "http://127.0.0.1:53470");
const wsUrlArg = arg("ws", "");
const position = arg("position", "");
const outPath = arg("out", `online_resumes_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`);
const limit = Number(arg("limit", "0"));
const showHelp = process.argv.includes("--help") || process.argv.includes("-h");
const scanOnly = process.argv.includes("--scan-only");
let autoRead = process.argv.includes("--auto-read") || process.argv.includes("--read-current-position");
const currentOpenResume = process.argv.includes("--current-open-resume");
const unsafeAutoClick = process.argv.includes("--unsafe-auto-click");
const appendOutput = process.argv.includes("--append");
const onlyUnread = process.argv.includes("--only-unread");
const sinceDate = arg("since-date", "");
const includeUnknownDate = process.argv.includes("--include-unknown-date");
const autoMethod = arg("auto-method", "hybrid");
const minDelayMs = Number(arg("min-delay-ms", "10000"));
const maxDelayMs = Number(arg("max-delay-ms", "18000"));
const batchPauseEvery = Number(arg("batch-pause-every", "5"));
const batchPauseMs = Number(arg("batch-pause-ms", "90000"));
const throttleCooldownMs = Number(arg("throttle-cooldown-ms", "90000"));
const maxRetries = Number(arg("max-retries", "1"));
const runtimeContexts = new Map();
const framesById = new Map();
const cdpSessions = new Map();
let puppeteerPagePromise = null;
let puppeteerBrowser = null;

function requirePuppeteerCore() {
  try {
    return require("puppeteer-core");
  } catch (firstError) {
    const appData = process.env.APPDATA;
    if (appData) {
      const bossCliNodeModules = path.join(appData, "npm", "node_modules", "@joohw", "boss-cli", "node_modules");
      try {
        return require(path.join(bossCliNodeModules, "puppeteer-core"));
      } catch (_) {}
    }
    throw firstError;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min, max) {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(lo, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

async function politeDelay(reason, min = minDelayMs, max = maxDelayMs) {
  const delay = jitter(min, max);
  console.error(`${reason}; waiting ${Math.round(delay / 1000)}s`);
  await sleep(delay);
}

function js(value) {
  return JSON.stringify(String(value ?? ""));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function resolveWsUrl() {
  if (wsUrlArg) return wsUrlArg;
  const pages = await fetchJson(`${browserUrl.replace(/\/$/, "")}/json`);
  const page =
    pages.find((p) => String(p.url || "").includes("/web/chat/index")) ||
    pages.find((p) => String(p.url || "").includes("zhipin.com") && !String(p.url || "").includes("login")) ||
    pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error(`No debuggable BOSS page found at ${browserUrl}`);
  }
  return page.webSocketDebuggerUrl;
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const key = `${msg.sessionId || ""}:${msg.id || ""}`;
    const p = pending.get(key);
    if (!p) {
      handleCdpEvent(msg);
      return;
    }
    pending.delete(key);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg);
  };
  const send = (method, params = {}, sessionId = "") =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(`${sessionId || ""}:${mid}`, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, send });
    ws.onerror = () => reject(new Error("websocket error"));
  });
}

function handleCdpEvent(msg) {
  if (msg.method === "Target.attachedToTarget") {
    const sessionId = msg.params && msg.params.sessionId;
    const targetInfo = msg.params && msg.params.targetInfo;
    if (sessionId) cdpSessions.set(sessionId, targetInfo || {});
  } else if (msg.method === "Target.detachedFromTarget") {
    if (msg.params && msg.params.sessionId) cdpSessions.delete(msg.params.sessionId);
  } else if (msg.method === "Target.targetInfoChanged") {
    for (const [sessionId, info] of cdpSessions.entries()) {
      if (info && info.targetId === msg.params.targetInfo.targetId) cdpSessions.set(sessionId, msg.params.targetInfo);
    }
  } else if (msg.method === "Runtime.executionContextCreated") {
    const context = msg.params && msg.params.context;
    if (context && context.id) runtimeContexts.set(`${msg.sessionId || ""}:${context.id}`, { ...context, sessionId: msg.sessionId || "" });
  } else if (msg.method === "Runtime.executionContextDestroyed") {
    runtimeContexts.delete(`${msg.sessionId || ""}:${msg.params.executionContextId}`);
  } else if (msg.method === "Runtime.executionContextsCleared") {
    for (const key of [...runtimeContexts.keys()]) {
      if (key.startsWith(`${msg.sessionId || ""}:`)) runtimeContexts.delete(key);
    }
  } else if (msg.method === "Page.frameNavigated") {
    const frame = msg.params && msg.params.frame;
    if (frame && frame.id) framesById.set(frame.id, frame);
  }
}

async function evalExpr(send, expression, options = {}) {
  const msg = await send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(options.contextId ? { contextId: options.contextId } : {}),
    },
    options.sessionId || ""
  );
  return msg.result.result.value;
}

async function pressKey(send, key) {
  const map = {
    Enter: { windowsVirtualKeyCode: 13, code: "Enter", key: "Enter" },
    Escape: { windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" },
    Space: { windowsVirtualKeyCode: 32, code: "Space", key: " " },
  };
  const data = map[key];
  if (!data) throw new Error(`Unsupported key: ${key}`);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...data }).catch(() => {});
  await sleep(80);
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...data }).catch(() => {});
}

async function enablePageIntrospection(send) {
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }).catch(() => {});
  await send("Runtime.enable").catch(() => {});
  await send("Page.enable").catch(() => {});
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        window.__bossResumeTexts = window.__bossResumeTexts || [];
        const patch = () => {
          try {
            const proto = CanvasRenderingContext2D.prototype;
            if (proto.__bossBriefFillTextPatched) return;
            proto.__bossBriefFillTextPatched = true;
            const oldFillText = proto.fillText;
            proto.fillText = function patchedFillText(text, ...rest) {
              try { window.__bossResumeTexts.push(String(text)); } catch (_) {}
              return oldFillText.call(this, text, ...rest);
            };
          } catch (_) {}
        };
        patch();
      })();
    `,
  }).catch(() => {});
}

async function refreshFrameTree(send) {
  const tree = await send("Page.getFrameTree").catch(() => null);
  const visit = (node) => {
    if (!node || !node.frame) return;
    framesById.set(node.frame.id, node.frame);
    for (const child of node.childFrames || []) visit(child);
  };
  if (tree && tree.result && tree.result.frameTree) visit(tree.result.frameTree);
}

function resumeContextReaders() {
  const readers = [];
  for (const context of runtimeContexts.values()) {
    const frameId = context.auxData && context.auxData.frameId;
    const frame = frameId ? framesById.get(frameId) : null;
    const url = String((frame && frame.url) || context.origin || context.name || "");
    if (url.includes("/web/frame/c-resume/")) readers.push({ contextId: context.id, sessionId: context.sessionId || "", url });
  }
  return readers;
}

function resumeContextIds() {
  return resumeContextReaders().map((reader) => reader.contextId);
}

function resumeFrameIds() {
  const ids = [];
  for (const frame of framesById.values()) {
    if (String(frame.url || "").includes("/web/frame/c-resume/")) ids.push(frame.id);
  }
  return ids;
}

function resumeSessionReaders() {
  const readers = [];
  for (const [sessionId, info] of cdpSessions.entries()) {
    const url = String((info && info.url) || "");
    if (url.includes("/web/frame/c-resume/")) readers.push({ sessionId, url });
  }
  return readers;
}

async function ensureResumeReaders(send) {
  await refreshFrameTree(send);
  const existing = resumeContextReaders();
  if (existing.length > 0) return existing;
  const sessionReaders = resumeSessionReaders();
  for (const reader of sessionReaders) {
    await send("Runtime.enable", {}, reader.sessionId).catch(() => {});
  }
  if (sessionReaders.length > 0) return sessionReaders;
  const created = [];
  for (const frameId of resumeFrameIds()) {
    try {
      const msg = await send("Page.createIsolatedWorld", {
        frameId,
        worldName: "bossBriefResumeReader",
        grantUniveralAccess: true,
      });
      const contextId = msg && msg.result && msg.result.executionContextId;
      if (contextId) created.push({ contextId, sessionId: "", frameId });
    } catch (_) {}
  }
  return [...existing, ...created];
}

async function ensureResumeContextIds(send) {
  return (await ensureResumeReaders(send)).map((reader) => reader.contextId).filter(Boolean);
}

async function waitForResumeFrame(send, timeoutMs = 5000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    await refreshFrameTree(send);
    const ids = resumeContextIds();
    const sessions = resumeSessionReaders();
    last = [...framesById.values()]
      .map((frame) => frame.url || "")
      .filter((url) => url.includes("/web/frame/c-resume/"));
    if (ids.length > 0 || sessions.length > 0 || last.length > 0) {
      const readers = ids.length > 0 || sessions.length > 0 ? [...resumeContextReaders(), ...sessions] : await ensureResumeReaders(send);
      return {
        ok: true,
        contextIds: readers.map((reader) => reader.contextId).filter(Boolean),
        sessionIds: readers.map((reader) => reader.sessionId).filter(Boolean),
        urls: [...new Set([...last, ...readers.map((reader) => reader.url).filter(Boolean)])],
        frameIds: resumeFrameIds(),
      };
    }
    await sleep(300);
  }
  return { ok: false, contextIds: [], urls: last };
}

async function getPageState(send) {
  return evalExpr(send, `(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 800)
  }))()`);
}

async function getThrottleState(send) {
  return evalExpr(send, `(() => {
    const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const text = normalize(document.body.innerText || '');
    const patterns = [
      '操作过于频繁',
      '操作频繁',
      '访问过于频繁',
      '请求过于频繁',
      '请稍后再试',
      '稍后再试',
      '安全验证',
      '风险验证',
      '验证',
      '加载中'
    ];
    const matched = patterns.filter((item) => text.includes(item));
    return { throttled: matched.length > 0, matched, text: text.slice(0, 1200) };
  })()`);
}

async function getVisibleRows(send) {
  return evalExpr(send, `(() => {
    const position = ${js(position)};
    const onlyUnread = ${JSON.stringify(onlyUnread)};
    const sinceDate = ${js(sinceDate)};
    const includeUnknownDate = ${JSON.stringify(includeUnknownDate)};
    const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const parseSince = (value) => {
      if (!value) return null;
      const m = String(value).match(/^(20\\d{2})[-/.](\\d{1,2})[-/.](\\d{1,2})$/);
      if (!m) return null;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    };
    const sinceTs = parseSince(sinceDate);
    const parseRowDate = (text) => {
      const now = new Date();
      const today = dayStart(now);
      if (/刚刚|今天/.test(text)) return { text: 'today', timestamp: today };
      if (/昨天/.test(text)) return { text: 'yesterday', timestamp: today - 86400000 };
      let m = text.match(/(20\\d{2})[.\\/-](\\d{1,2})[.\\/-](\\d{1,2})/);
      if (m) return {
        text: m[0],
        timestamp: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      };
      m = text.match(/(^|[^\\d])(\\d{1,2})[.\\/-](\\d{1,2})(?=\\s|$|[^\\d])/);
      if (m) return {
        text: m[0].trim(),
        timestamp: new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[3])).getTime()
      };
      return { text: '', timestamp: null };
    };
    return [...document.querySelectorAll('.geek-item-wrap,.geek-item')]
      .map((row, index) => {
        const text = normalize(row.innerText || row.textContent || '');
        const name = normalize(row.querySelector('.geek-name')?.innerText || '');
        const unreadHint = Boolean(
          row.querySelector('.unread,.badge,.badge-num,.message-count,.red-dot') ||
          /未读|new/i.test(text)
        );
        const date = parseRowDate(text);
        const r = row.getBoundingClientRect();
        return {
          index,
          name,
          text,
          signature: name + '|' + text,
          unreadHint,
          dateText: date.text,
          dateTimestamp: date.timestamp,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height }
        };
      })
      .filter((row) => row.name)
      .filter((row) => row.rect.width > 30 && row.rect.height > 20)
      .filter((row) => !position || row.text.includes(position))
      .filter((row) => !onlyUnread || row.unreadHint)
      .filter((row) => {
        if (!sinceTs) return true;
        if (row.dateTimestamp === null) return includeUnknownDate;
        return row.dateTimestamp >= sinceTs;
      });
  })()`);
}

async function getCurrentCandidateName(send) {
  return evalExpr(send, `(() => {
    const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const selectors = [
      '.geek-item.active .geek-name',
      '.geek-item-wrap.active .geek-name',
      '.geek-item.selected .geek-name',
      '.geek-item-wrap.selected .geek-name',
      '.chat-info .geek-name',
      '.boss-chat-card .geek-name',
      '.geek-name'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = normalize(el && el.innerText);
      if (text) return text;
    }
    return '';
  })()`);
}

function candidateListHelperSource() {
  return `
    const findCandidateList = () => {
      const rows = [...document.querySelectorAll('.geek-item-wrap,.geek-item')];
      const firstRow = rows.find((row) => {
        const r = row.getBoundingClientRect();
        return r.width > 30 && r.height > 20;
      });
      let el = firstRow;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        const scrollable = /(auto|scroll|overlay)/.test(style.overflowY || '') || el.scrollHeight > el.clientHeight + 20;
        if (scrollable && el.scrollHeight > el.clientHeight + 20) return el;
        el = el.parentElement;
      }
      return document.querySelector('.user-list.b-scroll-stable') ||
        document.querySelector('.user-list') ||
        document.querySelector('[class*="user-list"]') ||
        document.scrollingElement;
    };
  `;
}

function rightPanelHelperSource() {
  return `
    const findDetailRoot = () => {
      const normalizePanelText = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const selectors = [
        '.base-info-single-container',
        '.conversation-main',
        '.conversation-box',
        '.chat-conversation',
        '[class*="conversation-main"]',
        '[class*="base-info"]'
      ];
      const good = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const text = normalizePanelText(el.innerText || el.textContent || '');
        return r.left > 480 && r.width > 220 && r.height > 60 &&
          /在线简历|查看简历|附件简历|沟通职位|期望|牛人分析/.test(text);
      };
      for (const selector of selectors) {
        const found = [...document.querySelectorAll(selector)].filter(good)
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (ar.width * ar.height) - (br.width * br.height);
          })[0];
        if (found) return found;
      }
      return [...document.querySelectorAll('div,section,main,aside')]
        .filter(good)
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.width * ar.height) - (br.width * br.height);
        })[0] || null;
    };
  `;
}

async function focusRowForKeyboard(send, row) {
  return evalExpr(send, `(() => {
    const signature = ${js(row.signature)};
    const name = ${js(row.name)};
    const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('.geek-item-wrap,.geek-item')];
    const target = rows.find((el) => {
      const rowName = normalize(el.querySelector('.geek-name')?.innerText || '');
      const text = normalize(el.innerText || el.textContent || '');
      return rowName + '|' + text === signature;
    }) || rows.find((el) => {
      const rowName = normalize(el.querySelector('.geek-name')?.innerText || '');
      const text = normalize(el.innerText || el.textContent || '');
      return rowName === name && text.includes(${js((row.text || "").slice(0, 80))});
    });
    if (!target) return { ok: false, reason: 'visible row disappeared before keyboard focus' };
    target.scrollIntoView({ block: 'center' });
    const focusTarget = target.querySelector('a,button,[tabindex],.geek-name,.content') || target;
    if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
    focusTarget.focus({ preventScroll: true });
    return {
      ok: document.activeElement === focusTarget || target.contains(document.activeElement),
      text: normalize(target.innerText || target.textContent || ''),
      activeTag: document.activeElement && document.activeElement.tagName,
      activeClass: String(document.activeElement && document.activeElement.className || '').slice(0, 120)
    };
  })()`);
}

async function selectRowKeyboard(send, row) {
  const focused = await focusRowForKeyboard(send, row);
  if (!focused.ok) return focused;
  await pressKey(send, "Enter");
  await sleep(700);
  let panel = await waitForPanel(send, row.name);
  if (!panel.ready) {
    await pressKey(send, "Space");
    await sleep(700);
    panel = await waitForPanel(send, row.name);
  }
  return { ...focused, panel };
}

async function selectRowHybrid(send, row) {
  const keyboard = await selectRowKeyboard(send, row);
  if (keyboard.ok && keyboard.panel && keyboard.panel.ready) {
    return { ...keyboard, selectMethod: "keyboard", attempts: [keyboard] };
  }
  const dom = await dispatchRowClick(send, row);
  if (!dom.ok) {
    return {
      ok: false,
      reason: dom.reason || keyboard.reason || "candidate row activation failed",
      attempts: [keyboard, dom],
    };
  }
  await sleep(1200);
  const panel = await waitForPanel(send, row.name);
  return {
    ok: panel.ready,
    text: dom.text,
    panel,
    selectMethod: "dom-row-activation",
    attempts: [keyboard, dom],
    reason: panel.ready ? undefined : (panel.reason || "candidate detail panel did not load after DOM row activation"),
  };
}

async function dispatchRowClick(send, row) {
  return evalExpr(send, `(() => {
    const signature = ${js(row.signature)};
    const name = ${js(row.name)};
    const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('.geek-item-wrap,.geek-item')];
    const target = rows.find((el) => {
      const rowName = normalize(el.querySelector('.geek-name')?.innerText || '');
      const text = normalize(el.innerText || el.textContent || '');
      return rowName + '|' + text === signature;
    }) || rows.find((el) => {
      const rowName = normalize(el.querySelector('.geek-name')?.innerText || '');
      const text = normalize(el.innerText || el.textContent || '');
      return rowName === name && text.includes(${js((row.text || "").slice(0, 80))});
    });
    if (!target) return { ok: false, reason: 'visible row disappeared before DOM click' };
    target.scrollIntoView({ block: 'center' });
    const clickTarget = target.querySelector('.geek-name') || target.querySelector('.content') || target;
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      clickTarget.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    if (typeof clickTarget.click === 'function') clickTarget.click();
    return { ok: true, text: normalize(target.innerText || target.textContent || '') };
  })()`);
}

async function waitForPanel(send, name) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const state = await evalExpr(send, `(() => {
      const name = ${js(name)};
      const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      ${rightPanelHelperSource()}
      const root = findDetailRoot();
      const text = normalize((root || document.body).innerText || (root || document.body).textContent || '');
      const hasResume = root && [...root.querySelectorAll('a,button,span,div,[role="button"],[class*="resume"],[class*="Resume"]')]
        .some((el) => {
          const content = String(el.innerText || el.textContent || '').replace(/\\s+/g, '');
          const cls = String(el.className || '');
          const title = String(el.getAttribute('title') || '');
          const aria = String(el.getAttribute('aria-label') || '');
          return content.includes('在线简历') || content.includes('查看简历') ||
            title.includes('在线简历') || aria.includes('在线简历') ||
            cls.includes('resume-btn-online') ||
            (cls.toLowerCase().includes('resume') && !content.includes('附件简历'));
        });
      return {
        ready: Boolean(root) && (!name || text.includes(name)),
        hasResume: Boolean(hasResume),
        hasRoot: Boolean(root),
        rootClass: root ? String(root.className || '').slice(0, 120) : '',
        expectedName: name,
        matchedName: !name || text.includes(name),
        text: text.slice(0, 3000)
      };
    })()`);
    if (state.ready) return state;
    await sleep(350);
  }
  return { ready: false, text: "", reason: "candidate detail panel did not load" };
}

function resumeButtonProbeSource() {
  return `
    ${rightPanelHelperSource()}
    const collectAttrs = (el) => {
      const attrs = {};
      for (const attr of el.attributes || []) attrs[attr.name] = attr.value;
      return attrs;
    };
    const scoreResumeButton = (el) => {
      const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, '');
      const cls = String(el.className || '');
      const title = String(el.getAttribute('title') || '');
      const aria = String(el.getAttribute('aria-label') || '');
      const href = String(el.getAttribute('href') || '');
      const dataset = Object.values(el.dataset || {}).join(' ');
      const attrs = Object.values(collectAttrs(el)).join(' ');
      const r = el.getBoundingClientRect();
      const textLen = text.length;
      const visible = r.width > 12 && r.height > 12 && r.width <= 180 && r.height <= 56 &&
        r.left > 480 && r.top > 90 && r.bottom > 0 && r.right > 0 && textLen <= 24;
      const haystack = (text + ' ' + cls + ' ' + title + ' ' + aria + ' ' + href + ' ' + dataset + ' ' + attrs).toLowerCase();
      let score = 0;
      if (text.includes('在线简历') || title.includes('在线简历') || aria.includes('在线简历')) score += 100;
      if (text.includes('查看简历') || title.includes('查看简历') || aria.includes('查看简历')) score += 80;
      if (cls.includes('resume-btn-online')) score += 90;
      if (haystack.includes('c-resume')) score += 90;
      if (haystack.includes('online') && haystack.includes('resume')) score += 70;
      if (haystack.includes('resume')) score += 30;
      if (text.includes('简历') || title.includes('简历') || aria.includes('简历')) score += 25;
      if (text.includes('附件简历') || title.includes('附件简历') || aria.includes('附件简历')) score -= 200;
      if (text.includes('已获取简历') || title.includes('已获取简历') || aria.includes('已获取简历')) score -= 200;
      if (/wrap-v2|chat-label|chat-container|page-content|user-list|geek-item|filter/.test(haystack)) score -= 200;
      return { el, visible, score, text: text.slice(0, 80), cls: cls.slice(0, 120), title, aria, href, attrs: collectAttrs(el) };
    };
    const findResumeButtons = () => {
      const root = findDetailRoot();
      const scope = root || document;
      return [...scope.querySelectorAll('a,button,span,div,[role="button"],[class*="resume"],[class*="Resume"]')]
      .map(scoreResumeButton)
      .filter((item) => item.visible && item.score > 0)
      .sort((a, b) => b.score - a.score);
    };
  `;
}

async function focusOnlineResumeButton(send) {
  return evalExpr(send, `(() => {
    ${resumeButtonProbeSource()}
    const candidates = findResumeButtons();
    const best = candidates[0];
    if (!best) return { ok: false, reason: 'online resume button not found', candidates: candidates.slice(0, 20).map(({el, ...rest}) => rest) };
    best.el.scrollIntoView({ block: 'center' });
    if (!best.el.hasAttribute('tabindex')) best.el.setAttribute('tabindex', '0');
    best.el.focus({ preventScroll: true });
    return {
      ok: document.activeElement === best.el || best.el.contains(document.activeElement),
      button: { score: best.score, text: best.text, cls: best.cls, title: best.title, aria: best.aria, href: best.href, attrs: best.attrs }
    };
  })()`);
}

async function openOnlineResumeKeyboard(send) {
  const focused = await focusOnlineResumeButton(send);
  if (!focused.ok) return focused;
  await pressKey(send, "Enter");
  const enterFrame = await waitForResumeFrame(send, 2500);
  if (enterFrame.ok) return { ok: true, method: "keyboard-enter", button: focused.button, frame: enterFrame };
  await pressKey(send, "Space");
  const spaceFrame = await waitForResumeFrame(send, 2500);
  return {
    ok: spaceFrame.ok,
    method: "keyboard-enter-space",
    button: focused.button,
    frame: spaceFrame,
    reason: spaceFrame.ok ? undefined : "online resume iframe did not appear after keyboard activation",
  };
}

async function openOnlineResume(send) {
  return evalExpr(send, `(() => {
    ${resumeButtonProbeSource()}
    const candidates = findResumeButtons();
    const best = candidates[0];
    if (!best) return { ok: false, reason: 'online resume button not found', candidates: candidates.slice(0, 20).map(({el, ...rest}) => rest) };
    best.el.scrollIntoView({ block: 'center' });
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      best.el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    if (typeof best.el.click === 'function') best.el.click();
    return { ok: true, method: 'dom-events-click', button: { score: best.score, text: best.text, cls: best.cls, title: best.title, aria: best.aria, href: best.href, attrs: best.attrs } };
  })()`);
}

async function openOnlineResumeFromDiscoveredUrl(send) {
  return evalExpr(send, `(() => {
    ${resumeButtonProbeSource()}
    const candidates = findResumeButtons();
    const urls = [];
    const add = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return;
      const decoded = raw.replace(/&amp;/g, '&');
      for (const item of [raw, decoded]) {
        if (item.includes('/web/frame/c-resume/') || item.includes('c-resume')) {
          try { urls.push(new URL(item, location.origin).href); } catch (_) {}
        }
      }
    };
    for (const item of candidates) {
      add(item.href);
      for (const value of Object.values(item.attrs || {})) add(value);
    }
    const url = [...new Set(urls)][0];
    if (!url) return { ok: false, reason: 'no c-resume url found in online resume button attributes', candidates: candidates.slice(0, 10).map(({el, ...rest}) => rest) };
    let iframe = document.querySelector('iframe[data-boss-brief-resume-frame="1"]');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.setAttribute('data-boss-brief-resume-frame', '1');
      iframe.style.cssText = 'position:fixed;inset:24px;z-index:2147483647;width:calc(100vw - 48px);height:calc(100vh - 48px);background:#fff;border:1px solid #ddd;';
      document.body.appendChild(iframe);
    }
    iframe.src = url;
    return { ok: true, method: 'direct-c-resume-iframe', url };
  })()`);
}

async function openOnlineResumeHybrid(send) {
  const attempts = [];
  const keyboard = await openOnlineResumeKeyboard(send);
  attempts.push(keyboard);
  if (keyboard.ok) return { ...keyboard, attempts };

  const dom = await openOnlineResume(send);
  attempts.push(dom);
  if (dom.ok) {
    const domFrame = await waitForResumeFrame(send, 5000);
    if (domFrame.ok) return { ...dom, ok: true, frame: domFrame, attempts };
    dom.frame = domFrame;
    dom.ok = false;
    dom.reason = dom.reason || "DOM activation did not create online resume iframe";
  }

  const direct = await openOnlineResumeFromDiscoveredUrl(send);
  attempts.push(direct);
  if (direct.ok) {
    const directFrame = await waitForResumeFrame(send, 6000);
    if (directFrame.ok) return { ...direct, ok: true, frame: directFrame, attempts };
    direct.frame = directFrame;
    direct.ok = false;
    direct.reason = direct.reason || "direct c-resume iframe did not become readable";
  }

  return {
    ok: false,
    method: "hybrid",
    attempts,
    reason: attempts.map((item) => item && item.reason).filter(Boolean).join("; ") || "online resume iframe did not appear",
  };
}

async function getPuppeteerPage() {
  if (!puppeteerPagePromise) {
    puppeteerPagePromise = (async () => {
      const puppeteer = requirePuppeteerCore();
      const browser = await puppeteer.connect({ browserURL: browserUrl });
      puppeteerBrowser = browser;
      const pages = await browser.pages();
      return pages.find((page) => page.url().includes("/web/chat/index")) ||
        pages.find((page) => page.url().includes("zhipin.com")) ||
        pages[0];
    })();
  }
  return puppeteerPagePromise;
}

async function closePuppeteer() {
  if (!puppeteerBrowser) return;
  try {
    await puppeteerBrowser.disconnect();
  } catch (_) {}
  puppeteerBrowser = null;
  puppeteerPagePromise = null;
}

async function closeConnections(ws) {
  await closePuppeteer();
  try {
    if (ws) ws.close();
  } catch (_) {}
}

async function readWasmResumeDetailWithPuppeteer(expectedName) {
  let fallback = null;
  try {
    const page = await getPuppeteerPage();
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
  } catch (_) {}
  return fallback;
}

async function readCanvasTextWithPuppeteer(expectedName) {
  try {
    const page = await getPuppeteerPage();
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
  } catch (_) {
    return "";
  }
}

async function readResumeText(send, name) {
  return evalExpr(send, `(() => {
    const name = ${js(name)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 50 && r.height > 30 && r.left >= 250 && r.top >= 0;
    };
    const all = [...document.querySelectorAll('body *')]
      .filter(visible)
      .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return all.find((text) => text.includes(name)) || all[0] || '';
  })()`);
}

async function readWasmResumeDetail(send, name) {
  let fallback = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const readers = await ensureResumeReaders(send);
    for (const reader of readers) {
      try {
        const detail = await evalExpr(
          send,
          `import(${js(RESUME_WASM_URL)}).then((mod) => mod.get_export_geek_detail_info()).catch(() => null)`,
          { contextId: reader.contextId, sessionId: reader.sessionId }
        );
        if (detail && detail.geekBaseInfo && detail.geekBaseInfo.name === name) return detail;
        if (detail && detail.geekBaseInfo && !fallback) fallback = detail;
      } catch (_) {}
    }
    await sleep(500);
  }
  return fallback || await readWasmResumeDetailWithPuppeteer(name);
}

async function readCanvasText(send, name) {
  let fallback = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const readers = await ensureResumeReaders(send);
    for (const reader of readers) {
      try {
        await evalExpr(
          send,
          `(() => {
            const h = document.body.scrollHeight || document.documentElement.scrollHeight || 4000;
            window.scrollTo(0, Math.min(h, ${attempt * 700}));
            return true;
          })()`,
          { contextId: reader.contextId, sessionId: reader.sessionId }
        );
        await sleep(180);
        const text = await evalExpr(send, `(() => (window.__bossResumeTexts || []).join(''))()`, {
          contextId: reader.contextId,
          sessionId: reader.sessionId,
        });
        if (text && !fallback) fallback = text;
        if (text && text.includes(name)) return text;
      } catch (_) {}
    }
    await sleep(400);
  }
  return fallback || await readCanvasTextWithPuppeteer(name);
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

function isResumeReadWeak(result) {
  if (!result.opened) return true;
  if (result.rawDetail || result.canvasText) return false;
  const text = String(result.resumeText || "");
  if (text.length < 80) return true;
  if (/牛人分析器|牛人分析|人才分析|沟通分析/.test(text) && !/工作经历|项目经历|教育经历|个人优势/.test(text)) return true;
  return /操作过于频繁|操作频繁|访问过于频繁|请求过于频繁|稍后再试|安全验证|风险验证|加载中|浏览太频繁/.test(text);
}

async function closeModal(send) {
  await evalExpr(send, `(() => {
    const close = [...document.querySelectorAll('i,span,button,div')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').trim();
        return r.width <= 80 && r.height <= 80 && r.top < 140 && r.left > window.innerWidth * 0.45 &&
          (text === '×' || text.toLowerCase() === 'x' || String(el.className || '').includes('close'));
      })[0];
    if (close) {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        close.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    return false;
  })()`);
}

async function closeModalKeyboard(send) {
  await pressKey(send, "Escape").catch(() => {});
  await sleep(500);
  await evalExpr(send, `(() => {
    const injected = document.querySelector('iframe[data-boss-brief-resume-frame="1"]');
    if (injected) injected.remove();
    return true;
  })()`).catch(() => {});
}

async function scrollList(send) {
  return evalExpr(send, `(() => {
    ${candidateListHelperSource()}
    const list = findCandidateList();
    if (!list) return { moved: false, reason: 'candidate list not found' };
    const before = list.scrollTop;
    list.scrollTop += Math.max(480, Math.floor((list.clientHeight || 700) * 0.75));
    return { moved: list.scrollTop !== before, top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight };
  })()`);
}

async function readOneCandidateKeyboard(send, row, attempt) {
  if (attempt > 0) {
    await politeDelay(`retrying ${row.name}, attempt ${attempt + 1}`, throttleCooldownMs, throttleCooldownMs + 30000);
  }

  const selected = autoMethod === "hybrid" ? await selectRowHybrid(send, row) : await selectRowKeyboard(send, row);
  if (!selected.ok) {
    return { name: row.name, row, attempt, error: selected.reason || "keyboard row focus failed", focusProbe: selected };
  }
  const panel = selected.panel || { ready: false, text: "" };
  if (!panel.ready) {
    return {
      name: row.name,
      row,
      attempt,
      clickedText: selected.text,
      panelReady: false,
      profile: panel.text || "",
      error: panel.reason || "candidate detail panel did not load after keyboard selection",
      focusProbe: selected,
    };
  }

  const profile = panel.text || "";
  const beforeOpenThrottle = await getThrottleState(send);
  if (beforeOpenThrottle.throttled) {
    return {
      name: row.name,
      row,
      attempt,
      clickedText: selected.text,
      panelReady: panel.ready,
      profile,
      throttle: beforeOpenThrottle,
      error: "possible BOSS throttling before opening online resume",
    };
  }

  const opened = autoMethod === "hybrid" ? await openOnlineResumeHybrid(send) : await openOnlineResumeKeyboard(send);
  await sleep(opened.ok ? 3200 : 800);
  const afterOpenThrottle = await getThrottleState(send);
  const rawDetail = opened.ok ? await readWasmResumeDetail(send, row.name) : null;
  const canvasText = opened.ok ? await readCanvasText(send, row.name) : "";
  const resumeText = opened.ok ? await readResumeText(send, row.name) : "";
  const source = rawDetail || canvasText ? "online-resume" : "panel-or-fallback";

  return {
    name: row.name,
    row,
    attempt,
    clickedText: selected.text,
    panelReady: panel.ready,
    profile,
    opened: opened.ok,
    source,
    selectMethod: selected.selectMethod || "keyboard",
    selectAttempts: selected.attempts,
    detail: summarizeDetail(rawDetail),
    rawDetail,
    canvasText,
    headerText: profile,
    resumeText,
    modalText: resumeText,
    throttle: afterOpenThrottle.throttled ? afterOpenThrottle : undefined,
    resumeButtonProbe: opened.ok ? undefined : opened,
    openMethod: opened.method,
    openAttempts: opened.attempts,
    error: opened.ok && source === "online-resume" ? undefined : (opened.ok ? "online resume did not yield structured/canvas content" : opened.reason),
  };
}

async function readOneCandidate(send, row, attempt) {
  if (attempt > 0) {
    await politeDelay(`retrying ${row.name}, attempt ${attempt + 1}`, throttleCooldownMs, throttleCooldownMs + 30000);
  }

  const clicked = await dispatchRowClick(send, row);
  if (!clicked.ok) {
    return { name: row.name, row, attempt, error: clicked.reason || "DOM row click failed" };
  }
  await sleep(1200);

  const panel = await waitForPanel(send, row.name);
  const profile = panel.text || "";
  const beforeOpenThrottle = await getThrottleState(send);
  if (beforeOpenThrottle.throttled) {
    return {
      name: row.name,
      row,
      attempt,
      clickedText: clicked.text,
      panelReady: panel.ready,
      profile,
      throttle: beforeOpenThrottle,
      error: "possible BOSS throttling before opening online resume",
    };
  }

  const opened = await openOnlineResume(send);
  await sleep(opened.ok ? 3500 : 800);
  const afterOpenThrottle = await getThrottleState(send);
  const rawDetail = opened.ok ? await readWasmResumeDetail(send, row.name) : null;
  const canvasText = opened.ok ? await readCanvasText(send, row.name) : "";
  const resumeText = opened.ok ? await readResumeText(send, row.name) : "";
  const source = rawDetail || canvasText ? "online-resume" : "panel-or-fallback";

  return {
    name: row.name,
    row,
    attempt,
    clickedText: clicked.text,
    panelReady: panel.ready,
    profile,
    opened: opened.ok,
    source,
    detail: summarizeDetail(rawDetail),
    rawDetail,
    canvasText,
    headerText: profile,
    resumeText,
    modalText: resumeText,
    throttle: afterOpenThrottle.throttled ? afterOpenThrottle : undefined,
    resumeButtonProbe: opened.ok ? undefined : opened,
    openMethod: opened.method,
    error: opened.ok && source === "online-resume" ? undefined : (opened.ok ? "online resume did not yield structured/canvas content" : opened.reason),
  };
}

async function readCurrentOpenResume(send) {
  await refreshFrameTree(send);
  const rawDetail = await readWasmResumeDetail(send, "");
  const detailName = rawDetail && rawDetail.geekBaseInfo && rawDetail.geekBaseInfo.name;
  const domName = await getCurrentCandidateName(send);
  const name = detailName || domName || "current-open-resume";
  const canvasText = await readCanvasText(send, name === "current-open-resume" ? "" : name);
  const headerText = await readResumeText(send, name === "current-open-resume" ? "" : name);
  const throttle = await getThrottleState(send);
  const source = rawDetail || canvasText ? "online-resume" : "panel-or-fallback";
  return {
    name,
    row: null,
    attempt: 0,
    clickedText: "",
    panelReady: Boolean(headerText || rawDetail || canvasText),
    profile: headerText,
    opened: Boolean(rawDetail || canvasText || headerText),
    source,
    detail: summarizeDetail(rawDetail),
    rawDetail,
    canvasText,
    headerText,
    resumeText: headerText,
    modalText: headerText,
    throttle: throttle.throttled ? throttle : undefined,
    error: source === "online-resume" ? undefined : "current open resume did not yield structured/canvas content",
  };
}

function readExistingOutput(file) {
  if (!appendOutput || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.rows) && Array.isArray(parsed.results)) return parsed;
  } catch (_) {}
  return null;
}

async function main() {
  if (showHelp) {
    console.error(`Usage:
  Auto-read current position candidates with hybrid online-resume opening:
    node read-current-chat-online-resumes-cdp.js --position "<position>" --out online_resumes.json

  Auto-read only unread greetings:
    node read-current-chat-online-resumes-cdp.js --position "<position>" --only-unread --out online_resumes.json

  Auto-read greetings since a date:
    node read-current-chat-online-resumes-cdp.js --position "<position>" --since-date YYYY-MM-DD --out online_resumes.json

  Safe list scan:
    node read-current-chat-online-resumes-cdp.js --position "<position>" --scan-only --out online_resumes.json

  Fallback read after the user manually opens "在线简历":
    node read-current-chat-online-resumes-cdp.js --current-open-resume --append --out online_resumes.json

  Legacy DOM-click debug only, may trigger BOSS refresh:
    node read-current-chat-online-resumes-cdp.js --position "<position>" --auto-method dom --limit 3 --out dom_click_test.json`);
    return;
  }

  if (!scanOnly && !currentOpenResume && !unsafeAutoClick && !autoRead) autoRead = true;
  if (!["hybrid", "keyboard", "dom"].includes(autoMethod)) {
    throw new Error("--auto-method must be hybrid, keyboard, or dom");
  }

  const wsUrl = await resolveWsUrl();
  const { ws, send } = await connect(wsUrl);
  await enablePageIntrospection(send);
  const state = await getPageState(send);
  if (state.url.includes("/web/chat/recommend")) {
    throw new Error("BOSS is on /web/chat/recommend. Manually switch back to the target position unread list, then rerun.");
  }
  console.error(`connected: ${state.url}`);

  const resolvedOut = path.resolve(outPath);
  const output = readExistingOutput(resolvedOut) || {
    meta: {
      createdAt: new Date().toISOString(),
      position,
      browserUrl,
      pageUrl: state.url,
      mode: currentOpenResume
        ? "current-open-resume-no-clicks"
        : scanOnly
          ? "scan-only-no-clicks"
          : autoRead
            ? `auto-read-${autoMethod}`
          : unsafeAutoClick
            ? "unsafe-auto-click-legacy"
            : "blocked-no-clicks",
      filter: {
        onlyUnread,
        sinceDate,
        includeUnknownDate,
      },
      bossSideActionsPerformed: 0,
    },
    rows: [],
    results: [],
  };
  fs.writeFileSync(resolvedOut, JSON.stringify(output, null, 2), "utf8");

  if (scanOnly) {
    const seenRows = new Set(output.rows.map((row) => row.signature).filter(Boolean));
    let stagnant = 0;
    for (let step = 0; step < 80 && stagnant < 8; step += 1) {
      const rows = (await getVisibleRows(send)) || [];
      let added = 0;
      for (const row of rows) {
        if (!row.signature || seenRows.has(row.signature)) continue;
        seenRows.add(row.signature);
        output.rows.push(row);
        added += 1;
        if (limit > 0 && output.rows.length >= limit) break;
      }
      fs.writeFileSync(resolvedOut, JSON.stringify(output, null, 2), "utf8");
      console.error(`scan step ${step}: visible ${rows.length}, added ${added}, total ${output.rows.length}`);
      if (limit > 0 && output.rows.length >= limit) break;
      if (added > 0) stagnant = 0;
      else stagnant += 1;
      const scrolled = await scrollList(send);
      if (!scrolled.moved) stagnant += 1;
      await sleep(500);
    }
    await closeConnections(ws);
    console.error(`saved scan: ${resolvedOut}`);
    return;
  }

  if (currentOpenResume) {
    const result = await readCurrentOpenResume(send);
    output.results.push(result);
    fs.writeFileSync(resolvedOut, JSON.stringify(output, null, 2), "utf8");
    await closeConnections(ws);
    console.error(`saved current open resume: ${resolvedOut}`);
    return;
  }

  if (!autoRead && !unsafeAutoClick) {
    await closeConnections(ws);
    throw new Error(
      "Choose --auto-read, --scan-only, --current-open-resume, or --unsafe-auto-click."
    );
  }

  const seen = new Set();
  let stagnant = 0;
  for (let step = 0; step < 120 && stagnant < 10; step += 1) {
    const rows = (await getVisibleRows(send)) || [];
    let processed = 0;
    for (const row of rows) {
      if (limit > 0 && output.results.length >= limit) {
        await closeConnections(ws);
        return;
      }
      if (!row.signature || seen.has(row.signature)) continue;
      seen.add(row.signature);
      output.rows.push(row);
      console.error(`reading visible row: ${row.name}`);

      let result = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        result = autoRead && autoMethod !== "dom"
          ? await readOneCandidateKeyboard(send, row, attempt)
          : await readOneCandidate(send, row, attempt);
        const weak = isResumeReadWeak(result);
        const throttled = Boolean(result.throttle && result.throttle.throttled);
        if (!weak && !throttled) break;
        if (attempt >= maxRetries) break;
        console.error(`weak/throttled read for ${row.name}: ${result.error || "resume text too short"}`);
        if (autoRead && autoMethod !== "dom") await closeModalKeyboard(send);
        else await closeModal(send);
      }

      output.results.push(result);
      fs.writeFileSync(resolvedOut, JSON.stringify(output, null, 2), "utf8");
      if (result && result.opened) {
        if (autoRead && autoMethod !== "dom") await closeModalKeyboard(send);
        else await closeModal(send);
      }
      processed += 1;

      if (batchPauseEvery > 0 && output.results.length % batchPauseEvery === 0) {
        await politeDelay(`batch pause after ${output.results.length} candidates`, batchPauseMs, batchPauseMs + 30000);
      } else {
        await politeDelay(`candidate ${row.name} finished`);
      }
    }
    if (processed > 0) stagnant = 0;
    else stagnant += 1;
    const scrolled = await scrollList(send);
    console.error(`step ${step}: visible ${rows.length}, processed ${processed}, total ${output.results.length}`);
    if (!scrolled.moved) stagnant += 1;
    await sleep(500);
  }

  await closeConnections(ws);
  console.error(`saved: ${resolvedOut}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
