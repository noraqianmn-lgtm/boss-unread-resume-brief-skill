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
const autoMethod = arg("auto-method", "keyboard");
const minDelayMs = Number(arg("min-delay-ms", "10000"));
const maxDelayMs = Number(arg("max-delay-ms", "18000"));
const batchPauseEvery = Number(arg("batch-pause-every", "5"));
const batchPauseMs = Number(arg("batch-pause-ms", "90000"));
const throttleCooldownMs = Number(arg("throttle-cooldown-ms", "90000"));
const maxRetries = Number(arg("max-retries", "1"));
const runtimeContexts = new Map();
const framesById = new Map();

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
    const p = pending.get(msg.id);
    if (!p) {
      handleCdpEvent(msg);
      return;
    }
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, send });
    ws.onerror = () => reject(new Error("websocket error"));
  });
}

function handleCdpEvent(msg) {
  if (msg.method === "Runtime.executionContextCreated") {
    const context = msg.params && msg.params.context;
    if (context && context.id) runtimeContexts.set(context.id, context);
  } else if (msg.method === "Runtime.executionContextDestroyed") {
    runtimeContexts.delete(msg.params.executionContextId);
  } else if (msg.method === "Runtime.executionContextsCleared") {
    runtimeContexts.clear();
  } else if (msg.method === "Page.frameNavigated") {
    const frame = msg.params && msg.params.frame;
    if (frame && frame.id) framesById.set(frame.id, frame);
  }
}

async function evalExpr(send, expression, options = {}) {
  const msg = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(options.contextId ? { contextId: options.contextId } : {}),
  });
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

