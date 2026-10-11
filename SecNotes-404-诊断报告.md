# SecNotes 博客 404 问题诊断报告

- 站点：`https://deus808.github.io/secnotes/#/`
- 诊断时间：2026-10-04
- 结论：**不是代码或部署配置问题，而是 GitHub 账号 `Deus808` 被平台标记（flagged / 限制公开可见），账号下所有公开内容对外统一返回 404。**
- 补充定性（第二轮取证）：账号**在公开搜索中查不到**（`search/users?q=Deus808` 返回 0），Pages **已成功构建且开启**（`status: built, public: true, https_enforced: true`），最后一次 Pages 构建停在 **2026-09-20**，其后 09-24、10-03 的推送都没再触发重建 —— 与「账号在 9 月下旬被限制、Pages 被冻结」的时间线吻合。

---

## 一、结论（一句话）

博客代码、本地构建产物、GitHub Pages 配置**全部正常**。真正原因是 **GitHub 账号 `Deus808` 处于「被标记 / 限制公开可见」状态**：用你自己的令牌访问一切正常，但不带登录态的公开访问——个人主页、仓库页面、API，以及该账号下**所有** GitHub Pages 站点——都被隐藏并返回 404。

---

## 二、关键证据（实测）

### 1. 公开访问 vs 带令牌访问，结果完全相反

| 检查项 | 匿名访问 | 带你自己的令牌（gh CLI） |
| --- | --- | --- |
| 账号接口 `api.github.com/users/Deus808` | **404 Not Found** | **200**（`{"login":"Deus808","name":"Deus","public_repos":5}`） |
| 个人主页 `github.com/Deus808` | **404** | — |
| 仓库页 `github.com/Deus808/secnotes` | **404** | — |
| 仓库接口 `api.github.com/repos/Deus808/secnotes` | **404** | **200**（`"private":false, "visibility":"public", "has_pages":true`） |
| git 匿名 `info/refs` | **401**（不公开可见） | — |
| `git ls-remote origin`（带凭据） | — | **成功**，HEAD=`427a92d` |

同一份数据，**带令牌看得到、匿名看不到** —— 这是「账号被标记后隐藏公开内容」的独有特征，而不是仓库被删、被改名或转私有。

### 2. 平台正常，排除 GitHub 故障

| 对照项 | 返回码 |
| --- | --- |
| 对照账号 `api.github.com/users/torvalds` | **200** |
| 对照仓库 `github.com/torvalds/linux` | **200** |

平台本身工作正常，只有你的账号异常。

### 3. 整账号级影响，而非单站点

带令牌查看 5 个公开仓库（全部 `visibility: public`）：

```
deus808.github.io     has_pages: true
FJNU-Wiki             has_pages: false
secnotes              has_pages: true    ← 博客
secnotes-blog         has_pages: true    ← 演示站
wakeup-schedule-mod   has_pages: false
```

对外实测：

| 站点 / 资源 | 返回码 |
| --- | --- |
| `https://deus808.github.io/secnotes/` | **404** |
| `https://deus808.github.io/secnotes-blog/` | **404** |
| `https://deus808.github.io/` | **404** |
| `https://deus808.github.io/secnotes/assets/css/style.css` | **404** |

连一个静态 CSS 都 404，说明是**整个域名被隐藏**，不是某个文件丢失。

### 4. 本地文件完整，排除内容缺失

发布目录 `D:\TraeWork\secnotes-pages\`：

```
.git  assets  data  .nojekyll  index.html
data/notes.js   19725 字节
.nojekyll       存在（已阻止 Jekyll 干扰）
```

`git status` 显示 `main...origin/main` 已同步，无未推送提交。**本地一切正常**，推送也已成功，只是线上被隐藏。

---

## 三、为什么会被标记？

- 账号 `Deus808` 创建于 **2026-08-04**，仅约 2 个月，属于新账号。
- 部署脚本会频繁产生 `自动部署：…` 提交。新账号 + 高频自动化提交，容易触发 GitHub 的**自动风控（疑似机器人 / 垃圾内容）**，进而被标记。
- 被标记后：公开页面 / API / Pages 一律 404，但账号与内容并未删除，持有令牌仍可访问。

> `deploy.py` 里那些「禁用空提交 / amend 合并 / 推送频率保护」措施，正是防这个的，但仍未完全避免。

---

## 四、处理建议

### 方案 A：向 GitHub 申诉（首选，恢复原状）

1. 打开申诉入口：**https://support.github.com/contact/reinstatement**
2. 说明这是**个人网络安全学习笔记博客**，纯静态、无商业 / 垃圾用途，请求解除标记。
3. **同时检查邮箱（含垃圾邮件箱）**，找来自 `support@github.com` / `noreply@github.com` 的通知，里面通常写明被标记原因。
4. 申诉通过后，站点会自动恢复，无需重新部署。

### 方案 B：先迁到不依赖该账号的托管（快速恢复访问，建议并行做）

站点是纯静态，`D:\TraeWork\secnotes-pages\` 即完整发布包，可直接上传：

| 平台 | 操作 |
| --- | --- |
| **Cloudflare Pages** | 新建项目 → Direct Upload → 上传 `secnotes-pages` 目录 |
| **Vercel / Netlify** | 拖拽 `secnotes-pages` 目录即可 |
| **自有服务器 / 内网** | 目录丢到 Nginx 静态目录，或 `python -m http.server 8080` |

### 方案 C：降低再次被标记的风险

- 降低自动部署频率，避免短时间密集 push（脚本已有 10 分钟防抖，可再调大）。
- 完善账号资料：邮箱验证、开启 2FA、补充头像与简介。
- 新账号先「养号」一段时间再挂自动化部署。

---

## 五、附：这次排查否定掉的原因

| 曾被怀疑的原因 | 是否成立 | 依据 |
| --- | --- | --- |
| 文件缺失 / 构建失败 | 否 | 本地 `index.html`、`assets/`、`data/notes.js`、`.nojekyll` 齐全 |
| Pages 分支 / 目录配置错 | 否 | 带令牌 API 显示 `has_pages:true` |
| Jekyll 忽略下划线文件 | 否 | `.nojekyll` 已存在 |
| 前端 hash 路由问题 | 否 | `/secnotes/` 根路径就 404，与 `#/` 无关 |
| GitHub 平台故障 | 否 | 对照账号 / 仓库均 200 |
| 仓库被删 / 改名 / 转私有 | 否 | 带令牌可见且 `visibility:public`；改名应 301 而非 404 |
| **账号被标记（flagged）** | **是** | 匿名 404 / 带令牌 200，整账号全站隐藏 |

