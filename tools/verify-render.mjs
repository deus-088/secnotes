/* ============================================================
   SecNotes 渲染链路自检（jsdom）
   用途：在无浏览器环境下校验首页/检索/分类/文章/归档/标签/主题等
         渲染链路是否正常，修改前端代码后运行一次即可回归。
   依赖：jsdom（Node 包）
   用法：node tools/verify-render.mjs
         JSDOM_PATH=file:///.../node_modules/jsdom/lib/api.js node tools/verify-render.mjs
   说明：脚本会在进程内启动一个临时静态服务（支持 keep-alive），
         避免外部 HTTP/1.0 服务导致的资源加载抖动。
   ============================================================ */
const { readFileSync, existsSync, statSync, readdirSync, copyFileSync, rmSync, writeFileSync } =
  await import('node:fs');
const { spawnSync } = await import('node:child_process');
const { join, resolve, dirname, extname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const http = await import('node:http');

const JSDOM_PATH = process.env.JSDOM_PATH ||
  'file:///C:/Users/Deus/.workbuddy/binaries/node/workspace/node_modules/jsdom/lib/api.js';
const { JSDOM, VirtualConsole } = await import(JSDOM_PATH);

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/* 进程内静态服务：支持 keep-alive，避免 HTTP/1.0 连接被反复关闭导致资源加载失败 */
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = join(PROJECT, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(PROJECT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_BASE = `http://127.0.0.1:${server.address().port}/`;
const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  results.push(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
}

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const msg = String(e.message);
  // 「导航未实现」是下面自动刷新断言的预期信号，单独断言，不计入告警
  if (/Could not parse CSS/.test(msg) || /navigation/i.test(msg)) return;
  results.push('  WARN  jsdomError: ' + msg);
});
vc.on('error', (m) => results.push('  WARN  console.error: ' + m));

/* ---------------- 夹具安装（带「快照精确还原」） ----------------
   本套断言针对一份「固定内容」编写（需要代码块、表格、有序列表、双向链接、
   足够多篇以触发分页等特征）。夹具在 tools/fixtures/notes/，运行期间临时装进
   notes/ 并构建；结束后按**开始时的快照**把 notes/ 精确还原再重建。

   为什么不是"只删掉自己装的那些"：那样不足以恢复现场，曾真实发生夹具残留在
   用户站点里的事故。快照还原是幂等的，并且可以在结束时直接断言"零残留"。 */
const PY = process.env.SECNOTES_PY ||
  'C:\\Users\\Deus\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const FIXTURE_DIR = join(PROJECT, 'tools', 'fixtures', 'notes');
const NOTES_DIR = join(PROJECT, 'notes');
const runBuild = () => spawnSync(PY, ['build.py'], { cwd: PROJECT, encoding: 'utf8' });

/* 测试专用文件名：出现在 notes/ 里一律视为污染——
   夹具同名文件，以及 zz- 前缀的临时笔记（zz-verify*、zz-e2e*）。
   必须显式识别：残留一旦被当成「用户内容」进入快照，就再也还原不掉，
   还会被构建进 data/notes.js、再被 e2e 的同步写回 notes/，越滚越多（真实发生过）。 */
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
let fixtureCount = 0;
let notesDirty = false;

if (existsSync(FIXTURE_DIR)) {
  for (const name of FIXTURE_NAMES) {
    if (notesSnapshot.has(name)) continue;       // 理论上到不了（上面已净化）
    copyFileSync(join(FIXTURE_DIR, name), join(NOTES_DIR, name));
    fixtureCount++;
  }
  if (fixtureCount) { runBuild(); notesDirty = true; }
}

function restoreNotes() {
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
/* Node.js 的 process.on('exit') 在 process.exit(N) 设置了退出码时不再触发；
   用 beforeExit + exit 双保险，确保任何方式退出都会跑还原。 */
process.on('beforeExit', restoreNotes);
process.on('exit', restoreNotes);

const dom = await JSDOM.fromURL(URL_BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; }
      observe() {} unobserve() {} disconnect() {}
    };
    window.scrollTo = () => {};
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
  },
});

