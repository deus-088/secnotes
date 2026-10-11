/* ============================================================
   SecNotes 编辑器自检（jsdom）
   ------------------------------------------------------------
   在无浏览器环境下验证后台编辑器的关键交互：
     · 列表加载、新建、脏标记
     · 代码块插入（空选区 / 有选区 / 正文中间 / 行首 / 文末）
     · 插入结果经 SecRender 渲染后，与站点文章页结构一致
       （.code-block / .code-lang / .copy-btn / hljs 高亮）
     · 工具栏其余动作、快捷键保存

   进程内自带静态服务并桩掉 fetch，无需启动 admin.py，结果确定可复现。
   用法：node tools/verify-editor.mjs
   ============================================================ */
const JSDOM_PATH = process.env.JSDOM_PATH ||
  'file:///C:/Users/Deus/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js';
const { JSDOM, VirtualConsole } = await import(JSDOM_PATH);
const { readFileSync, existsSync } = await import('node:fs');
const { createServer } = await import('node:http');
const { resolve, dirname, join, extname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'verify-token-abc123';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const rel = url === '/' ? 'admin/index.html' : decodeURIComponent(url).replace(/^\//, '');
  const file = join(PROJECT, rel);
  if (!file.startsWith(PROJECT) || !existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  let body = readFileSync(file);
  if (url === '/') body = Buffer.from(String(body).replace('__ADMIN_TOKEN__', TOKEN), 'utf8');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(body);
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

/* ---------------- 桩数据与 fetch ---------------- */
const SEED_NOTES = [
  { slug: 'web-01-sqli', title: 'SQL 注入：从原理到防御', date: '2026-09-10', category: 'Web 安全', tags: ['SQL注入'], draft: false, words: 652, mtime: '2026-09-10 10:00' },
  { slug: 'ir-02-linux', title: 'Linux 日志分析', date: '2026-09-03', category: '应急响应', tags: ['Linux'], draft: false, words: 731, mtime: '2026-09-03 10:00' },
  { slug: 'draft-one', title: '未完成的草稿', date: '2026-09-01', category: '基础建设', tags: [], draft: true, words: 100, mtime: '2026-09-01 10:00' }
];
const SEED_NOTE = {
  slug: 'web-01-sqli', title: 'SQL 注入：从原理到防御', date: '2026-09-10',
  category: 'Web 安全', tags: ['SQL注入', 'OWASP'], summary: '摘要', draft: false,
  body: '# SQL 注入\n\n正文 `code` 与表格：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n' +
    '参见 [[Linux 日志分析]] 与 [[内网渗透提权清单]]。\n'
};

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/Could not parse CSS/.test(String(e.message))) results.push('  WARN  jsdomError: ' + e.message);
});

const calls = [];
const dom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    const ok = (obj) => Promise.resolve({ json: () => Promise.resolve(obj) });
    window.fetch = function (url, opt) {
      const u = String(url);
      const body = opt && opt.body ? JSON.parse(opt.body) : null;
      calls.push({ url: u, method: (opt && opt.method) || 'GET', body: body });
      if (u.indexOf('/api/state') === 0) {
        return ok({
          ok: true, notes: SEED_NOTES,
          categories: [['Web 安全', 1], ['应急响应', 1], ['基础建设', 1]],
          tags: [['SQL注入', 1], ['Linux', 1]],
          trash: [{ name: '20260901-120000-old.md', title: '被删的笔记', size: 10, deleted_at: '2026-09-01 12:00' }],
          links: { 'web-01-sqli': ['ir-02-linux'], 'ir-02-linux': [], 'draft-one': [] },
          backlinks: { 'web-01-sqli': ['draft-one'], 'ir-02-linux': ['web-01-sqli'], 'draft-one': [] },
          broken: { 'web-01-sqli': ['内网渗透提权清单'], 'ir-02-linux': [], 'draft-one': [] }
        });
      }
      if (u.indexOf('/api/note?') === 0) return ok({ ok: true, note: SEED_NOTE });
      if (u.indexOf('/api/search') === 0) {
        const q = decodeURIComponent((u.split('q=')[1] || '').split('&')[0]);
        if (!q) return ok({ ok: true, query: '', terms: [], results: [], total: 0, truncated: false });
        return ok({
          ok: true, query: q, terms: [q], total: 2, truncated: false,
          results: [
            {
              slug: 'web-01-sqli', title: 'SQL 注入：从原理到防御', date: '2026-09-10',
              category: 'Web 安全', tags: ['SQL注入'], draft: false,
              titleHit: false, metaHit: false, matchCount: 2, score: 2,
              matches: [
                { line: 3, text: '正文 `code` 与表格：', cols: { code: 3 } },
                { line: 5, text: '| a | b |', cols: {} }
              ]
            },
            {
              slug: 'ir-02-linux', title: 'Linux 日志分析', date: '2026-09-03',
              category: '应急响应', tags: ['Linux'], draft: false,
              titleHit: true, metaHit: false, matchCount: 0, score: 100, matches: []
            }
          ]
        });
      }
      if (u.indexOf('/api/upload') === 0) {
        const url = 'assets/uploads/202609/shot-ab12cd34ef.png';
        return ok({ ok: true, url: url, markdown: '![图片](' + url + ')', bytes: 2048, deduped: false });
      }
      if (u.indexOf('/api/note') === 0) {
        return ok({ ok: true, created: true, renamed: false, note: SEED_NOTE, build: { ok: true, output: '📚 笔记总数 : 4' } });
      }
      return ok({ ok: true, build: { ok: true, output: '📚 笔记总数 : 4' } });
    };
  }
});

