#!/bin/sh
# 用法：scripts/release.sh v0.1.1
# 打标签并推送；Release 由 .github/workflows/release.yml 自动创建，不用去网页点。
set -e
tag="${1:?用法: scripts/release.sh v0.1.1}"
case "$tag" in
  v*) ;;
  *) echo "标签要以 v 开头，例如 v0.1.1" >&2; exit 1 ;;
esac
git diff --quiet && git diff --cached --quiet || { echo "工作区还有未提交改动，先提交再发版。" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "标签 $tag 已存在。" >&2; exit 1; }
git tag -a "$tag" -m "$tag"
git push origin main "refs/tags/$tag"
echo "已推送 ${tag}，几十秒后自动出现在：$(git remote get-url origin | sed 's#git@github.com:#https://github.com/#' | sed 's#\.git$##')/releases"
