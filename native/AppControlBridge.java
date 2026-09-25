package com.fnnas.photouploader;

import android.webkit.JavascriptInterface;

/**
 * v4.9.7：App 控制桥接（window.AppControlNative）。
 *
 * 由来：App 启动页此前没有任何退出入口，只能靠系统返回键 / 最近任务划掉，
 * 车间现场换人、卡顿、误进时很不方便。
 * 与扫码/拍照桥同源：Capacitor 的插件桥在远程 http://NAS:3080 页面里不存在，
 * 只有 addJavascriptInterface 注入的对象对任何页面都可用。
 *
 * JS 用法：
 *   window.AppControlNative._exit()  —— 真正退出 App（finishAffinity + 结束进程）
 *   window.AppControlNative._home()  —— 退到后台（等价按 Home，不杀进程）
 * 桥不存在时（浏览器 / 旧 APK）页面自动降级为 window.close() + 提示。
 */
public class AppControlBridge {
    private static MainActivity act;

    public static void bind(MainActivity a) {
        act = a;
    }

    /** 退出应用：先关掉任务栈里所有 Activity，再结束进程，等同于「彻底关闭」 */
    @JavascriptInterface
    public void _exit() {
        if (act == null) return;
        final MainActivity a = act;
        a.runOnUiThread(() -> {
            try {
                a.finishAffinity();
            } catch (Throwable ignore) {}
            try {
                android.os.Process.killProcess(android.os.Process.myPid());
            } catch (Throwable ignore) {}
        });
    }

    /** 退到后台（不杀进程）：与按 Home 键一致 */
    @JavascriptInterface
    public void _home() {
        if (act == null) return;
        final MainActivity a = act;
        a.runOnUiThread(() -> {
            try {
                a.moveTaskToBack(true);
            } catch (Throwable ignore) {}
        });
    }
}
