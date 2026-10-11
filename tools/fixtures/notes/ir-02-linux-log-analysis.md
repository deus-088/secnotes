---
title: Linux 日志分析与入侵痕迹排查
date: 2026-09-03
category: 应急响应
tags: [Linux, 日志分析, 入侵排查, 后门排查, 溯源]
summary: 梳理 Linux 主机的主要日志位置、关键字段解读方法，以及计划任务、SSH 后门、LD_PRELOAD 劫持等常见持久化手法的排查命令。
---

# Linux 日志分析与入侵痕迹排查

## 一、日志地图

| 日志 | 路径 | 关注内容 |
| --- | --- | --- |
| 认证日志 | `/var/log/auth.log`（Debian）/ `/var/log/secure`（RHEL） | SSH 登录、sudo、su |
| 系统日志 | `/var/log/syslog` / `/var/log/messages` | 服务启停、内核消息 |
| 历史命令 | `~/.bash_history` | 攻击者操作（常被清空） |
| Web 访问 | `/var/log/nginx/access.log` | 扫描、webshell 访问 |
| Web 错误 | `/var/log/nginx/error.log` | 报错注入、路径穿越 |
| 计划任务 | `/var/log/cron` | 定时后门 |
| 登录历史 | `last`、`lastb`、`w`、`who` | 登录来源与时长 |
| 审计 | `/var/log/audit/audit.log` | 需 auditd，最完整的命令级记录 |

## 二、认证日志分析

```bash
# 登录失败的来源 IP 排行（暴破识别）
grep "Failed password" /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn | head

# 登录成功的记录（含来源 IP 与认证方式）
grep -E "Accepted (password|publickey)" /var/log/auth.log

# 按小时统计失败次数（找攻击时间窗）
grep "Failed password" /var/log/auth.log | awk '{print $3}' | sort | uniq -c
```

**关键点**：`Accepted password` 后紧跟 `session opened` 的记录要特别关注——如果来源 IP 是陌生地址，基本可以判定为成功入侵。

## 三、Web 日志分析

```bash
# 请求量 TOP IP
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -20

# 用户代理中的可疑扫描器
grep -iE "sqlmap|nikto|nmap|masscan|gobuster|dirsearch|curl|wget" access.log

# 高状态码与异常请求
awk '$9 ~ /^(404|500)$/ {print $1, $7, $9}' access.log | sort | uniq -c | sort -rn | head

# 找 webshell 访问特征
grep -E "\.(php|jsp|asp)\?.*=(eval|assert|system|passthru)" access.log
```

典型攻击链在日志中的表现：**大量 404（目录扫描）→ 特定参数的高频请求（注入探测）→ 某文件被 POST 且响应 200（上传/利用成功）**。

## 四、持久化排查

```bash
# 计划任务（用户级 + 系统级 + 其他位置）
crontab -l; ls -la /etc/cron.*; cat /etc/crontab
cat /var/spool/cron/crontabs/* 2>/dev/null

# 开机自启
systemctl list-unit-files --state=enabled
ls -la /etc/init.d/ /etc/rc*.d/

# 用户级自启文件（容易被忽略）
cat ~/.bashrc ~/.bash_profile ~/.profile /etc/profile
cat ~/.ssh/authorized_keys       # 后门公钥是最常见的持久化

# SSH 配置是否被改
grep -Ev "^#|^$" /etc/ssh/sshd_config

# 动态链接劫持
cat /etc/ld.so.preload
cat /etc/ld.so.conf.d/*.conf
```

**`/etc/ld.so.preload` 与 `~/.ssh/authorized_keys` 是排查中重复率最高的两个后门位置。**

## 五、进程与文件线索

```bash
# 隐藏进程：对比 /proc 与 ps 的输出差异
ls /proc | grep -E '^[0-9]+$' | sort -n > /tmp/p1
ps -eo pid --no-headers | tr -d ' ' | sort -n > /tmp/p2
diff /tmp/p1 /tmp/p2

# 已删除但仍运行的进程（木马常用）
ls -l /proc/*/exe 2>/dev/null | grep deleted

# 异常监听端口
ss -tulnp | grep LISTEN

# 按时间找最近被修改的文件
find / -xdev -type f -newermt "2026-09-01" -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null

# SUID 提权后门
find / -xdev -perm -4000 -type f 2>/dev/null
```

## 六、使用 rootkit 查杀工具交叉验证

```bash
rkhunter --check --skip-keypress
chkrootkit
# 用可信介质中的静态编译版本执行，避免被 rootkit 劫持
```

用户态 rootkit 常通过劫持 `ls`、`ps`、`netstat` 的 libc 调用来隐藏痕迹，因此**不能只用系统自带命令下结论**，务必用可信二进制交叉验证。

## 小结

Linux 排查的主线是"**登录 → 提权 → 持久化 → 外连 → 清除**"。每条链路都至少留有一处日志或文件痕迹，关键是找到相互印证的证据对，而不是依赖单一可疑项。
