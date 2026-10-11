/* ============================================================
   SecNotes 管理端（manage.html）自检（jsdom）
   ------------------------------------------------------------
   验证"双击即可打开"的免服务管理端：
     · 页面引用全部是相对路径（file:// 下可用）
     · 首次打开从 data/notes.js 导入站点现有笔记
     · 新建 / 编辑 / 保存 / 删除 / 搜索 / 本地库持久化
     · 预览与展示端文章页逐字符一致（同一渲染链路）
     · 双向链接面板（出链 / 入链 / 待创建）
     · 导出 notes.json、导出 .md、导入备份

   用法：node tools/verify-manage.mjs
   ============================================================ */
const JSDOM_PATH = process.env.JSDOM_PATH ||
  'file:///C:/Users/Deus/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js';
const { JSDOM, VirtualConsole } = await import(JSDOM_PATH);
const { readFileSync, existsSync, readdirSync, copyFileSync, rmSync, writeFileSync } = await import('node:fs');
const { createServer } = await import('node:http');
const { resolve, dirname, join, extname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const rel = decodeURIComponent(url).replace(/^\//, '') || 'manage.html';
  const file = join(PROJECT, rel);
  if (!file.startsWith(PROJECT) || !existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

/* ---------------- 断言工具 ---------------- */
const results = [];
let failed = 0;
function check(name, cond, extra = '') {
  results.push(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
}

/* ---------------- 静态检查：file:// 可用性 ---------------- */
const manageHtml = readFileSync(join(PROJECT, 'manage.html'), 'utf8');
const indexHtml = readFileSync(join(PROJECT, 'index.html'), 'utf8');
const absRefs = (html) => (html.match(/(?:src|href)="(\/[^"]*|(?!#)[a-z]+:\/\/[^"]*)"/g) || [])
  .filter((m) => !/https?:\/\/(www\.w3\.org|schemas)/.test(m));

check('管理端无绝对/远程资源引用（可 file:// 双击打开）',
  absRefs(manageHtml).length === 0, absRefs(manageHtml).join(', '));
check('展示端无绝对/远程资源引用（可 file:// 双击打开）',
  absRefs(indexHtml).length === 0, absRefs(indexHtml).join(', '));
check('管理端引用了站点同一份样式表', /href="assets\/css\/style\.css"/.test(manageHtml));
check('管理端引用了共享渲染模块', /src="assets\/js\/render\.js"/.test(manageHtml));
/* 站点数据改为按需加载（src + ?t= 时间戳）：浏览器对 <script src> 的强缓存会让
   管理端读到过期的站点数据，对账逻辑据此会把已删除的笔记当成「站点上还有」而保留，
   下次同步又写回 notes/ —— 表现为删除后展示端不同步。断言锁定这个机制。 */
check('管理端按需加载站点数据文件（带时间戳避开缓存）',
  /['"]data\/notes\.js['"]/.test(manageHtml) && /\?t=/.test(manageHtml));

/* ---------------- 加载管理端 ---------------- */
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e.message);
  // 探测本地服务必然失败（测试环境没有服务），属预期；CSS 解析告警与本项目无关
  if (/Could not parse CSS/.test(msg)) return;
  if (/Could not load script/.test(msg) && /api\/token\.js/.test(msg)) return;
  results.push('  WARN  jsdomError: ' + msg);
});

const downloads = [];
/* ---------------- 夹具安装（带快照精确还原） ----------------
   与 verify-render.mjs 同一份 fixtures/notes/。manage 测试需要至少一条笔记
   来构造「右键笔记」「批量操作」等流程；用户清空了 notes/ 后测试若无 fixture
   会假失败。notes/ 也得重建 data/notes.js 让 manage.html 启动时能见到笔记。 */
const { spawnSync } = await import('node:child_process');
const FIXTURE_DIR = join(PROJECT, 'tools', 'fixtures', 'notes');
const NOTES_DIR = join(PROJECT, 'notes');
const PY = process.env.SECNOTES_PY ||
  'C:\\Users\\Deus\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const runBuild = () => spawnSync(PY, ['build.py'], { cwd: PROJECT, encoding: 'utf8' });

/* 测试专用文件名：出现在 notes/ 里一律视为污染（夹具同名文件 + zz- 前缀临时笔记）。
   必须显式识别：残留一旦进入快照就被当成「用户内容」，之后再也还原不掉。 */
const FIXTURE_NAMES = new Set(
  existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.md')) : []
);
const isTestArtifact = (name) => FIXTURE_NAMES.has(name) || /^zz-(verify|e2e)/.test(name);

/* 起跑先净化，保证快照建立在干净的基线上 */
const purgedAtStart = [];
for (const n of readdirSync(NOTES_DIR)) {
  if (n.endsWith('.md') && isTestArtifact(n)) {
    rmSync(join(NOTES_DIR, n), { force: true });
    purgedAtStart.push(n);
  }
}
if (purgedAtStart.length) runBuild();

const notesSnapshot = new Map();
for (const n of readdirSync(NOTES_DIR)) {
  if (n.endsWith('.md')) notesSnapshot.set(n, readFileSync(join(NOTES_DIR, n)));
}
let notesDirty = false;
if (existsSync(FIXTURE_DIR)) {
  for (const name of FIXTURE_NAMES) {
    if (notesSnapshot.has(name)) continue;
    copyFileSync(join(FIXTURE_DIR, name), join(NOTES_DIR, name));
    notesDirty = true;
  }
  if (notesDirty) runBuild();
}
function restoreManageNotes() {
  let changed = false;
  for (const n of readdirSync(NOTES_DIR)) {
    if (!n.endsWith('.md')) continue;
    if (!notesSnapshot.has(n) || isTestArtifact(n)) {
      rmSync(join(NOTES_DIR, n), { force: true });
      changed = true;
    }
  }
  for (const [n, buf] of notesSnapshot) {
    if (isTestArtifact(n)) continue;             // 防御：快照里不该有污染
    const p = join(NOTES_DIR, n);
    if (!existsSync(p) || !readFileSync(p).equals(buf)) { writeFileSync(p, buf); changed = true; }
  }
  if (changed || notesDirty) { runBuild(); notesDirty = false; }
}
process.on('beforeExit', restoreManageNotes);
process.on('exit', restoreManageNotes);

const dom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || (() => ({
      matches: false, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}
    }));
    window.scrollTo = () => {};          // jsdom 未实现，静音
    /* 捕获下载内容：Blob 与 <a download> 都不真正触发文件写入 */
    const RealBlob = window.Blob;
    window.Blob = function (parts, opts) {
      downloads.push({ text: String(parts.join('')), type: (opts && opts.type) || '' });
      return new RealBlob(parts, opts);
    };
    window.URL.createObjectURL = () => 'blob:stub';
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () { /* 不触发导航 */ };
  }
});

const { window } = dom;
const { document } = window;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

await new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else window.addEventListener('load', resolve, { once: true });
});
await wait(400);

console.log('\n=== SecNotes 管理端验证 ===');

const M = window.__MANAGE__;
check('管理脚本已初始化', !!M && !!M.state);
check('预览容器与展示端使用同一样式类',
  !!document.querySelector('#preview.post-body'));

