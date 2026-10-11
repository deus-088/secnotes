---
title: XSS 三种类型与输出上下文分析
date: 2026-09-08
category: Web 安全
tags: [XSS, 前端安全, CSP, 同源策略]
summary: 区分反射型、存储型、DOM 型 XSS 的判定方式，重点讲解输出上下文（HTML/属性/JS/URL/CSS）对应的编码策略，以及 CSP 的正确落地姿势。
---

# XSS 三种类型与输出上下文分析

## 一、三种类型的判定

| 类型 | 数据流向 | 触发条件 | 危害特征 |
| --- | --- | --- | --- |
| 反射型 | 请求 → 响应 → 浏览器 | 诱导点击特制链接 | 一次性，需社工配合 |
| 存储型 | 请求 → 数据库 → 其他用户 | 恶意内容被持久化 | 影响面最大，可蠕虫化 |
| DOM 型 | URL/前端存储 → JS 拼接 → DOM | 前端直接操作 DOM | 服务端日志中不可见 |

DOM 型 XSS 的关键特征是**服务端从未参与**：值从 `location.hash`、`document.referrer` 等来源进入 `innerHTML`、`document.write`、`eval` 等危险汇聚点。

## 二、输出上下文决定编码方式

这是防御 XSS 最容易被忽视的部分——**同一个值输出到不同位置，需要的编码完全不同**。

| 输出位置 | 示例 | 编码策略 |
| --- | --- | --- |
| HTML 文本 | `<div>${x}</div>` | HTML 实体编码 `& < > " '` |
| HTML 属性 | `<input value="${x}">` | 属性值加引号 + HTML 实体编码 |
| URL 参数 | `<a href="/s?q=${x}">` | URL 编码，并校验协议白名单 |
| JavaScript 变量 | `var a = "${x}"` | 禁止直接嵌入，改用 `JSON.stringify` + 转义 `<` |
| CSS | `style="color:${x}"` | 白名单化，否则禁止 |

**常见误区**：在 JS 上下文里只用 HTML 实体编码，攻击者用 `</script>` 即可逃逸。正确做法是让模板引擎（如 Vue 的 `{{ }}`、React 的 JSX）自动完成上下文感知编码。

## 三、防御优先级

1. **上下文感知的自动转义**（模板引擎默认行为，不要用 `v-html` / `dangerouslySetInnerHTML`）；
2. **DOM 层避免危险 API**：用 `textContent` 替代 `innerHTML`，用 `setAttribute` 替代字符串拼接；
3. **富文本必须先净化再存储**：服务端用成熟库（DOMPurify 的服务端版本、`bleach`、`jsoup`）做白名单过滤，禁止自研正则过滤器；
4. **CSP 作为第二道防线**：

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{random}';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'self'
```

注意 `'unsafe-inline'` 与 `'unsafe-eval'` 一旦开启，CSP 的 XSS 防护基本失效。若必须内联脚本，使用**每个响应随机生成的 nonce**。

5. **Cookie 加固**：`HttpOnly` 阻断 `document.cookie` 窃取，`SameSite=Lax/Strict` 缓解 CSRF 联动风险。

## 四、测试要点

- 逐一测试每个输出点，不要只测"最明显"的那个参数；
- 关注二次输出：输入时被过滤，但读取时拼接进了新上下文；
- 检查 `Content-Type` 与 `X-Content-Type-Options: nosniff`，防止 MIME 嗅探导致的 HTML 解析；
- 验证 CSP 是否真正生效（Report-Only 模式不会拦截）。

## 小结

XSS 的本质是**代码与数据在同一上下文中混淆**。防住它需要"输入校验 + 输出编码 + 危险 API 规避 + CSP 兜底"四层配合，任何单点方案都不足以覆盖全部场景。