---

## 六、两条申诉路都堵住时怎么办

你遇到的两个卡点，本身也是「账号被限制」的佐证，而且都有解：

### 卡点一：没收到任何 GitHub 邮件

GitHub 只往账号里**已验证的邮箱**发通知，且常被归入垃圾邮件 / 推广标签。

1. 登录网页版 → 右上角头像 → **Settings → Emails**，确认存在一个「Verified」状态的邮箱；若没有或未验证，先补上并验证。
2. 手机 / 邮箱客户端里把 `@github.com`、`noreply@github.com`、`support@github.com` 加入白名单，翻**垃圾邮件、推广、归档**文件夹。
3. 网页版右上角**通知铃铛**、以及 `https://github.com/account_verifications` 页面，往往就写着被限制的原因与要求做的事。

### 卡点二：申诉页要求先开双重认证（2FA）

这**不是死路，而是前置步骤**：GitHub 现把「开启 2FA」作为使用支持 / 申诉渠道的条件。**先开 2FA，申诉页即可用。**

开启步骤（约 2 分钟）：

1. 登录网页版 → 头像 → **Settings → Password and authentication**
2. 找到 **Two-factor authentication → Enable two-factor authentication**
3. 选 **Set up using an app**（TOTP），用 **Microsoft Authenticator / Google Authenticator / 1Password / Authy** 扫二维码
4. 输入 App 生成的 6 位验证码完成绑定
5. **务必保存恢复码（Recovery codes）**，下载或抄下来
6. 完成后回到申诉页重试

### 第三步：走申诉（2FA 开好后）

- 主入口：**https://support.github.com/contact/reinstatement**
- 若表单仍不可用，改走这些渠道（任选）：
  - 邮件：**support@github.com**（用账号邮箱发，主题写明账号被 flagged 请求核查）
  - X / Twitter：**@GitHubSupport**（账号类问题回复较快）
  - 社区讨论：**https://github.com/orgs/community/discussions**（发在 `Account` 板块，常有官方 staff 介入）

> 申诉话术要点：说明这是**个人网络安全学习笔记的纯静态博客**，非商业、无垃圾 / 爬虫行为；说明匿名访问你的账号与全部仓库均 404、但带令牌访问正常。

### 第四步（强烈建议并行）：把托管迁出这个账号

申诉结果不可控、可能耗时数天。你的站点是**纯静态**、且**完整内容都在本地**，迁移几分钟就能恢复访问，不必等申诉：

| 方案 | 说明 | 是否依赖被限账号 |
| --- | --- | --- |
| **Cloudflare Pages**（推荐） | 新建项目 → Direct Upload → 上传 `D:\TraeWork\secnotes-pages\` 整个目录 | 否 |
| Vercel / Netlify | 直接把 `secnotes-pages\` 目录拖进去 | 否 |
| 自有服务器 / 内网 | 目录放进 Nginx 静态目录，或 `python -m http.server 8080` | 否 |
| 新建一个 GitHub 账号 | 重新建仓推送 + 开 Pages | 否（但同平台，新号仍可能被风控） |

本地先验证站点本身没问题（在发布目录执行）：

```powershell
cd "D:\TraeWork\secnotes-pages"
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/
```

### 关于 `deus808.github.io` 这个地址

被限制的是**账号**，不是仓库。即使申诉失败，只要换账号 / 换平台，把 `secnotes-pages` 的内容原样上传即可，站点功能与外观完全不变（站点用相对路径，`blog.config.json` 里的 `siteUrl` 改一下即可重新生成 RSS / sitemap）。