/* ---------------- 首次导入 ---------------- */
const siteCount = (window.SEC_BLOG && window.SEC_BLOG.notes) ? window.SEC_BLOG.notes.length : 0;
check('首次打开从 data/notes.js 导入站点笔记',
  M.state.notes.length === siteCount && siteCount > 0,
  `${M.state.notes.length} / 站点 ${siteCount}`);
check('导入的笔记被标记为已同步',
  M.state.notes.every((n) => M.state.synced[n.slug] === true));
check('本地库已写入 localStorage',
  !!window.localStorage.getItem('secnotes.manage.v1'));
check('列表渲染出全部笔记',
  document.querySelectorAll('#listScroll .adm-item').length === siteCount,
  String(document.querySelectorAll('#listScroll .adm-item').length));
check('顶部统计显示篇数', /\d+ 篇/.test($('#libPill').textContent), $('#libPill').textContent);

/* ---------------- 布局回归守卫 ---------------- */
/* 曾经的事故：.adm-editor-inner 只声明了 4 个网格行却有 5 个子元素，
   工具栏被塞进弹性行压成 19px，按钮溢出到文本域下方——点击全被文本域接走。
   这里把"行数必须等于可见子元素数"固定成断言。 */
const adminCss = readFileSync(join(PROJECT, 'assets/css/admin.css'), 'utf8');
const styleCss = readFileSync(join(PROJECT, 'assets/css/style.css'), 'utf8');
const gridRule = /\.adm-editor-inner\s*\{[^}]*grid-template-rows:\s*([^;]+);/.exec(adminCss);
/* 轨道以空格分隔；minmax(0, 1fr) 里的空格与逗号不算分隔符 */
const countTracks = (v) => {
  let depth = 0, n = 0, inToken = false;
  for (const ch of v.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) inToken = false;
    else if (!inToken) { inToken = true; n++; }
  }
  return n;
};
const editorInner = $('#editorInner');
const flowChildren = Array.from(editorInner.children)
  .filter((el) => !el.hasAttribute('hidden') && window.getComputedStyle(el).position !== 'absolute');
check('编辑器网格行数与子元素数一致（防工具栏被压扁）',
  !!gridRule && countTracks(gridRule[1]) === flowChildren.length,
  `声明 ${gridRule ? countTracks(gridRule[1]) : '?'} 行 / 实际 ${flowChildren.length} 个可见子元素`);
check('工具栏不再与编辑区重叠（行数声明含独立的工具栏行）',
  !!gridRule && /auto\s+auto\s+auto\s+minmax/.test(gridRule[1]), gridRule ? gridRule[1].trim() : '');

/* 作者样式里的 display 会压过 UA 的 [hidden]，必须有全局兜底 */
check('全局 [hidden] 兜底规则存在（hidden 才是真的隐藏）',
  /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(styleCss));

/* ---------------- 预览收起 / 展开（统一在操作栏，同一个按钮） ---------------- */
check('预览默认展开', !document.body.classList.contains('preview-collapsed'));
check('预览栏头不再带切换按钮（统一到操作栏）',
  !document.querySelector('.adm-preview-head .adm-preview-toggle, #btnPreview'));
check('操作栏的预览按钮初始文案为「收起预览」',
  $('#btnPreviewBar').textContent === '收起预览', $('#btnPreviewBar').textContent);
check('操作栏的预览按钮始终可见', $('#btnPreviewBar').hidden === false);

M.togglePreview();
await wait(60);
check('点收起后预览栏隐藏', document.body.classList.contains('preview-collapsed'));
check('收起后 preview 容器不显示',
  window.getComputedStyle($('.adm-pane-preview')).display === 'none',
  window.getComputedStyle($('.adm-pane-preview')).display);
check('收起后同一按钮文案变为「展开预览」',
  $('#btnPreviewBar').textContent === '展开预览', $('#btnPreviewBar').textContent);
check('收起状态写入本地偏好',
  window.localStorage.getItem('secnotes.manage.preview') === 'collapsed');

click($('#btnPreviewBar'));
await wait(60);
check('再点同一按钮可以重新展开', !document.body.classList.contains('preview-collapsed'));
check('展开后按钮文案回到「收起预览」',
  $('#btnPreviewBar').textContent === '收起预览', $('#btnPreviewBar').textContent);
check('展开状态写入本地偏好',
  window.localStorage.getItem('secnotes.manage.preview') === 'open');

/* ---------------- 右键笔记：上下文菜单 ----------------
   流程：右键 .adm-item → 自绘菜单出现，含"打开 / 复制标题 / 删除这篇…"
   → 点"删除这篇…" → 走原有 deleteCurrent 流程（弹确认、删本地库、加进 removed）。 */
const ctxListItem = document.querySelector('#listScroll .adm-item');
const ctxSlug = ctxListItem && ctxListItem.getAttribute('data-slug');
check('列表里有可被右键的笔记项', !!ctxListItem && !!ctxSlug, ctxSlug);

/* 打开一条再测，避免在空态上右键。
   但 openNote 会调 renderList() 重建列表，缓存的 ctxListItem 会被替换——必须重取 */
ctxListItem && ctxListItem.click();
await wait(80);
const firstItem = document.querySelector('#listScroll .adm-item');
const firstSlug = firstItem && firstItem.getAttribute('data-slug');
check('点击后仍能定位到列表项', !!firstItem && firstSlug === ctxSlug, firstSlug);

const ctxEvent = new window.MouseEvent('contextmenu', {
  bubbles: true, cancelable: true, clientX: 123, clientY: 234, button: 2
});
firstItem.dispatchEvent(ctxEvent);
await wait(40);
const menu = document.querySelector('.adm-context-menu');
check('右键笔记后弹出上下文菜单', !!menu, menu ? menu.outerHTML.slice(0, 80) : '');
check('上下文菜单包含三条动作',
  menu && menu.querySelectorAll('.adm-context-item').length === 3,
  menu ? String(menu.querySelectorAll('.adm-context-item').length) : '0');
check('上下文菜单含「删除这篇…」',
  !!menu && /删除这篇/.test(menu.textContent));
check('上下文菜单定位在视口内',
  !!menu && menu.getBoundingClientRect().left >= 0 && menu.getBoundingClientRect().top >= 0,
  menu ? JSON.stringify(menu.getBoundingClientRect()) : '');

/* 点"删除这篇…"应弹出确认框；点击确认后从本地库移除、加进 removed */
const beforeDel = M.state.notes.length;
const beforeRem = (M.state.removed || []).length;
const deleteItem = menu && menu.querySelector('.adm-context-item[data-act="delete"]');
check('右键菜单有删除动作按钮', !!deleteItem, deleteItem ? deleteItem.textContent : '');
deleteItem && deleteItem.click();
await wait(40);
check('点删除后弹出确认框', !document.querySelector('#modalConfirm').hidden);
const confirmBtn = document.querySelector('#cfConfirm');
confirmBtn && confirmBtn.click();
await wait(80);
check('确认后笔记从本地库移除', M.state.notes.length === beforeDel - 1,
  `${M.state.notes.length} vs ${beforeDel - 1}`);