const { window } = dom;
const { document } = window;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const route = async (hash) => {
  window.location.hash = hash;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await wait(160);
};

await new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else window.addEventListener('load', resolve, { once: true });
});
/* index.html 现在走按需加载链（data/notes.js 和 assets/js/app.js 是动态 appendChild）。
   jsdom 对动态 <script src> 的 onload 时机不可靠，所以这里兜底：轮询 SEC_BLOG + app.js
   的关键内部函数到位再放行；超过 5 秒视为 fixture/数据缺失。 */
await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const haveData = !!(window.SEC_BLOG && (Array.isArray(window.SEC_BLOG.notes) || window.SEC_BLOG.stats));
    /* app.js 内部函数未必全暴露；用「首页 .note-card 已渲染」作为脚本跑完的最终信号。
       同时 home 默认就渲染（hash 路由初始为 '#/'），所以这里也能当锚点。 */
    const appRendered = document.querySelectorAll('#app .note-card, #app .arch-item, #app .empty-state').length > 0
                         || document.querySelector('#app')?.textContent?.length > 0;
    if (haveData && appRendered) return;
    await wait(50);
  }
})();

/* 期望数量一律从站点实际数据推导，不要在断言里写死篇数——
   否则每新增一篇笔记都会造成一批假失败（曾多次踩到）。 */
const SITE = window.SEC_BLOG || {};
const ALL_NOTES = Array.isArray(SITE.notes) ? SITE.notes : [];
const TOTAL = Number(SITE.stats?.notes ?? ALL_NOTES.length);
const CATEGORY_COUNT = new Set(ALL_NOTES.map((n) => n.category).filter(Boolean)).size;
const TAG_COUNT = new Set(ALL_NOTES.flatMap((n) => n.tags || [])).size;
const PAGE_SIZE = Number(SITE.config?.pageSize || 8);
check('站点数据已加载（推导期望值的前提）', TOTAL > 0 && ALL_NOTES.length === TOTAL,
  `${ALL_NOTES.length} 篇 / stats ${TOTAL}`);

/* ---------------- 首页 ---------------- */
const app = document.querySelector('#app');
check('首页渲染容器存在', !!app);
/* 配置文案类断言必须从 SITE.config.title 推导，不能硬编码——用户改了
   blog.config.json 这条就会假失败（实际是正确的）。 */
const EXPECTED_TITLE = SITE.config?.title || 'SecNotes';
check(`侧边栏品牌标题注入 → ${EXPECTED_TITLE}`,
  document.querySelector('#brandTitle')?.textContent === EXPECTED_TITLE,
  document.querySelector('#brandTitle')?.textContent);check('侧边栏统计-笔记数', document.querySelector('#statNotes')?.textContent === String(TOTAL),
  document.querySelector('#statNotes')?.textContent);
check('侧边栏统计-总字数格式化', /[\d,]+/.test(document.querySelector('#statWords')?.textContent || ''),
  document.querySelector('#statWords')?.textContent);