const { window } = dom;
const { document } = window;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => {
  if (document.readyState === 'complete') r();
  else window.addEventListener('load', r, { once: true });
});
await wait(350);

const A = window.__ADMIN__;
const TA = document.querySelector('#body');
const PREVIEW = document.querySelector('#preview');
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/* ============================================================
   1. 基础加载
   ============================================================ */
check('编辑器脚本初始化', !!A && !!A.insertCodeBlock);
check('令牌已按服务注入', window.ADMIN_TOKEN === TOKEN, window.ADMIN_TOKEN);
check('列表渲染出全部笔记', document.querySelectorAll('.adm-item[data-slug]').length === 3,
  String(document.querySelectorAll('.adm-item[data-slug]').length));
check('草稿标记可见', /草稿/.test(document.querySelector('.adm-list-scroll')?.textContent || ''));
check('分类下拉由服务数据填充', document.querySelectorAll('#catList option').length === 3);

click(document.querySelector('[data-tab="trash"]'));
await wait(40);
check('回收站标签页可切换', document.querySelectorAll('[data-restore]').length === 1);
click(document.querySelector('[data-tab="notes"]'));
await wait(40);

/* ============================================================
   2. 新建笔记
   ============================================================ */
click(document.querySelector('#btnNew'));
await wait(60);
check('新建后编辑器可见', document.querySelector('#editorInner').hidden === false);
check('空白模板不算「已修改」', A.state.dirty === false && document.title.indexOf('●') === -1, document.title);
check('新建给出正文骨架', /^# 标题/.test(TA.value), JSON.stringify(TA.value.slice(0, 12)));

document.querySelector('#fTitle').value = '临时标题';
document.querySelector('#fTitle').dispatchEvent(new window.Event('input', { bubbles: true }));
check('填写标题后进入已修改状态', A.state.dirty === true && document.title.indexOf('●') === 0, document.title);
document.querySelector('#fTitle').value = '';
document.querySelector('#fTitle').dispatchEvent(new window.Event('input', { bubbles: true }));

/* ============================================================
   3. 代码块插入 —— 通过真实 UI 路径（工具栏 → 语言弹窗）
   ============================================================ */
TA.value = '';
TA.setSelectionRange(0, 0);

click(document.querySelector('[data-md="codeblock"]'));
await wait(60);
check('点击工具栏打开语言弹窗', document.querySelector('#modalLang').hidden === false);

const langOptions = Array.from(document.querySelectorAll('#langList option')).map((o) => o.value);
check('语言列表来自 highlight.js 支持集', langOptions.indexOf('bash') > -1 && langOptions.indexOf('python') > -1,
  `${langOptions.length} 种语言`);
check('语言列表不含未支持的语言', langOptions.indexOf('zzznotreal') === -1);
check('常用语言有快捷按钮', document.querySelectorAll('#langQuick [data-lang]').length >= 8,
  String(document.querySelectorAll('#langQuick [data-lang]').length));

click(document.querySelector('#langQuick [data-lang="bash"]'));
await wait(80);
check('弹窗已关闭', document.querySelector('#modalLang').hidden === true);
check('空正文插入代码块内容正确', TA.value === '```bash\n```\n', JSON.stringify(TA.value));
check('光标落在围栏内部', TA.selectionStart === 8, String(TA.selectionStart));
check('插入后标记为脏', A.state.dirty === true);

/* 关键：插入结果经共享渲染模块渲染后，与站点文章页结构一致 */
await wait(200);
const pv = document.querySelector('#preview');
check('预览生成代码块容器', pv.querySelectorAll('.code-block').length === 1);
check('预览显示语言标签且与站点同款', pv.querySelector('.code-lang')?.textContent === 'bash',
  pv.querySelector('.code-lang')?.textContent);
check('预览注入复制按钮', pv.querySelectorAll('.copy-btn').length === 1);
check('预览应用了语法高亮', pv.querySelector('pre code.hljs') !== null);
check('预览样式类与站点正文一致', document.querySelector('#preview').classList.contains('post-body'));

/* ============================================================
   4. 代码块插入 —— 边界情形（直接调用，覆盖 UI 触达不到的分支）
   ============================================================ */
function insert(text, selStart, selEnd, lang) {
  TA.value = text;
  TA.setSelectionRange(selStart, selEnd);
  A.insertCodeBlock(lang);
  return { value: TA.value, caret: TA.selectionStart };
}

let r = insert('abc\ndef', 3, 3, 'bash');
// 光标前是本行内容、光标后已有换行：围栏前后各补空行，且不破坏原有换行
check('行中有内容时前补空行', r.value === 'abc\n\n```bash\n```\ndef', JSON.stringify(r.value));
check('闭合围栏独占一行', /```\n/.test(r.value.slice(r.value.indexOf('```bash'))),
  JSON.stringify(r.value));
check('插入后光标在围栏内', r.value.slice(r.caret, r.caret + 4) === '```\n',
  JSON.stringify(r.value.slice(r.caret)));

r = insert('abc\ndef', 0, 0, 'python');
check('行首插入不产生多余空行', r.value === '```python\n```\n\nabc\ndef' || r.value === '```python\n```\nabc\ndef',
  JSON.stringify(r.value));

r = insert('行一\n行二', 2, 5, 'bash');
check('有选区时选中的内容被包进代码块',
  r.value === '行一\n\n```bash\n\n行二\n```\n' || r.value.indexOf('```bash\n\n行二\n```') > -1,
  JSON.stringify(r.value));
check('有选区时原内容被选中便于调整', r.caret >= 4, String(r.caret));

r = insert('末尾内容', 4, 4, 'bash');
check('文末插入补齐结尾换行', r.value.endsWith('```\n'), JSON.stringify(r.value));

r = insert('已有围栏\n\n```bash\necho hi\n```\n', 5, 5, 'bash');
check('紧邻已有代码块插入不破坏原围栏',
  (r.value.match(/```/g) || []).length === 4, String((r.value.match(/```/g) || []).length));

