# -*- coding: utf-8 -*-
"""便捷入口：生成通知栏小图标 ic_qt_notification。

等价于：
    python tools/gen-app-logo.py --apply brand --notif

真正的生成逻辑放在 tools/gen-app-logo.py（品牌母版 brand-glyph-master.png 的提取与
新鲜度检查都在那里，避免两处重复实现），本脚本只是把那条命令包一层，方便记忆。

产物：
    nativeResources/android/res/drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_qt_notification_glyph.png
    图形从 static/icon/{密度}.png（桌面图标那份 logo 文件）抽出白色图形本体而来；
    同时会删掉已弃用的手绘兜底矢量 drawable/ic_qt_notification.xml。

依赖：Pillow、numpy
"""
import os
import subprocess
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
GEN_APP_LOGO = os.path.join(TOOLS_DIR, "gen-app-logo.py")

if __name__ == "__main__":
    raise SystemExit(subprocess.call(
        [sys.executable, GEN_APP_LOGO, "--apply", "brand", "--notif"]))
