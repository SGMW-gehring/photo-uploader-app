package com.fnnas.photouploader;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * WebView 桥接：MainActivity 在 onStart 里把本对象注入为 window.BarcodeScannerNative。
 * JS 调 window.BarcodeScannerNative._scan(cbId) 即调起全屏原生扫码（BarcodeScannerActivity）；
 * 扫码成功后由 Activity 回调用 deliver() 把结果经 WebView.evaluateJavascript 送回 JS。
 * 完全基于原生 ZXing，不依赖 Google Play / GMS，国内车间手机通用。
 */
public class BarcodeScannerBridge {
    private static MainActivity act;

    public static void bind(MainActivity a) {
        act = a;
    }

    @JavascriptInterface
    public void _scan(final String cbId) {
        if (act == null) return;
        final MainActivity a = act;
        // JS 接口方法运行在后台线程，切回 UI 线程再 startActivity
        a.runOnUiThread(() -> {
            try {
                android.content.Intent i = new android.content.Intent(a, BarcodeScannerActivity.class);
                i.putExtra("cbId", cbId);
                a.startActivity(i);
            } catch (Exception ignore) {
            }
        });
    }

    // 扫码成功/失败均回调此函数，把结果送回 WebView
    // ⚠️ BridgeActivity.bridge 是 protected，非子类直接访问会编译报错（protected access），
    //    必须走公开的 getBridge()（Capacitor 8 源码确认其存在）
    public static void deliver(String cbId, String value) {
        if (act == null || act.getBridge() == null || act.getBridge().getWebView() == null) return;
        WebView wv = act.getBridge().getWebView();
        String js = "window.__barcodeResolve && window.__barcodeResolve("
                + JSONObject.quote(cbId == null ? "" : cbId) + ","
                + JSONObject.quote(value == null ? "" : value) + ");";
        wv.evaluateJavascript(js, null);
    }
}