check('确认后 slug 进入同步待移除列表',
  (M.state.removed || []).length === beforeRem + 1,
  `${(M.state.removed || []).length} vs ${beforeRem + 1}`);
check('右键菜单已关闭', !document.querySelector('.adm-context-menu'));

/* 点菜单外应关闭 */
const stillThere = document.querySelector('#listScroll .adm-item');
stillThere && stillThere.dispatchEvent(new window.MouseEvent('contextmenu', {
  bubbles: true, cancelable: true, clientX: 50, clientY: 50, button: 2 }));
await wait(40);
check('再次右键能再次弹出菜单', !!document.querySelector('.adm-context-menu'));
document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
document.body.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
await wait(40);
check('点菜单外能关闭', !document.querySelector('.adm-context-menu'));

/* ---------------- 工具栏（曾因重叠而"点了没反应"） ---------------- */
const toolbarCases = [
  ['h2', '第一行\n## 第二行'],
  ['h3', '第一行\n### 第二行'],
  ['h4', '第一行\n#### 第二行'],
  ['bold', '第一行\n第二行**加粗**'],
  ['italic', '第一行\n第二行*斜体*'],
  ['code', '第一行\n第二行`code`'],
  ['quote', '第一行\n> 第二行'],
  ['ul', '第一行\n- 第二行'],
  ['ol', '第一行\n1. 第二行'],
  ['link', '第一行\n第二行[链接文字](https://)'],
  ['wikilink', '第一行\n第二行[[笔记标题]]'],
  /* image 不在这里测：它现在打开系统选择器，由下方"图片：系统选择器"独立验证 */
  ['hr', '第一行\n第二行\n---\n'],
  ['codeblock', '第一行\n第二行\n```bash\n\n```\n']
];
const toolbarFail = [];
for (const [md, expect] of toolbarCases) {
  const ta = $('#body');
  ta.value = '第一行\n第二行';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  click(document.querySelector(`#toolbar button[data-md="${md}"]`));
  await wait(10);
  if (ta.value !== expect) toolbarFail.push(`${md}: ${JSON.stringify(ta.value)}`);
}
check('工具栏全部动作插入结果正确', toolbarFail.length === 0, toolbarFail.slice(0, 2).join(' | '));

/* execCommand 假装成功但什么都不做时，仍必须插入（防静默失败） */
const realExec = document.execCommand;
document.execCommand = () => true;                 // 返回成功，但不改内容
$('#body').value = '第一行\n第二行';
$('#body').focus();
$('#body').setSelectionRange($('#body').value.length, $('#body').value.length);
click(document.querySelector('#toolbar button[data-md="h2"]'));
await wait(10);
check('execCommand 静默失败时兜底插入生效', $('#body').value === '第一行\n## 第二行',
  JSON.stringify($('#body').value));
document.execCommand = realExec;

/* ---------------- 图片：系统选择器 → 上传 → 插入 ----------------
   toolbar 的"图片"按钮现在调用原生 <input type="file">，拿到文件后：
   有同步服务 → POST /api/upload → 插入 ![](相对路径)；
   没服务 → 明确提示，不静默失败。 */
const imgBtn = document.querySelector('#toolbar button[data-md="image"]');
check('工具栏含"图片"按钮', !!imgBtn, imgBtn ? imgBtn.textContent : '');

/* stub 同步服务的 fetch（避免在 jsdom 里真发请求） */
const imgCalls = [];
const realFetch = window.fetch;
window.fetch = (url, init) => {
  imgCalls.push({
    url: String(url),
    method: init && init.method,
    body: init && init.body,
    headers: init && init.headers ? JSON.stringify(init.headers) : ''
  });
  return Promise.resolve({
    status: 200,
    json: function () { return Promise.resolve({
      ok: true, url: 'assets/uploads/2026-09/test.png', bytes: 4096, deduped: false
    }); }
  });
};

/* 模拟"服务在线 + 选了文件"：把文件喂给 file input */
M.state.syncBase = 'http://127.0.0.1:8080/';
M.state.syncToken = 'fake-token';
imgBtn.click();
const imgInput = window.__MANAGE__.state.imagePicker;
check('点图片按钮后创建了 file input', !!imgInput && imgInput.type === 'file',
  imgInput ? imgInput.outerHTML.slice(0, 60) : '');
const fakeFile = new window.File([new Uint8Array(64)], 'test.png', { type: 'image/png' });
Object.defineProperty(imgInput, 'files', { value: [fakeFile], configurable: true });
imgInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(200);
check('有服务时图片走 /api/upload', imgCalls.length === 1 && /\/api\/upload$/.test(imgCalls[0].url),
  JSON.stringify(imgCalls[0]));
check('上传请求带令牌与 JSON 体',
  imgCalls[0] && imgCalls[0].method === 'POST' &&
  imgCalls[0].body && /"dataUrl":/.test(imgCalls[0].body) &&
  /X-Admin-Token/.test(imgCalls[0].headers) &&
  /fake-token/.test(imgCalls[0].headers),
  imgCalls[0] ? imgCalls[0].headers : '');
check('上传成功后插入 Markdown 图片语法',
  /!\[[^\]]*\]\(assets\/uploads\/2026-09\/test\.png\)/.test($('#body').value),
  $('#body').value.slice(-80));

/* 没服务时不应尝试 fetch，且给出状态提示 */
M.state.syncBase = '';
M.state.syncToken = '';
imgCalls.length = 0;
imgBtn.click();
const imgInput2 = window.__MANAGE__.state.imagePicker;
Object.defineProperty(imgInput2, 'files', { value: [new window.File([new Uint8Array(8)], 'x.png', { type: 'image/png' })], configurable: true });
imgInput2.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('没服务时不会发请求', imgCalls.length === 0, String(imgCalls.length));
check('没服务时给出明确提示而不是静默失败',
  /同步服务未启动/.test($('#stState').textContent),
  $('#stState').textContent);

/* 非图片文件直接拒绝（不依赖服务） */
M.state.syncBase = 'http://127.0.0.1:8080/';
M.state.syncToken = 'fake';
imgBtn.click();
const imgInput3 = window.__MANAGE__.state.imagePicker;
Object.defineProperty(imgInput3, 'files', { value: [new window.File([new Uint8Array(8)], 'evil.txt', { type: 'text/plain' })], configurable: true });
imgInput3.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(40);
check('非图片文件被拒绝（不发请求）', imgCalls.length === 0, String(imgCalls.length));

window.fetch = realFetch;

/* ---------------- 搜索 ---------------- */
/* 用自建夹具做检索：不要依赖"某篇带 nmap 的笔记还在"——
   用户随时可能删掉笔记，那样测试会假失败（曾因此整批变红）。 */
const searchFixture = {
  slug: 'zz-search-fixture', title: 'ZZ 检索夹具', date: '2026-01-01',
  category: '验证分类', tags: ['检索夹具'], summary: '', draft: false,
  body: '正文里有一个独特标记 zzsearchtoken，用来验证正文命中。'
};
M.state.notes.push(searchFixture);
M.state.synced[searchFixture.slug] = false;
M.renderList();
const beforeQuery = document.querySelectorAll('#listScroll .adm-item').length;
M.setQuery('zzsearchtoken');
const searched = document.querySelectorAll('#listScroll .adm-item').length;
check('搜索按正文/标题过滤', searched > 0 && searched < beforeQuery, `${searched} / ${beforeQuery}`);
M.setQuery('绝对不存在的关键词zzz');
check('无匹配时给出空态提示', !!$('#listScroll .adm-list-empty'));
M.setQuery('');
check('清空搜索后恢复全部',
  document.querySelectorAll('#listScroll .adm-item').length === beforeQuery,
  `${document.querySelectorAll('#listScroll .adm-item').length} vs ${beforeQuery}`);