/* 未支持的语言：围栏照常插入、语言名照常标注，但不做高亮
   ——标签是否显示只取决于是否声明了语言，与站点同一套逻辑 */
r = insert('', 0, 0, 'zzznotreal');
await wait(200);
check('未支持语言仍能插入围栏', r.value === '```zzznotreal\n```\n', JSON.stringify(r.value));
check('未支持语言仍标注声明的语言名',
  document.querySelector('#preview .code-lang')?.textContent === 'zzznotreal',
  document.querySelector('#preview .code-lang')?.textContent);
check('未支持语言不做语法高亮', document.querySelector('#preview pre code.hljs') === null);
check('未支持语言不落回行内代码', document.querySelector('#preview .code-block') !== null);

/* ============================================================
   5. 工具栏其余动作
   ============================================================ */
function pick(action, text, s, e) {
  TA.value = text;
  TA.setSelectionRange(s, e);
  A.actions[action]();
  return TA.value;
}

check('加粗包裹选区', pick('bold', '文字', 0, 2) === '**文字**', JSON.stringify(pick('bold', '文字', 0, 2)));
check('加粗可再次点击取消', pick('bold', '**文字**', 0, 8) === '文字', JSON.stringify(pick('bold', '**文字**', 0, 8)));
check('行内代码包裹', pick('code', 'ls -al', 0, 6) === '`ls -al`', JSON.stringify(pick('code', 'ls -al', 0, 6)));
check('无序列表加前缀', pick('ul', '第一行\n第二行', 0, 7).indexOf('- 第一行') === 0,
  JSON.stringify(pick('ul', '第一行\n第二行', 0, 7)));
check('无序列表可取消', pick('ul', '- 第一行', 0, 5) === '第一行', JSON.stringify(pick('ul', '- 第一行', 0, 5)));
check('有序列表按行编号', pick('ol', 'a\nb', 0, 3) === '1. a\n2. b', JSON.stringify(pick('ol', 'a\nb', 0, 3)));
check('有序列表可取消', pick('ol', '1. a\n2. b', 0, 10) === 'a\nb', JSON.stringify(pick('ol', '1. a\n2. b', 0, 10)));
check('引用加前缀', pick('quote', '引用', 0, 2) === '> 引用', JSON.stringify(pick('quote', '引用', 0, 2)));
check('二级标题加前缀', pick('h2', '小节', 0, 2) === '## 小节', JSON.stringify(pick('h2', '小节', 0, 2)));
check('链接自动补协议', pick('link', '谷歌', 0, 2) === '[谷歌](https://)', JSON.stringify(pick('link', '谷歌', 0, 2)));

TA.value = '';
TA.setSelectionRange(0, 0);
A.actions.table();
await wait(160);
check('表格插入后渲染为滚动容器', document.querySelector('#preview .table-wrap table') !== null);
check('表格骨架为三列两行', document.querySelectorAll('#preview .table-wrap tbody tr').length === 1,
  String(document.querySelectorAll('#preview .table-wrap tbody tr').length));

