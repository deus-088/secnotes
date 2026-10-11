---
title: Linux基础
date: 2026-10-11
category: 计算机基础
tags: [Linux]
---

# Linux基础命令与使用

> 以下均为基于Kali Linux（Debian）所学的命令

## 一、有关情报收集最常用命令
### 1.1 curl/wget：HTTP 请求与下载

#### -I / -i 响应头、体
-I 只看响应头，-i 看响应头＋体，主要看Server、X-Powered-By、Set-Cookie、Location
*此处顾名思义不放图片*
#### -L 跟随重定向
跟随重定向的地址继续发送请求，下图为有无-L命令的运行状态
![图片](assets/uploads/202610/linux-5831828e24.png)
显而易见，没有加-L的命令的响应体中只回显了301，加了-L的命令回显200，此为重定向
#### -H：自定义请求头






## 二、核心内容