/* ---------------- 新建与保存 ---------------- */
/* 出链目标同样用自建夹具：依赖"用户没删过某篇正式笔记"会让整批断言假失败 */
const linkTarget = {
  slug: 'zz-link-target', title: 'ZZ 链接目标', date: '2026-01-01',
  category: '验证分类', tags: [], summary: '', draft: false, body: '被引用的目标笔记。'
};
M.state.notes.push(linkTarget);
M.state.synced[linkTarget.slug] = false;
M.renderList();

click($('#btnNew'));
await wait(60);
check('新建后进入编辑区', $('#editorInner').hidden === false);
check('新建时给出正文骨架', /## 一、背景/.test($('#body').value));

$('#fTitle').value = 'ZZ 管理端验证笔记';
$('#fCategory').value = '验证分类';
$('#fTags').value = '验证, 管理端';
$('#body').value = '# ZZ 管理端验证笔记\n\n正文里引用 [[ZZ 链接目标]]，以及 [[尚不存在的笔记]]。\n';
$('#body').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(200);

check('编辑后标记未保存', $('#dirtyMark').hidden === false);
check('slug 由标题自动生成', M.slugify('ZZ 管理端验证笔记') === 'zz-管理端验证笔记',
  M.slugify('ZZ 管理端验证笔记'));

const beforeSave = M.state.notes.length;
click($('#btnSave'));
await wait(120);
check('保存后本地库 +1', M.state.notes.length === beforeSave + 1, String(M.state.notes.length));
check('保存后清除未保存标记', $('#dirtyMark').hidden === true);
check('保存后列表出现新笔记',
  Array.prototype.some.call(document.querySelectorAll('.adm-item-title'),
    (el) => el.textContent.indexOf('ZZ 管理端验证笔记') > -1));
check('新笔记标记为未写入 notes/',
  M.state.synced[M.state.current] === false);
check('本地库持久化含新笔记',
  /ZZ 管理端验证笔记/.test(window.localStorage.getItem('secnotes.manage.v1')));

/* ---------------- 分类选择栏 ---------------- */
/* 曾经的问题：manage.html 里写了个 <datalist> 却从未被填充，等于没有选择栏 */
const catSel = $('#fCategoryPick');
const catNames = M.categoryCounts().map((c) => c.name);
const pickOptions = Array.from(catSel.options).filter((o) => o.value && o.value !== M.NEW_CAT);
check('分类选择栏列出了全部已有分类',
  catNames.length > 0 && pickOptions.length === catNames.length,
  `${pickOptions.length} 项 / 已有分类 ${catNames.length} 个`);
check('分类选项带篇数', pickOptions.some((o) => /（\d+）/.test(o.textContent)),
  pickOptions.map((o) => o.textContent).join(' '));
check('选择栏保留「新建分类」入口',
  Array.from(catSel.options).some((o) => o.value === M.NEW_CAT));

/* 选中已有分类 → 填进输入框 */
const pickTarget = catNames.filter((c) => c !== $('#fCategory').value)[0] || catNames[0];
catSel.value = pickTarget;
catSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(40);
check('从选择栏选中的分类会填入输入框', $('#fCategory').value === pickTarget, $('#fCategory').value);

/* 选「新建分类」→ 清空输入框，可直接敲新名字 */
catSel.value = M.NEW_CAT;
catSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(40);
check('选「新建分类」会清空输入框以便输入新名字', $('#fCategory').value === '',
  `"${$('#fCategory').value}"`);

$('#fCategory').value = '全新分类ZZ';
$('#fCategory').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(40);
check('手输的新名字不会被选择栏抹掉（选择栏只是回退到未选中）',
  $('#fCategory').value === '全新分类ZZ' && catSel.value === '', `"${$('#fCategory').value}"`);
M.refreshCategories();
check('手输的新分类名会作为「新分类」出现在选择栏',
  Array.from(catSel.options).some((o) => o.value === '全新分类ZZ'));

/* ---------------- 双向链接面板 ---------------- */
const outChips = document.querySelectorAll('#linkOut .adm-chip');
const brokenChips = document.querySelectorAll('#linkBroken .adm-chip');
check('出链面板列出引用到的笔记', outChips.length === 1, String(outChips.length));
check('出链指向正确的笔记标题',
  /ZZ 链接目标/.test(outChips[0] ? outChips[0].textContent : ''),
  outChips[0] ? outChips[0].textContent : '');
check('待创建面板列出不存在的笔记', brokenChips.length === 1, String(brokenChips.length));
check('待创建显示原始标题',
  /尚不存在的笔记/.test(brokenChips[0] ? brokenChips[0].textContent : ''),
  brokenChips[0] ? brokenChips[0].textContent : '');

/* ---------------- 标题容错（## 后漏空格） ---------------- */
/* 用户实际踩过：写成 "##三、补充目录111"（漏了空格）。CommonMark 规定 # 后必须有空格，
   否则只是普通段落——字号比 "## 一、" 小一截，也进不了目录。
   render.js 现在会在解析前补上空格，这里把边界一起钉住。 */
const scratch = document.createElement('div');
document.body.appendChild(scratch);
const renderHeadings = (md) => {
  scratch.innerHTML = '';
  return window.SecRender.render(md, scratch, {});
};

let hs = renderHeadings('##三、补充目录111');
check('漏空格的 ## 也会渲染成标题',
  hs.length === 1 && hs[0].level === 2 && hs[0].text === '三、补充目录111',
  hs.map((h) => `h${h.level} ${h.text}`).join(' | ') || '（无标题）');

hs = renderHeadings('## 一、有空格\n##三、漏空格');
check('有空格与漏空格的标题层级一致（字号因此相同）',
  hs.length === 2 && hs[0].level === hs[1].level,
  hs.map((h) => `h${h.level} ${h.text}`).join(' | '));

check('代码块里的 # 注释不会被误当标题',
  renderHeadings('```bash\n# 这是注释\n```').length === 0);
check('四空格缩进的 ## 不会被误当标题',
  renderHeadings('    ##四空格缩进是代码块').length === 0);
check('行内代码后的 ## 不会被误改',
  renderHeadings('`a`##b').length === 0 && scratch.textContent.indexOf('##b') > -1,
  scratch.textContent.trim());
check('站点与编辑器共用同一份标题容错实现',
  typeof window.SecRender.normalizeHeadings === 'function' &&
  window.SecRender.normalizeHeadings('##x') === '## x' &&
  window.SecRender.normalizeHeadings('```\n#x\n```') === '```\n#x\n```');
scratch.remove();

/* ---------------- 预览与展示端一致性 ---------------- */
const SAMPLE = '# 标题\n\n正文 `code` 与 **粗体**。\n\n```bash\nls -la\n```\n\n' +
  '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n参见 [[Linux 日志分析与入侵痕迹排查]]。\n';
$('#body').value = SAMPLE;
$('#body').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(220);
const manageHtmlOut = $('#preview').innerHTML;

const siteDom = await JSDOM.fromURL(BASE + 'index.html', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w) {
    w.matchMedia = w.matchMedia || (() => ({
      matches: false, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}
    }));
    w.scrollTo = () => {};
  }
});
await new Promise((resolve) => {
  if (siteDom.window.document.readyState === 'complete') resolve();
  else siteDom.window.addEventListener('load', resolve, { once: true });
});
await wait(400);
const siteBox = siteDom.window.document.createElement('article');
siteBox.className = 'post-body';
siteDom.window.document.body.appendChild(siteBox);
siteDom.window.SecRender.render(SAMPLE, siteBox);
const siteHtmlOut = siteBox.innerHTML;