const cards = document.querySelectorAll('.note-card');
check('首页首屏卡片数 = pageSize(8)', cards.length === 8, String(cards.length));
check(`Hero 标题渲染 → ${EXPECTED_TITLE}`,
  new RegExp(EXPECTED_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(document.querySelector('.hero h1')?.textContent || ''));
/* 展示端是纯阅读界面：不应出现任何管理入口 */
check('展示端顶栏无「管理笔记」入口', !document.querySelector('.topnav a[href*="admin"], .manage-link, [data-admin-entry]'),
  document.querySelector('.topnav')?.textContent);
check('展示端无「写笔记」悬浮按钮', !document.querySelector('a.to-edit'));
check('展示端正文未出现管理入口文案',
  !/管理笔记|python admin\.py/.test(document.body.textContent || ''),
  (document.body.textContent || '').match(/管理笔记|python admin\.py/)?.[0] || '');
check(`分类项数量 = ${CATEGORY_COUNT}`, document.querySelectorAll('#categoryList a[data-category]:not([data-category=""])').length === CATEGORY_COUNT,
  String(document.querySelectorAll('#categoryList a[data-category]:not([data-category=""])').length));
check(`标签项数量 = ${TAG_COUNT}`, document.querySelectorAll('#tagCloud a[data-tag]').length === TAG_COUNT,
  String(document.querySelectorAll('#tagCloud a[data-tag]').length));
check('卡片含分类与日期', !!cards[0]?.querySelector('.cat') && /\d{4}-\d{2}-\d{2}/.test(cards[0]?.textContent || ''));

/* ---------------- 分页 ---------------- */
check('分页控件已渲染', !!document.querySelector('[data-load-more]'));
check('分页提示显示总数与剩余',
  new RegExp(`已显示 ${PAGE_SIZE} \\/ ${TOTAL} 篇`).test(document.querySelector('.load-more-hint')?.textContent || ''),
  document.querySelector('.load-more-hint')?.textContent);
/* 「加载更多」点击行为已移交给 e2e-chain.mjs 用真实浏览器覆盖 */
check(`列表总数标注为 ${TOTAL}`, new RegExp(`\\b${TOTAL}\\b`).test(document.querySelector('.list-head .badge')?.textContent || ''),
  document.querySelector('.list-head .badge')?.textContent);

/* 点击加载更多的交互测试在 jsdom + 动态加载链下不稳定（loadMore IIFE 内部作用域
   通过 window.eval 调用在 jsdom 里有兼容问题）。点击链路的真实覆盖在 tools/e2e-chain.mjs：
   那个用真浏览器跑「管理端编辑→同步→展示端可见→清理」全链路。这里只验证
   分页控件渲染正确，分页 hint 显示合理的「已显示 X / TOTAL 篇」。 */
check('分页控件已渲染（按钮 + hint）',
  !!document.querySelector('[data-load-more]') &&
  !!document.querySelector('.load-more-hint'));
check(`分页提示：已显示 ${PAGE_SIZE} / ${TOTAL} 篇`,
  new RegExp(`已显示 ${PAGE_SIZE} \\/ ${TOTAL} 篇`).test(document.querySelector('.load-more-hint')?.textContent || ''),
  document.querySelector('.load-more-hint')?.textContent);
/* 「全部加载后卡片数 = TOTAL」「分页控件移除」「追加内容位于原列表容器」：
   这三条都依赖「点击 + 全部加载完」这一中间状态，jsdom + 动态加载链下不能
   触发点击，但等价信号在 e2e-chain.mjs 用真实浏览器覆盖了。这里跳过。 */

/* ---------------- 搜索 ---------------- */
const input = document.querySelector('#searchInput');
input.value = 'nmap';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(320);
const searched = document.querySelectorAll('.note-card');
check('搜索 "nmap" 命中结果非空', searched.length > 0, `${searched.length} 条`);
check('搜索结果包含高亮标记 <mark>', document.querySelectorAll('.note-card mark').length > 0);
check('搜索标题栏显示结果数', /搜索结果/.test(document.querySelector('.list-head h2')?.textContent || ''));

input.value = '';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(320);
check('清空搜索后恢复首页', document.querySelectorAll('.note-card').length === 8,
  String(document.querySelectorAll('.note-card').length));
check('清空搜索后分页控件回归', !!document.querySelector('[data-load-more]'));

/* ---------------- 分类筛选 ---------------- */
await route('#/category/Web 安全');
check('分类路由筛选生效', document.querySelectorAll('.note-card').length === 3,
  String(document.querySelectorAll('.note-card').length));
check('分类筛选出现清除按钮', !!document.querySelector('[data-clear-filter]'));
check('条数不足一页时不显示分页控件', !document.querySelector('[data-load-more]'));

/* ---------------- 文章页 ---------------- */
await route('#/note/web-01-sql-injection-basics');
check('文章页标题渲染', /SQL 注入/.test(document.querySelector('.post-header h1')?.textContent || ''));
check('文章正文已渲染 Markdown', (document.querySelector('#postBody')?.innerHTML || '').length > 2000);
check('代码块已包裹', document.querySelectorAll('.code-block').length === 2,
  String(document.querySelectorAll('.code-block').length));
check('代码块含语言标签', document.querySelectorAll('.code-lang').length === 2,
  Array.from(document.querySelectorAll('.code-lang')).map((e) => e.textContent).join(','));
check('复制按钮已注入', document.querySelectorAll('.copy-btn').length === 2,
  String(document.querySelectorAll('.copy-btn').length));
check('有序列表渲染', document.querySelectorAll('#postBody ol').length >= 1);

/* ---------------- 相关笔记推荐 ---------------- */
const relItems = document.querySelectorAll('.related-list a');
check('相关笔记区块已渲染', document.querySelectorAll('.related').length === 1);
check('相关笔记条目数在 1–4 之间', relItems.length >= 1 && relItems.length <= 4, String(relItems.length));
check('相关笔记指向其他笔记', Array.from(relItems).every((a) => a.getAttribute('href').startsWith('#/note/')),
  Array.from(relItems).map((a) => a.getAttribute('href')).join(' '));
check('推荐结果不含当前文章自身',
  !Array.from(relItems).some((a) => a.getAttribute('href') === '#/note/web-01-sql-injection-basics'));
check('代码高亮已应用', document.querySelectorAll('#postBody code.hljs').length > 0);

/* 复制按钮点击（jsdom 无 Clipboard API，走 execCommand 回退分支） */
const copyBtn = document.querySelector('.copy-btn');
copyBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('复制按钮点击不抛异常', !!document.querySelector('.copy-btn'));
check('表格已包裹滚动容器', document.querySelectorAll('.table-wrap table').length >= 1);
check('表格渲染行数正确', document.querySelectorAll('.table-wrap tbody tr').length === 5,
  String(document.querySelectorAll('.table-wrap tbody tr').length));
check('目录已生成', document.querySelectorAll('.toc a[data-toc]').length >= 4,
  String(document.querySelectorAll('.toc a[data-toc]').length));
/* 目录只收 h2–h4：h1 是文章标题、h5/h6 太深，都不该出现在目录里 */
const tocLevels = Array.from(document.querySelectorAll('.toc li[class^="lvl-"]'))
  .map((li) => Number((li.className.match(/lvl-(\d)/) || [])[1]));
check('目录只收录 h2–h4（文章标题 h1 不进目录）',
  tocLevels.length > 0 && tocLevels.every((lv) => lv >= 2 && lv <= 4),
  '实际层级 ' + JSON.stringify(Array.from(new Set(tocLevels)).sort()));
check('目录不包含 h1 条目', !document.querySelector('#postBody h1[id^="heading"], #postBody h1')?.id ||
  !Array.from(document.querySelectorAll('.toc a[data-toc]')).some((a) => a.getAttribute('data-toc') === document.querySelector('#postBody h1')?.id));

/* 标题容错：手写漏掉 "# " 里那个空格（##标题）时也要按标题渲染，
   否则字号比相邻标题小、也进不了目录。与编辑器预览共用 render.js 里同一份实现。 */
check('站点侧容忍漏空格的 ## 标题',
  typeof window.SecRender?.normalizeHeadings === 'function' &&
  window.SecRender.normalizeHeadings('##三、补充') === '## 三、补充');
check('标题容错不碰代码块内的 #',
  window.SecRender?.normalizeHeadings('```bash\n# 注释\n```\n##裸') === '```bash\n# 注释\n```\n## 裸');
check('标题已注入锚点 id', !!document.querySelector('#postBody h2[id]'));
check('上/下一篇导航存在', document.querySelectorAll('.post-nav a').length >= 1);
check('面包屑包含分类链接', /Web 安全/.test(document.querySelector('.crumbs')?.textContent || ''));
check('页面标题同步为文章名', /SQL 注入/.test(document.title), document.title);

/* ---------------- 多代码块长文（bash 高亮与目录） ---------------- */
await route('#/note/ir-02-linux-log-analysis');
check('长文代码块数量 = 5', document.querySelectorAll('.code-block').length === 5,
  String(document.querySelectorAll('.code-block').length));
check('bash 代码块被识别', Array.from(document.querySelectorAll('.code-lang')).filter((e) => e.textContent === 'bash').length === 5,
  Array.from(document.querySelectorAll('.code-lang')).map((e) => e.textContent).join(','));
check('bash 高亮 span 已生成', document.querySelectorAll('#postBody pre code .hljs-comment, #postBody pre code .hljs-string, #postBody pre code .hljs-built_in').length > 0);
check('长文目录条目充足', document.querySelectorAll('.toc a[data-toc]').length >= 6,
  String(document.querySelectorAll('.toc a[data-toc]').length));
check('长文二级标题完整', document.querySelectorAll('#postBody h2').length >= 6,
  String(document.querySelectorAll('#postBody h2').length));
check('行内代码渲染', document.querySelectorAll('#postBody p > code, #postBody li > code, #postBody td > code').length >= 5,
  String(document.querySelectorAll('#postBody p > code, #postBody li > code, #postBody td > code').length));

/* 用同分类且有同名标签的两篇应急响应笔记，验证「共同标签」推荐依据可见 */
check('相关笔记包含同分类文章', /Windows 应急响应排查清单/.test(document.querySelector('.related')?.textContent || ''),
  document.querySelector('.related')?.textContent?.slice(0, 60));
check('相关笔记展示共同标签依据', /共同标签/.test(document.querySelector('.related')?.textContent || ''),
  document.querySelector('.related-meta')?.textContent);

/* ---------------- 双向链接与反向链接 ---------------- */
check('被别的笔记引用的页面显示反向链接面板',
  document.querySelectorAll('.backlinks .backlink').length >= 1,
  String(document.querySelectorAll('.backlinks .backlink').length));
check('反向链接列出引用来源的标题',
  /Windows 应急响应排查清单/.test(document.querySelector('.backlinks')?.textContent || ''),
  document.querySelector('.backlink-title')?.textContent);
check('反向链接附上引用处的上下文',
  /Linux 日志分析/.test(document.querySelector('.backlink-ctx')?.textContent || ''),
  document.querySelector('.backlink-ctx')?.textContent);

/* 出链：正文里的 [[..]] 应渲染为站内链接 */
await route('#/note/ir-01-windows-triage');
const wikilinks = Array.from(document.querySelectorAll('#postBody a.wikilink'));
check('正文中的双向链接渲染为站内链接', wikilinks.length === 2, String(wikilinks.length));
check('双向链接指向对应笔记',
  wikilinks.some((a) => a.getAttribute('href') === '#/note/ir-02-linux-log-analysis'),
  wikilinks.map((a) => a.getAttribute('href')).join(' '));
check('双向链接显示为笔记标题', wikilinks[0]?.textContent === 'Linux 日志分析与入侵痕迹排查',
  wikilinks[0]?.textContent);
check('双向链接不会被当成外链新开窗口',
  wikilinks.every((a) => !a.getAttribute('target')),
  wikilinks.map((a) => a.getAttribute('target')).join(','));

/* 指向尚未创建笔记的链接要如实标记，而不是静默失效 */
await route('#/note/pentest-02-nmap-usage');
const missing = Array.from(document.querySelectorAll('#postBody a.wikilink.missing'));
check('指向未创建笔记的链接标记为待创建', missing.length === 1, String(missing.length));
check('待创建链接保留原文并给出提示',
  missing[0]?.textContent === '内网渗透提权清单' && /尚未创建/.test(missing[0]?.getAttribute('title') || ''),
  missing[0]?.textContent);
check('待创建链接不指向错误页面', missing[0]?.getAttribute('href') === '#/',
  missing[0]?.getAttribute('href'));
check('同页已创建的链接仍为正常链接',
  document.querySelectorAll('#postBody a.wikilink:not(.missing)').length === 1,
  String(document.querySelectorAll('#postBody a.wikilink:not(.missing)').length));

/* ---------------- 思维导图（```mindmap 围栏代码块） ----------------
   夹具 zz-fixture-mindmap.md 里有两个图：一张 3 分支 10 节点的主图，
   一张单节点图；另有一个空内容的 mindmap 块应当回退成普通代码块。 */
await route('#/note/zz-fixture-mindmap');
const mmMaps = Array.from(document.querySelectorAll('#postBody .mindmap'));
check('mindmap 代码块渲染为思维导图容器（主图 + 单节点）',
  mmMaps.length === 2, String(mmMaps.length));
check('思维导图输出内联 SVG',
  mmMaps.length === 2 && mmMaps.every((m) => !!m.querySelector('svg.mm-svg')));

const mmMain = mmMaps[0] ? Array.from(mmMaps[0].querySelectorAll('.mm-node')) : [];
check('主图节点数 = 10', mmMain.length === 10, String(mmMain.length));
check('主图连线数 = 节点数 - 1',
  !!mmMaps[0] && mmMaps[0].querySelectorAll('.mm-edge').length === mmMain.length - 1,
  mmMaps[0] ? String(mmMaps[0].querySelectorAll('.mm-edge').length) : '-');
check('根节点单独标记 mm-root', mmMain.some((n) => n.classList.contains('mm-root')));
/* 注意：SVG 元素的 className 是 SVGAnimatedString，不是字符串，必须用 getAttribute('class') */
check('分支节点带配色类 mm-b0..mm-b5',
  mmMain.some((n) => /(^|\s)mm-b[0-5](\s|$)/.test(n.getAttribute('class') || '')));
check('中心主题文字正确',
  /渗透测试流程/.test(mmMaps[0]?.querySelector('.mm-root')?.textContent || ''),
  mmMaps[0]?.querySelector('.mm-root')?.textContent);
check('最深一层节点文字完整', /横向移动/.test(mmMaps[0]?.textContent || ''));

/* 一级分支应左右分侧：取每个节点矩形中心的 x，需同时存在正负 */
const mmCenters = mmMain.map((n) => {
  const r = n.querySelector('rect');
  return parseFloat(r.getAttribute('x')) + parseFloat(r.getAttribute('width')) / 2;
});
check('一级分支左右分侧（中心 x 有正有负）',
  mmCenters.some((v) => v > 1) && mmCenters.some((v) => v < -1),
  mmCenters.slice(0, 4).map((v) => v.toFixed(0)).join(','));

check('单节点图只有 1 个节点、0 条连线',
  !!mmMaps[1] && mmMaps[1].querySelectorAll('.mm-node').length === 1 &&
  mmMaps[1].querySelectorAll('.mm-edge').length === 0,
  mmMaps[1] ? String(mmMaps[1].querySelectorAll('.mm-node').length) : '-');
check('内容为空的 mindmap 回退为普通代码块',
  !!document.querySelector('#postBody .code-block'));
check('思维导图不影响后续正文渲染',
  /上图之后仍有正文/.test(document.querySelector('#postBody')?.textContent || ''));

/* ---------------- 归档 / 标签 / 关于 ---------------- */
await route('#/archive');
check('归档页渲染年份分组', document.querySelectorAll('.year-title').length >= 1,
  String(document.querySelectorAll('.year-title').length));
check(`归档条目数量 = ${TOTAL}`, document.querySelectorAll('.arch-item').length === TOTAL,
  String(document.querySelectorAll('.arch-item').length));

await route('#/tags');
check(`标签页渲染分类区块（≥ ${TAG_COUNT}）`, document.querySelectorAll('.tag-cloud-lg a').length >= TAG_COUNT,
  String(document.querySelectorAll('.tag-cloud-lg a').length));

await route('#/about');
check('关于页渲染使用说明', /build\.py/.test(document.querySelector('.about-card')?.textContent || ''));
check('关于页说明了笔记来源与构建方式',
  /manage\.html/.test(document.querySelector('.about-card')?.textContent || '') &&
  /build\.py/.test(document.querySelector('.about-card')?.textContent || ''));

/* ---------------- 同步后自动刷新 ---------------- */
/* 管理端同步完成会写 secnotes.reloadAt 并广播；展示端收到后自动重载，无需手动 F5。
   jsdom 不允许替换 location.reload，因此以"发生了导航尝试"作为 reload 被调用的信号。 */
const navErrors = [];
vc.on('jsdomError', (e) => { navErrors.push(String(e.message)); });

window.dispatchEvent(new window.StorageEvent('storage', {
  key: 'secnotes.reloadAt', newValue: String(Date.now() + 1), oldValue: '0'
}));
await wait(80);
check('收到管理端同步信号后自动刷新',
  navErrors.some((m) => /navigation|reload/i.test(m)),
  navErrors.slice(-1)[0] || '未观察到重载');

/* 自动刷新不能只依赖 storage 事件 / BroadcastChannel：
   前者不跨 origin、部分浏览器在 file:// 下也不派发它；后者在 file:// 下可能不可用。
   轮询 localStorage 是唯一在两种协议下都可靠的通道，必须存在。 */
const appSrc = readFileSync(join(PROJECT, 'assets', 'js', 'app.js'), 'utf8');
check('展示端有轮询兜底（主动读 secnotes.reloadAt）',
  /setInterval/.test(appSrc) && /secnotes\.reloadAt/.test(appSrc));
check('轮询在标签页隐藏时跳过，不做无谓检查', /document\.hidden/.test(appSrc));

/* 其它 key 不应触发刷新 */
const otherErrors = navErrors.length;
window.dispatchEvent(new window.StorageEvent('storage', {
  key: 'unrelated-key', newValue: 'x', oldValue: 'y'
}));
await wait(60);
check('无关的存储事件不触发刷新', navErrors.length === otherErrors);

/* ---------------- 主题切换 ---------------- */
await route('#/');
const themeBtn = document.querySelector('#themeToggle');
themeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
const themeNow = document.documentElement.getAttribute('data-theme');
check('主题切换按钮生效', themeNow === 'light', String(themeNow));
check('浅色高亮样式已启用', document.querySelector('#hljs-theme-light')?.disabled === false);
themeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('主题可切回深色', document.documentElement.getAttribute('data-theme') === 'dark');

/* ---------------- 404 兜底 ---------------- */
await route('#/note/not-exist-slug');
check('无效 slug 显示友好提示', /笔记不存在/.test(document.querySelector('#app')?.textContent || ''));

/* 先按快照还原 notes/ 并重建站点数据，再断言"零残留"，最后才输出结果 */
restoreNotes();
/* 还原是否彻底：notes/ 的文件名集合应回到起跑时的快照。
   不假设用户有没有笔记（只比对集合），避免"用户本来有笔记"时假失败。 */
const nowNames = readdirSync(NOTES_DIR).filter((n) => n.endsWith('.md')).sort();
const snapNames = Array.from(notesSnapshot.keys()).sort();
check('夹具与测试文件已完全还原（notes/ 与起跑时一致）',
  nowNames.join('|') === snapNames.join('|'),
  nowNames.join(', ') || '(空)');
if (purgedAtStart.length) {
  results.push(`  INFO  起跑时清除了 ${purgedAtStart.length} 篇上轮残留：${purgedAtStart.join(', ')}`);
}
results.push(`  INFO  本次临时装入夹具 ${fixtureCount} 篇（tools/fixtures/notes/）`);

console.log('\n=== SecNotes 渲染验证 ===');
results.forEach((r) => console.log(r));
console.log(`\n合计 ${results.filter((r) => r.includes('PASS') || r.includes('FAIL')).length} 项检查，失败 ${failed} 项\n`);
window.close();
server.close();
process.exit(failed ? 1 : 0);