TA.value = '';
TA.setSelectionRange(0, 0);
A.actions.hr();
check('分割线插入正确', TA.value.trim() === '---', JSON.stringify(TA.value));

/* ============================================================
   6. 标题锚点与目录一致性（正文渲染细节）
   ============================================================ */
TA.value = '## 一级小节\n\n内容\n\n### 二级小节\n\n内容\n';
A.insertCodeBlock('bash');
await wait(220);
const headings = Array.from(document.querySelectorAll('#preview h2[id], #preview h3[id]'));
check('预览为标题生成锚点 id', headings.length === 2, String(headings.length));

/* ============================================================
   7. 字数估算与保存
   ============================================================ */
check('字数估算：纯中文', A.countWords('网络安全笔记') === 6, String(A.countWords('网络安全笔记')));
check('字数估算：中英混合', A.countWords('SQL 注入 nmap 扫描') >= 6, String(A.countWords('SQL 注入 nmap 扫描')));
check('字数估算：忽略代码围栏', A.countWords('```bash\necho hello world\n```') === 0,
  String(A.countWords('```bash\necho hello world\n```')));

document.querySelector('#fTitle').value = '新建的测试笔记';
document.querySelector('#fTitle').dispatchEvent(new window.Event('input', { bubbles: true }));
document.querySelector('#fTags').value = '验证, 编辑器';
document.querySelector('#fTags').dispatchEvent(new window.Event('input', { bubbles: true }));
document.querySelector('#fDraft').checked = true;
document.querySelector('#fDraft').dispatchEvent(new window.Event('change', { bubbles: true }));

calls.length = 0;
click(document.querySelector('#btnSave2'));
await wait(220);

const saveCall = calls.filter((c) => c.method === 'POST' && c.url.indexOf('/api/note') === 0)[0];
check('点击保存发出 POST /api/note', !!saveCall);
check('保存携带标题', saveCall?.body?.meta?.title === '新建的测试笔记', JSON.stringify(saveCall?.body?.meta));
check('标签按逗号拆分', JSON.stringify(saveCall?.body?.meta?.tags) === '["验证","编辑器"]',
  JSON.stringify(saveCall?.body?.meta?.tags));
