package com.fnnas.photouploader;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import java.io.File;

/**
 * v4.9.9：App 内自更新（window.AppUpdateNative）。
 *
 * 由来：每次改原生（拍照页/扫码页）都要重新构建 APK，再想办法把文件传到每台手机上，
 * 车间几十台机器时这是最麻烦的一步。改造后：
 *   启动页检测到 NAS 上有新版本 → 点「立即更新」→ 系统下载 → 下完自动弹出安装界面，
 * 用户只需点一次「安装」。与微信/抖音的更新流程一致（安卓不允许完全静默安装，
 * 最后那一次点击是系统强制的，绕不开）。
 *
 * 与扫码/拍照桥同源：Capacitor 插件桥在远程 http://NAS:3080 页面里不存在，
 * 只有 addJavascriptInterface 注入的对象对任何页面都可用。
 *
 * JS 用法：
 *   window.AppUpdateNative.canInstall()      —— 是否已授权「安装未知应用」（未授权返回 false）
 *   window.AppUpdateNative.update(apkUrl)    —— 下载并在完成后拉起系统安装界面
 * 桥不存在时（浏览器 / 旧 APK）页面自动降级为直接访问 apkUrl（WebView 下载监听会接管）。
 *
 * APK 落在 App 私有目录 getExternalFilesDir/Download，无需任何存储权限；
 * 通过 FileProvider（authority = 包名.fileprovider）把读权限授予系统安装器。
 */
public class AppUpdateBridge {
    private static MainActivity act;

    /** 下载完成监听只注册一次，避免重复弹安装界面 */
    private static boolean receiverReady = false;

    public static void bind(MainActivity a) {
        act = a;
    }

    /** 当前 APK 的版本名（如 4.9.9），网页端据此判断「要不要提示更新」；取不到返回空串 */
    @JavascriptInterface
    public String appVersion() {
        if (act == null) return "";
        try {
            return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
        } catch (Throwable ignore) {
            return "";
        }
    }

    /** 是否已获得「安装未知应用」授权（Android 8+ 才需要；8 以下恒为 true） */
    @JavascriptInterface
    public boolean canInstall() {
        if (act == null) return false;
        try {
            if (Build.VERSION.SDK_INT < 26) return true;
            return act.getPackageManager().canRequestPackageInstalls();
        } catch (Throwable ignore) {
            return true;
        }
    }

    /** 跳系统设置页，让用户打开「允许安装未知应用」（每台手机只需一次） */
    @JavascriptInterface
    public void openInstallSetting() {
        if (act == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent it = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + act.getPackageName()));
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(it);
            }
        } catch (Throwable ignore) {}
    }

    /**
     * 下载 APK 并在完成后拉起安装界面。
     * @param url APK 的完整地址（http://NAS:3080/apk/photo-uploader-vX.Y.Z.apk）
     */
    @JavascriptInterface
    public void update(final String url) {
        if (act == null || url == null || url.length() == 0) return;
        final MainActivity a = act;

        // ① 未授权「安装未知应用」：先跳设置页，让用户开一次（之后永久有效）
        if (!canInstall()) {
            openInstallSetting();
            return;
        }

        try {
            // ② 目标文件：App 私有 Download 目录，不需要任何存储权限
            final String name = "photo-uploader-update.apk";
            File dir = a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir != null && !dir.exists()) dir.mkdirs();
            final File dest = new File(dir, name);
            if (dest.exists()) dest.delete();

            // ③ 交给系统下载器：有通知栏进度，断网/息屏也不会中断
            DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) { fallback(a, url); return; }

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("新版本下载");
            req.setDescription("照片上传 App");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
            req.setMimeType("application/vnd.android.package-archive");
            req.setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, name);
            final long id = dm.enqueue(req);

            // ④ 下载完成 → 用 FileProvider 把读权限授予安装器 → 弹出系统安装界面
            ensureReceiver(a, dm);
        } catch (Throwable t) {
            // 任何异常都不影响使用：退化成交给浏览器/系统下载
            fallback(a, url);
        }
    }

    /** 注册一次下载完成监听（幂等） */
    private static void ensureReceiver(final MainActivity a, final DownloadManager dm) {
        if (receiverReady) return;
        receiverReady = true;
        try {
            a.registerReceiver(new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    try {
                        if (intent == null) return;
                        if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
                        long doneId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                        if (doneId <= 0) return;

                        // 只处理我们发起的那一次下载
                        File f = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                                "photo-uploader-update.apk");
                        if (!f.exists() || f.length() <= 0) return;

                        Uri uri = FileProvider.getUriForFile(a, a.getPackageName() + ".fileprovider", f);
                        Intent it = new Intent(Intent.ACTION_VIEW);
                        it.setDataAndType(uri, "application/vnd.android.package-archive");
                        it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        a.startActivity(it);
                    } catch (Throwable ignore) {}
                }
            }, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        } catch (Throwable ignore) {}
    }

    /** 兜底：直接用系统浏览器/下载器打开 APK 链接 */
    private static void fallback(Activity a, String url) {
        try {
            Intent it = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            a.startActivity(it);
        } catch (Throwable ignore) {}
    }
}
