#!/bin/bash
# fork 叠加: X(上游#994+#975) + fork 专属文件 + fork 改动的共享文件(最近基底三方合并)
set -u
cd "C:\Users\百晓公子\WorkBuddy\2026-11-01-22-34-50\repos\folia-sonnet" || exit 1
X=upstream-merged

echo "[$(date +%H:%M:%S)] start from X"
git checkout -q -B build/liquid-glass $X

# --- 1. fork 专属文件直接复制 ---
N=0
while IFS= read -r f <&3; do
    [ -z "$f" ] && continue
    git checkout origin/dev -- "$f" </dev/null 2>/dev/null && N=$((N+1)) || echo "COPY-FAIL: $f"
done 3< <(comm -23 /tmp/fmp.txt /tmp/upmain_files.txt)
echo "[$(date +%H:%M:%S)] fork-only copied: $N"

# --- 2. fork 改动的共享文件: 最近基底三方合并 ---
mkdir -p /tmp/m4
TOTAL=0; SKIP=0; MERGED=0; CONFLICT=0; BINARY=0; NOBASE=0
> /tmp/overlay_conflicts.txt
> /tmp/overlay_progress.log
while IFS= read -r f <&3; do
    [ -z "$f" ] && continue
    TOTAL=$((TOTAL+1))
    O=$(git rev-parse "origin/dev:$f" 2>/dev/null)
    W=$(git hash-object "$f" 2>/dev/null)
    [ -z "$W" ] && { echo "$f" >> /tmp/overlay_conflicts.txt; echo "MISSING-IN-X: $f"; continue; }
    [ "$O" = "$W" ] && { SKIP=$((SKIP+1)); continue; }

    # 二进制: 取 fork 版
    if ! grep -qI "$f" 2>/dev/null; then
        git checkout origin/dev -- "$f" </dev/null && BINARY=$((BINARY+1)); continue
    fi

    # 候选基底: 最近 12 个触过该文件的上游提交 + 两个已知同步点
    CANDS=$( { git log $X --format=%H -- "$f" 2>/dev/null | head -12; echo ba70dd18; echo 895471e8; } | sort -u)
    BEST=""; BESTSCORE=-1
    for c in $CANDS; do
        CB=$(git rev-parse "$c:$f" 2>/dev/null)
        [ -z "$CB" ] && continue
        [ "$CB" = "$O" ] && { BEST="$CB"; BESTSCORE=0; break; }   # 精确命中
        S=$(git diff --numstat "$O" "$CB" 2>/dev/null | awk '{s+=$1+$2} END {print s+9999}')  # 空diff=0
        [ "$S" -lt "${BESTSCORE:-99999999}" ] && { BEST="$CB"; BESTSCORE=$S; }
    done
    if [ -z "$BEST" ]; then NOBASE=$((NOBASE+1)); echo "$f (nobase)" >> /tmp/overlay_conflicts.txt; continue; fi

    git show "origin/dev:$f" > /tmp/m4/ours 2>/dev/null
    git cat-file blob "$BEST" > /tmp/m4/base 2>/dev/null
    cp "$f" /tmp/m4/theirs
    git merge-file -L fork -L base -L upstream /tmp/m4/ours /tmp/m4/base /tmp/m4/theirs > /dev/null 2>&1 </dev/null
    RC=$?
    cp /tmp/m4/ours "$f"
    if [ $RC -eq 0 ]; then MERGED=$((MERGED+1))
    elif [ $RC -gt 0 ]; then CONFLICT=$((CONFLICT+1)); echo "$f ($RC, base-dist=$BESTSCORE)" >> /tmp/overlay_conflicts.txt
    else MERGED=$((MERGED+1)); fi
    [ $((TOTAL % 50)) -eq 0 ] && echo "[$(date +%H:%M:%S)] processed $TOTAL" >> /tmp/overlay_progress.log
done 3< /tmp/forkmod_shared.txt
echo "[$(date +%H:%M:%S)] RESULT: total=$TOTAL same=$SKIP merged=$MERGED conflict=$CONFLICT binary=$BINARY nobase=$NOBASE"
echo "=== conflicts ==="
cat /tmp/overlay_conflicts.txt
