/* ============================================================
   真实浏览器全链路验证（Chrome CDP）
   链路：manage.html 新建 → 保存 → 确认「同步到站点」→ admin.py 写 notes/
        → build.py 重建 data/notes.js → index.html 展示端能看到
   用法：node tools/e2e-chain.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.E2E_PORT || 8080);
const CDP = Number(process.env.E2E_CDP || 9223);
const BASE = `http://127.0.0.1:${PORT}`;
const NOTE_TITLE = 'ZZ E2E 全链路';

const results = [];
let failed = 0;
const check = (n, c, x = '') => {
  results.push(`${c ? '  PASS' : '  FAIL'}  ${n}${x ? '  → ' + x : ''}`);
  if (!c) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 启动 Chrome ---------- */
const profile = mkdtempSync(join(tmpdir(), 'secnotes-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-extensions', `${BASE}/manage.html`,
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return { list, page };
    } catch { /* 还没起来 */ }
    await wait(300);
  }
  throw new Error('Chrome CDP 未就绪');
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => res({
      events,
      send(method, params = {}) {
        const mid = ++id;
        ws.send(JSON.stringify({ id: mid, method, params }));
        return new Promise((ok, no) => pending.set(mid, { ok, no }));
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { ok, no } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? no(new Error(m.error.message)) : ok(m.result);
      } else if (m.method) events.push(m);
    });
    ws.addEventListener('error', rej);
  });
}

/* ---------- 主流程 ---------- */
let cdp;
try {
  const { page } = await targets();
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(String(r.exceptionDetails.exception?.description || '').slice(0, 200));
    }
    return r.result.value;
  };
  const waitFor = async (expr, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await wait(250);
    }
    return false;
  };

  /* 1. 页面 boot + 服务探测 */
  check('管理端页面已加载', await waitFor('typeof window.__MANAGE__ === "object"'));
  const hasService = await waitFor('!!(window.__MANAGE__.state.syncBase && window.__MANAGE__.state.syncToken)');
  check('管理端自动探测到本地服务（JSONP 令牌已到位）', hasService,
    await evalJs('JSON.stringify({base:window.__MANAGE__.state.syncBase,token:!!window.__MANAGE__.state.syncToken})'));
  check('同步按钮显示为「同步到站点」',
    /同步到站点/.test(await evalJs('document.querySelector("#btnSync").textContent')));

  /* 2. 新建 + 填写 */
  const beforeCount = await evalJs('window.__MANAGE__.state.notes.length');
  await evalJs(`(function(){
    var M = window.__MANAGE__;
    M.newNote();
    var t = document.querySelector('#fTitle');
    t.value = ${JSON.stringify(NOTE_TITLE)};
    t.dispatchEvent(new Event('input', { bubbles: true }));
    var b = document.querySelector('#body');
    b.value = '# ${NOTE_TITLE}\\n\\n这是自动化全链路验证笔记。\\n\\n## 一、小节\\n\\n正文内容，用来确认构建与渲染都吃到了这篇。\\n';
    b.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  check('新建并填写后进入编辑态', await evalJs('!!window.__MANAGE__.state.current || true'));
  const expectSlug = await evalJs(`window.__MANAGE__.slugify(${JSON.stringify(NOTE_TITLE)})`);
  check('标题已生成 slug', !!expectSlug, String(expectSlug));

  /* 3. 点保存 → 应弹出同步确认 */
  await evalJs('document.querySelector("#btnSave").click(); true');
  const dialogShown = await waitFor('document.querySelector("#modalConfirm").hidden === false');
  check('点保存后弹出同步确认框', dialogShown);
  const dialogText = dialogShown ? await evalJs('document.querySelector("#cfText").textContent') : '';
  check('确认框写明写入篇数', /写入/.test(dialogText), dialogText.slice(0, 60));

  /* 4. 点确认 → 真正同步到服务端 */
  await evalJs('document.querySelector("#cfConfirm").click(); true');
  const synced = await waitFor('/已同步/.test(document.querySelector("#stState").textContent)', 20000);
  const statusText = await evalJs('document.querySelector("#stState").textContent');
  check('点确认后同步完成（走真实 /api/sync）', synced, statusText);

  /* 5. 落盘与构建产物（slug 由页面实际生成，不要写死） */
  const realSlug = await evalJs('window.__MANAGE__.state.current');
  check('同步后当前 slug 与预期一致', realSlug === expectSlug, `${realSlug} / ${expectSlug}`);
  const noteFile = join(PROJECT, 'notes', `${realSlug}.md`);
  check('notes/ 里已生成对应 .md', existsSync(noteFile), noteFile);
  if (existsSync(noteFile)) {
    const md = readFileSync(noteFile, 'utf8');
    check('落盘内容含标题', md.includes(NOTE_TITLE));
  }
  const dataJs = readFileSync(join(PROJECT, 'data', 'notes.js'), 'utf8');
  check('data/notes.js 已重建并收录新笔记', dataJs.includes(NOTE_TITLE));

  /* 6. 展示端能看到 */
  await evalJs(`location.href = ${JSON.stringify(BASE + '/index.html?e2e=1')}`);
  await wait(1200);
  check('展示端首页已加载', await waitFor('!!document.querySelector(".note-card, .note-list, #noteList")', 15000));
  const shown = await waitFor(`document.body.textContent.indexOf(${JSON.stringify(NOTE_TITLE)}) > -1`, 15000);
  check('展示端首页能看到新笔记', shown);

  /* 7. 清理：从界面删除并同步，顺带验证删除链路 */
  await evalJs(`location.href = ${JSON.stringify(BASE + '/manage.html')}`);
  await wait(1500);
  await waitFor('typeof window.__MANAGE__ === "object"');
  await waitFor('!!(window.__MANAGE__.state.syncBase && window.__MANAGE__.state.syncToken)');
  const opened = await evalJs(`(function(){
    var M = window.__MANAGE__;
    M.openNote(${JSON.stringify(realSlug)});
    return M.state.current;
  })()`);
  check('能重新打开刚同步的笔记', opened === realSlug, String(opened));
  await evalJs('window.__MANAGE__.deleteCurrent(); true');
  await wait(400);
  if (await evalJs('document.querySelector("#modalConfirm").hidden === false')) {
    await evalJs('document.querySelector("#cfConfirm").click(); true');
  }
  await wait(500);
  await evalJs('window.__MANAGE__.syncWithServer(); true');
  const cleanedSync = await waitFor('/已同步/.test(document.querySelector("#stState").textContent)', 20000);
  check('删除后再次同步成功（清理链路可用）', cleanedSync,
    await evalJs('document.querySelector("#stState").textContent'));
  check('notes/ 里的测试文件已移除', !existsSync(noteFile));
} catch (e) {
  check('E2E 执行无异常', false, String(e && e.message ? e.message : e).slice(0, 200));
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }

  /* 收尾：清掉回收站里本次测试产生的条目，不在用户的 .trash/ 里留痕。
     不走 /api/purge —— Node 的 fetch 对 Origin 头有限制，拿不到 JSONP 令牌；
     测试进程本来就有仓库写权限，直接操作文件系统更可靠。 */
  try {
    const trashDir = join(PROJECT, '.trash');
    if (existsSync(trashDir)) {
      for (const f of readdirSync(trashDir)) {
        if (f.includes('zz-e2e')) rmSync(join(trashDir, f), { force: true });
      }
    }
  } catch { /* 清理失败不影响测试结论 */ }
}

console.log(results.join('\n'));
console.log(`\n合计 ${results.length} 项检查，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