check('同一段 Markdown：管理端预览与展示端渲染逐字符一致',
  manageHtmlOut === siteHtmlOut,
  manageHtmlOut === siteHtmlOut ? '' : `管理端 ${manageHtmlOut.length} 字符 / 展示端 ${siteHtmlOut.length} 字符`);
check('两侧都把代码块渲染为 .code-block',
  /class="code-block"/.test(manageHtmlOut) && /class="code-block"/.test(siteHtmlOut));
siteDom.window.close();

/* ---------------- 导出 ---------------- */
const md = M.toMarkdown({
  slug: 'zz-export', title: '导出：冒号与"引号"', date: '2026-09-11',
  category: '验证分类', tags: ['A', 'B'], summary: '摘要', draft: true, body: '正文'
});
check('导出的 md 含 front-matter 标题且正确转义',
  /^---\ntitle: "导出：冒号与\\"引号\\""/.test(md), md.split('\n')[1]);
check('导出的 md 含分类与标签',
  /category: 验证分类/.test(md) && /tags: \[A, B\]/.test(md));
check('导出的 md 含草稿标记', /draft: true/.test(md));
check('导出的 md 末尾是正文', /正文$/.test(md.trim()));

downloads.length = 0;
click($('#btnExportJson'));
await wait(80);
const exported = downloads[0] ? JSON.parse(downloads[0].text) : null;
check('导出 notes.json 可解析', !!exported && Array.isArray(exported.notes));
check('导出内容含全部笔记', exported && exported.notes.length === M.state.notes.length,
  exported ? `${exported.notes.length} / ${M.state.notes.length}` : '');
check('导出内容含新笔记',
  exported && JSON.stringify(exported).indexOf('ZZ 管理端验证笔记') > -1);

downloads.length = 0;
click($('#btnDownloadMd'));
await wait(80);
check('下载当前 .md 生成文件', downloads.length === 1 && /^---\n/.test(downloads[0].text),
  downloads[0] ? downloads[0].text.slice(0, 20) : '');

/* ---------------- 导入备份 ---------------- */
const backup = {
  version: 1, source: 'manage.html', exportedAt: new Date().toISOString(),
  notes: [{
    slug: 'zz-imported', title: '导入的备份笔记', date: '2026-09-11',
    category: '验证分类', tags: ['导入'], summary: '', draft: false, body: '导入正文'
  }]
};
const file = new window.File([JSON.stringify(backup)], 'notes.json', { type: 'application/json' });
M.importFromFile(file);
await wait(220);
check('导入备份后库中出现该笔记',
  M.state.notes.some((n) => n.slug === 'zz-imported'),
  String(M.state.notes.length));
check('导入的笔记标记为未写入', M.state.synced['zz-imported'] === false);

/* ---------------- 删除 ---------------- */
const beforeDelete = M.state.notes.length;
M.openNote('zz-imported');
await wait(60);
click($('#btnDelete'));
await wait(60);
click($('#cfConfirm'));
await wait(120);
check('删除后库 -1', M.state.notes.length === beforeDelete - 1, String(M.state.notes.length));
check('删除后列表不再包含该笔记',
  !Array.prototype.some.call(document.querySelectorAll('.adm-item'),
    (el) => el.getAttribute('data-slug') === 'zz-imported'));
check('删除后回到空态', $('#editorInner').hidden === true);

/* ---------------- 重名保护 ---------------- */
M.newNote();
$('#fTitle').value = '同名测试';
click($('#btnSave'));
await wait(80);
const afterFirst = M.state.notes.length;
M.newNote();
$('#fTitle').value = '同名测试';
$('#fSlug').value = '';
click($('#btnSave'));
await wait(80);
check('同名文件不会覆盖已有笔记（数量不变）', M.state.notes.length === afterFirst,
  `${M.state.notes.length} vs ${afterFirst}`);
check('同名保存时给出提示', /已被/.test($('#toast').textContent), $('#toast').textContent);
check('原有笔记内容未被改动',
  (M.state.notes.filter((n) => n.slug === '同名测试')[0] || {}).body.indexOf('## 一、背景') > -1);

/* ---------------- 主题 ---------------- */
const themeBefore = document.documentElement.getAttribute('data-theme');
click($('#btnTheme'));
await wait(40);
check('主题可切换并持久化',
  document.documentElement.getAttribute('data-theme') !== themeBefore &&
  window.localStorage.getItem('secnotes.theme') === document.documentElement.getAttribute('data-theme'),
  document.documentElement.getAttribute('data-theme'));

/* ---------------- 一键同步（写回 notes/ + 重建） ---------------- */
/* 未连上服务时，保存后应提示启动服务，而不是假装成功 */
M.state.syncBase = '';
M.state.syncToken = '';
M.setSyncState(false);
M.offerSync();
await wait(60);
check('未检测到服务时提示启动方式',
  $('#modalSync').hidden === false && /python admin\.py/.test($('#syncText').textContent),
  $('#syncText').textContent.slice(0, 40));
$('#modalSync').hidden = true;

/* 连上服务后的同步流程（fetch 打桩，断言请求与后续状态） */
const syncCalls = [];
M.state.syncBase = 'http://127.0.0.1:8080/';
M.state.syncToken = 'stub-token';
M.setSyncState(true);
check('检测到服务后按钮变为「同步到站点」', $('#btnSync').textContent === '同步到站点',
  $('#btnSync').textContent);

window.fetch = function (url, opt) {
  syncCalls.push({ url: String(url), method: (opt && opt.method) || 'GET', body: opt && opt.body });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, written: 3, trashed: [], build: { ok: true } }) });
};
const sentBody = await M.syncWithServer();
await wait(80);
check('同步调用本地服务的 /api/sync', syncCalls.length === 1 && /\/api\/sync$/.test(syncCalls[0].url),
  syncCalls[0] ? syncCalls[0].url : '');
check('同步请求携带令牌与 JSON 体',
  syncCalls[0].method === 'POST' && /X-Admin-Token/i.test(JSON.stringify(syncCalls[0].body || '')) === false
    && typeof syncCalls[0].body === 'string');
const payload = JSON.parse(syncCalls[0].body);
check('同步体包含全部笔记', Array.isArray(payload.notes) && payload.notes.length === M.state.notes.length,
  `${payload.notes ? payload.notes.length : 0} / ${M.state.notes.length}`);
