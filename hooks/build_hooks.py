#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MkDocs 构建钩子，在 mkdocs.yml 的 hooks: 里挂载。

把原本由 build.py 负责的两件事搬到 MkDocs 构建期，让「扁平的 notes/ + front-matter
分类 + [[双向链接]]」这套写作方式不受影响：

1. 自动导航 —— 按 front-matter 的 category 生成导航树，分类内按日期倒序。
   所以新增笔记只需动 notes/，不必手写 mkdocs.yml 的 nav。
2. 双向链接 —— 把 [[标题]] / [[标题|显示文字]] 转成站内相对链接。匹配规则与
   build.py 的 build_link_graph 保持一致：先按 title 匹配，再退回按文件名匹配；
   目标笔记不存在时原样保留（旧站把它记作「待创建」）。

若 mkdocs.yml 里显式写了 nav，则以显式 nav 为准，本钩子不再介入。
"""
from __future__ import annotations

import posixpath
import re
from pathlib import Path

import yaml

WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]")
HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$", re.M)

# 标题 / 文件名（统一小写）→ 相对 docs_dir 的路径
_TITLE_INDEX: dict[str, str] = {}


def _front_matter(path: Path) -> dict:
    """读取文件头部的 YAML front-matter，失败时返回空字典（不中断构建）。"""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    lines = text.split("\n")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() in ("---", "...")), None)
    if end is None:
        return {}
    try:
        meta = yaml.safe_load("\n".join(lines[1:end]))
    except yaml.YAMLError:
        return {}
    return meta if isinstance(meta, dict) else {}


def _plain(text: str) -> str:
    return re.sub(r"[*_`]", "", text).strip()


def on_config(config):
    """扫描 docs_dir，生成 nav，并建立标题索引供双链使用。"""
    if config.get("nav"):
        return config  # 显式 nav 优先

    docs_dir = Path(config["docs_dir"])
    entries: list[tuple[str, str, str, str]] = []  # (category, date, title, rel)
    _TITLE_INDEX.clear()

    for path in sorted(docs_dir.rglob("*.md")):
        if path.name.startswith("_") or path.name == "index.md":
            continue
        rel = path.relative_to(docs_dir).as_posix()
        meta = _front_matter(path)

        title = str(meta.get("title") or "").strip()
        if not title:
            text = path.read_text(encoding="utf-8", errors="replace")
            m = HEADING_RE.search(text)
            title = _plain(m.group(1)) if m else path.stem

        category = str(meta.get("category") or "未分类").strip() or "未分类"
        entries.append((category, str(meta.get("date") or ""), title, rel))

        _TITLE_INDEX.setdefault(title.lower(), rel)
        _TITLE_INDEX.setdefault(path.stem.lower(), rel)

    counts: dict[str, int] = {}
    for category, *_ in entries:
        counts[category] = counts.get(category, 0) + 1

    nav: list[dict] = []
    if (docs_dir / "index.md").exists():
        nav.append({"首页": "index.md"})
    for category in sorted(counts, key=lambda c: (-counts[c], c)):
        items = sorted(
            (e for e in entries if e[0] == category),
            key=lambda e: (e[1], e[2]),
            reverse=True,
        )
        nav.append({category: [{title: rel} for _, _, title, rel in items]})

    config["nav"] = nav
    return config


def on_page_markdown(markdown, page, config, files):
    """把 [[标题]] 语法翻译成标准 Markdown 链接。"""
    if "[[" not in markdown:
        return markdown

    by_src = {f.src_uri: f for f in files}

    def repl(match: re.Match) -> str:
        raw = match.group(1).strip()
        label = (match.group(2) or raw).strip() or raw
        rel = _TITLE_INDEX.get(raw.lower())
        if not rel:
            return match.group(0)  # 目标还没写，保持原样
        target = by_src.get(rel)
        if target is None or not target.url:
            return match.group(0)
        base = posixpath.dirname(page.url or "")
        return f"[{label}]({posixpath.relpath(target.url, base or '.')})"

    return WIKILINK_RE.sub(repl, markdown)