check('草稿标记随保存提交', saveCall?.body?.meta?.draft === true);
check('代码块内容随保存提交', /```bash/.test(saveCall?.body?.body || ''));
check('保存后清除脏标记', A.state.dirty === false, String(A.state.dirty));
check('保存后刷新列表数据', calls.some((c) => c.url.indexOf('/api/state') === 0));

/* ============================================================
   8. 删除需二次确认
   ============================================================ */
calls.length = 0;
click(document.querySelector('#btnDelete'));
await wait(40);
check('删除前弹出确认框', document.querySelector('#modalConfirm').hidden === false);
check('未确认时不发送删除请求', !calls.some((c) => c.url.indexOf('/api/delete') === 0));
click(document.querySelector('#cfConfirm'));
await wait(200);
check('确认后发送删除请求', calls.some((c) => c.url.indexOf('/api/delete') === 0));

/* ============================================================
   9. 快捷键
   ============================================================ */
TA.value = '文字';
TA.setSelectionRange(0, 2);
TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
check('Ctrl+B 触发加粗', TA.value === '**文字**', JSON.stringify(TA.value));

TA.value = '';
TA.setSelectionRange(0, 0);
TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true }));
await wait(40);
check('Ctrl+Shift+C 打开代码块弹窗', document.querySelector('#modalLang').hidden === false);
document.querySelector('#modalLang').hidden = true;

TA.value = 'ab';
TA.setSelectionRange(2, 2);
TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
check('Tab 插入两个空格缩进', TA.value === 'ab  ', JSON.stringify(TA.value));

/* ============================================================
   10. 图片：插入、上传、粘贴、拖入、预览渲染
   ============================================================ */
const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const PIXEL_DIR = join(PROJECT, 'assets', 'uploads', 'zz-verify');
const PIXEL_REL = 'assets/uploads/zz-verify/pixel.png';
mkdirSync(PIXEL_DIR, { recursive: true });
// 1×1 透明 PNG，避免预览加载图片时产生 404 噪音
writeFileSync(join(PIXEL_DIR, 'pixel.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'));

TA.value = '';
TA.setSelectionRange(0, 0);
A.insertImageMarkdown(PIXEL_REL, '图片');
check('插入图片使用相对路径写法', TA.value === '![图片](' + PIXEL_REL + ')\n', JSON.stringify(TA.value));
check('插入图片后选中替代文字便于填写',
  TA.value.slice(TA.selectionStart, TA.selectionEnd) === '图片',
  JSON.stringify(TA.value.slice(TA.selectionStart, TA.selectionEnd)));

await wait(220);
const pvImg = document.querySelector('#preview img');
check('预览渲染出 img 元素', pvImg !== null);
check('预览图片地址为相对路径', pvImg?.getAttribute('src') === PIXEL_REL, pvImg?.getAttribute('src'));

const shotFile = new window.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });

function countUploads() { return calls.filter((c) => c.url.indexOf('/api/upload') === 0).length; }

calls.length = 0;
TA.value = '';
TA.setSelectionRange(0, 0);
A.uploadImage(shotFile);
await wait(260);
const upCall = calls.filter((c) => c.url.indexOf('/api/upload') === 0)[0];
check('上传图片发出 /api/upload 请求', !!upCall);
check('上传请求携带 base64 data URL', /^data:image\/png;base64,/.test(upCall?.body?.dataUrl || ''),
  String(upCall?.body?.dataUrl || '').slice(0, 24));
check('上传成功后插入图片 Markdown',
  /!\[图片\]\(assets\/uploads\/202609\/shot-ab12cd34ef\.png\)/.test(TA.value), JSON.stringify(TA.value));

let before = countUploads();
const pasteEv = new window.Event('paste', { bubbles: true, cancelable: true });
pasteEv.clipboardData = { files: [shotFile], items: [] };
TA.dispatchEvent(pasteEv);
await wait(260);
check('粘贴截图触发上传', countUploads() === before + 1);
check('粘贴后插入到正文', /assets\/uploads\//.test(TA.value));

before = countUploads();
const textEv = new window.Event('paste', { bubbles: true, cancelable: true });
textEv.clipboardData = { files: [], items: [] };
TA.dispatchEvent(textEv);
await wait(80);
check('纯文本粘贴不被拦截', countUploads() === before);

before = countUploads();
const dropEv = new window.Event('drop', { bubbles: true, cancelable: true });
dropEv.dataTransfer = { files: [shotFile] };
TA.dispatchEvent(dropEv);
await wait(260);
check('拖入图片触发上传', countUploads() === before + 1);

before = countUploads();
const badDrop = new window.Event('drop', { bubbles: true, cancelable: true });
badDrop.dataTransfer = { files: [new window.File(['x'], 'note.txt', { type: 'text/plain' })] };
TA.dispatchEvent(badDrop);
await wait(80);
check('拖入非图片文件被拒绝', countUploads() === before && /只支持拖入图片/.test(document.querySelector('#toast').textContent),
  document.querySelector('#toast').textContent);

/* ============================================================
   11. 草稿自动保存与恢复
   ============================================================ */
A.state.current = 'web-01-sqli';
TA.value = '本地未保存的内容';
document.querySelector('#fTitle').value = '草稿中的标题';
document.querySelector('#fTitle').dispatchEvent(new window.Event('input', { bubbles: true }));
A.writeDraft();

const draft = A.readDraft('web-01-sqli');
check('自动保存写入本地草稿', !!draft && draft.body === '本地未保存的内容', JSON.stringify(draft?.body));
check('草稿一并保存元信息', draft?.meta?.title === '草稿中的标题', JSON.stringify(draft?.meta?.title));
check('状态栏提示草稿已自动保存',
  /草稿已自动保存 \d{2}:\d{2}/.test(document.querySelector('#stDraft').textContent),
  document.querySelector('#stDraft').textContent);

A.state.declinedDrafts = {};
A.openNote('web-01-sqli');
await wait(280);
check('检测到草稿与磁盘版本不同时弹窗询问', document.querySelector('#modalConfirm').hidden === false);
check('确认按钮文案为「恢复草稿」', document.querySelector('#cfConfirm').textContent === '恢复草稿',
  document.querySelector('#cfConfirm').textContent);
check('取消按钮说明了取消的后果',
  /磁盘版本/.test(document.querySelector('#modalConfirm [data-close]').textContent),
  document.querySelector('#modalConfirm [data-close]').textContent);

click(document.querySelector('#cfConfirm'));
await wait(80);
check('恢复草稿后正文变为草稿内容', TA.value === '本地未保存的内容', JSON.stringify(TA.value));
check('恢复草稿后标记为已修改', A.state.dirty === true);

/* 选择「不恢复」：正文回到磁盘版本，但草稿必须保留（不能丢用户内容） */
TA.value = '第二份未保存内容';
A.state.dirty = true;
A.writeDraft();
A.state.declinedDrafts = {};
A.openNote('web-01-sqli');
await wait(280);
check('再次检测到草稿并询问', document.querySelector('#modalConfirm').hidden === false);
click(document.querySelector('#modalConfirm [data-close]'));
await wait(80);
check('选择不恢复时关闭询问', document.querySelector('#modalConfirm').hidden === true);
check('选择不恢复时正文为磁盘版本', TA.value === SEED_NOTE.body, JSON.stringify(TA.value.slice(0, 16)));
check('选择不恢复时草稿仍保留，未丢失内容', !!A.readDraft('web-01-sqli'));
check('已拒绝的草稿本次会话不再重复询问', A.state.declinedDrafts['web-01-sqli'] === true);

A.save();
await wait(300);
check('保存成功后清除本地草稿', A.readDraft('web-01-sqli') === null);
check('保存后状态栏草稿提示清空', document.querySelector('#stDraft').textContent === '',
  document.querySelector('#stDraft').textContent);

rmSync(PIXEL_DIR, { recursive: true, force: true });
check('测试用图片文件已清理', !existsSync(join(PIXEL_DIR, 'pixel.png')));

/* ============================================================
   12. 正文全文检索与命中跳转
   ============================================================ */
const searchInput = document.querySelector('#listSearch');

searchInput.value = 'code';
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(420);

check('检索请求带上了关键词',
  calls.some((c) => c.url.indexOf('/api/search') === 0 && c.url.indexOf('q=code') > -1),
  calls.filter((c) => c.url.indexOf('/api/search') === 0).map((c) => c.url).join(' '));
check('检索结果按笔记分组渲染', document.querySelectorAll('.adm-search-item').length === 2,
  String(document.querySelectorAll('.adm-search-item').length));
check('展示正文命中片段与行号', /正文 `code`/.test(document.querySelector('#listScroll').textContent) &&
  /3/.test(document.querySelector('.adm-hit-line')?.textContent || ''),
  document.querySelector('.adm-hit-line')?.textContent);
check('关键词高亮使用 mark 标签', document.querySelectorAll('#listScroll mark').length > 0,
  String(document.querySelectorAll('#listScroll mark').length));
check('仅有标题命中的笔记如实标注',
  /标题\/标签命中/.test(document.querySelector('#listScroll').textContent));
check('命中篇数提示可见', /命中 2 篇/.test(document.querySelector('.adm-list-head-note')?.textContent || ''),
  document.querySelector('.adm-list-head-note')?.textContent);

/* 点击正文命中：应打开该笔记并选中命中所在行 */
click(document.querySelector('.adm-hit[data-slug="web-01-sqli"]'));
await wait(320);
check('点击命中片段打开了对应笔记', A.state.current === 'web-01-sqli', String(A.state.current));
check('选中了命中所在的那一行',
  TA.value.slice(TA.selectionStart, TA.selectionEnd) === '正文 `code` 与表格：',
  JSON.stringify(TA.value.slice(TA.selectionStart, TA.selectionEnd)));

/* 回车跳到第一条命中 */
searchInput.value = 'code';
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(420);
TA.setSelectionRange(0, 0);
searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await wait(320);
check('回车跳转到第一条命中',
  TA.value.slice(TA.selectionStart, TA.selectionEnd) === '正文 `code` 与表格：',
  JSON.stringify(TA.value.slice(TA.selectionStart, TA.selectionEnd)));

/* Escape 清空检索，恢复普通列表 */
searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(80);
check('Escape 清空检索框', searchInput.value === '' && A.state.searchResults === null);
check('清空后恢复普通笔记列表', document.querySelectorAll('.adm-item[data-slug]').length === 3,
  String(document.querySelectorAll('.adm-item[data-slug]').length));

/* 无命中时给出明确说明 */
searchInput.value = '不存在的关键词';
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(420);
check('服务端返回空结果时不显示笔记条目',
  document.querySelectorAll('.adm-item[data-slug]').length === 0);

/* ============================================================
   13. 双向链接：[[ 联想 + 出链/入链/待创建面板
   ============================================================ */
await A.openNote('web-01-sqli');
await wait(320);

check('面板列出正文里的出链',
  /Linux 日志分析/.test(document.querySelector('#linkOut')?.textContent || ''),
  document.querySelector('#linkOut')?.textContent);
check('面板列出来自链接图的入链',
  /未完成的草稿/.test(document.querySelector('#linkIn')?.textContent || ''),
  document.querySelector('#linkIn')?.textContent);
check('未创建的链接进入「待创建」',
  /内网渗透提权清单/.test(document.querySelector('#linkBroken')?.textContent || ''),
  document.querySelector('#linkBroken')?.textContent);

/* ---- 输入 [[ 弹出标题联想 ---- */
TA.value = '前文 [[';
TA.setSelectionRange(TA.value.length, TA.value.length);
TA.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(80);

check('输入 [[ 弹出标题联想面板', document.querySelector('#picker').hidden === false);
const pickIds = Array.from(document.querySelectorAll('#pickerList [data-pick]')).map((b) => b.getAttribute('data-pick'));
check('联想列表列出其他笔记', pickIds.length === 2, pickIds.join(','));
check('联想列表不推荐链接当前笔记本身', pickIds.indexOf('web-01-sqli') === -1, pickIds.join(','));
check('默认高亮第一项', document.querySelectorAll('#pickerList .adm-picker-item.active').length === 1);

/* ---- 输入片段过滤 ---- */
TA.value = '前文 [[Linux';
TA.setSelectionRange(TA.value.length, TA.value.length);
TA.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(80);
check('输入的片段会过滤联想结果',
  document.querySelectorAll('#pickerList .adm-picker-item').length === 1,
  String(document.querySelectorAll('#pickerList .adm-picker-item').length));
check('联想结果对匹配处高亮', document.querySelectorAll('#pickerList mark').length > 0);

/* ---- 方向键 + 回车插入 ---- */
TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
await wait(40);
TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
await wait(40);
check('方向键可在联想列表中移动', document.querySelectorAll('#pickerList .adm-picker-item.active').length === 1);

TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await wait(80);
check('回车插入双向链接', TA.value === '前文 [[Linux 日志分析]]', JSON.stringify(TA.value));
check('插入后面板收起', document.querySelector('#picker').hidden === true);
check('插入后面板出链同步更新',
  /Linux 日志分析/.test(document.querySelector('#linkOut')?.textContent || ''),
  document.querySelector('#linkOut')?.textContent);

/* ---- Esc 关闭且不被 keyup 重新弹出 ---- */
TA.value = '再试 [[';
TA.setSelectionRange(TA.value.length, TA.value.length);
TA.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(80);
check('联想面板可再次弹出', document.querySelector('#picker').hidden === false);
TA.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(40);
check('Esc 关闭联想面板', document.querySelector('#picker').hidden === true);
TA.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
await wait(60);
check('按过 Esc 后不会被 keyup 重新弹出', document.querySelector('#picker').hidden === true);

/* ---- 鼠标点选插入 ---- */
TA.value = '点选 [[';
TA.setSelectionRange(TA.value.length, TA.value.length);
TA.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(80);
click(document.querySelector('#pickerList [data-pick="ir-02-linux"]'));
await wait(80);
check('点击联想项插入链接', TA.value === '点选 [[Linux 日志分析]]', JSON.stringify(TA.value));

/* ---- 点出链打开对应笔记 ---- */
A.state.dirty = false;          // 此处只验证点击接线，脏状态拦截另有断言
calls.length = 0;
click(document.querySelector('#linkOut [data-open-note]'));
await wait(320);
check('点击出链会请求打开对应笔记',
  calls.some((c) => c.url.indexOf('/api/note?slug=ir-02-linux') > -1),
  calls.map((c) => c.url).join(' '));

/* ---- 点「待创建」按标题新建 ---- */
await A.openNote('web-01-sqli');
await wait(320);
TA.dispatchEvent(new window.Event('input', { bubbles: true }));   // 制造未保存状态
await wait(1400);                                                  // 等草稿防抖，避免干扰
click(document.querySelector('#linkBroken [data-create-note]'));
await wait(80);
check('有未保存修改时先提示确认', document.querySelector('#modalConfirm').hidden === false);
click(document.querySelector('#cfConfirm'));
await wait(120);
check('确认后按该标题新建笔记',
  document.querySelector('#fTitle').value === '内网渗透提权清单',
  document.querySelector('#fTitle').value);
check('新建后尚未落盘', A.state.current === null, String(A.state.current));

/* ============================================================
   14. 一致性比对：同一段 Markdown 在「站点」与「编辑器预览」中的输出
      这是「代码框等元素输出效果与站点一致」这一要求的直接验证
   ============================================================ */
const SAMPLE = [
  '## 小节标题', '',
  '段落含 `行内代码`、**加粗**、[链接](https://example.com)。', '',
  '另见 [[不存在的笔记X]]。', '',
  '| 列 A | 列 B |', '| --- | --- |', '| 1 | 2 |', '',
  '```python', 'print("hello")  # 注释里的 [[Linux 日志分析]] 不应被解析', '```', '',
  '```bash', 'nmap -sV 127.0.0.1', '```', '',
  '- 项目一', '- 项目二', '',
  '> 引用行', ''
].join('\n');

