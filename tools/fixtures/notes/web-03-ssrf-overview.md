---
title: SSRF 漏洞：成因、利用面与云环境下的加固
date: 2026-09-05
category: Web 安全
tags: [SSRF, 云安全, 内网探测, 元数据]
summary: 从服务端请求伪造的触发点出发，分析协议走私、302 跳转、DNS Rebinding 等常见绕过手法，并给出云环境 IMDS 加固与出网代理白名单方案。
---

# SSRF 漏洞：成因、利用面与云环境下的加固

## 一、什么是 SSRF

服务端请求伪造（Server-Side Request Forgery）指**应用根据用户可控的输入发起网络请求**，导致攻击者可以借服务端的网络位置访问内网资源。

典型触发功能：图片/文件远程加载、URL 预览与抓取、Webhook 回调、PDF/截图生成、SSO 与 OAuth 回调校验、XML 解析（XXE 常伴随 SSRF）。

```python
# 高危写法：URL 完全由用户控制
requests.get(request.args["url"], timeout=5)
```

## 二、危害等级

1. **探测内网拓扑**：通过响应时间与状态码差异判断存活主机与端口；
2. **访问内网未授权服务**：Redis、Memcached、Elasticsearch、Jenkins、K8s API Server；
3. **读取云元数据服务（IMDS）**：AWS `169.254.169.254/latest/meta-data/iam/security-credentials/` 可获取临时凭证，直接导致云账号接管；
4. **本地文件读取**：`file://` 协议读取配置与源码；
5. **协议走私**：`gopher://`、`dict://` 可用于构造任意 TCP 数据包，常与 Redis 写文件组合。

## 三、常见防护绕过手法

| 防护手段 | 绕过思路 |
| --- | --- |
| 关键字黑名单（`127.0.0.1`） | `2130706433`（十进制）、`0x7f000001`（十六进制）、`0177.0.0.1`（八进制）、`127.1` |
| 域名黑名单 | `DNS Rebinding`（TTL 设为 0，二次解析指向内网） |
| 只允许 http/https | `302` 跳转到 `file://` 或 `gopher://`，服务端跟随跳转时未复检 |
| 正则匹配 URL 前缀 | `http://evil.com@127.0.0.1/`、`http://127.0.0.1#@evil.com` |
| 仅校验一次 | 重定向后不再校验，形成 TOCTOU |

## 四、加固方案（按有效性排序）

### 1. 网络层隔离（最根本）

- 业务服务**默认禁止出网**，仅放行必要域名；
- 内网敏感服务（Redis、K8s API、IMDS）加独立网络策略，拒绝来自应用网段的访问；
- 云上启用 **IMDSv2**（要求 token 且禁止 `PUT` 到任意地址），可显著抬高利用门槛。

### 2. 应用层白名单

```python
ALLOW_HOSTS = {"api.example.com", "cdn.example.com"}
ALLOW_SCHEMES = {"https"}

p = urlparse(user_url)
if p.scheme not in ALLOW_SCHEMES or p.hostname not in ALLOW_HOSTS:
    raise ValueError("blocked")
```

- 解析 URL → 校验**协议与主机名**（用解析后的 `hostname`，不要用原始字符串）→ 解析出 IP 后再校验一次 → **使用该 IP 直连**（避免二次解析触发 DNS Rebinding）；
- 禁止跟随跳转，或对每一跳重新执行完整校验；
- 只允许 `http`/`https`，显式拒绝 `file`、`gopher`、`dict`、`ftp`。

### 3. 兜底措施

- 出网请求走**统一 HTTP 代理**，在代理层落地域名白名单与审计日志；
- 对响应体做类型与大小限制，防止被当作数据外带通道；
- 记录完整请求 URL、解析 IP、响应码，便于事后溯源。

## 五、测试检查清单

- [ ] 所有接受 URL/域名参数的接口是否枚举完整
- [ ] 是否支持 `file://`、`gopher://` 等非 HTTP 协议
- [ ] 是否跟随 302 且跟随之后不再校验
- [ ] 是否存在解析歧义（`@`、`#`、编码、大小写）
- [ ] 云环境下 IMDS 是否可达、是否为 v2

## 小结

SSRF 的修复难点不在"判断"而在"解析一致性"——**校验用的 URL 和实际请求的 URL 必须是同一个解析结果**。做不到这一点，白名单也会被绕过。

若要在代码层定位这类问题，思路可参考 [[PHP 代码审计入门：从入口到危险函数]] 中「追踪数据流」的部分。