check('同步体包含待移除的笔记', Array.isArray(payload.removed));
check('同步成功后全部标记为已写入',
  M.state.notes.every((n) => M.state.synced[n.slug] === true));
check('同步成功后清空待移除列表', M.state.removed.length === 0);
check('同步成功后通知展示端刷新',
  !!window.localStorage.getItem('secnotes.reloadAt'));
check('同步成功后状态栏回执', /已同步/.test($('#stState').textContent), $('#stState').textContent);
check('同步流程返回成功', sentBody === true);

/* ---- 回归：必须校验构建结果 ----
   服务可能以 --no-rebuild 启动，或 build.py 执行失败。这两种情况下 notes/ 已改动、
   data/notes.js 却没重建，展示端永远看不到变化。过去只看 res.ok，
   于是会谎报「站点已重建」（真实踩过，表现为「删了却没反应」）。 */

/* 1) 构建被跳过（--no-rebuild）→ 明确告警，且不通展示端刷新 */
window.localStorage.removeItem('secnotes.reloadAt');
window.fetch = () => Promise.resolve({
  json: () => Promise.resolve({
    ok: true, written: 0, trashed: ['a.md'],
    build: { ok: true, skipped: true, output: '已跳过自动重建（--no-rebuild）' },
  }),
});
const rSkip = await M.syncWithServer();
await wait(80);
check('服务跳过重建时明确告警（不谎报「已重建」）',
  !/已同步/.test($('#stState').textContent) && /跳过|重建/.test($('#stState').textContent),
  $('#stState').textContent);
check('服务跳过重建时不通展示端刷新（避免白刷新）',
  !window.localStorage.getItem('secnotes.reloadAt'));
check('服务跳过重建时 removed 仍被清空（文件确实写入了）', M.state.removed.length === 0);
check('服务跳过重建时同步仍返回成功', rSkip === true);

/* 2) 构建失败（ok=false）→ 返回失败并告警 */
window.fetch = () => Promise.resolve({
  json: () => Promise.resolve({
    ok: true, written: 2, trashed: [],
    build: { ok: false, code: 1, output: 'Traceback ...' },
  }),
});
const rFail = await M.syncWithServer();
await wait(80);
check('构建失败时返回失败', rFail === false);
check('构建失败时状态栏告警', /失败/.test($('#stState').textContent), $('#stState').textContent);

/* 3) 构建成功 → 通知展示端刷新，文案为「已同步」 */
window.localStorage.removeItem('secnotes.reloadAt');
window.fetch = () => Promise.resolve({
  json: () => Promise.resolve({ ok: true, written: 2, trashed: [], build: { ok: true } }),
});
const rOk = await M.syncWithServer();
await wait(80);
check('构建成功时通知展示端刷新', !!window.localStorage.getItem('secnotes.reloadAt'));
check('构建成功时状态栏为「已同步」', /已同步/.test($('#stState').textContent), $('#stState').textContent);
check('构建成功时返回成功', rOk === true);

/* 保存即询问：点保存后应弹出同步确认，而不是直接结束 */
window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, written: 1, build: { ok: true } }) });
M.newNote();
$('#fTitle').value = 'ZZ 保存即同步';
$('#body').value = '正文';
$('#body').dispatchEvent(new window.Event('input', { bubbles: true }));
click($('#btnSave'));
await wait(120);
check('保存后弹出同步确认', $('#modalConfirm').hidden === false &&
  /同步到站点/.test($('#cfText').textContent), $('#cfText').textContent.slice(0, 30));
check('确认框提供「稍后再说」', $('#cfAlt').hidden === false && $('#cfAlt').textContent === '稍后再说',
  $('#cfAlt').textContent);
click($('#cfConfirm'));
await wait(140);
check('确认后自动完成同步', /已同步/.test($('#stState').textContent), $('#stState').textContent);

/* ---------------- 回归：removed 持久化 / 两端对账 / 文案准确性 ----------------
   背景：persist() 曾漏存 S.removed，导致"管理端删了、notes/ 里的文件还在"，
   于是展示端有而管理端没有，两端数量长期不一致。以下断言锁死这个行为。 */

/* 1) 删除后 removed 必须写进 localStorage（刷新后仍然记得要删谁） */
M.state.syncBase = 'http://127.0.0.1:8080/';
M.state.syncToken = 'stub-token';
M.newNote();
$('#fTitle').value = 'ZZ removed 持久化';
$('#body').value = '正文';
$('#body').dispatchEvent(new window.Event('input', { bubbles: true }));
click($('#btnSave'));
await wait(80);
if ($('#modalConfirm').hidden === false && $('#cfAlt') && $('#cfAlt').hidden === false) {
  click($('#cfAlt'));                      // 只保留本地保存，避免触发同步
}
await wait(80);
const persistSlug = M.state.current;
M.deleteCurrent();
await wait(80);
check('删除弹窗说明会移入回收站（可还原）',
  /回收站/.test($('#cfText').textContent), $('#cfText').textContent.slice(0, 46));
click($('#cfConfirm'));
await wait(100);
const storeAfterDelete = JSON.parse(window.localStorage.getItem('secnotes.manage.v1') || '{}');
check('删除后 removed 已持久化到本地库（刷新不丢）',
  Array.isArray(storeAfterDelete.removed) && storeAfterDelete.removed.indexOf(persistSlug) !== -1,
  'removed=' + JSON.stringify(storeAfterDelete.removed));

/* 2) 同步确认框应明确写出"写入几篇 / 移除几篇" */
M.offerSync();
await wait(80);
const syncText = $('#cfText').textContent;
check('同步确认框显示写入篇数', /写入/.test(syncText), syncText.slice(0, 60));
check('同步确认框显示将移入回收站的篇数', /移入回收站/.test(syncText), syncText.slice(0, 80));
if ($('#cfAlt') && $('#cfAlt').hidden === false) click($('#cfAlt'));
await wait(60);

/* 3) 启动对账：站点上有、本地库缺失的笔记要被补进来（反之会长期不一致） */
const siteNotes = (window.SEC_BLOG && window.SEC_BLOG.notes) || [];
const probe = {
  slug: 'zz-reconcile-probe', title: 'ZZ 对账探针', date: '2026-01-01',
  category: '未分类', tags: [], summary: '', draft: false, body: 'probe'
};
window.SEC_BLOG.notes = siteNotes.concat([probe]);
M.state.removed = M.state.removed.filter((s) => s !== probe.slug);
M.state.notes = M.state.notes.filter((n) => n.slug !== probe.slug);
/* 期望值 = 站点有、本地既没有也没标记删除的篇数（不写死数字，随内容变化自适应） */
const localSlugs = {}, removedSlugs = {};
M.state.notes.forEach((n) => { localSlugs[n.slug] = true; });
M.state.removed.forEach((s) => { removedSlugs[s] = true; });
const expectedAdopt = window.SEC_BLOG.notes
  .filter((n) => !localSlugs[n.slug] && !removedSlugs[n.slug]).length;