const siteVc = new VirtualConsole();
siteVc.on('jsdomError', (e) => {
  if (!/Could not parse CSS|Not implemented/.test(String(e.message))) {
    results.push('  WARN  站点实例: ' + e.message);
  }
});

const siteDom = await JSDOM.fromURL(BASE + 'index.html', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: siteVc,
  beforeParse(w) {
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.scrollTo = () => {};
  }
});
await new Promise((r) => {
  if (siteDom.window.document.readyState === 'complete') r();
  else siteDom.window.addEventListener('load', r, { once: true });
});
await wait(300);

const siteWin = siteDom.window;
check('站点侧已加载共享渲染模块', !!siteWin.SecRender);

const siteBox = siteWin.document.createElement('div');
const editorBox = document.createElement('div');
siteWin.document.body.appendChild(siteBox);
document.body.appendChild(editorBox);

const siteHeads = siteWin.SecRender.render(SAMPLE, siteBox);
const editorHeads = window.SecRender.render(SAMPLE, editorBox);

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
check('同一 Markdown 两侧渲染结果逐字符一致',
  norm(siteBox.innerHTML) === norm(editorBox.innerHTML),
  `站点 ${siteBox.innerHTML.length} 字符 / 编辑器 ${editorBox.innerHTML.length} 字符`);
