#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (!p) return;
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

async function evalExpr(send, expression) {
  const msg = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return msg.result.result.value;
}

async function getPageState(send) {
  return evalExpr(send, `(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 800)
  }))()`);
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
    const list = document.querySelector('.user-list.b-scroll-stable') || document.querySelector('.user-list') || document.scrollingElement;
    if (!list) return { moved: false, reason: 'candidate list not found' };
    const before = list.scrollTop;
    list.scrollTop += Math.max(480, Math.floor((list.clientHeight || 700) * 0.75));
    return { moved: list.scrollTop !== before, top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight };
  })()`);
}

async function main() {
  const wsUrl = await resolveWsUrl();
  const { ws, send } = await connect(wsUrl);
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

      const clicked = await dispatchRowClick(send, row);
      if (!clicked.ok) {
        output.results.push({ name: row.name, row, error: clicked.reason || "DOM row click failed" });
        fs.writeFileSync(path.resolve(outPath), JSON.stringify(output, null, 2), "utf8");
        continue;
      }
      await sleep(900);
      const panel = await waitForPanel(send, row.name);
      const profile = panel.text || "";
      const opened = await openOnlineResume(send);
      await sleep(opened.ok ? 2200 : 500);
      const resumeText = opened.ok ? await readResumeText(send, row.name) : "";

      output.results.push({
        name: row.name,
        row,
        clickedText: clicked.text,
        panelReady: panel.ready,
        profile,
        opened: opened.ok,
        resumeText,
        modalText: resumeText,
        resumeButtonProbe: opened.ok ? undefined : opened,
        error: opened.ok ? undefined : opened.reason,
      });
      fs.writeFileSync(path.resolve(outPath), JSON.stringify(output, null, 2), "utf8");
      if (opened.ok) await closeModal(send);
      await sleep(500);
      processed += 1;
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

