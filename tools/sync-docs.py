#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把笔记与图片同步进 MkDocs 的内容源 docs/。

    notes/**.md        ->  docs/**.md              （跳过 _ 开头的私密文件）
    assets/uploads/**  ->  docs/assets/uploads/**

设计要点：
- 镜像语义：目标目录里多出来的旧文件会被删除，避免删掉笔记后站点仍留着幽灵页面。
- docs/index.md 是唯一由人手维护的页面，永不被覆盖或删除。
- 这些都是生成物，已在 .gitignore 里排除；仓库中笔记只有一份（notes/）。

用法：
    python tools/sync-docs.py && mkdocs build
"""
from __future__ import annotations

import filecmp
import shutil
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent.parent
SRC_NOTES = ROOT / "notes"
SRC_UPLOADS = ROOT / "assets" / "uploads"
DOCS = ROOT / "docs"
HANDPICKED = {"index.md"}  # 手写页面，不参与镜像清理


def _same(a: Path, b: Path) -> bool:
    try:
        return filecmp.cmp(a, b, shallow=False)
    except OSError:
        return False


def sync_notes() -> tuple[int, int]:
    """同步 Markdown，返回 (新增或更新, 删除)。"""
    if not SRC_NOTES.exists():
        print(f"⚠ 笔记目录不存在：{SRC_NOTES}")
        return 0, 0

    copied = 0
    expected: set[Path] = set()
    for src in sorted(SRC_NOTES.rglob("*.md")):
        if src.name.startswith("_"):
            continue
        dst = DOCS / src.relative_to(SRC_NOTES)
        expected.add(dst)
        if dst.exists() and _same(src, dst):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
        print(f"  + {dst.relative_to(ROOT).as_posix()}")

    removed = 0
    for dst in sorted(DOCS.rglob("*.md")):
        if dst in expected or dst.name in HANDPICKED:
            continue
        dst.unlink()
        removed += 1
        print(f"  - {dst.relative_to(ROOT).as_posix()}")

    return copied, removed


def sync_uploads() -> tuple[int, int]:
    """同步图片，返回 (新增或更新, 删除)。"""
    if not SRC_UPLOADS.exists():
        return 0, 0

    dst_root = DOCS / "assets" / "uploads"
    copied = 0
    expected: set[Path] = set()
    for src in sorted(SRC_UPLOADS.rglob("*")):
        if not src.is_file():
            continue
        dst = dst_root / src.relative_to(SRC_UPLOADS)
        expected.add(dst)
        if dst.exists() and _same(src, dst):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1

    removed = 0
    for dst in sorted(dst_root.rglob("*")) if dst_root.exists() else []:
        if dst.is_file() and dst not in expected:
            dst.unlink()
            removed += 1

    # 清掉空目录，保证删除文件后不留空壳
    for folder in sorted((d for d in dst_root.rglob("*") if d.is_dir()), reverse=True):
        if not any(folder.iterdir()):
            folder.rmdir()

    return copied, removed


def main() -> int:
    DOCS.mkdir(parents=True, exist_ok=True)
    notes_copied, notes_removed = sync_notes()
    img_copied, img_removed = sync_uploads()

    print(
        f"\n✅ 同步完成：笔记 {notes_copied} 篇更新 / {notes_removed} 篇清理，"
        f"图片 {img_copied} 张更新 / {img_removed} 张清理"
    )
    print("   下一步：mkdocs build（或 mkdocs serve 本地预览）\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
