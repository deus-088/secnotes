---
title: PHP 代码审计入门：从入口到危险函数
date: 2026-09-01
category: 代码审计
tags: [代码审计, PHP, 危险函数, 自动化]
summary: 介绍代码审计的通用方法论：梳理入口点、追踪数据流、定位危险汇聚点，并给出 PHP 中需要重点关注的函数清单与审计工具组合。
---

# PHP 代码审计入门：从入口到危险函数

> 代码审计的核心不是"记函数名"，而是**沿着数据流走完从入口到汇聚点的完整路径**。

## 一、通用审计方法论

1. **摸清架构**：框架还是原生？路由如何分发？有无统一入口（单一 `index.php`）？
2. **枚举入口点**：所有能接收外部输入的来源——`$_GET`、`$_POST`、`$_COOKIE`、`$_REQUEST`、`$_SERVER`、`php://input`、上传文件、HTTP 头。
3. **追踪数据流**：从入口出发，看数据经过哪些函数、是否被过滤、最终流向哪里。
4. **定位汇聚点（Sink）**：真正执行危险操作的函数。
5. **验证可利用性**：过滤是否可绕、上下文是否可控、是否需要前置条件（登录、特定配置）。

## 二、必须警惕的汇聚点

| 类别 | 危险函数 | 风险 |
| --- | --- | --- |
| 代码执行 | `eval`、`assert`、`create_function`、`preg_replace` 的 `/e` | 直接执行任意代码 |
| 命令执行 | `system`、`exec`、`shell_exec`、`passthru`、`popen`、反引号 | 执行系统命令 |
| 文件包含 | `include`、`require`、`include_once` | 配合上传实现 RCE |
| 文件操作 | `file_get_contents`、`fopen`、`unlink`、`copy`、`rename` | 任意文件读写/删除 |
| 反序列化 | `unserialize` | 触发魔术方法链（POP Chain） |
| 变量覆盖 | `extract`、`parse_str`、`$$var` | 覆盖关键变量绕过校验 |
| SQL | 字符串拼接的 `query` / `mysqli_query` | SQL 注入 |
| 反射与回调 | `call_user_func`、`call_user_func_array` | 间接代码执行 |

**反引号容易被忽略**：`` `id` `` 与 `shell_exec("id")` 等价，正则搜索时务必单独加一条。

## 三、危险函数的搜索方式

```bash
# 单文件快速排查
grep -nE "eval|assert|system|exec|shell_exec|passthru|popen|proc_open" *.php

# 递归搜索，排除第三方库
grep -rnE --include="*.php" "\b(eval|assert|system|exec)\s*\(" ./src | grep -v vendor

# 找可控的 include（变量包含）
grep -rnE --include="*.php" "(include|require)(_once)?\s*\(?\s*\\\$" ./

# 找反序列化入口
grep -rnE --include="*.php" "unserialize\s*\(" ./src | grep -v vendor
```

仅靠关键字会漏掉大量变形（如 `array_map('system', ...)`、`$f='sys'.'tem'`），因此关键字搜索只是**起点**，后续必须人工跟踪数据流。

## 四、过滤绕过的常见形态

审查过滤逻辑时，重点看这几类问题：

| 过滤写法 | 绕过思路 |
| --- | --- |
| `str_replace('select', '', $x)` | 只替换一次 → `seleselectct` |
| 黑名单未处理大小写 | `SeLeCt` |
| 黑名单未处理编码 | URL 编码、二次编码、宽字节 |
| `addslashes` 但未指定字符集 | 宽字节注入 |
| 前端 JS 校验 | 直接构造请求绕过 |
| 只校验 `$_GET` | 改用 `$_POST` 或 Cookie |

**审查要点**：过滤函数的作用范围（是否覆盖所有入参）、作用顺序（解码前还是解码后）、以及是否可被污染（如过滤结果被后续操作覆盖）。

## 五、框架审计的差异

框架项目有一个统一入口，漏斗式过滤会消化掉一部分传统漏洞，应把注意力转向：

- **路由解析**：是否存在参数覆盖、路径穿越、越权访问控制器；
- **依赖组件**：`composer.json` 中版本是否存在已知 CVE；
- **模板引擎**：是否存在模板注入（SSTI）；
- **ORM 逃逸口**：`whereRaw`、`DB::raw`、`orderBy` 动态字段；
- **序列化与反序列化**：框架自带的 POP 链（如 ThinkPHP、Laravel 的历史链）。

## 六、工具组合

| 工具 | 定位 |
| --- | --- |
| `grep` / `ripgrep` | 最快的关键字定位，日常主力 |
| RIPS（商业版） | 数据流分析，误报与漏报控制较好 |
| semgrep | 规则可定制，适合写项目专属规则 |
| phpstan / psalm | 静态类型检查，能发现部分类型混淆问题 |
| Burp Suite | 结合动态验证确认可利用性 |

**静态工具的结论必须动态验证**。工具报告"存在漏洞"与"可利用"之间往往隔着认证、配置、编码等多重条件。

## 小结

审计效率取决于两件事：**对入口点的敏感度**，以及对**数据流是否被真正拦截**的判断力。建议建立自己的检查清单，每次审计后把新发现的绕过手法回填进去。