const adoptedA = M.reconcileWithSite();
check('对账会把站点上多出的笔记补进本地库',
  adoptedA === expectedAdopt && adoptedA >= 1 &&
  M.state.notes.some((n) => n.slug === probe.slug),
  `补入 ${adoptedA} 篇（期望 ${expectedAdopt}）`);

/* 已显式删除过的笔记不应该被对账重新拉回来 */
M.state.notes = M.state.notes.filter((n) => n.slug !== probe.slug);
M.state.removed.push(probe.slug);
const adoptedB = M.reconcileWithSite();
check('对账不会把显式删除过的笔记拉回来', adoptedB === 0, String(adoptedB));

/* 已在本地库里的笔记不会被重复添加 */
M.state.removed = M.state.removed.filter((s) => s !== probe.slug);
M.state.notes.push(probe);
const adoptedC = M.reconcileWithSite();
check('对账不会重复添加已有笔记', adoptedC === 0, String(adoptedC));

window.SEC_BLOG.notes = siteNotes;
M.state.notes = M.state.notes.filter((n) => n.slug !== probe.slug);

/* ---- 回归：「删除后展示端不同步」的根因 ----
   同步成功后 S.removed 会被清空。若此时本地库仍留着站点上已不存在的笔记，
   下次同步就会把它重新写回 notes/，等于把删除操作悄悄撤销 ——
   表现为「管理端删了、展示端还在」，且会无限循环。
   对账必须以站点为权威，双向对齐。 */

/* 1) 站点上没有、但本地库标记为「已同步」的笔记 → 必须被清理 */
M.state.notes = [{
  slug: 'zz-ghost-note', title: '幻影笔记', date: '2026-01-01',
  category: '未分类', tags: [], summary: '', draft: false, body: 'ghost',
}];
M.state.synced = { 'zz-ghost-note': true };
M.state.removed = [];
const adoptedD = M.reconcileWithSite();
check('对账清理站点上已不存在的已同步笔记（防止删除被撤销）',
  !M.state.notes.some((n) => n.slug === 'zz-ghost-note'),
  `补入 ${adoptedD} 篇，剩余 [${M.state.notes.map((n) => n.slug).join(',')}]`);

/* 2) 本地有未同步的改动（synced === false）→ 必须保留，否则丢用户数据 */
M.state.notes = [{
  slug: 'zz-local-unsaved', title: '本地未同步', date: '2026-01-01',
  category: '未分类', tags: [], summary: '', draft: false, body: 'local only',
}];
M.state.synced = { 'zz-local-unsaved': false };
M.state.removed = [];
M.reconcileWithSite();
check('对账不会清理本地未同步的改动',
  M.state.notes.some((n) => n.slug === 'zz-local-unsaved'),
  `[${M.state.notes.map((n) => n.slug).join(',')}]`);

/* 3) 待删除队列里的笔记 → 保留，交给同步流程处理 */
M.state.notes = [{
  slug: 'zz-pending-del', title: '待删除', date: '2026-01-01',
  category: '未分类', tags: [], summary: '', draft: false, body: 'pending',
}];
M.state.synced = { 'zz-pending-del': true };
M.state.removed = ['zz-pending-del'];
M.reconcileWithSite();
check('对账不会清理待删除队列里的笔记',
  M.state.notes.some((n) => n.slug === 'zz-pending-del'),
  `[${M.state.notes.map((n) => n.slug).join(',')}]`);

/* 4) 站点数据未加载（window.SEC_BLOG 缺失）→ 绝不能动本地库 */
const savedSecBlog = window.SEC_BLOG;
window.SEC_BLOG = undefined;
M.state.notes = [{
  slug: 'zz-must-keep', title: '必须保留', date: '2026-01-01',
  category: '未分类', tags: [], summary: '', draft: false, body: 'keep',
}];
M.state.synced = { 'zz-must-keep': true };
M.state.removed = [];
M.reconcileWithSite();
check('站点数据未加载时不做对账（防止清空本地库）',
  M.state.notes.some((n) => n.slug === 'zz-must-keep'),
  `[${M.state.notes.map((n) => n.slug).join(',')}]`);
window.SEC_BLOG = savedSecBlog;

/* 5) 幂等：连续对账两次结果不变 */
M.state.notes = [{
  slug: 'zz-idem', title: '幂等检查', date: '2026-01-01',
  category: '未分类', tags: [], summary: '', draft: false, body: 'idem',
}];
M.state.synced = { 'zz-idem': true };
M.state.removed = [];
M.reconcileWithSite();                       // 先让状态稳定下来
const lenStable = M.state.notes.length;
const idem1 = M.reconcileWithSite();
const idem2 = M.reconcileWithSite();
check('对账是幂等的（重复调用不产生副作用）',
  idem1 === 0 && idem2 === 0 && M.state.notes.length === lenStable,
  `补入 ${idem1}/${idem2}，长度 ${lenStable}→${M.state.notes.length}`);

/* ---- 思维导图：编辑器预览与站点共用 render.js，机制上保证一致 ---- */
const mmBox = window.SecRender.renderMindmap('中心主题\n  分支一\n    子节点\n  分支二');
check('renderMindmap 输出思维导图容器',
  !!mmBox && mmBox.classList.contains('mindmap'));
check('renderMindmap 生成 SVG 与 4 个节点',
  !!mmBox && !!mmBox.querySelector('svg.mm-svg') && mmBox.querySelectorAll('.mm-node').length === 4,
  mmBox ? String(mmBox.querySelectorAll('.mm-node').length) : '-');
check('renderMindmap 连线数 = 节点数 - 1',
  !!mmBox && mmBox.querySelectorAll('.mm-edge').length === 3,
  mmBox ? String(mmBox.querySelectorAll('.mm-edge').length) : '-');
check('renderMindmap 空内容返回 null（调用方回退为代码块）',
  window.SecRender.renderMindmap('   \n  \n') === null);
check('render() 可用 opts.mindmap=false 关闭思维导图',
  (function () {
    const host = document.createElement('div');
    window.SecRender.render('```mindmap\nA\n  B\n```', host, { mindmap: false });
    return !!host.querySelector('.code-block') && !host.querySelector('.mindmap');
  })());

/* ---- slug 规则：必须与 build.py 一致，且绝不编造随机名 ----
   背景：前端曾在空输入时生成 `note-日期-随机` 的 slug，
   于是「同一篇再保存一次」变成「多出一篇新文章」；
   两侧规则还曾不一致（111 → 111 / note），导致管理端与磁盘对不上。 */
check('slugify：普通中英标题', M.slugify('Nmap 实战') === 'nmap-实战', M.slugify('Nmap 实战'));
check('slugify：保留开头的数字（不再被剥掉）',
  M.slugify('111 测试') === '111-测试', M.slugify('111 测试'));
check('slugify：下划线转横线（与 build.py 一致）',
  M.slugify('A_B') === 'a-b', M.slugify('A_B'));
check('slugify：无法生成时返回空串（不编造随机名）',
  M.slugify('!!!') === '' && M.slugify('') === '' && M.slugify('   ') === '',
  JSON.stringify([M.slugify('!!!'), M.slugify(''), M.slugify('   ')]));
check('slugify 幂等（对已是 slug 的输入不再改变）',
  M.slugify('111-测试') === '111-测试' && M.slugify('a-b') === 'a-b');

