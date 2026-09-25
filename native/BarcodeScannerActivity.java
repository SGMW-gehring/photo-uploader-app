package com.fnnas.photouploader;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Size;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 全屏原生扫码（体验同微信/QQ）：CameraX 取实时帧 → 原生 ZXing 解码。
 * v4.6 解码管线与网页端 Worker（实测能啃动车间高密度 Code128）完全同款：
 *   ① 四方向旋转直接解 → ② 灰度拉伸 × 四方向 → ③ 行合成扫描（多行平均成合成扫描线，专治反光/模糊/高密度）× 四方向
 * 分析帧 1280x720 → 1920x1080（密集条码模块更宽，命中率高一个量级）。
 * 12s 未识别自动退出交回网页链路（拍照识别 + NAS 服务端解码），App 内永不卡死。
 * 不依赖 Google Play / GMS，国内车间手机通用。
 */
public class BarcodeScannerActivity extends AppCompatActivity {

    private static final long FALLBACK_TIMEOUT_MS = 12000;

    private PreviewView previewView;
    private TextView hintText;
    private ScanOverlay overlay;
    private Camera camera;
    private MultiFormatReader reader;
    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final AtomicBoolean done = new AtomicBoolean(false);
    private boolean torchOn = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(previewView);

        overlay = new ScanOverlay(this);
        overlay.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // v4.8：点按画面任意位置即对焦到该点（老机近距合焦慢时，手动点一下立刻清晰）
        overlay.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == android.view.MotionEvent.ACTION_UP) {
                float nx = ev.getX() / Math.max(1f, v.getWidth());
                float ny = ev.getY() / Math.max(1f, v.getHeight());
                focusAt(nx, ny);
            }
            return true;
        });
        root.addView(overlay);

        // 顶栏：关闭 / 标题 / 补光
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(16), dp(44), dp(16), dp(12));
        top.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView close = new TextView(this);
        close.setText("✕ 关闭");
        close.setTextColor(Color.WHITE);
        close.setTextSize(16);
        close.setPadding(dp(8), dp(8), dp(8), dp(8));
        close.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });

        TextView title = new TextView(this);
        title.setText("对准条码，自动识别");
        title.setTextColor(Color.WHITE);
        title.setTextSize(16);
        title.setGravity(Gravity.CENTER);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        TextView flash = new TextView(this);
        flash.setText("💡 补光");
        flash.setTextColor(Color.WHITE);
        flash.setTextSize(16);
        flash.setPadding(dp(8), dp(8), dp(8), dp(8));
        flash.setAlpha(0.55f);
        flash.setOnClickListener(v -> toggleTorch(flash));

        top.addView(close);
        top.addView(title);
        top.addView(flash);
        root.addView(top);

        // 底部提示
        hintText = new TextView(this);
        hintText.setText("将条码放入框内，自动识别");
        hintText.setTextColor(Color.WHITE);
        hintText.setTextSize(14);
        hintText.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.gravity = Gravity.BOTTOM;
        hp.bottomMargin = dp(48);
        hintText.setLayoutParams(hp);
        root.addView(hintText);

        setContentView(root);

        setupReader();
        overlay.start();
        startCamera();

        // v4.6：超时兜底——原生引擎长期未识别（高密度条码/环境差）时自动退出，
        // 让网页链路（拍照识别 + NAS 服务端重型解码）接手，绝不把用户卡在本页
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (done.get()) return;
            hintText.setText("长时间未识别，切换网页识别…");
            finishWithError();
        }, FALLBACK_TIMEOUT_MS);
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void setupReader() {
        reader = new MultiFormatReader();
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        List<BarcodeFormat> fmts = new ArrayList<>();
        fmts.add(BarcodeFormat.CODE_128);
        fmts.add(BarcodeFormat.CODE_39);
        fmts.add(BarcodeFormat.CODE_93);
        fmts.add(BarcodeFormat.CODABAR);
        fmts.add(BarcodeFormat.ITF);
        fmts.add(BarcodeFormat.EAN_13);
        fmts.add(BarcodeFormat.EAN_8);
        fmts.add(BarcodeFormat.UPC_A);
        fmts.add(BarcodeFormat.UPC_E);
        fmts.add(BarcodeFormat.QR_CODE);
        fmts.add(BarcodeFormat.DATA_MATRIX);
        fmts.add(BarcodeFormat.AZTEC);
        fmts.add(BarcodeFormat.PDF_417);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, fmts);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.ALSO_INVERTED, Boolean.TRUE);
        reader.setHints(hints);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                bindCamera(future.get());
            } catch (Exception e) {
                finishWithError();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindCamera(ProcessCameraProvider provider) {
        try {
            provider.unbindAll();
            Preview preview = new Preview.Builder().build();
            preview.setSurfaceProvider(previewView.getSurfaceProvider());

            ImageAnalysis analysis = new ImageAnalysis.Builder()
                    .setTargetResolution(new Size(1920, 1080))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();

            final String[] found = {null};
            analysis.setAnalyzer(analysisExecutor, image -> {
                if (busy.get()) { image.close(); return; }
                busy.set(true);
                try {
                    Bitmap bmp = image.toBitmap();
                    int w = bmp.getWidth(), h = bmp.getHeight();
                    int[] px = new int[w * h];
                    bmp.getPixels(px, 0, w, 0, 0, w, h);
                    bmp.recycle();
                    int n = w * h;
                    // ITU-R 601 加权灰度（与网页 Worker 同款公式；RGBLuminanceSource 不会自动转灰度）
                    int[] v = new int[n];
                    for (int i = 0; i < n; i++) {
                        int c = px[i];
                        int r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
                        v[i] = (r * 306 + g * 601 + b * 117) >> 10;
                    }
                    String t = decodeAll(v, w, h);
                    if (t != null && !t.trim().isEmpty()) {
                        found[0] = t.trim();
                    }
                } catch (Throwable ignore) {
                    // 取帧/解码异常忽略，下一帧再试
                } finally {
                    image.close();
                    busy.set(false);
                }
                if (found[0] != null) {
                    onDecoded(found[0]);
                }
            });

            CameraSelector selector = new CameraSelector.Builder()
                    .requireLensFacing(CameraSelector.LENS_FACING_BACK).build();
            camera = provider.bindToLifecycle(this, selector, preview, analysis);
            // v4.8：连续自动对焦（此前完全没有对焦控制，Honor Play 等老机近距条码常常不合焦 →
            // 画面发虚 → 「识别困难」。这里周期触发 AF/AE 测光对焦，并支持点按对焦。）
            startAutoFocusLoop();
        } catch (Exception e) {
            finishWithError();
        }
    }

    private final android.os.Handler focusHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    /**
     * v4.9.7：改成「触发一次、持续对焦」，不再周期重触发。
     *
     * 原写法的问题（真机反馈「识别条码时相机一直变焦」）：
     *   每 2.2s 触发一次 AF，且每次都带 setAutoCancelDuration(2s) ——
     *   2 秒后被系统自动取消 → 对焦状态回退 → 2.2s 后再重新搜索 →
     *   形成「重搜 → 取消 → 重搜」的死循环，画面就是一直在拉风箱，看起来永远合不了焦。
     *
     * 正确做法：不带 autoCancelDuration 的 FocusMeteringAction 会**持续**运行 AF/AE（等价连续对焦），
     * 只需要触发一次即可一直保持，合焦更快、画面稳定不跳。
     * 点按画面仍可手动改对焦点（focusAt），同样不带 autoCancel，避免手动对焦后 3 秒又失焦。
     */
    private void startAutoFocusLoop() {
        focusHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    if (camera != null && !done.get()) focusAt(0.5f, 0.42f);
                } catch (Throwable ignore) {}
                // 不再周期重触发：一次触发即为持续对焦（见上）
            }
        }, 700);
    }

    /** 在预览归一化坐标 (nx, ny) 处触发一次 AF/AE；不改动任何解码算法 */
    private void focusAt(float nx, float ny) {
        try {
            if (camera == null || previewView == null) return;
            MeteringPoint pt = previewView.getMeteringPointFactory().createPoint(nx, ny);
            // v4.9.7：去掉 setAutoCancelDuration —— 保留它就会 2 秒后取消对焦并回退，
            // 这正是「一直变焦」的根因；不带它则 AF/AE 持续生效（连续对焦）
            FocusMeteringAction action = new FocusMeteringAction.Builder(pt,
                    FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                    .build();
            camera.getCameraControl().startFocusAndMetering(action);
        } catch (Throwable ignore) {}
    }

    // ---------- v4.6 解码管线：与网页端 zxing Worker 完全同款（实战验证版） ----------

    private static final int[] ANGLES = {0, 90, 180, 270};

    private String decodeAll(int[] v, int w, int h) {
        // ① 四方向直接解
        for (int a : ANGLES) {
            Img r = rotImg(v, w, h, a);
            String t = tryBmp(makeBmp(r.d, r.w, r.h));
            if (t != null) return t;
        }
        // ② 灰度拉伸 × 四方向（低对比/浅印）
        int[] st = stretchLum(v);
        for (int a : ANGLES) {
            Img r = rotImg(st, w, h, a);
            String t = tryBmp(makeBmp(r.d, r.w, r.h));
            if (t != null) return t;
        }
        // ③ 行合成扫描（原图/拉伸 × 四方向）——多行像素平均成合成扫描线，专治反光/模糊/高密度
        for (int s = 0; s < 2; s++) {
            int[] src = (s == 1) ? st : v;
            for (int a : ANGLES) {
                Img r = rotImg(src, w, h, a);
                String t = rowSynthScan(r.d, r.w, r.h);
                if (t != null) return t;
            }
        }
        return null;
    }

    private String tryBmp(BinaryBitmap bb) {
        try {
            // decodeWithState：保留 setHints 的格式/TRY_HARDER 配置（decode() 会把 hints 清空，不能用）
            Result r = reader.decodeWithState(bb);
            if (r != null && r.getText() != null && !r.getText().trim().isEmpty()) return r.getText().trim();
        } catch (Exception ignore) {
            // 本帧此角度未解出，继续
        }
        return null;
    }

    private BinaryBitmap makeBmp(int[] v, int w, int h) {
        int[] packed = new int[v.length];
        for (int i = 0; i < v.length; i++) {
            int x = v[i];
            if (x < 0) x = 0;
            if (x > 255) x = 255;
            packed[i] = (x << 16) | (x << 8) | x; // 灰度值按 RGB 三通道同值打包
        }
        return new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, h, packed)));
    }

    private static final class Img {
        final int[] d;
        final int w, h;
        Img(int[] d, int w, int h) { this.d = d; this.w = w; this.h = h; }
    }

    // 灰度图旋转（每像素 1 值），覆盖手机横拍/倒拍
    private Img rotImg(int[] g, int w, int h, int deg) {
        if (deg == 0) return new Img(g, w, h);
        int[] out = new int[g.length];
        if (deg == 180) {
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = g[y * w + x];
            return new Img(out, w, h);
        }
        if (deg == 90) {
            int nw = h;
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) out[x * nw + (h - 1 - y)] = g[y * w + x];
            return new Img(out, nw, w);
        }
        if (deg == 270) {
            int nw = h;
            for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) out[(w - 1 - x) * nw + y] = g[y * w + x];
            return new Img(out, nw, w);
        }
        return new Img(g, w, h);
    }

    // 灰度拉伸：对比度弱的浅印/反光条码拉开黑白天梯
    private int[] stretchLum(int[] lum) {
        int[] o = lum.clone();
        int mn = 255, mx = 0;
        for (int x : lum) { if (x < mn) mn = x; if (x > mx) mx = x; }
        if (mx - mn > 1 && mx - mn < 200) {
            float g = 255f / (mx - mn);
            for (int i = 0; i < o.length; i++) o[i] = (int) ((o[i] - mn) * g);
        }
        return o;
    }

    // 每行黑白跳变次数（条码区域行跳变远高于背景）
    private int[] rowEdges(int[] lum, int w, int h) {
        int[] e = new int[h];
        for (int y = 0; y < h; y++) {
            int prev = lum[y * w], cnt = 0;
            for (int x = 1; x < w; x++) {
                int g = lum[y * w + x];
                if (Math.abs(g - prev) > 20) cnt++;
                prev = g;
            }
            e[y] = cnt;
        }
        return e;
    }

    // 多行像素平均成一条合成扫描线（等效扫码枪多扫描线）
    private int[] avgRows(int[] lum, int w, int y0, int y1) {
        int n = Math.max(1, y1 - y0);
        int[] o = new int[w];
        for (int x = 0; x < w; x++) {
            int s = 0;
            for (int y = y0; y < y1; y++) s += lum[y * w + x];
            o[x] = s / n;
        }
        return o;
    }

    // 行合成扫描：定位条码行带 → 全带 + 分段 + 滑窗多候选合成扫描线逐条解码
    private String rowSynthScan(int[] lum, int w, int h) {
        if (h < 2 || w < 8) return null;
        int[] e = rowEdges(lum, w, h);
        int mx = 0;
        for (int y = 0; y < h; y++) mx = Math.max(mx, e[y]);
        if (mx < 8) return null;
        int thr = Math.max(6, mx / 4);
        List<Integer> good = new ArrayList<>();
        for (int y = 0; y < h; y++) if (e[y] >= thr) good.add(y);
        if (good.size() < 2) return null;
        int yTop = good.get(0), yBot = good.get(good.size() - 1) + 1;
        List<int[]> candidates = new ArrayList<>();
        candidates.add(new int[]{yTop, yBot});
        for (int parts = 2; parts <= 4; parts++) {
            float step = (float) (yBot - yTop) / parts;
            for (int i = 0; i < parts; i++) {
                int a = yTop + (int) (i * step), b = yTop + (int) ((i + 1) * step);
                if (b - a >= 1) candidates.add(new int[]{a, b});
            }
        }
        int win = Math.max(1, (yBot - yTop) / 8), c = 0;
        for (int y0 = yTop; y0 + win <= yBot && c < 6; y0 += Math.max(1, win >> 1), c++) {
            candidates.add(new int[]{y0, y0 + win});
        }
        for (int[] cd : candidates) {
            int[] row = avgRows(lum, w, cd[0], cd[1]);
            String t = tryBmp(makeBmp(row, w, 1));
            if (t == null) t = tryBmp(makeBmp(stretchLum(row), w, 1));
            if (t != null) return t;
        }
        return null;
    }

    private void toggleTorch(TextView flash) {
        if (camera == null) return;
        torchOn = !torchOn;
        try {
            camera.getCameraControl().enableTorch(torchOn);
            flash.setAlpha(torchOn ? 1f : 0.55f);
        } catch (Exception ignore) {
        }
    }

    private void onDecoded(final String code) {
        if (done.getAndSet(true)) return;
        runOnUiThread(() -> {
            try {
                Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) {
                    if (Build.VERSION.SDK_INT >= 26) {
                        v.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        v.vibrate(60);
                    }
                }
            } catch (Exception ignore) {
            }
            String cbId = getIntent().getStringExtra("cbId");
            BarcodeScannerBridge.deliver(cbId, code);
            setResult(RESULT_OK);
            finish();
        });
    }

    private void finishWithError() {
        if (done.getAndSet(true)) return;
        runOnUiThread(() -> {
            String cbId = getIntent().getStringExtra("cbId");
            BarcodeScannerBridge.deliver(cbId, null);
            setResult(RESULT_CANCELED);
            finish();
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (overlay != null) overlay.stop();
        try { focusHandler.removeCallbacksAndMessages(null); } catch (Throwable ignore) {}
        analysisExecutor.shutdown();
    }

    // 取景框遮罩 + 扫描线（纯代码绘制，无需任何 res 资源）
    private static class ScanOverlay extends View {
        private final Paint maskPaint = new Paint();
        private final Paint linePaint = new Paint();
        private final Paint cornerPaint = new Paint();
        private RectF win;
        private float lineY = 0f;
        private android.animation.ValueAnimator anim;

        public ScanOverlay(Context ctx) {
            super(ctx);
            // v4.8：遮罩淡化（原 #88000000 太重，框外画面几乎全黑，主观上「可识别区域很小」）。
            // 淡遮罩后框外仍是可见画面，配合放大的取景框，Honor Play 等小屏老机对准明显轻松。
            maskPaint.setColor(Color.parseColor("#4C000000"));
            linePaint.setColor(Color.parseColor("#4ADE80"));
            linePaint.setStrokeWidth(3f);
            cornerPaint.setColor(Color.parseColor("#4ADE80"));
            cornerPaint.setStyle(Paint.Style.STROKE);
            cornerPaint.setStrokeWidth(4f);
        }

        void start() {
            anim = android.animation.ValueAnimator.ofFloat(0f, 1f);
            anim.setDuration(1800);
            anim.setRepeatMode(android.animation.ValueAnimator.REVERSE);
            anim.setRepeatCount(android.animation.ValueAnimator.INFINITE);
            anim.addUpdateListener(a -> {
                lineY = (Float) a.getAnimatedValue();
                invalidate();
            });
            anim.start();
        }

        void stop() {
            if (anim != null) anim.cancel();
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            super.onLayout(changed, l, t, r, b);
            float w = r - l, h = b - t;
            // v4.8：取景框放大并适配小屏。解码始终基于完整 1920x1080 分析帧（不裁框内区域），
            // 所以放大框只影响「对准确易度」，不会削弱识别力。
            //  - 宽：屏幕宽的 88%（上限 880px，大屏不虚胖）
            //  - 高：宽的 44%（更贴近一维码细长形状，同时保证小屏也有足够竖向空间）
            float ww = Math.min(w * 0.88f, 880f);
            float wh = Math.min(Math.max(ww * 0.44f, h * 0.28f), h * 0.46f);
            float cx = w / 2f, cy = h * 0.42f;
            win = new RectF(cx - ww / 2f, cy - wh / 2f, cx + ww / 2f, cy + wh / 2f);
        }

        @Override
        protected void onDraw(Canvas c) {
            super.onDraw(c);
            if (win == null) return;
            int W = getWidth(), H = getHeight();
            c.drawRect(0, 0, W, win.top, maskPaint);
            c.drawRect(0, win.bottom, W, H, maskPaint);
            c.drawRect(0, win.top, win.left, win.bottom, maskPaint);
            c.drawRect(win.right, win.top, W, win.bottom, maskPaint);
            float len = Math.min(win.width(), win.height()) * 0.18f;
            c.drawLine(win.left, win.top, win.left + len, win.top, cornerPaint);
            c.drawLine(win.left, win.top, win.left, win.top + len, cornerPaint);
            c.drawLine(win.right - len, win.top, win.right, win.top, cornerPaint);
            c.drawLine(win.right, win.top, win.right, win.top + len, cornerPaint);
            c.drawLine(win.left, win.bottom - len, win.left, win.bottom, cornerPaint);
            c.drawLine(win.left, win.bottom, win.left + len, win.bottom, cornerPaint);
            c.drawLine(win.right - len, win.bottom, win.right, win.bottom, cornerPaint);
            c.drawLine(win.right, win.bottom - len, win.right, win.bottom, cornerPaint);
            float y = win.top + lineY * win.height();
            c.drawLine(win.left, y, win.right, y, linePaint);
        }
    }
}