function resumeContextIds() {
  const ids = [];
  for (const context of runtimeContexts.values()) {
    const frameId = context.auxData && context.auxData.frameId;
    const frame = frameId ? framesById.get(frameId) : null;
    const url = String((frame && frame.url) || context.origin || context.name || "");
    if (url.includes("/web/frame/c-resume/")) ids.push(context.id);
  }
  return ids;
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
      const text = normalize(document.body.innerText || '');
      const hasResume = [...document.querySelectorAll('a,button,span,div,[role="button"],[class*="resume"],[class*="Resume"]')]
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
      return { ready: text.includes(name) || hasResume, hasResume, text: text.slice(0, 3000) };
    })()`);
    if (state.ready) return state;
    await sleep(350);
  }
  return { ready: false, text: "", reason: "candidate detail panel did not load" };
}

async function focusOnlineResumeButton(send) {
  return evalExpr(send, `(() => {
    const candidates = [...document.querySelectorAll('a,button,span,div,[role="button"],[class*="resume"],[class*="Resume"]')]
      .map((el) => {
        const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, '');
        const cls = String(el.className || '');
        const title = String(el.getAttribute('title') || '');
        const aria = String(el.getAttribute('aria-label') || '');
        const href = String(el.getAttribute('href') || '');
        const r = el.getBoundingClientRect();
        const visible = r.width > 12 && r.height > 12 && r.bottom > 0 && r.right > 0;
        const haystack = (text + ' ' + cls + ' ' + title + ' ' + aria + ' ' + href).toLowerCase();
        let score = 0;
        if (text.includes('在线简历') || title.includes('在线简历') || aria.includes('在线简历')) score += 100;
        if (text.includes('查看简历') || title.includes('查看简历') || aria.includes('查看简历')) score += 80;
        if (cls.includes('resume-btn-online')) score += 90;
        if (haystack.includes('online') && haystack.includes('resume')) score += 70;
        if (haystack.includes('resume')) score += 30;
        if (text.includes('简历') || title.includes('简历') || aria.includes('简历')) score += 25;
        if (text.includes('附件简历') || title.includes('附件简历') || aria.includes('附件简历')) score -= 15;
        return { el, visible, score, text: text.slice(0, 80), cls: cls.slice(0, 120), title, aria, href };
      })
      .filter((item) => item.visible && item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return { ok: false, reason: 'online resume button not found', candidates: candidates.slice(0, 20).map(({el, ...rest}) => rest) };
    best.el.scrollIntoView({ block: 'center' });
    if (!best.el.hasAttribute('tabindex')) best.el.setAttribute('tabindex', '0');
    best.el.focus({ preventScroll: true });
    return {
      ok: document.activeElement === best.el || best.el.contains(document.activeElement),
      button: { score: best.score, text: best.text, cls: best.cls, title: best.title, aria: best.aria, href: best.href }
    };
  })()`);
}

async function openOnlineResumeKeyboard(send) {
  const focused = await focusOnlineResumeButton(send);
  if (!focused.ok) return focused;
  await pressKey(send, "Enter");
  await sleep(1200);
  await refreshFrameTree(send);
  if (resumeContextIds().length > 0) return { ok: true, method: "keyboard-enter", button: focused.button };
  await pressKey(send, "Space");
  await sleep(1200);
  await refreshFrameTree(send);
  return {
    ok: resumeContextIds().length > 0,
    method: "keyboard-enter-space",
    button: focused.button,
    reason: resumeContextIds().length > 0 ? undefined : "online resume iframe did not appear after keyboard activation",
  };
}

async function openOnlineResume(send) {
  return evalExpr(send, `(() => {
    const candidates = [...document.querySelectorAll('a,button,span,div,[role="button"],[class*="resume"],[class*="Resume"]')]
      .map((el) => {
        const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, '');
        const cls = String(el.className || '');
        const title = String(el.getAttribute('title') || '');
        const aria = String(el.getAttribute('aria-label') || '');
        const r = el.getBoundingClientRect();
        const visible = r.width > 12 && r.height > 12 && r.bottom > 0 && r.right > 0;
        const haystack = (text + ' ' + cls + ' ' + title + ' ' + aria).toLowerCase();
        let score = 0;
        if (text.includes('在线简历') || title.includes('在线简历') || aria.includes('在线简历')) score += 100;
        if (text.includes('查看简历') || title.includes('查看简历') || aria.includes('查看简历')) score += 80;
        if (cls.includes('resume-btn-online')) score += 90;
        if (haystack.includes('online') && haystack.includes('resume')) score += 70;
        if (haystack.includes('resume')) score += 30;
        if (text.includes('简历') || title.includes('简历') || aria.includes('简历')) score += 25;
        if (text.includes('附件简历') || title.includes('附件简历') || aria.includes('附件简历')) score -= 15;
        return { el, visible, score, text: text.slice(0, 80), cls: cls.slice(0, 120), title, aria };
      })
      .filter((item) => item.visible && item.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return { ok: false, reason: 'online resume button not found', candidates: candidates.slice(0, 20).map(({el, ...rest}) => rest) };
    best.el.scrollIntoView({ block: 'center' });
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      best.el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    if (typeof best.el.click === 'function') best.el.click();
    return { ok: true, button: { score: best.score, text: best.text, cls: best.cls, title: best.title, aria: best.aria } };
  })()`);
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
    await refreshFrameTree(send);
    const ids = resumeContextIds();
    for (const contextId of ids) {
      try {
        const detail = await evalExpr(
          send,
          `import(${js(RESUME_WASM_URL)}).then((mod) => mod.get_export_geek_detail_info()).catch(() => null)`,
          { contextId }
        );
        if (detail && detail.geekBaseInfo && detail.geekBaseInfo.name === name) return detail;
        if (detail && detail.geekBaseInfo && !fallback) fallback = detail;
      } catch (_) {}
    }
    await sleep(500);
  }
  return fallback;
}

async function readCanvasText(send, name) {
  let fallback = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await refreshFrameTree(send);
    const ids = resumeContextIds();
    for (const contextId of ids) {
      try {
        await evalExpr(
          send,
          `(() => {
            const h = document.body.scrollHeight || document.documentElement.scrollHeight || 4000;
            window.scrollTo(0, Math.min(h, ${attempt * 700}));
            return true;
          })()`,
          { contextId }
        );
        await sleep(180);
        const text = await evalExpr(send, `(() => (window.__bossResumeTexts || []).join(''))()`, { contextId });
        if (text && !fallback) fallback = text;
        if (text && text.includes(name)) return text;
      } catch (_) {}
    }
    await sleep(400);
  }
  return fallback;
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

  const selected = await selectRowKeyboard(send, row);
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

  const opened = await openOnlineResumeKeyboard(send);
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
    detail: summarizeDetail(rawDetail),
    rawDetail,
    canvasText,
    headerText: profile,
    resumeText,
    modalText: resumeText,
    throttle: afterOpenThrottle.throttled ? afterOpenThrottle : undefined,
    resumeButtonProbe: opened.ok ? undefined : opened,
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
  Auto-read current position candidates with keyboard automation:
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
  if (autoMethod !== "keyboard" && autoMethod !== "dom") {
    throw new Error("--auto-method must be keyboard or dom");
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
    ws.close();
    console.error(`saved scan: ${resolvedOut}`);
    return;
  }

  if (currentOpenResume) {
    const result = await readCurrentOpenResume(send);
    output.results.push(result);
    fs.writeFileSync(resolvedOut, JSON.stringify(output, null, 2), "utf8");
    ws.close();
    console.error(`saved current open resume: ${resolvedOut}`);
    return;
  }

  if (!autoRead && !unsafeAutoClick) {
    ws.close();
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
        ws.close();
        return;
      }
      if (!row.signature || seen.has(row.signature)) continue;
      seen.add(row.signature);
      output.rows.push(row);
      console.error(`reading visible row: ${row.name}`);

      let result = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        result = autoRead && autoMethod === "keyboard"
          ? await readOneCandidateKeyboard(send, row, attempt)
          : await readOneCandidate(send, row, attempt);
        const weak = isResumeReadWeak(result);
        const throttled = Boolean(result.throttle && result.throttle.throttled);
        if (!weak && !throttled) break;
        if (attempt >= maxRetries) break;
        console.error(`weak/throttled read for ${row.name}: ${result.error || "resume text too short"}`);
        if (autoRead && autoMethod === "keyboard") await closeModalKeyboard(send);
        else await closeModal(send);
      }

      output.results.push(result);
      fs.writeFileSync(resolvedOut, JSON.stringify(output, null, 2), "utf8");
      if (result && result.opened) {
        if (autoRead && autoMethod === "keyboard") await closeModalKeyboard(send);
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

  ws.close();
  console.error(`saved: ${resolvedOut}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
