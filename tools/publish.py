#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本地更新推送到 GitHub，交给 Actions 自动发布。

双击「更新到GitHub.bat」就是调用本脚本；也可以命令行直接用：

    python tools/publish.py              # 同步 + 本地校验 + 提交 + 推送 + 等部署结果
    python tools/publish.py --dry-run    # 只演练：做到暂存为止，不提交不推送
    python tools/publish.py --no-build   # 跳过本地严格构建（赶时间时用）
    python tools/publish.py --no-wait    # 推送后不等 CI，立即返回
    python tools/publish.py -m "自定义提交信息"

与旧站的关系：本脚本只推送源码（notes/、站点配置等），不碰旧站产物
（index.html、data/notes.js 仍由 build.py / admin.py 负责）。推送后由
.github/workflows/deploy.yml 自动构建并发布到 GitHub Pages。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent.parent
VENV_PY = ROOT / ".venv" / "Scripts" / "python.exe"
SITE_URL = "https://deus-088.github.io/secnotes/"
ACTIONS_URL = "https://github.com/deus-088/secnotes/actions"
# 全局 git 身份没配时的兜底（GitHub 提供的隐私邮箱）
FALLBACK_ID = ("deus-088", "340621857+deus-088@users.noreply.github.com")

PUSH_ATTEMPTS = 8
PUSH_WAIT = 12
WAIT_TIMEOUT = 300
WAIT_INTERVAL = 10


def say(step: str, text: str) -> None:
    print(f"\n[{step}] {text}", flush=True)


def run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
        env=None,
    )


def git(*args: str, timeout: int = 600) -> subprocess.CompletedProcess:
    # core.quotepath=false 让中文文件名按原样输出，日志更好读
    return run(["git", "-c", "core.quotepath=false", *args], timeout=timeout)


def out(result: subprocess.CompletedProcess) -> str:
    return ((result.stdout or "") + (result.stderr or "")).strip()


def identity_args() -> list[str]:
    """全局身份为空时，临时传一个，避免 commit 直接失败。"""
    if out(git("config", "user.email")):
        return []
    print(f"   提示：全局 git 身份未配置，本次使用 {FALLBACK_ID[1]} 提交")
    return ["-c", f"user.name={FALLBACK_ID[0]}", "-c", f"user.email={FALLBACK_ID[1]}"]


def local_build() -> bool:
    """同步笔记并本地严格构建，提前发现错误。返回是否通过。"""
    py = str(VENV_PY) if VENV_PY.exists() else sys.executable
    result = run([py, "tools/sync-docs.py"])
    if result.returncode != 0:
        print(out(result))
        print("   !! 同步失败，已中止（没有推送任何东西）")
        return False
    print("   docs/ 已同步")

    result = run([py, "-m", "mkdocs", "build", "--strict"])
    if result.returncode != 0:
        print(out(result)[-1500:])
        print("   !! 本地严格构建失败，已中止（没有推送任何东西）")
        return False
    print("   本地严格构建通过")
    return True


def staged_files() -> list[str]:
    result = git("diff", "--cached", "--name-only")
    return [line for line in (result.stdout or "").splitlines() if line.strip()]


def commit_message(files: list[str], custom: str | None) -> str:
    if custom:
        return custom
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    notes = [f for f in files if f.startswith("notes/") and f.endswith(".md")]
    head = (f"更新笔记：{len(notes)} 篇 · {len(files)} 个文件 · {stamp}"
            if notes else f"更新站点：{len(files)} 个文件 · {stamp}")
    listed = files[:15]
    body = "\n".join(f"- {f}" for f in listed)
    if len(files) > len(listed):
        body += f"\n- …另有 {len(files) - len(listed)} 个文件"
    return f"{head}\n\n{body}"


def push_with_retry() -> bool:
    for attempt in range(1, PUSH_ATTEMPTS + 1):
        result = git("push", "origin", "main", timeout=300)
        combined = out(result)
        if result.returncode == 0:
            print(f"   推送成功（第 {attempt} 次尝试）")
            return True
        low = combined.lower()
        if "rejected" in low or "non-fast-forward" in low or "fetch first" in low:
            print("   远端有新提交，先变基再推 ...")
            git("pull", "--rebase", "--autostash", timeout=300)
            continue
        retryable = any(key in low for key in (
            "could not resolve host", "unable to access", "error connecting",
            "timed out", "timeout", "connection", "eof", "tls",
        ))
        if retryable and attempt < PUSH_ATTEMPTS:
            print(f"   网络异常，{PUSH_WAIT}s 后重试（{attempt}/{PUSH_ATTEMPTS}）...")
            time.sleep(PUSH_WAIT)
            continue
        print(f"   !! 推送失败：{combined.splitlines()[-1] if combined else '未知错误'}")
        return False
    print("   !! 多次重试后仍失败，请检查网络后重跑本脚本（改动已提交在本地，不会丢）")
    return False


