package com.fnnas.photouploader;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * v4.9.7：全屏原生拍照页（连拍、拍完不退出、全程没有系统相机的「确定」步骤）。
 *
 * 为什么必须有它：
 *   Capacitor 的插件桥（window.Capacitor）只注入到本地源页面（https://localhost），
 *   WebViewLocalServer 对远程 http://NAS:3080 页面匹配不到 handler → 不注入任何插件 JS。
 *   于是上传页里 CameraPreview / Camera 插件全部不存在，拍照只能靠 <input type=file>
 *   唤起系统相机，而系统相机自带「确认」页 —— 这就是「拍完免按确定」一直实现不了的根因。
 *   addJavascriptInterface 注入的对象则对任何页面都可用（原生扫码桥已验证），
 *   因此这里走同样的思路：JS 调 PhotoShootNative._shoot() 拉起本页，
 *   每拍一张立即分块回传 base64 给页面，页面复用既有水印/落库/上传管线。
 *
 * 交互：进入即实时取景 → 点 ⭕ 或点画面拍一张（可连拍）→ 点「完成」返回上传页。
 * 任一步失败都只是回退到原系统相机链路，不影响既有功能。
 *
 * v4.9.7 版面调整（按真机反馈）：
 *   ① 顶栏/底栏去掉整条半透明黑带（原先上下各一条铺满屏幕、压住画面），
 *      改成只包裹文字本身的半透明胶囊，其余完全透明；
 *   ② 追溯码不再截断（原 >26 字符加「…」），改自适应字号 + 最多两行，整码可见；
 *   ③ 「完成」从顶栏移到底栏，与快门按钮同一排、垂直居中对齐（补光对称放右侧）；
 *   ④ 快门下方的说明小字改成「印章式」弧形环绕（Canvas.drawTextOnPath），
 *      与网页上传页的公章顶弧保持同一观感。
 */
public class PhotoShootActivity extends AppCompatActivity {

    private static final int JPEG_QUALITY = 88;
    private static final int CHUNK = 100000; // 单次 evaluateJavascript 字符数（Binder 事务上限约 1MB）
    // v4.9.6：出图分辨率 1920×1440 → 1600×1200。
    // 老机型（荣耀 Play / 4GB）在出图瞬间会同时存在「原图 + 旋转后」两张 bitmap（≈22MB），
    // 加上 base64 回传与页面解码，容易被系统杀进程（表现为点快门闪退）。
    // v4.9.7：低内存设备（isLowRamDevice）再降一档到 1280×960，宁可像素低一点也不能崩。
    private static int OUT_W = 1600;
    private static int OUT_H = 1200;

    private PreviewView previewView;
    private ImageCapture imageCapture;
    private Camera camera;
    private ExecutorService camExec = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String cbId = "";
    private int shotCount = 0;
    private TextView countText;
    private TextView shootBtn;
    private boolean torchOn = false;
    private volatile boolean shooting = false;
    private int crashN = 0; // v4.9.7：上次进本页是否没活着出来（>0 = 崩过）
    private android.content.SharedPreferences sprefs; // v4.9.7：崩溃留痕（onCreate 写，startCamera 归零）
    private boolean safeMode = false; // v4.9.7：上次崩过 → 本次用兼容模式（TextureView + 默认分辨率）

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cbId = getIntent().getStringExtra("cbId");
        if (cbId == null) cbId = "";
        final String title = getIntent().getStringExtra("title");

