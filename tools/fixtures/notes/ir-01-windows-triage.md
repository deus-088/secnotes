---
title: Windows 应急响应排查清单（可执行版）
date: 2026-09-04
category: 应急响应
tags: [应急响应, Windows, 入侵排查, 取证]
summary: "按\"先隔离后取证\"的原则，给出 Windows 主机入侵排查的六大方向与可直接执行的命令清单，含时间线构建与证据保全注意事项。"
---

# Windows 应急响应排查清单（可执行版）

> 核心原则：**先控制，再取证，最后溯源**。任何排查动作都不应破坏原始证据。

## 零、处置顺序

1. **隔离**：断网（保留内存优先）或网络层封禁，避免攻击者继续横向；
2. **保全**：内存镜像 → 磁盘镜像 → 再开始分析；
3. **排查**：按下方六个方向逐项过；
4. **溯源**：构建时间线，定位初始入口；
5. **清除与加固**：清除持久化，修补入口点。

> 注意：**直接关机或重启会丢失内存证据**。若非必须，应优先抓取内存（可用 WinPmem、DumpIt）后再操作。

## 一、账号与登录

```cmd
:: 本地用户与管理员组
net user
net localgroup administrators
wmic useraccount get name,sid,status,passwordrequired

:: 隐藏/克隆账号排查：关注 SID 以 $ 结尾的项
reg query "HKLM\SAM\SAM\Domains\Account\Users" /s

:: 登录记录（需开启审核策略）
wevtutil qe Security /q:"*[System[(EventID=4624)]]" /c:50 /rd:true /f:text
:: 4624 登录成功 4625 登录失败 4672 特权分配 4720 新建用户
```

关注点：非预期的新增管理员、异常时间窗的登录、来自内网其他主机的 4624（类型 3 网络登录）。

## 二、进程与服务

```cmd
:: 进程及其命令行与父进程（wmic 比 tasklist 信息更全）
wmic process get name,processid,parentprocessid,executablepath,commandline /format:list

:: 服务与驱动
sc query type= service state= all
sc qc <服务名>
driverquery /v

:: 计划任务
schtasks /query /fo LIST /v
```

可疑信号：路径在 `Temp`、`ProgramData`、用户目录下的可执行文件；命令行含 `powershell -enc`、`-nop -w hidden`；父进程异常（如 `winword.exe` 启动 `cmd.exe`）。

## 三、持久化位置

| 位置 | 检查命令 |
| --- | --- |
| 注册表 Run 键 | `reg query HKLM\Software\Microsoft\Windows\CurrentVersion\Run /s` |
| 启动文件夹 | `dir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"` |
| Winlogon | `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"` |
| 服务 | `sc query type= service` |
| WMI 事件订阅 | `Get-WmiObject -Namespace root\subscription -Class __EventFilter` |
| IFEO 劫持 | `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options" /s` |

WMI 事件订阅与 IFEO 劫持是**容易被遗漏**的两处，务必单独检查。

## 四、网络连接

```cmd
netstat -ano | findstr ESTABLISHED
netstat -anob            :: 需管理员，可显示进程名
arp -a
route print
```

将 `netstat` 的 PID 与前面的进程清单交叉比对，重点看**外连的公网 IP 与非常用端口**。

## 五、日志与时间线

```powershell
# 关键事件 ID 一览
# 4624 登录成功   4625 登录失败   4672 特权登录
# 4688 进程创建   4698 计划任务创建  7045 服务安装
# 1102 日志被清空 104  日志被清除

Get-WinEvent -FilterHashtable @{LogName='System'; Id=7045} -MaxEvents 50 |
  Format-List TimeCreated, Message

Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4688,4720,4726} |
  Select-Object TimeCreated, Id, Message
```

**日志被清空（1102/104）本身就是强告警信号**，往往发生在横向或清除阶段。

## 六、文件与痕迹

```cmd
:: 按时间找最近修改的 Web 目录文件（找 webshell）
forfiles /P "C:\inetpub\wwwroot" /S /M *.* /D +2026-09-01 /C "cmd /c echo @path @fdate @ftime"

:: 查找 ADS 数据流
dir /r /s C:\Users

:: 最近访问记录
dir "%USERPROFILE%\Recent"
```

Webshell 常见特征：时间戳异常（与目录内其他文件差异大）、内容含编码后的 eval/assert 调用、文件大小偏小但权限新。

## 七、常用工具

- **Autoruns**：一站式列出全部自启动项，最适合快速扫持久化；
- **Process Explorer / Process Hacker**：查看进程树、签名、加载的 DLL；
- **Sysmon + SwiftOnSecurity 配置**：补足系统默认日志的盲区；
- **Volatility 3**：内存镜像取证，`windows.pslist`、`windows.netscan`、`windows.malfind`。

## 小结

排查的最高效路径是**先建时间线再解释时间线**：把账号、进程、网络、文件的时间戳汇总到一条轴上，异常点会自然浮现。工具只是加速器，判断仍然来自对业务正常基线的理解。

Linux 主机上的同类排查思路见 [[Linux 日志分析与入侵痕迹排查]]；单机练手环境可参考 [[个人安全实验环境搭建清单]]。
