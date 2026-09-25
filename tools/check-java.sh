#!/bin/bash
# ============================================================
# 本地 Java 编译自查（无需 Android SDK / Gradle）
#
# 用途：改完 native/*.java 后先在电脑上跑一遍，确认没有
#       "cannot find symbol" 之类的编译错误，再推 GitHub Actions，
#       避免又出现 BUILD FAILED in 1m 40s 白等一轮。
#
# 用法：bash tools/check-java.sh
# 依赖：只需 JDK（javac）。没有 javac 时脚本会直接提示。
#
# 原理：tools/android-stubs/ 里放着 68 个 Android / CameraX / ZXing
#       的最小签名桩（只有方法签名，没有实现），javac 会按真实
#       类型规则做符号解析 —— 变量作用域、方法是否存在、参数类型
#       对不对，都能查出来。这是"真编译"，不是正则扫描。
# ============================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/native"
STUB="$HERE/android-stubs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v javac >/dev/null 2>&1; then
  echo "❌ 本机没有 javac，请先安装 JDK（Ubuntu: sudo apt install -y default-jdk）"
  exit 2
fi

if [ ! -d "$STUB" ]; then
  echo "❌ 缺少 $STUB ，脚本无法运行"
  exit 2
fi

FILES=""
for f in "$SRC"/*.java; do
  [ -e "$f" ] || continue
  FILES="$FILES $f"
done
if [ -z "$FILES" ]; then
  echo "❌ $SRC 下没有 java 文件"
  exit 2
fi

echo "▶ 待编译："
for f in "$SRC"/*.java; do echo "   $(basename "$f")"; done

rm -rf "$WORK/out"; mkdir -p "$WORK/out"
javac -nowarn -proc:none -d "$WORK/out" $(find "$STUB" -name '*.java') $FILES 2>"$WORK/log"
N=$(grep -c 'error:' "$WORK/log")

echo "────────────────────────────────────────────"
if [ "$N" = "0" ]; then
  echo "✅ 编译通过：0 错误 —— 可以放心推仓库跑 Actions"
  exit 0
else
  echo "❌ 发现 $N 个编译错误，先修完再推："
  echo
  grep -E 'error:|symbol:|location:' "$WORK/log" | head -60
  echo
  echo "（完整日志可自行执行 javac 复现；常见坑：方法里定义的局部变量被另一个方法引用）"
  exit 1
fi