/* 空 slug 的保存必须被拒绝，否则每存一次就多一篇 */
const notesBeforeBad = M.state.notes.length;
M.newNote();
$('#fTitle').value = '!!!';
$('#body').value = 'no usable chars in title';
M.saveCurrent(true);
check('标题无法生成文件名时拒绝保存（不会新增笔记）',
  M.state.notes.length === notesBeforeBad,
  `${notesBeforeBad} -> ${M.state.notes.length}`);

/* ---- 启动器必须用 http:// 打开管理端 ----
   这是本次排查出的根因：file:// 页面无法向 http://127.0.0.1:8080 发起脚本请求，
   于是 JSONP 令牌握手失败，管理端连不上服务，同步**静默地从未执行**，
   删除只停留在浏览器 localStorage 里。改为 http 打开后两端同 origin，
   刷新信号也能双向传达。 */
const batSrc = readFileSync(join(PROJECT, 'start-admin.bat'), 'utf8');
check('启动器以 http:// 打开管理端（file:// 下连不上服务）',
  /start "" "http:\/\/127\.0\.0\.1:8080\/manage\.html"/.test(batSrc),
  (batSrc.split('\n').find((l) => l.includes('manage.html')) || '').trim());

/* ---- 生产 Python 脚本都必须做 stdout UTF-8 加固 ----
   中文 Windows 控制台/管道默认 GBK，而 GBK 编码不了 emoji；这些脚本的统计输出
   含 📚/✅/✗ 等符号，漏掉任何一个都会让用户手动运行它时 UnicodeEncodeError。
   新增脚本时这条断言会立刻提醒补上 reconfigure。 */
const PY_SCRIPTS = ['build.py', 'admin.py', 'new-note.py', 'export.py', 'share-server.py'];
const pyMissing = PY_SCRIPTS.filter((f) => {
  try {
    return !/reconfigure\(encoding="utf-8"/.test(readFileSync(join(PROJECT, f), 'utf8'));
  } catch {
    return true;
  }
});
check('所有生产 Python 脚本都做了 stdout UTF-8 加固',
  pyMissing.length === 0, pyMissing.join(', ') || '全部已加固');

/* ---- 回收站（.trash/ 的入口，依赖本地服务） ---- */
check('工具栏有回收站入口', !!$('#btnTrash'));

/* 1) 服务未连接 → 明确指引，而不是空白 */
M.state.syncBase = '';
M.state.syncToken = '';
click($('#btnTrash'));
await wait(100);
check('回收站面板可以打开', $('#modalTrash').hidden === false);
check('未连接服务时给出明确指引（不静默失败）',
  /本地服务|admin\.py/.test($('#trashList').textContent),
  $('#trashList').textContent.trim().slice(0, 60));

/* 2) 有数据 → 渲染条目，含删除时间、原始文件名与两个动作 */
M.state.syncBase = 'http://127.0.0.1:8080/';
M.state.syncToken = 'stub-token';
window.fetch = () => Promise.resolve({
  json: () => Promise.resolve({
    ok: true,
    trash: [
      { name: '20260913-141854-aaa.md', title: '被删的甲', size: 1024, deleted_at: '2026-09-13 14:18', original: 'aaa.md' },
      { name: '20260913-142009-bbb.md', title: '被删的乙', size: 2048, deleted_at: '2026-09-13 14:20', original: 'bbb.md' },
    ],
  }),
});
click($('#btnTrashRefresh'));
await wait(150);
check('回收站渲染出条目',
  document.querySelectorAll('#trashList .mg-trash-item').length === 2,
  String(document.querySelectorAll('#trashList .mg-trash-item').length));
check('条目展示删除时间与原始文件名',
  /14:18/.test($('#trashList').textContent) && /aaa\.md/.test($('#trashList').textContent));
check('每条都提供还原与彻底删除',
  document.querySelectorAll('#trashList [data-restore]').length === 2 &&
  document.querySelectorAll('#trashList [data-purge]').length === 2);

/* 3) 还原 → 调用 /api/restore 并带上完整文件名 */
const restoreCalls = [];
window.fetch = (url, init) => {
  restoreCalls.push({ url: String(url), body: (init && init.body) || '' });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, restored: 'aaa.md', build: { ok: true } }) });
};
click(document.querySelector('#trashList [data-restore]'));
await wait(180);
check('还原调用 /api/restore 且带上文件名',
  restoreCalls.some((c) => /\/api\/restore$/.test(c.url) && /20260913-141854-aaa\.md/.test(c.body)),
  restoreCalls.map((c) => c.url).join(' '));

/* 4) 彻底删除 → 必须先二次确认；未确认不得调用接口。
   #modalConfirm 是共用的（"保存后询问同步"也用它），先清掉可能残留的询问，
   否则点 purge 会误触同步确认，断言串到别的流程上。
   另外：还原成功后 loadTrash() 会重新拉列表，所以这个 mock 必须**同时**返回
   trash，否则列表被渲染成空，后面就取不到 [data-purge] 了。 */
$('#modalConfirm').hidden = true;
const purgeCalls = [];
const twoTrash = [
  { name: '20260913-141854-aaa.md', title: '被删的甲', size: 1024, deleted_at: '2026-09-13 14:18', original: 'aaa.md' },
  { name: '20260913-142009-bbb.md', title: '被删的乙', size: 2048, deleted_at: '2026-09-13 14:20', original: 'bbb.md' },
];
window.fetch = (url, init) => {
  purgeCalls.push({ url: String(url), body: (init && init.body) || '' });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, purged: 'x', trash: twoTrash }) });
};
click($('#btnTrashRefresh'));
await wait(150);
check('彻底删除前列表已重新渲染', !!document.querySelector('#trashList [data-purge]'));
click(document.querySelector('#trashList [data-purge]'));
await wait(120);
check('彻底删除先弹二次确认且写明不可还原',
  $('#modalConfirm').hidden === false && /无法还原/.test($('#cfText').textContent),
  $('#cfText').textContent.slice(0, 40));
/* 注意这里会混入 /api/state（上面刚点了刷新），所以只判断 purge 没被调用 */
check('未确认前不调用 /api/purge',
  !purgeCalls.some((c) => /\/api\/purge$/.test(c.url)),
  purgeCalls.map((c) => c.url).join(' '));
click($('#cfConfirm'));
await wait(180);
check('确认后调用 /api/purge 并带 confirm:true',
  purgeCalls.some((c) => /\/api\/purge$/.test(c.url) && /"confirm":true/.test(c.body)),
  purgeCalls.map((c) => c.url).join(' '));

/* 关闭回收站面板，避免影响后续断言 */
$('#modalTrash').hidden = true;

/* ---------------- 清理：恢复本地库 ---------------- */
const cleaned = M.state.notes.filter((n) => n.slug.indexOf('zz-') !== 0 && n.title.indexOf('ZZ ') !== 0);
M.state.notes = cleaned;
window.localStorage.removeItem('secnotes.manage.v1');

console.log(results.join('\n'));
console.log(`\n合计 ${results.length} 项检查，失败 ${failed} 项\n`);
window.close();
server.close();
process.exit(failed ? 1 : 0);