def wait_for_deploy() -> None:
    """等 Actions 跑完并汇报结果（拿不到 gh 或网络不通时安静跳过）。"""
    probe = run(["gh", "--version"])
    if probe.returncode != 0:
        print(f"   未安装 gh，跳过等待。部署进度：{ACTIONS_URL}")
        return

    deadline = time.time() + WAIT_TIMEOUT
    run_id = None
    while time.time() < deadline:
        result = run(["gh", "run", "list", "--limit", "1",
                      "--json", "databaseId,status,conclusion,headSha"])
        try:
            import json
            runs = json.loads(result.stdout or "[]")
        except Exception:  # noqa: BLE001
            runs = []
        if runs:
            info = runs[0]
            if run_id is None:
                run_id = info.get("databaseId")
                print(f"   已触发部署 #{run_id}")
            if info.get("status") == "completed":
                conclusion = info.get("conclusion")
                if conclusion == "success":
                    print(f"   ✅ 部署成功，站点已更新：{SITE_URL}")
                else:
                    print(f"   !! 部署结论：{conclusion}")
                    print(f"      查看日志：{ACTIONS_URL}/runs/{run_id}")
                return
        time.sleep(WAIT_INTERVAL)
    print(f"   等待超时（{WAIT_TIMEOUT}s），部署可能仍在进行：{ACTIONS_URL}")


def main() -> int:
    parser = argparse.ArgumentParser(description="把本地更新推送到 GitHub")
    parser.add_argument("--dry-run", action="store_true",
                        help="只演练到暂存为止，不提交、不推送")
    parser.add_argument("--no-build", action="store_true",
                        help="跳过本地同步与严格构建")
    parser.add_argument("--no-wait", action="store_true",
                        help="推送后不等待 CI 结果")
    parser.add_argument("-m", "--message", help="自定义提交信息")
    args = parser.parse_args()

    say("1/5", "检查仓库状态")
    if git("rev-parse", "--is-inside-work-tree").returncode != 0:
        print("   !! 当前目录不是 git 仓库")
        return 1
    branch = out(git("rev-parse", "--abbrev-ref", "HEAD"))
    remote = out(git("remote", "get-url", "origin"))
    if not remote:
        print("   !! 没有配置 origin 远端")
        return 1
    print(f"   分支 {branch} → {remote}")
    if branch != "main":
        print(f"   !! 当前在 {branch} 分支，部署工作流只监听 main")
        return 1

    if args.no_build:
        say("2/5", "跳过本地校验（--no-build）")
    else:
        say("2/5", "同步笔记并做本地严格构建")
        if not local_build():
            return 1

    say("3/5", "暂存改动")
    git("add", "-A")
    files = staged_files()
    if not files:
        print("   没有需要推送的改动，结束。")
        return 0
    notes = [f for f in files if f.startswith("notes/") and f.endswith(".md")]
    print(f"   共 {len(files)} 个文件（其中笔记 {len(notes)} 篇）")
    for name in files[:15]:
        print(f"     · {name}")
    if len(files) > 15:
        print(f"     · …另有 {len(files) - 15} 个文件")

    message = commit_message(files, args.message)
    if args.dry_run:
        say("4/5", "演练模式：不提交、不推送")
        print("   将使用的提交信息：")
        for line in message.splitlines():
            print(f"     {line}")
        print("\n   已暂存，可执行 git reset 撤销暂存")
        return 0

    say("4/5", "提交")
    result = git(*identity_args(), "commit", "-m", message.strip())
    if result.returncode != 0:
        print(out(result))
        return 1
    print(f"   {out(result).splitlines()[0] if out(result) else '已提交'}")

    say("5/5", "推送到 GitHub")
    if not push_with_retry():
        return 1

    if not args.no_wait:
        wait_for_deploy()
    print(f"\n完成。站点：{SITE_URL}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
