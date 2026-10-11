---
title: HTTP协议
date: 2026-09-16
category: Web基础知识
tags: [HtTP]
summary: HTTP的请求方式、请求消息与响应消息解析、响应码分析
---

HTTP协议：浏览器与服务器交流的统一协议

## 一、四大特点
1. 第一项基于TCP/IP协议：HTTP所有请求与响应建立在TCP三次握手成功后
1. 第一项第一项默认端口是80：HTTP默认80，HTTPS则默认是443
1. 第一项请求与响应：一次请求就有一次响应，一一对应，不多不少
1. 第一项无状态协议：HTTP协议本身是没记性的，它不记录上次访问的信息。因此，为了记住你的信息，发明了Cookie和Session

## 二、两种常用的请求方法
### HTTP协议的8种请求方式：
- GET 请求指定页面信息
- POST 提交数据进行处理请求（登录/上传）
- HEAD 类似于GET请求，但是返回响应没有具体内容，纯获取报头的
- OPTIONS 查看服务器性能
- PUT 从客户端向服务器传送的数据取代指定文档的内容
- DELETE 请求服务器删除某页面
- TRACE 回显服务器收到的请求，用于测试诊断
- CONNECT 

其中最常见的两种方式是GET和POST，下面逐一分析：
### 2.1. GET请求
- 用于向服务器获取/查询资源
- 请求参数会直接拼接在URL地址里
- 其传输数据有长度限制（通常为2KB~8KB）
```bash
GET示例：（用NFS教室导航知名1-101）：
https://nfs.pcdawn.cn/api/app/classroomNavigation/public/media?id=59493c3f-c49a-43bd-95e7-3277255f9244
*这个请求的资源实际上是导航到1-101的那张示例照片
```

### 2.2. POST请求
- 用于向服务器提交/更新资源（登录/上传等）
- 请求参数放在协议的请求体中
- 理论上无大小限制，适合传输大文件/数据包/JSON表单
```bash
POST示例（位于请求体）：
Content-Type: application/x-www-form-urlencoded;charset=utf-8
```

## 三、请求消息-Request结构拆解
### *以下是在福师大教务处登录界面提交账密为12345登录请求的抓包结果，发现其为POST请求，接下来逐步分析*
（*手动抓包记录*）
![图片](assets/uploads/202609/http-406a286e4c.png)


### 3.1. 请求行
```bash 
请求方式                   请求URI                     协议及版本
  POST      /jwglxt/xtgl/yhgl_cxXxqrCheck.html        HTTP/2
``` 

### 3.2. 请求头
#### 3.2.1. Host请求目标
指明请求的目标主机域名或IP地址 （用于在一台服务器部署多个虚拟主机做站点区分）
```bash
Host: jwglxt.fjnu.edu.cn
```
#### 3.2.2. User-Agent 客户端指纹
告诉服务器浏览器版本与操作系统环境（服务器据此解决兼容性问题，规避自动化扫描器的阻断）
```bash
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
比如这里就透露了客户端操作系统版本Windows、浏览器核心指纹Chrome/151 Safari/537.36
```
*自动化工具nmap、如sqlmap都带着自己的UA，所以写自动化脚本等得把这个“马甲”换好*
#### 3.2.3. Accept 媒体类型限制
告诉服务器，客户端浏览器可接收、处理的文件类型

其中q代表权重/优先级/偏好程度，范围是0~1，q=1表示优先级最高，向0递减，q=0表示不接受此类型消息，未注明时q默认为1
```bash
Accept: application/json, text/javascript, */*; q=0.01
如上面这条说明可处理JSON数据、JavaScript文本、和任意其他类型(*/*),q=0.01说明优先级不高
```

#### 3.2.4. Referrer 来源溯源
告诉服务器当前请求是从哪个页面跳转过来的

*（运维常用于统计来源及防盗链防御，在安全视角下也常牵扯到CSPF漏洞验证）*
```bash
Referer: https://jwglxt.fjnu.edu.cn/jwglxt/xtgl/login_slogin.html？time=1789542970642
这就是我们正常访问福师大教务处的登录界面，确实是由此跳转的
```

#### 3.2.5. Accept-Encoding/Language 压缩与语言：协议对齐
浏览器向服务器声明自己可以接收的数据压缩方法（如gzip）以及首选语言环境（如zh-CN）
```bash
Accept-Language: zh-CN,zh;q=0.9
Accept-Encoding: gzip, deflate, br
```

