package com.fnnas.photouploader;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * v4.8：原生拍照桥接（window.PhotoShootNative）。
 *
 * 为什么不用 Capacitor 插件：Capacitor 只在本地源页面注入插件桥，远程 http://NAS 页面
 * 拿不到 window.Capacitor（源码级确认：WebViewLocalServer 对远程 URL 匹配不到 handler）。
 * addJavascriptInterface 注入的对象对所有页面都可用（原生扫码桥已长期验证），
 * 因此拍照也走同一条可靠通道。
 *
 * 回传协议（JS 侧在 app.js 中实现）：
 *   window.__shotBegin(cbId, total)   —— 开始一张照片，共 total 片
 *   window.__shotChunk(cbId, i, part) —— 第 i 片 base64（base64 仅含安全字符，无需转义）
 *   window.__shotDone(cbId)           —— 本张完整，可解码入库
 *   window.__shotEnd(cbId)            —— 拍照页结束（用户点完成/返回/相机不可用）
 * 分片原因：Binder 单次事务上限约 1MB，整张 JPEG 的 base64 常常超过。
 */
public class PhotoShootBridge {
    private static MainActivity act;

    public static void bind(MainActivity a) {
        act = a;
    }

    @JavascriptInterface
    public void _shoot(final String cbId, final String title) {
        if (act == null) return;
        final MainActivity a = act;
        a.runOnUiThread(() -> {
            try {
                android.content.Intent i = new android.content.Intent(a, PhotoShootActivity.class);
                i.putExtra("cbId", cbId == null ? "" : cbId);
                i.putExtra("title", title == null ? "" : title);
                a.startActivity(i);
            } catch (Exception ignore) {
                deliver(cbId, null); // 启动失败立即通知页面，页面回退系统相机
            }
        });
    }

    /** 回传一张照片（b64 非空）或通知结束（b64 为 null） */
    public static void deliver(final String cbId, final String b64) {
        if (act == null) return;
        final MainActivity a = act;
        a.runOnUiThread(() -> {
            try {
                WebView wv = (a.getBridge() != null) ? a.getBridge().getWebView() : null;
                if (wv == null) return;
                final String id = q(cbId == null ? "" : cbId);
                if (b64 == null || b64.length() == 0) {
                    wv.evaluateJavascript("window.__shotEnd&&window.__shotEnd(" + id + ");", null);
                    return;
                }
                int total = (b64.length() + CHUNK - 1) / CHUNK;
                wv.evaluateJavascript("window.__shotBegin&&window.__shotBegin(" + id + "," + total + ");", null);
                for (int i = 0; i < total; i++) {
                    int s = i * CHUNK, e = Math.min(b64.length(), s + CHUNK);
                    wv.evaluateJavascript("window.__shotChunk&&window.__shotChunk(" + id + "," + i + ",'" + b64.substring(s, e) + "');", null);
                }
                wv.evaluateJavascript("window.__shotDone&&window.__shotDone(" + id + ");", null);
            } catch (Throwable ignore) {
                try {
                    WebView wv = a.getBridge().getWebView();
                    if (wv != null) wv.evaluateJavascript("window.__shotEnd&&window.__shotEnd(" + q(cbId) + ");", null);
                } catch (Throwable ignore2) {}
            }
        });
    }

    private static final int CHUNK = 100000;

    private static String q(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }
}
