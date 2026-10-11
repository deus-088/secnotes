#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecNotes 内容管理服务（admin.py）回归测试
-----------------------------------------
会真实启动 admin.py，完成一轮「新建 → 读取 → 修改 → 改名 → 删除 → 还原 → 彻底删除」，
并在结束时校验笔记目录回到初始状态、data/notes.js 已重新构建。

用法：
    python tools/verify-admin.py
    python tools/verify-admin.py --keep    # 保留临时文件便于排查（默认清理）

注意：测试只操作自己的临时笔记（slug 以 zz-verify- 开头），不会触碰现有笔记。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

RESULTS: list[str] = []
FAILED = 0


def check(name: str, cond: bool, extra: str = "") -> bool:
    global FAILED
    RESULTS.append(f"  {'PASS' if cond else 'FAIL'}  {name}{('  → ' + extra) if extra else ''}")
    if not cond:
        FAILED += 1
    return bool(cond)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, base: str, token: str):
        self.base, self.token = base, token

    def call(self, method: str, path: str, body=None, token: bool = True):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-Admin-Token", self.token)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def json(self, method: str, path: str, body=None, token: bool = True):
        status, raw = self.call(method, path, body, token)
        try:
            return status, json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return status, {"ok": False, "raw": raw[:200]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="保留临时笔记（默认清理）")
    args = parser.parse_args()

    py = sys.executable
    port = free_port()
    env = {**__import__("os").environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}

    # ---------------- 夹具安装（快照精确还原） ----------------
    # 测试需要站点上至少有笔记可供「读、改、删、还原」全流程；
    # 用户清空 notes/ 时测试不应假失败。fixtures 与 verify-render/manage 同一份。
    #
    # 测试专用文件名（夹具同名 + zz- 前缀）出现在 notes/ 里一律视为污染：
    # 必须显式识别，否则残留会被当成「用户内容」进入快照，之后再也还原不掉，
    # 还会被构建进 data/notes.js、再被 e2e 的同步写回 notes/（真实发生过）。
    FIXTURE_DIR = ROOT / "tools" / "fixtures" / "notes"
    NOTES_DIR = ROOT / "notes"
    fixture_names = ({p.name for p in FIXTURE_DIR.glob("*.md")}
                     if FIXTURE_DIR.exists() else set())

    def is_test_artifact(name: str) -> bool:
        return name in fixture_names or re.match(r"^zz-(verify|e2e)", name) is not None

    notes_snapshot: dict = {}
    fixture_state = {"dirty": False}        # 用 dict 绕过 Python 闭包作用域陷阱

    # 起跑先净化，保证快照建立在干净的基线上
    purged = 0
    if NOTES_DIR.exists():
        for p in list(NOTES_DIR.glob("*.md")):
            if is_test_artifact(p.name):
                p.unlink(missing_ok=True)
                purged += 1
    if purged:
        subprocess.run([py, "build.py"], cwd=str(ROOT), check=False)
        print(f"  INFO  起跑时清除了 {purged} 篇上轮测试残留")

    if NOTES_DIR.exists():
        for p in NOTES_DIR.glob("*.md"):
            notes_snapshot[p.name] = p.read_bytes()
    if FIXTURE_DIR.exists():
        for name in sorted(fixture_names):
            if name in notes_snapshot:
                continue
            shutil.copyfile(FIXTURE_DIR / name, NOTES_DIR / name)
            fixture_state["dirty"] = True
        if fixture_state["dirty"]:
            subprocess.run([py, "build.py"], cwd=str(ROOT), check=False)

    def restore_notes() -> None:
        changed = False
        if NOTES_DIR.exists():
            for p in list(NOTES_DIR.glob("*.md")):
                if p.name not in notes_snapshot or is_test_artifact(p.name):
                    p.unlink(missing_ok=True)
                    changed = True
        for name, buf in notes_snapshot.items():
            if is_test_artifact(name):      # 防御：快照里不该有污染
                continue
            target = NOTES_DIR / name
            if not target.exists() or target.read_bytes() != buf:
                target.write_bytes(buf)
                changed = True
        if changed or fixture_state["dirty"]:
            subprocess.run([py, "build.py"], cwd=str(ROOT), check=False)
        fixture_state["dirty"] = False
    import atexit
    atexit.register(restore_notes)

    proc = subprocess.Popen(
        # -u：关闭子进程的输出缓冲，否则启动横幅会滞留在管道里导致读取阻塞
        [py, "-u", str(ROOT / "admin.py"), "--port", str(port)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", env=env, bufsize=1,
    )

    base = f"http://127.0.0.1:{port}"
    token = ""
    try:
        # ---------- 等待服务就绪并取出访问令牌 ----------
        deadline = time.time() + 25
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            m = re.search(r"token=([A-Za-z0-9_\-]+)", line)
            if m:
                token = m.group(1)
                break
        if not check("服务成功启动并打印访问令牌", bool(token)):
            print("\n".join(RESULTS))
            return 1

        c = Client(base, token)

        # ---------- 静态资源与令牌注入 ----------
        status, raw = c.call("GET", "/")
        html = raw.decode("utf-8", "replace")
        check("编辑器首页可访问", status == 200, f"HTTP {status}")
        check("页面已注入真实令牌", "__ADMIN_TOKEN__" not in html and token in html)
        check("编辑器优先加载共享渲染模块",
              "/assets/js/render.js" in html and html.index("render.js") < html.index("admin.js"))
        status, _ = c.call("GET", "/assets/css/admin.css")
        check("编辑器样式可访问", status == 200, f"HTTP {status}")
        status, _ = c.call("GET", "/../admin.py")
        check("静态资源目录穿越被拦截", status == 404, f"HTTP {status}")

        # ---------- 静态资源收窄：写作产物不得经 HTTP 暴露 ----------
        status, _ = c.call("GET", "/notes/web-01-sql-injection-basics.md")
        check("原始笔记不经 HTTP 暴露", status == 404, f"HTTP {status}")
        status, _ = c.call("GET", "/notes/")
        check("笔记目录列表不可访问", status == 404, f"HTTP {status}")
        status, _ = c.call("GET", "/.trash/any.md")
        check("回收站不经 HTTP 暴露", status == 404, f"HTTP {status}")
        status, _ = c.call("GET", "/.workbuddy/memory/MEMORY.md")
        check("以点开头的目录一律拒绝", status == 404, f"HTTP {status}")
        status, _ = c.call("GET", "/admin.py")
        check("服务端源码不经 HTTP 暴露", status == 404, f"HTTP {status}")
        status, _ = c.call("GET", "/blog.config.json")
        check("站点配置文件不经 HTTP 暴露", status == 404, f"HTTP {status}")
        status, _ = c.call("GET", "/index.html")
        check("站点首页仍可正常访问", status == 200, f"HTTP {status}")
        status, _ = c.call("GET", "/assets/js/render.js")
        check("前端脚本仍可正常访问", status == 200, f"HTTP {status}")

        # ---------- 鉴权 ----------
        status, obj = c.json("GET", "/api/state", token=False)
        check("缺少令牌时接口返回 403", status == 403, f"HTTP {status}")
        status, obj = c.json("GET", "/api/state")
        check("携带令牌可读取状态", status == 200 and obj.get("ok"), f"HTTP {status}")

        # 防御：上一次运行若被中断，可能残留测试文件。若不先清理，
        # 后续断言会以被污染的集合为基线，从而「看起来通过」实则掩盖问题。
        leftovers = sorted(
            list((ROOT / "notes").glob("zz-verify*")) + list((ROOT / ".trash").glob("*zz-verify*"))
        )
        if leftovers:
            check("检测到上次运行遗留的测试文件（已自动清理）", False,
                  "、".join(str(p) for p in leftovers))
            for p in leftovers:
                p.unlink()
            subprocess.run([py, str(ROOT / "build.py")], cwd=str(ROOT),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env)
            status, obj = c.json("GET", "/api/state")

        initial_count = len(obj.get("notes", []))
        initial_slugs = {n["slug"] for n in obj.get("notes", [])}
        initial_files = {p.name for p in (ROOT / "notes").glob("*.md")}
        # 回收站可能本来就有东西（用户删掉的笔记）。以"开始时快照"为准，
        # 断言测试没有往回收站新增/残留，而不是假设回收站是空的。
        initial_trash = ({p.name for p in (ROOT / ".trash").glob("*")}
                         if (ROOT / ".trash").exists() else set())
        check("初始笔记列表非空", initial_count > 0, f"{initial_count} 篇")
        check("初始状态没有测试文件残留",
              not any(name.startswith("zz-verify") for name in initial_files),
              str(sorted(initial_files)[:3]))

        # ---------- 新建 ----------
        TMP = "zz-verify-tmp"
        title = "验证用笔记：冒号与中文 # 标题"
        body = (
            "# 验证正文\n\n"
            "含 **加粗**、`行内代码` 与表格：\n\n"
            "| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n\n"
            "```bash\nnmap -sV 127.0.0.1\n```\n"
        )
        status, obj = c.json("POST", "/api/note", {
            "slug": "",
            "meta": {"slug": TMP, "title": title, "date": "2026-09-10",
                     "category": "工具链", "tags": ["验证", "测试:标签"],
                     "summary": "含: 冒号的摘要", "draft": False},
            "body": body,
        })
        check("新建笔记成功", status == 200 and obj.get("ok"), obj.get("error", ""))
        check("返回创建标记", obj.get("created") is True)

        note_path = ROOT / "notes" / f"{TMP}.md"
        check("笔记文件已落盘", note_path.is_file())
        saved = obj.get("note") or {}
        check("标题正确回读", saved.get("title") == title, repr(saved.get("title")))
        check("标签正确回读", saved.get("tags") == ["验证", "测试:标签"], str(saved.get("tags")))
        check("摘要正确回读", saved.get("summary") == "含: 冒号的摘要", repr(saved.get("summary")))
        check("正文字节数一致", len((saved.get("body") or "").strip()) == len(body.strip()))

        # 用 build.py 自己的解析器复核 front-matter 往返一致
        import build as builder
        meta, parsed_body = builder.split_front_matter(note_path.read_text(encoding="utf-8"))
        check("front-matter 可被构建脚本正确解析", str(meta.get("title")) == title,
              repr(meta.get("title")))
        check("标签数组往返一致", builder.as_list(meta.get("tags")) == ["验证", "测试:标签"],
              str(builder.as_list(meta.get("tags"))))
        check("围栏代码块保留完整", body.strip() in parsed_body)

        # slug 规则：必须与前端 assets/js/manage.js 完全一致，且绝不编造名字。
        # 两侧不一致会让「同一篇再保存一次」落成新的文件名（曾导致保存一次多一篇）。
        check("slugify 保留开头数字（不再被剥掉）",
              builder.slugify("111 测试") == "111-测试", builder.slugify("111 测试"))
        check("slugify 下划线转横线（与前端一致）",
              builder.slugify("A_B") == "a-b", builder.slugify("A_B"))
        check("slugify 无法生成时返回空串（不编造名字）",
              builder.slugify("!!!") == "" and builder.slugify("") == "",
              repr([builder.slugify("!!!"), builder.slugify("")]))
        check("slugify 幂等（对已是 slug 的输入不再改变）",
              builder.slugify("111-测试") == "111-测试" and builder.slugify("a-b") == "a-b")

        # 构建确实跑过：data/notes.js 应包含新标题
        data_js = (ROOT / "data" / "notes.js").read_text(encoding="utf-8")
        check("保存后自动重建了站点数据", title in data_js)
        check("构建输出已回传", bool((obj.get("build") or {}).get("output")))

        # ---------- 重名与非法文件名 ----------
        status, obj = c.json("POST", "/api/note", {
            "slug": "",
            "meta": {"slug": TMP, "title": "重复", "date": "2026-09-10", "category": "x", "tags": []},
            "body": "dup",
        })
        check("重复文件名被拒绝", status == 400, obj.get("error", ""))
        status, obj = c.json("GET", "/api/note?slug=" + TMP)
        check("被拒绝的重名写入未覆盖原笔记", obj.get("note", {}).get("title") == title,
              repr(obj.get("note", {}).get("title")))

        status, obj = c.json("GET", "/api/note?slug=" + urllib.parse.quote("../build", safe=""))
        check("读取接口拒绝目录穿越", status == 400, f"HTTP {status}")

        status, obj = c.json("GET", "/api/note?slug=_hidden")
        check("读取接口拒绝下划线开头文件", status == 400, f"HTTP {status}")

        # ---------- 修改 ----------
        status, obj = c.json("POST", "/api/note", {
            "slug": TMP,
            "meta": {"slug": TMP, "title": "验证用笔记（已修改）", "date": "2026-09-11",
                     "category": "应急响应", "tags": ["验证"], "summary": "", "draft": True},
            "body": body + "\n## 新增小节\n\n补充内容。\n",
        })
        check("修改笔记成功", status == 200 and obj.get("ok"), obj.get("error", ""))
        check("修改不视为新建", obj.get("created") is False)
        check("草稿标记已写入", obj["note"].get("draft") is True)
        check("摘要留空时自动截取首段", bool(obj["note"].get("summary")))
        check("分类已更新", obj["note"].get("category") == "应急响应")

        # ---------- 改名 ----------
        NEW = "zz-verify-renamed"
        status, obj = c.json("POST", "/api/note", {
            "slug": TMP,
            "meta": {"slug": NEW, "title": "验证用笔记（已改名）", "date": "2026-09-11",
                     "category": "应急响应", "tags": ["验证"], "summary": "", "draft": False},
            "body": body,
        })
        check("改名保存成功", status == 200 and obj.get("ok"), obj.get("error", ""))
        check("响应标记已改名", obj.get("renamed") is True)
        check("新文件名已生成", (ROOT / "notes" / f"{NEW}.md").is_file())
        check("旧文件已清理", not (ROOT / "notes" / f"{TMP}.md").exists())

        # ---------- 删除 → 回收站 ----------
        status, obj = c.json("POST", "/api/delete", {"slug": NEW})
        check("删除成功", status == 200 and obj.get("ok"), obj.get("error", ""))
        check("删除为移入回收站而非抹除", obj.get("canRestore") is True, str(obj.get("trashed")))
        check("笔记文件已移出 notes/", not (ROOT / "notes" / f"{NEW}.md").exists())
        trash_name = obj.get("trashed", "")
        check("回收站文件存在", bool(trash_name) and (ROOT / ".trash" / trash_name).is_file())

        status, obj = c.json("GET", "/api/state")
        check("删除后笔记数回到初始", len(obj["notes"]) == initial_count,
              f"{len(obj['notes'])} / {initial_count}")
        check("回收站列表中可见", any(t["name"] == trash_name for t in obj.get("trash", [])))

        # ---------- 还原 ----------
        status, obj = c.json("POST", "/api/restore", {"name": trash_name})
        check("从回收站还原成功", status == 200 and obj.get("ok"), obj.get("error", ""))
        restored = ROOT / "notes" / (obj.get("restored") or "")
        check("还原后文件回到 notes/", restored.is_file(), restored.name)
        check("还原文件名去掉了时间戳前缀", not re.match(r"^\d{8}-\d{6}-", restored.name),
              restored.name)

        # ---------- 再删并彻底删除 ----------
        status, obj = c.json("POST", "/api/delete", {"slug": restored.stem})
        trash2 = obj.get("trashed", "")
        check("二次删除成功", status == 200 and bool(trash2))
        status, obj = c.json("POST", "/api/purge", {"name": trash2})
        check("未确认时拒绝彻底删除", status == 400, obj.get("error", ""))
        status, obj = c.json("POST", "/api/purge", {"name": trash2, "confirm": True})
        check("确认后彻底删除", status == 200 and obj.get("ok"), obj.get("error", ""))
        check("回收站文件已消失", not (ROOT / ".trash" / trash2).exists())

        # ---------- 图片上传 ----------
        PIXEL = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/"
                 "q842iQAAAABJRU5ErkJggg==")
        uploaded_path = None

        status, obj = c.json("POST", "/api/upload",
                             {"dataUrl": "data:image/png;base64," + PIXEL}, token=False)
        check("上传接口需要令牌", status == 403, f"HTTP {status}")

        status, obj = c.json("POST", "/api/upload",
                             {"dataUrl": "data:image/png;base64," + PIXEL, "slug": "zz-verify-tmp"})
        check("上传图片成功", status == 200 and obj.get("ok"), obj.get("error", ""))
        url = obj.get("url", "")
        check("返回相对路径（双击打开站点也能取到图）",
              url.startswith("assets/uploads/") and not url.startswith("/"), url)
        check("返回可直接使用的大小", obj.get("bytes") == len(base64.b64decode(PIXEL)),
              str(obj.get("bytes")))
        check("返回 Markdown 片段", obj.get("markdown", "").startswith("![图片]("), obj.get("markdown", ""))
        check("首次上传不是去重命中", obj.get("deduped") is False)

        uploaded_path = ROOT / url
        check("图片已落盘", uploaded_path.is_file(), url)
        check("上传目录位于 assets/uploads/ 下",
              uploaded_path.parent.parent == (ROOT / "assets" / "uploads").resolve()
              or str(uploaded_path).startswith(str(ROOT / "assets" / "uploads")), str(uploaded_path.parent))

        status, _ = c.call("GET", "/" + url)
        check("上传后的图片可经静态服务访问", status == 200, f"HTTP {status}")

        before_files = len(list((ROOT / "assets" / "uploads").rglob("*.*")))
        status, obj = c.json("POST", "/api/upload",
                             {"dataUrl": "data:image/png;base64," + PIXEL, "slug": "zz-verify-tmp"})
        after_files = len(list((ROOT / "assets" / "uploads").rglob("*.*")))
        check("同图重复上传按内容去重", status == 200 and obj.get("deduped") is True)
        check("去重后不产生冗余文件", after_files == before_files, f"{before_files} → {after_files}")

        status, obj = c.json("POST", "/api/upload", {"dataUrl": "data:text/plain;base64,aGk="})
        check("拒绝非图片数据", status == 400, obj.get("error", ""))

        status, obj = c.json("POST", "/api/upload",
                             {"dataUrl": "data:image/svg+xml;base64,PHN2Zy8+"})
        check("拒绝 SVG（可内嵌脚本，公开部署即成同源 XSS 载体）", status == 400,
              obj.get("error", ""))

        status, obj = c.json("POST", "/api/upload", {"dataUrl": "data:image/png;base64,!!!非法!!!"})
        check("拒绝损坏的图片数据", status == 400, obj.get("error", ""))

        big = base64.b64encode(b"\x00" * (8 * 1024 * 1024 + 4096)).decode()
        status, obj = c.json("POST", "/api/upload", {"dataUrl": "data:image/png;base64," + big})
        check("拒绝超过 8MB 的图片", status == 400 and "8MB" in obj.get("error", ""),
              obj.get("error", ""))

        # 清理上传的文件
        if uploaded_path and uploaded_path.is_file():
            uploaded_path.unlink()
            try:
                uploaded_path.parent.rmdir()
            except OSError:
                pass
        check("上传测试文件已清理", not (uploaded_path and uploaded_path.exists()))

        # ---------- 重建与终态 ----------
        status, obj = c.json("POST", "/api/rebuild", {})
        check("手动重建接口可用", status == 200 and obj.get("build", {}).get("ok"),
              str(obj.get("build", {}).get("output", ""))[:80])

        status, obj = c.json("GET", "/api/state")
        now_slugs = {n["slug"] for n in obj["notes"]}
        check("笔记列表回到初始集合", now_slugs == initial_slugs,
              f"多出 {now_slugs - initial_slugs}，缺少 {initial_slugs - now_slugs}")

        data_js = (ROOT / "data" / "notes.js").read_text(encoding="utf-8")
        check("临时笔记已从站点数据中移除", "zz-verify" not in data_js)

        # ---------- 管理端一键同步（写回 notes/ + 重建） ----------
        SYNC_SLUG = "zz-verify-sync"
        sync_note = {
            "slug": SYNC_SLUG, "title": "同步验证：冒号与中文", "date": "2026-09-11",
            "category": "验证分类", "tags": ["同步", "JSON"],
            "summary": "由 /api/sync 写回的临时笔记。", "draft": False,
            "body": "# 同步验证\n\n正文一段。\n",
        }

        status, obj = c.json("POST", "/api/sync", {"notes": [], "removed": []}, token=False)
        check("同步接口需要令牌", status == 403, f"HTTP {status}")

        status, obj = c.json("POST", "/api/sync", {"notes": [sync_note], "removed": []})
        check("同步接口写入笔记", status == 200 and obj.get("ok") and obj.get("written") == 1,
              obj.get("error", "") + str(obj.get("written")))
        check("同步后自动重建了站点", bool(obj.get("build", {}).get("ok")))
        sync_file = ROOT / "notes" / f"{SYNC_SLUG}.md"
        check("同步的笔记已落盘", sync_file.is_file())
        if sync_file.is_file():
            text = sync_file.read_text(encoding="utf-8")
            # 全角冒号不需要引号，ASCII 特殊字符才需要——按 yaml 规则断言内容即可
            check("同步的 front-matter 可被构建脚本读回",
                  "title: 同步验证：冒号与中文" in text and "tags: [同步, JSON]" in text,
                  text.splitlines()[1] if len(text.splitlines()) > 1 else "")
        data_js = (ROOT / "data" / "notes.js").read_text(encoding="utf-8")
        check("同步后站点数据已包含该笔记", SYNC_SLUG in data_js)

        # 再次同步可覆盖同一篇（管理端是唯一数据源）
        sync_note2 = dict(sync_note, body="# 同步验证\n\n正文已更新。\n")
        status, obj = c.json("POST", "/api/sync", {"notes": [sync_note2], "removed": []})
        check("重复同步按文件名覆盖", status == 200 and obj.get("written") == 1)
        check("覆盖后内容为最新版本",
              "正文已更新" in (ROOT / "notes" / f"{SYNC_SLUG}.md").read_text(encoding="utf-8"))

        # 管理端删除的笔记：移入回收站而不是物理删除
        status, obj = c.json("POST", "/api/sync", {"notes": [], "removed": [SYNC_SLUG]})
        check("同步删除走回收站", status == 200 and len(obj.get("trashed", [])) == 1,
              str(obj.get("trashed")))
        check("被同步删除的笔记已移出 notes/", not sync_file.exists())
        trashed_name = (obj.get("trashed") or [""])[0]
        check("回收站里能找到该文件",
              trashed_name and (ROOT / ".trash" / trashed_name).is_file(), trashed_name)

        # 目录穿越：文件名必须被清洗，绝不允许写到 notes/ 之外
        status, obj = c.json("POST", "/api/sync",
                             {"notes": [{"slug": "../../evil", "title": "穿越测试", "body": "x"}],
                              "removed": []})
        check("目录穿越被清洗为合法文件名", status == 200 and obj.get("ok"), obj.get("error", ""))
        check("文件不会写到 notes/ 之外",
              not (ROOT / "evil.md").exists() and not (ROOT.parent / "evil.md").exists())
        EVIL_FILE = ROOT / "notes" / "evil.md"
        if EVIL_FILE.exists():
            status, obj = c.json("POST", "/api/sync", {"notes": [], "removed": ["evil"]})
            EVIL_TRASH = (obj.get("trashed") or [""])[0]
            if EVIL_TRASH:
                c.json("POST", "/api/purge", {"name": EVIL_TRASH, "confirm": True})
        check("穿越测试的文件已清理", not EVIL_FILE.exists())

        # 清理：彻底删除回收站里的临时文件
        if trashed_name:
            status, obj = c.json("POST", "/api/purge", {"name": trashed_name, "confirm": True})
        check("同步测试已清理", not (ROOT / ".trash" / trashed_name).is_file() if trashed_name else True)

        # ---------- 令牌下发（file:// 页面用 JSONP 取令牌） ----------
        def raw_get(path, headers=None):
            req = urllib.request.Request(base + path, method="GET")
            for k, v in (headers or {}).items():
                req.add_header(k, v)
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode("utf-8", "replace")

        st, body = raw_get("/api/token.js")
        check("令牌下发接口可用（免鉴权）", st == 200, f"HTTP {st}")
        check("下发的令牌与启动时一致", f'"{token}"' in body, body[:60])
        st, body = raw_get("/api/token.js", {"Origin": "null"})
        check("file:// 来源（Origin: null）可取到令牌", st == 200 and token in body, f"HTTP {st}")
        st, body = raw_get("/api/token.js", {"Origin": "https://evil.example"})
        check("第三方站点取不到令牌", st == 403, f"HTTP {st}")

        req = urllib.request.Request(base + "/api/sync", data=b"{}", method="OPTIONS")
        req.add_header("Origin", "null")
        req.add_header("Access-Control-Request-Headers", "x-admin-token")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                pre = (resp.status, dict(resp.headers))
        except urllib.error.HTTPError as e:  # 部分实现会以 200 返回
            pre = (e.code, dict(e.headers))
        check("CORS 预检通过（file:// 可跨域调用）", pre[0] in (200, 204), f"HTTP {pre[0]}")
        check("预检响应允许自定义令牌头",
              "x-admin-token" in (pre[1].get("Access-Control-Allow-Headers", "")).lower(),
              pre[1].get("Access-Control-Allow-Headers", ""))

        status, obj = c.json("POST", "/api/rebuild", {})
        data_js = (ROOT / "data" / "notes.js").read_text(encoding="utf-8")
        check("同步测试后站点数据干净", "zz-verify" not in data_js and '"evil"' not in data_js)

        # ---------- 正文全文检索 ----------
        S_NOTE = "zz-verify-search"
        search_body = "\n".join([
            "# 检索验证",
            "",
            "第一段讲 Sysmon 的事件 ID。",
            "第二段讲 nmap 端口扫描。",
            "",
            "## 小节",
            "Sysmon 与 nmap 同时出现的一行。",
            "内网探测常用代理与隧道。",
            "占位关键词：麒麟臂测试。",
        ]) + "\n"
        status, obj = c.json("POST", "/api/note", {
            "slug": "",
            "meta": {"slug": S_NOTE, "title": "检索验证用笔记", "date": "2026-09-10",
                     "category": "应急响应", "tags": ["Sysmon"]},
            "body": search_body,
        })
        check("为检索测试创建笔记", status == 200 and obj.get("ok"), obj.get("error", ""))

        def search(q, extra=""):
            return c.json("GET", "/api/search?q=" + urllib.parse.quote(q) + extra)

        status, obj = search("Sysmon")
        hit = next((r for r in obj.get("results", []) if r["slug"] == S_NOTE), None)
        check("按正文关键词检索命中", status == 200 and hit is not None, f"共 {obj.get('total')} 篇")
        check("返回正文命中行号", any(m["line"] == 3 for m in hit.get("matches", [])),
              str([m["line"] for m in hit.get("matches", [])]))
        check("返回命中行原文", any("Sysmon" in m["text"] for m in hit.get("matches", [])),
              str([m["text"][:20] for m in hit.get("matches", [])]))
        check("命中处数统计正确", hit.get("matchCount") == 2, str(hit.get("matchCount")))

        status, obj = search("sysmon")
        check("检索大小写不敏感",
              any(r["slug"] == S_NOTE for r in obj.get("results", [])))

        status, obj = search("端口扫描")
        check("中文关键词可检索",
              any(r["slug"] == S_NOTE for r in obj.get("results", [])), f"共 {obj.get('total')} 篇")

        status, obj = search("Sysmon nmap")
        hit = next((r for r in obj.get("results", []) if r["slug"] == S_NOTE), {})
        check("多关键词为 AND 语义（可在不同行命中）",
              any(m["line"] == 7 for m in hit.get("matches", [])),
              str([m["line"] for m in hit.get("matches", [])]))

        status, obj = search("Sysmon 钴钐钆铽")
        check("多关键词下 AND 语义仍然成立（放宽也不能全靠一个片段蒙中）",
              not any(r["slug"] == S_NOTE for r in obj.get("results", [])),
              f"共 {obj.get('total')} 篇：{str([r['slug'] for r in obj.get('results', [])][:4])}")

        status, obj = c.json("GET", "/api/search?q=")
        check("空关键词返回空结果", obj.get("total") == 0 and obj.get("results") == [])

        status, obj = search("Sysmon", "&limit=1")
        check("limit 参数生效", len(obj.get("results", [])) <= 1, str(len(obj.get("results", []))))

        status, obj = search("检索验证用笔记")
        hit = next((r for r in obj.get("results", []) if r["slug"] == S_NOTE), {})
        check("标题命中被标记", hit.get("titleHit") is True)

        hidden = ROOT / "notes" / "_zz-verify-hidden.md"
        hidden.write_text("---\ntitle: 隐藏草稿\ndate: 2026-09-10\ncategory: x\ntags: []\n---\n\n"
                          "专属暗号ZZQQ\n", encoding="utf-8")
        status, obj = search("ZZQQ")
        check("下划线开头的草稿不参与检索", obj.get("total") == 0, f"共 {obj.get('total')} 篇")
        hidden.unlink(missing_ok=True)

        # 精确匹配未命中时，中文词组放宽为二字组匹配
        status, obj = search("Sysmon")
        check("精确命中时不做放宽", obj.get("relaxed") is False)

        # 「麒麟臂甲」整串不存在，但二字组「麒麟」「臂甲」中的「麒麟」能在测试笔记里命中
        status, obj = search("麒麟臂甲")
        check("中文词组无精确命中时自动放宽", obj.get("relaxed") is True,
              f"relaxed={obj.get('relaxed')}，共 {obj.get('total')} 篇")
        check("放宽后能召回相关笔记",
              any(r["slug"] == S_NOTE for r in obj.get("results", [])),
              str([r["slug"] for r in obj.get("results", [])][:4]))

        status, obj = search("钴钐钆铽")   # 连二字组也无从命中
        check("放宽后仍无结果时如实返回空", obj.get("total") == 0 and obj.get("results") == [],
              f"共 {obj.get('total')} 篇")

        c.json("POST", "/api/delete", {"slug": S_NOTE})
        for nm in [t["name"] for t in c.json("GET", "/api/state")[1].get("trash", [])
                   if "zz-verify" in t["name"]]:
            c.json("POST", "/api/purge", {"name": nm, "confirm": True})
        check("检索测试笔记已清理", not (ROOT / "notes" / f"{S_NOTE}.md").exists())

        # ---------- 双向链接图 ----------
        # 引用目标由测试自己创建：依赖"用户某篇正式笔记还在"会让整批断言假失败
        LINK_NOTE = "zz-verify-link"
        LINK_A = "zz-verify-link-a"
        LINK_B = "zz-verify-link-b"
        for _slug, _title in ((LINK_A, "ZZ 链接目标甲"), (LINK_B, "ZZ 链接目标乙")):
            st, ob = c.json("POST", "/api/note", {
                "slug": "",
                "meta": {"slug": _slug, "title": _title, "date": "2026-09-10",
                         "category": "基础建设", "tags": []},
                "body": _title + " 的正文，不含任何链接。",
            })
            check(f"为链接图创建目标笔记 {_slug}", st == 200 and ob.get("ok"), ob.get("error", ""))

        link_body = "\n".join([
            "按标题引用：[[ZZ 链接目标甲]]",
            "",
            "同一目标改用 slug 引用：[[zz-verify-link-a]]（应与上一条去重）",
            "",
            "按 slug 引用另一篇：[[zz-verify-link-b]]",
            "",
            "指向尚不存在的笔记：[[ZZ 不存在的目标]]",
            "",
            "自引用不应计入：[[zz-verify-link]]",
            "",
        ])
        status, obj = c.json("POST", "/api/note", {
            "slug": "",
            "meta": {"slug": LINK_NOTE, "title": "链接图验证用笔记", "date": "2026-09-10",
                     "category": "基础建设", "tags": []},
            "body": link_body,
        })
        check("为链接图测试创建笔记", status == 200 and obj.get("ok"), obj.get("error", ""))

        status, obj = c.json("GET", "/api/state")
        check("状态接口返回链接图",
              all(k in obj for k in ("links", "backlinks", "broken")),
              str([k for k in ("links", "backlinks", "broken") if k not in obj]))

        out = obj.get("links", {}).get(LINK_NOTE, [])
        check("出链同时支持按标题与按 slug 解析",
              set(out) == {LINK_A, LINK_B}, str(out))
        check("同一目标重复引用被去重", len(out) == 2, str(out))
        check("自引用不计入出链", LINK_NOTE not in out, str(out))
        check("未创建的链接进入待创建", obj.get("broken", {}).get(LINK_NOTE) == ["ZZ 不存在的目标"],
              str(obj.get("broken", {}).get(LINK_NOTE)))
        check("入链反向记录了来源",
              LINK_NOTE in obj.get("backlinks", {}).get(LINK_A, []),
              str(obj.get("backlinks", {}).get(LINK_A, [])))
        check("每篇笔记都有链接图条目（无链接时为空数组）",
              obj.get("links", {}).get(LINK_B) == [],
              str(obj.get("links", {}).get(LINK_B)))

        # 站点数据里应带上同一份链接图，保证编辑器与站点判断一致
        data_js = (ROOT / "data" / "notes.js").read_text(encoding="utf-8")
        site = json.loads(data_js[data_js.index("{"): data_js.rindex("}") + 1])
        check("站点数据包含链接图",
              all(k in site for k in ("links", "backlinks", "broken")),
              str([k for k in ("links", "backlinks", "broken") if k not in site]))
        check("站点与服务的出链一致",
              site.get("links", {}).get(LINK_NOTE) == out,
              str(site.get("links", {}).get(LINK_NOTE)))
        check("站点与服务的待创建一致",
              site.get("broken", {}).get(LINK_NOTE) == ["ZZ 不存在的目标"],
              str(site.get("broken", {}).get(LINK_NOTE)))

        for _slug in (LINK_NOTE, LINK_A, LINK_B):
            c.json("POST", "/api/delete", {"slug": _slug})
        for nm in [t["name"] for t in c.json("GET", "/api/state")[1].get("trash", [])
                   if "zz-verify" in t["name"]]:
            c.json("POST", "/api/purge", {"name": nm, "confirm": True})
        check("链接图测试笔记已清理",
              not (ROOT / "notes" / f"{LINK_NOTE}.md").exists()
              and not (ROOT / "notes" / f"{LINK_A}.md").exists()
              and not (ROOT / "notes" / f"{LINK_B}.md").exists())
        status, obj = c.json("GET", "/api/state")
        check("删除后其它笔记的入链已复原",
              LINK_NOTE not in obj.get("backlinks", {}).get(LINK_A, []),
              str(obj.get("backlinks", {}).get(LINK_A, [])))

        # ---------- 未引用图片清理（build.py --gc-images） ----------
        UP = ROOT / "assets" / "uploads"
        UP.mkdir(parents=True, exist_ok=True)
        orphan_img = UP / "zz-verify-orphan.png"
        used_img = UP / "zz-verify-used.png"
        orphan_img.write_bytes(base64.b64decode(PIXEL))
        used_img.write_bytes(base64.b64decode(PIXEL))

        GC_NOTE = "zz-verify-gc"
        status, obj = c.json("POST", "/api/note", {
            "slug": "",
            "meta": {"slug": GC_NOTE, "title": "GC 验证用笔记", "date": "2026-09-10",
                     "category": "基础建设", "tags": []},
            "body": "这里引用一张图片：\n\n![图](assets/uploads/zz-verify-used.png)\n",
        })
        check("为图片清理测试创建笔记", status == 200 and obj.get("ok"), obj.get("error", ""))

        def run_gc(*extra):
            return subprocess.run(
                [py, "-u", str(ROOT / "build.py"), "--gc-images", *extra],
                cwd=str(ROOT), capture_output=True, text=True,
                encoding="utf-8", errors="replace", env=env,
            )

        res = run_gc()
        check("未引用的图片被列出", "zz-verify-orphan.png" in res.stdout, res.stdout.strip()[-60:])
        check("被引用的图片不被误报", "zz-verify-used.png" not in res.stdout)
        check("预览模式不删除文件", orphan_img.is_file())
        check("提示需要显式确认才删除", "--yes" in res.stdout)

        res = run_gc("--yes")
        check("确认后删除孤儿图片", not orphan_img.exists())
        check("被引用的图片保持不动", used_img.is_file())
        check("删除结果有回执", "已删除" in res.stdout, res.stdout.strip()[-40:])

        # 回收站中的笔记所引用的图片同样不应被判为孤儿
        up2 = UP / "zz-verify-trashed.png"
        up2.write_bytes(base64.b64decode(PIXEL))
        status, obj = c.json("POST", "/api/note", {
            "slug": "",
            "meta": {"slug": "zz-verify-trashed", "title": "将被删除的笔记",
                     "date": "2026-09-10", "category": "基础建设", "tags": []},
            "body": "![图](assets/uploads/zz-verify-trashed.png)\n",
        })
        status, obj = c.json("POST", "/api/delete", {"slug": "zz-verify-trashed"})
        check("构造回收站中的笔记", status == 200 and obj.get("ok"))
        res = run_gc()
        check("回收站笔记引用的图片不被误删（可还原）", "zz-verify-trashed.png" not in res.stdout)

        # 清理本段测试产生的内容
        for extra in (used_img, up2):
            if extra.exists():
                extra.unlink()
        trash_names = [t["name"] for t in c.json("GET", "/api/state")[1].get("trash", [])
                       if "zz-verify" in t["name"]]
        for nm in trash_names:
            c.json("POST", "/api/purge", {"name": nm, "confirm": True})
        c.json("POST", "/api/delete", {"slug": GC_NOTE})
        for nm in [t["name"] for t in c.json("GET", "/api/state")[1].get("trash", [])
                   if "zz-verify" in t["name"]]:
            c.json("POST", "/api/purge", {"name": nm, "confirm": True})
        if UP.exists() and not list(UP.rglob("*.*")):
            try:
                UP.rmdir()
            except OSError:
                pass

        status, obj = c.json("GET", "/api/state")
        check("图片清理测试后笔记集合复原",
              {n["slug"] for n in obj["notes"]} == initial_slugs,
              f"多出 {({n['slug'] for n in obj['notes']}) - initial_slugs}")
        final_files = {p.name for p in (ROOT / "notes").glob("*.md")}
        check("笔记文件集合与初始完全一致（按文件名比对）",
              final_files == initial_files,
              f"多出 {sorted(final_files - initial_files)}，缺少 {sorted(initial_files - final_files)}")
        final_trash = ({p.name for p in (ROOT / ".trash").glob("*")}
                       if (ROOT / ".trash").exists() else set())
        check("测试没有往回收站新增残留",
              final_trash <= initial_trash,
              f"新增 {sorted(final_trash - initial_trash)}")
        data_js = (ROOT / "data" / "notes.js").read_text(encoding="utf-8")
        check("图片清理测试后站点数据干净", "zz-verify" not in data_js)

        if not args.keep:
            leftovers = list((ROOT / ".trash").glob("*zz-verify*")) if (ROOT / ".trash").exists() else []
            for f in leftovers:
                f.unlink()
            check("测试残留文件已清理", not leftovers, str([f.name for f in leftovers]))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("\n=== SecNotes 内容管理服务回归 ===")
    print("\n".join(RESULTS))
    total = sum(1 for r in RESULTS if "PASS" in r or "FAIL" in r)
    print(f"\n合计 {total} 项检查，失败 {FAILED} 项\n")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