#### 3.2.6. Cookie 客户端状态凭证：专属令牌
- 声明客户端本地存储的会话数据。告诉服务器当前请求的相关身份或历史状态。
- 在安全测试中，若缺失 HttpOnly 属性，极易被XSS攻击；若缺失 SameSite 属性，常牵涉到 CSRF跨站请求伪造漏洞。
- 浏览器会自动在请求头中携带此字段（大小通常限制在 4KB 以内）。服务端可通过响应头 Set-Cookie 进行下发，建议对敏感信息进行加密或使用 Token 替代。
```bash
Cookie: Path=/; JSESSIONID=072EB37EC09B92EA6C549D7F6DEA0412; Path=/; SF_cookie_3=26141024
```
> Cookie和Session的区别：

- 位置不同：cookie在客户端，session在服务器端；
- 安全性不同：cookie用户可看到，session在服务器里；
- 容量不同：cookie容量很小（约几KB，session可以存更多）

**简单理解一下：Cookie就是客户端的小纸条，Session是服务器的档案柜，Cookie是打开档案柜的钥匙（SessionID）**

#### 3.2.7. Sec-Fetch-系列 请求元数据与安全策略
描述请求的目的、模式和站点关系。
- Dest: empty 表明这是由脚本发起的请求（非图片/文档加载）；
- Mode: cors 表明是跨域请求模式；
- Site: same-origin 表明请求完全同源。
```bash
Sec-Fetch-Dest: empty
Sec-Fetch-Mode: cors
Sec-Fetch-Site: same-origin
```

#### 3.2.8. Priority 请求优先级
告知服务器当前请求的相对优先级。 u=0 通常代表最高优先级

*用高优先级可能引发资源耗尽型拒绝服务（DoS）*
```bash
Priority u=0
```

> 下面几个写不动了，就先这些

Content-Type: application/x-www-form-urlencoded;charset=utf-8

X-Requested-With: XMLHttpRequest

Content-Length: 9

Origin: https://jwglxt.fjnu.edu.cn



### 3.3. 请求空行
```bash
就是一个空行

如上
```
### 3.4. 请求体
```bash
ylm=12345  （这就是账号12345)
```



## 四、响应消息-Response结构拆解
*以下是在Kali中运行curl -I nfs.pcdawn.cn的结果，得到了NFS的响应消息*
![图片](assets/uploads/202609/http-431d443def.png)
### 4.1.状态行
包含协议版本和状态码，判断请求是否成功的唯一标准
```bash
协议              状态码（含提示）
HTTP/1.1      301 Moved Permanently
```

### 4.2 响应头
#### 4.2.1 Server 中间件指纹
暴露了服务器使用的中间类型，在渗透中是关键线索，可以寻找对应版本的漏洞
```bash
Server: Tengine
*了解到Tengine是由阿里巴巴发起的Web服务器项目，证明NFS运行在阿里CDN下“
```
如果此处直接暴露版本号，假设为Tengine/2.3.3这种带版本号的字段，就可以查找已知漏洞针对性攻击，（*此处删去版本号是增加攻击者的信息收集难度*）

#### 4.2.2 Content-Type 数据格式
告诉浏览器如何解析内容，text/html代表这是一个网页，需要渲染显示
```bash
Content-Type: text/html
```

### 4.2.3 Location 重定向地址
服务器让我跳转到https的根路径（末尾/代表根目录），这里没有，但常见
```bash
Location: https://nfs.pcdawn.cn/
```

### 4.2.4Timing-Allow-Origin
允许任何来源的网页通过获取该资源的详细网络耗时信息

* 表示不限制来源
```bash
Timing-Allow-Origin: *
```

### 4.3 响应空行
```bash
就是一个完整的空行，如下：



其目的是宣告响应头信息结束
```
### 4.4 响应体
服务器回传的载荷数据，可以是HTML源码、JSON接口数据、图片、恶意脚本

这里是Web漏洞的最终展现舞台

## 五、响应状态码
### 5.1 五大状态码
#### 5.1.1 200 OK-成功
用于检测业务逻辑漏洞，低权限账号访问管理员接口回显200，即为越权漏洞
#### 5.1.2 302 Found-临时重定向
关注Location头，常用于拦截未登录请求，或存在URL跳转漏洞
#### 5.1.3 304 Not Modified-缓存
告知浏览器调用本地缓存，节约带宽
#### 5.1.4 403 Forbidden-拒绝
理解了请求，却拒绝执行，实战中尝试403Bypass绕过IP或路径限制
#### 5.1.5 404 Not Found-不存在
目录扫描的基础，非404响应可能爆出敏感文件
#### 5.1.6 Effor-内部错误
后台代码崩溃信号，往往是SQL注入或diamagnetic执行异常的报警

### 5.2 五类状态码
- 1xx 消息提示（接收中）（这个很罕见）
- 2xx 成功响应（处理完毕）
- 3xx 重定向（地址变化）
- 4xx 客户端错误（权限/路径）
- 5xx 服务器错误（服务器崩溃）