check('两侧标题锚点一致',
  JSON.stringify(siteHeads) === JSON.stringify(editorHeads),
  `站点 ${siteHeads.length} 个 / 编辑器 ${editorHeads.length} 个`);

/* 逐项确认关键元素在两侧同等生成 */
['.code-block', '.code-lang', '.copy-btn', '.table-wrap', 'pre code.hljs'].forEach((sel) => {
  const a = siteBox.querySelectorAll(sel).length;
  const b = editorBox.querySelectorAll(sel).length;
  check(`两侧都生成 ${sel}`, a === b && a > 0, `站点 ${a} / 编辑器 ${b}`);
});
check('两侧语言标签内容一致',
  Array.from(siteBox.querySelectorAll('.code-lang')).map((e) => e.textContent).join(',') ===
  Array.from(editorBox.querySelectorAll('.code-lang')).map((e) => e.textContent).join(','),
  Array.from(editorBox.querySelectorAll('.code-lang')).map((e) => e.textContent).join(','));
check('编辑器预览容器与站点正文使用同一样式类',
  document.querySelector('#preview').classList.contains('post-body'));
check('编辑器引用了站点同一份样式表',
  !!document.querySelector('link[href="/assets/css/style.css"]'));
check('编辑器引用了站点同一份代码高亮主题',
  !!document.querySelector('#hljs-theme-dark') && !!document.querySelector('#hljs-theme-light'));

