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
const scanOnly = process.argv.includes("--scan-only");
const onlyUnread = process.argv.includes("--only-unread");
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
    const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    return [...document.querySelectorAll('.geek-item-wrap,.geek-item')]
      .map((row, index) => {
        const text = normalize(row.innerText || row.textContent || '');
        const name = normalize(row.querySelector('.geek-name')?.innerText || '');
        const unreadHint = Boolean(
          row.querySelector('.unread,.badge,.badge-num,.message-count,.red-dot') ||
          /未读|new/i.test(text)
        );
        const r = row.getBoundingClientRect();
        return {
          index,
          name,
          text,
          signature: name + '|' + text,
          unreadHint,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height }
        };
      })
      .filter((row) => row.name)
      .filter((row) => row.rect.width > 30 && row.rect.height > 20)
      .filter((row) => !position || row.text.includes(position))
      .filter((row) => !onlyUnread || row.unreadHint);
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

async function main() {
  const wsUrl = await resolveWsUrl();
  const { ws, send } = await connect(wsUrl);
  await enablePageIntrospection(send);
  const state = await getPageState(send);
  if (state.url.includes("/web/chat/recommend")) {
    throw new Error("BOSS is on /web/chat/recommend. Manually switch back to the target position unread list, then rerun.");
  }
  console.error(`connected: ${state.url}`);

  const output = {
    meta: {
      createdAt: new Date().toISOString(),
      position,
      browserUrl,
      pageUrl: state.url,
      mode: "raw-cdp-runtime-evaluate-no-input-events",
      bossSideActionsPerformed: 0,
    },
    rows: [],
    results: [],
  };
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(output, null, 2), "utf8");

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
        result = await readOneCandidate(send, row, attempt);
        const weak = isResumeReadWeak(result);
        const throttled = Boolean(result.throttle && result.throttle.throttled);
        if (!weak && !throttled) break;
        if (attempt >= maxRetries) break;
        console.error(`weak/throttled read for ${row.name}: ${result.error || "resume text too short"}`);
        await closeModal(send);
      }

      output.results.push(result);
      fs.writeFileSync(path.resolve(outPath), JSON.stringify(output, null, 2), "utf8");
      if (result && result.opened) await closeModal(send);
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
  console.error(`saved: ${path.resolve(outPath)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
