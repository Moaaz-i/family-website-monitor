#!/bin/bash

# ===================================================
#   Family Website Monitor — Auto Update Script
#   يقوم بجلب آخر تحديثات من GitHub وتطبيقها
# ===================================================

REPO_URL="git@github.com:Moaaz-i/family-website-monitor.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Family Website Monitor Updater     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# التحقق من وجود git
if ! command -v git &> /dev/null; then
    echo "❌ خطأ: Git غير مثبت على الجهاز"
    exit 1
fi

cd "$SCRIPT_DIR"

# التحقق من وجود remote
REMOTE=$(git remote get-url origin 2>/dev/null)
if [ -z "$REMOTE" ]; then
    echo "🔗 لا يوجد remote، جاري الربط بـ GitHub..."
    git remote add origin "$REPO_URL"
fi

echo "📡 Remote: $REMOTE"
echo ""

# حفظ الـ commit الحالي قبل التحديث
BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "غير معروف")

echo "🔄 جاري جلب التحديثات من GitHub..."
echo "─────────────────────────────────────"

# جلب التحديثات
git fetch origin main 2>&1

# التحقق إذا كان هناك تحديثات
LOCAL=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE_HEAD" ]; then
    echo ""
    echo "✅ الملفات محدّثة بالفعل — لا توجد تغييرات جديدة"
    echo "🏷️  الإصدار الحالي: $(git log -1 --format='%h — %s' 2>/dev/null)"
    echo ""
    exit 0
fi

echo ""
echo "📦 تحديثات جديدة متوفرة! جاري التطبيق..."
echo "─────────────────────────────────────"

# تطبيق التحديثات (reset صارم لضمان استبدال كل الملفات)
git reset --hard origin/main 2>&1

AFTER=$(git rev-parse --short HEAD 2>/dev/null)

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         ✅ تم التحديث بنجاح!         ║"
echo "╠══════════════════════════════════════╣"
echo "║  قبل:  $BEFORE                        "
echo "║  بعد:  $AFTER                         "
echo "╚══════════════════════════════════════╝"
echo ""
echo "📋 الملفات التي تم تحديثها:"
git diff --name-only "$BEFORE" HEAD 2>/dev/null | sed 's/^/   ✔ /'
echo ""
echo "⚠️  أعد تحميل الإضافة من:"
echo "   chrome://extensions  →  🔄 زر Reload"
echo ""
