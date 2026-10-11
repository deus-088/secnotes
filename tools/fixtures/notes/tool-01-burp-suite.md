---
title: Burp Suite 高效配置与常用插件清单
date: 2026-09-02
category: 工具链
tags: [Burp Suite, 抓包, 代理, 插件]
summary: 整理 Burp Suite 的项目配置、代理与证书安装、Scope 与过滤器设置，以及提高测试效率的插件组合与快捷键。
---

# Burp Suite 高效配置与常用插件清单

## 一、初始化配置

### 1. 代理与证书

```bash
# Burp 默认监听 127.0.0.1:8080
# Firefox 推荐用 FoxyProxy 做规则切换，比全局代理更灵活
# 导入 CA：访问 http://burp 下载 cacert.der
```

```bash
# 命令行把 DER 转 PEM 供系统级导入（Linux）
openssl x509 -inform DER -in cacert.der -out cacert.pem
sudo cp cacert.pem /usr/local/share/ca-certificates/burp.crt
sudo update-ca-certificates
```

移动端抓包要点：设备与主机同网段 → 代理指向主机 IP → 安装并**在系统证书中信任**（Android 7+ 需将用户证书转为系统证书，或使用可改包的应用）。

### 2. Scope 设置（避免噪声）

在 `Target → Scope` 中把测试域名加入范围，然后：

- `Proxy → HTTP history` 勾选 **Show only in-scope items**；
- `Repeater`、`Intruder` 默认继承 Scope 过滤；
- 这样可以把第三方 CDN、统计脚本的流量彻底屏蔽掉。

### 3. 项目与内存管理

- 使用 **Project Options → Save project**（专业版支持持久化项目文件），临时测试可用内存模式；
- `Proxy → Options → Misc` 中调大 **Response 最大长度**，否则长响应会被截断；
- 关闭 `Intercept is on` 的默认开启，改用"只拦截特定范围"的匹配规则，避免手动放行到崩溃。

## 二、常用插件

| 插件 | 用途 |
| --- | --- |
| Logger++ | 全量流量记录与高级搜索，弥补 HTTP history 检索能力不足 |
| Turbo Intruder | 高性能并发爆破，适合 race condition 场景 |
| Autorize | 自动越权检测，登录低权限账号后自动重放请求 |
| Param Miner | 挖掘隐藏参数与缓存投毒面 |
| JWT Editor | JWT 结构解析与签名篡改测试 |
| Collaborator Everywhere | 批量注入外部交互 payload，检测盲注类漏洞 |
| Hackvertor | 快速做多层编码/解码变形 |
| Active Scan++ | 扩展主动扫描的检测面 |

> 插件安装后记得在 `Extender → BApp Store` 定期更新；插件堆太多会显著拖慢响应，按项目需要启用。

## 三、提效技巧

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 发送到 Repeater | `Ctrl+R` |
| 发送到 Intruder | `Ctrl+I` |
| 在 Repeater 中前/后一个 tab | `Ctrl+Shift+Tab` / `Ctrl+Tab` |
| 搜索响应内容 | `Ctrl+F` |
| 清空历史 | `Project options → Misc → Clear` |

### Repeater 的隐藏能力

- 右键 `Change body encoding` 快速切换编码；
- `Render` 标签页可直接预览 HTML 效果；
- 关闭 `Update Content-Length` 自动更新，用于测试 HTTP 请求走私与 Content-Length 不一致场景。

### Intruder 攻击类型选择

| 类型 | 适用场景 |
| --- | --- |
| Sniper | 单参数逐一测试，最常用 |
| Battering ram | 多位置填同一个值 |
| Pitchfork | 多组字典并行推进（用户名密码一一对应） |
| Cluster bomb | 多组字典全排列（笛卡尔积） |

## 四、与其他工具协作

```bash
# 结合 SQLMap 直接复用 Burp 的请求
# 1. 在 Burp 中右键 → Copy to file，保存为 req.txt
# 2. 交给 sqlmap 复用
sqlmap -r req.txt --batch --level=3 --risk=2 --dbs
```

```bash
# 结合 ffuf 复用 Cookie 做目录爆破
ffuf -u https://target/FUZZ -w dict.txt -H "Cookie: session=xxx" -fc 404
```

## 五、常见问题

1. **HTTPS 站点报证书错误**：CA 未导入到系统信任区，或应用使用了证书固定（Certificate Pinning）；
2. **抓不到流量**：检查应用是否绕过系统代理（如 Electron 应用需加 `--proxy-server` 参数）；
3. **响应被截断**：调大最大响应长度，或使用 Logger++ 查看完整内容；
4. **Repeater 响应乱码**：检查 `Content-Encoding`，必要时手动解压或让 Burp 自动处理。

## 小结

Burp 的效率差异主要来自两点：**Scope 是否干净**、**插件是否精简**。前者决定信噪比，后者决定响应速度。把这两件事做好，比堆砌功能更有效。