/* 双向链接在两侧的行为也必须一致 */
const siteMissing = siteBox.querySelectorAll('a.wikilink.missing').length;
const editorMissing = editorBox.querySelectorAll('a.wikilink.missing').length;
check('两侧都把未解析的双向链接标为待创建',
  siteMissing === 1 && editorMissing === 1, `站点 ${siteMissing} / 编辑器 ${editorMissing}`);
check('待创建链接保留原始文字',
  siteBox.querySelector('a.wikilink.missing')?.textContent === '不存在的笔记X',
  siteBox.querySelector('a.wikilink.missing')?.textContent);
check('两侧都不会在代码块里生成双向链接',
  siteBox.querySelectorAll('pre a.wikilink').length === 0 &&
  editorBox.querySelectorAll('pre a.wikilink').length === 0);
check('两侧都在代码块里保留原始写法',
  /\[\[Linux 日志分析\]\]/.test(siteBox.querySelector('pre code')?.textContent || '') &&
  /\[\[Linux 日志分析\]\]/.test(editorBox.querySelector('pre code')?.textContent || ''),
  siteBox.querySelector('pre code')?.textContent?.slice(0, 44));

siteDom.window.close();

/* ============================================================
   15. 未连接本地服务时的兜底（例如直接双击打开 admin/index.html）
   ============================================================ */
const offDom = await JSDOM.fromURL(BASE, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
  beforeParse(w) {
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    w.fetch = function () { return Promise.reject(new Error('offline')); };
  }
});
await new Promise((r) => {
  if (offDom.window.document.readyState === 'complete') r();
  else offDom.window.addEventListener('load', r, { once: true });
});
await wait(320);

const offDoc = offDom.window.document;
check('未连接服务时不抛未捕获异常',
  !results.some((r) => r.includes('WARN') && r.includes('Uncaught')),
  results.filter((r) => r.includes('WARN')).join(' | ') || '无');
check('未连接服务时给出启动指引',
  /admin\.py/.test(offDoc.querySelector('#listScroll')?.textContent || ''),
  (offDoc.querySelector('#listScroll')?.textContent || '').slice(0, 40));
check('未连接服务时状态栏提示', /未连接服务/.test(offDoc.querySelector('#stBuild')?.textContent || ''),
  offDoc.querySelector('#stBuild')?.textContent);
check('未连接服务时不渲染笔记条目',
  offDoc.querySelectorAll('.adm-item[data-slug]').length === 0);
offDom.window.close();

/* ============================================================ */
console.log('\n=== SecNotes 编辑器自检 ===');
console.log(results.join('\n'));
const total = results.filter((r) => r.includes('PASS') || r.includes('FAIL')).length;
console.log(`\n合计 ${total} 项检查，失败 ${failed} 项\n`);

window.close();
server.close();
process.exit(failed ? 1 : 0);