        // v4.9.7：低内存机（荣耀 Play 这类 3~4GB 老机）自动降出图档位
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            if (am != null && am.isLowRamDevice()) { OUT_W = 1280; OUT_H = 960; }
        } catch (Throwable ignore) {}

        // ---------- v4.9.7：原生端自救（荣耀 Play「一进拍照页就崩」） ----------
        // Java 的 try/catch 抓不住这种崩溃（CameraX/相机驱动层直接把进程带走），
        // 页面更无从得知。所以这里用 SharedPreferences 自己留痕：
        //   进来就 +1；相机正常跑起来 2.5 秒后归零。
        // 下次再进来时计数还 > 0，说明上次没活着出来 → 本次自动切「兼容模式」。
        // 兼容模式做两件事：
        //   ① PreviewView 改用 COMPATIBLE（TextureView）。默认 PERFORMANCE（SurfaceView）在
        //      部分老机型/老 GPU 上会直接崩，这是 CameraX 官方给出的兼容性开关；
        //   ② 不再指定 setTargetResolution，用相机默认分辨率，绑定组合最简单。
        // 正常机型计数恒为 0 → 走原路径，默认行为一点不变。
        // ⚠️ sprefs/safeMode 必须是类字段：startCamera() 里也要用（onCreate 的局部变量它看不见）
        sprefs = getSharedPreferences("pu_shoot", MODE_PRIVATE);
        crashN = sprefs.getInt("crash_n", 0);
        try { sprefs.edit().putInt("crash_n", crashN + 1).apply(); } catch (Throwable ignore) {}
        safeMode = crashN > 0;

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 必须在 setSurfaceProvider 之前设置才生效
        if (safeMode) {
            try { previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE); } catch (Throwable ignore) {}
        }
        // v4.9.7：点画面也能拍（与网页端「点画面拍照」一致），快门弧字才说得通
        previewView.setOnClickListener(v -> takeShot());
        root.addView(previewView);

        // ---- 顶栏：追溯码居中 + 状态行左对齐（v4.9.8：状态行从底栏移到条码正下方） ----
        LinearLayout top = new LinearLayout(this);
        // v4.9.8：由横排改竖排——第一行追溯码（水平居中），第二行「已拍 N 张」状态（左对齐），
        // 状态紧贴条码、先看码再看张数，不再挤在快门上方遮挡画面
        top.setOrientation(LinearLayout.VERTICAL);
        top.setGravity(Gravity.CENTER_HORIZONTAL);
        top.setPadding(dp(12), statusBarHeight() + dp(8), dp(12), dp(6));
        // v4.9.7：不再铺整条 #66000000 黑带（原样占掉顶部一大片画面）
        top.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView code = new TextView(this);
        String t = (title == null || title.isEmpty()) ? "拍照" : title;
        // v4.9.7：整码显示，不截断。按长度自适应字号，最多两行；再也见不到「…」
        code.setText(t);
        code.setTextColor(Color.WHITE);
        code.setTextSize(TypedValue.COMPLEX_UNIT_SP, codeSp(t.length()));
        code.setGravity(Gravity.CENTER);
        code.setSingleLine(false);
        code.setMaxLines(2);
        code.setEllipsize(null);
        code.setPadding(dp(12), dp(5), dp(12), dp(5));
        code.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        code.setBackgroundDrawable(pill(90));
        int maxW = getResources().getDisplayMetrics().widthPixels - dp(24);
        code.setMaxWidth(maxW);
        code.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        top.addView(code);

        // v4.9.8：状态行「已拍 N 张 · …」移到条码下方，左对齐（原来在底栏快门上方居中，
        // 一直压着画面主体；挪上来后底栏只剩三个按钮，画面更干净）
        countText = new TextView(this);
        countText.setText("已拍 0 张 · 拍完点「完成」返回");
        countText.setTextColor(Color.WHITE);
        countText.setTextSize(13);
        countText.setGravity(Gravity.START);
        countText.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        LinearLayout.LayoutParams ctp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ctp.gravity = Gravity.START; // 左对齐
        ctp.topMargin = dp(3);
        countText.setLayoutParams(ctp);
        top.addView(countText);
        root.addView(top);

        // ---- 底栏：一排 [完成 | 快门(印章弧字) | 补光]（v4.9.8：计数行已上移到条码下方） ----
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.gravity = Gravity.BOTTOM;
        bottom.setLayoutParams(bp);
        bottom.setPadding(0, dp(10), 0, dp(30));
        // v4.9.7：底栏同样不再铺整条黑带，全部交给按钮自身的胶囊背景

        // 一排三件：完成 / 快门 / 补光（垂直居中对齐，快门始终在正中）
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView done = new TextView(this);
        done.setText("✓ 完成");
        done.setTextColor(Color.WHITE);
        done.setTextSize(15);
        done.setGravity(Gravity.CENTER);
        done.setPadding(dp(14), dp(11), dp(14), dp(11));
        done.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        done.setBackgroundDrawable(pill(110));
        done.setOnClickListener(v -> finishShoot());

        // 快门 + 印章弧字：外层 FrameLayout 比快门大一圈，弧字画在快门环外沿
        int d = dp(84);
        int box = d + dp(34);
        FrameLayout shootWrap = new FrameLayout(this);
        shootWrap.setLayoutParams(new LinearLayout.LayoutParams(box, box));

        shootBtn = new TextView(this);
        shootBtn.setText("⭕");
        shootBtn.setTextSize(34);
        shootBtn.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(d, d);
        sp.gravity = Gravity.CENTER;
        shootBtn.setLayoutParams(sp);
        shootBtn.setBackgroundDrawable(makeRing());
        shootBtn.setOnClickListener(v -> takeShot());

        // v4.9.10：弧形提示字整体取消 —— 真机上快门白环会压住弧字（各机型屏幕密度/快门尺寸
        // 不同，调参无法保证都干净），按现场反馈直接去掉，页面更干净。拍照操作无需文字说明。

        shootWrap.addView(shootBtn);

        TextView flash = new TextView(this);
        flash.setText("💡 补光");
        flash.setTextColor(Color.WHITE);
        flash.setTextSize(15);
        flash.setGravity(Gravity.CENTER);
        flash.setPadding(dp(14), dp(11), dp(14), dp(11));
        flash.setShadowLayer(6f, 0f, 1f, Color.BLACK);
        flash.setBackgroundDrawable(pill(110));
        flash.setAlpha(0.85f);
        flash.setOnClickListener(v -> toggleTorch(flash));

        // 左右两个按钮各用一份 LayoutParams（同一实例给两个 child 用会被后者覆盖）
        LinearLayout.LayoutParams sideL = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        LinearLayout.LayoutParams sideR = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        bar.addView(done, sideL);
        bar.addView(shootWrap);
        bar.addView(flash, sideR);
        bottom.addView(bar);
        root.addView(bottom);

        setContentView(root);
        startCamera();
    }

    /** 追溯码字号：越长的码字越小，保证整条完整显示 */
    private float codeSp(int len) {
        if (len <= 16) return 14f;
        if (len <= 24) return 12.5f;
        if (len <= 34) return 11f;
        if (len <= 48) return 10f;
        return 9f;
    }

    /** 半透明圆角胶囊：只包住文字本身，取代原先铺满整条的黑底 */
    private Drawable pill(int alpha) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(20));
        g.setColor(Color.argb(alpha, 0, 0, 0));
        g.setStroke(Math.max(1, dp(1)), Color.argb(60, 255, 255, 255));
        return g;
    }

    private int statusBarHeight() {
        int h = 0;
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) h = getResources().getDimensionPixelSize(id);
        } catch (Throwable ignore) {}
        return h > 0 ? h : dp(24);
    }

    private Drawable makeRing() {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(Color.parseColor("#22FFFFFF"));
        g.setStroke(dp(3), Color.WHITE);
        return g;
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                provider.unbindAll();

                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                CameraSelector selector = new CameraSelector.Builder()
                        .requireLensFacing(CameraSelector.LENS_FACING_BACK).build();
                // v4.9.6：先按目标分辨率绑定；该组合本机不支持时（CameraX 在个别机型会抛异常），
                // 回退到「不指定分辨率」再绑一次，避免直接失败/崩溃 → 仍可拍照
                if (safeMode) {
                    // 兼容模式：不指定分辨率（绑定组合最简单，兼容面最广）
                    imageCapture = buildImageCapture(false);
                } else {
                    try {
                        imageCapture = buildImageCapture(true);
                        camera = provider.bindToLifecycle(this, selector, preview, imageCapture);
                    } catch (Throwable t) {
                        imageCapture = buildImageCapture(false);
                    }
                }
                if (camera == null || imageCapture == null || safeMode) {
                    camera = provider.bindToLifecycle(this, selector, preview, imageCapture);
                }
                // 相机真的跑起来了：2.5 秒后把崩溃计数归零（说明这次活着出来了）
                ui.postDelayed(() -> {
                    try { sprefs.edit().putInt("crash_n", 0).apply(); } catch (Throwable ignore) {}
                }, 2500);
                // v4.9.7：连续自动对焦只触发一次（不带 autoCancel → 持续对焦）。
                // 原来每 2.5s 重触发一次 + 2s 自动取消，画面会一直来回变焦（拉风箱），
                // 与扫码页同因同改；一次触发即持续生效，近距条码一样合得上焦。
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            MeteringPoint pt = previewView.getMeteringPointFactory().createPoint(0.5f, 0.5f);
                            FocusMeteringAction a = new FocusMeteringAction.Builder(pt,
                                    FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                                    .build();
                            if (camera != null) camera.getCameraControl().startFocusAndMetering(a);
                        } catch (Throwable ignore) {}
                    }
                }, 700);
            } catch (Exception e) {
                // 相机打不开：立刻结束，JS 会自动回退到系统相机链路
                PhotoShootBridge.deliver(cbId, null);
                finish();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private ImageCapture buildImageCapture(boolean withTargetResolution) {
        ImageCapture.Builder b = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setJpegQuality(JPEG_QUALITY);
        if (withTargetResolution) b.setTargetResolution(new Size(OUT_W, OUT_H));
        return b.build();
    }

    private void takeShot() {
        if (imageCapture == null || shooting) return;
        shooting = true;
        try { shootBtn.setAlpha(0.5f); } catch (Throwable ignore) {}
        imageCapture.takePicture(camExec, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(@androidx.annotation.NonNull ImageProxy image) {
                String b64 = null;
                try {
                    Bitmap bmp = image.toBitmap();
                    int rot = image.getImageInfo().getRotationDegrees();
                    if (rot != 0 && bmp != null) {
                        Matrix m = new Matrix();
                        m.postRotate(rot);
                        Bitmap r = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                        if (r != bmp) bmp.recycle();
                        bmp = r;
                    }
                    if (bmp != null) {
                        // v4.9.7：出图后按需再缩一次到 OUT_W×OUT_H（不指定分辨率时相机可能给 4000×3000），
                        // 老机型在这一步最容易 OOM，先缩再压，内存峰值直接减半
                        if (bmp.getWidth() > OUT_W || bmp.getHeight() > OUT_H) {
                            float s = Math.min((float) OUT_W / bmp.getWidth(), (float) OUT_H / bmp.getHeight());
                            Bitmap small = Bitmap.createScaledBitmap(bmp,
                                    Math.max(1, Math.round(bmp.getWidth() * s)),
                                    Math.max(1, Math.round(bmp.getHeight() * s)), true);
                            if (small != bmp) bmp.recycle();
                            bmp = small;
                        }
                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
                        bmp.recycle();
                        b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                    }
                } catch (Throwable ignore) {
                    b64 = null;
                    // v4.9.6：内存不足时不要再留在拍照页反复尝试（老机型会连环崩），直接退出让页面回退系统相机
                    if (ignore instanceof OutOfMemoryError) {
                        runOnUiThread(() -> { PhotoShootBridge.deliver(cbId, null); finish(); });
                    }
                } finally {
                    try { image.close(); } catch (Throwable ignore) {}
                }
                final String result = b64;
                runOnUiThread(() -> {
                    shooting = false;
                    try { shootBtn.setAlpha(1f); } catch (Throwable ignore) {}
                    if (result != null && result.length() > 0) {
                        shotCount++;
                        countText.setText("已拍 " + shotCount + " 张 · 可继续拍，完成点「完成」");
                        PhotoShootBridge.deliver(cbId, result);
                    } else {
                        PhotoShootBridge.deliver(cbId, null); // 通知页面本张失败（页面会回退系统相机）
                    }
                });
            }

            @Override
            public void onError(@androidx.annotation.NonNull ImageCaptureException exception) {
                runOnUiThread(() -> {
                    shooting = false;
                    try { shootBtn.setAlpha(1f); } catch (Throwable ignore) {}
                    PhotoShootBridge.deliver(cbId, null);
                });
            }
        });
    }

    private void toggleTorch(TextView flash) {
        try {
            if (camera == null) return;
            torchOn = !torchOn;
            camera.getCameraControl().enableTorch(torchOn);
            flash.setAlpha(torchOn ? 1f : 0.85f);
        } catch (Throwable ignore) {}
    }

    private void finishShoot() {
        PhotoShootBridge.deliver(cbId, null);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishShoot();
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try { ui.removeCallbacksAndMessages(null); } catch (Throwable ignore) {}
        try { camExec.shutdown(); } catch (Throwable ignore) {}
    }
}
