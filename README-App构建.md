# App 包构建说明（v4.2 / 最终版：实时取景连续扫码 + Worker 后台解码 + UA 环境标记）

本目录是 **Android App 原生壳源码**，用于上传到你的 GitHub 仓库，由 GitHub Actions 云端构建出 APK。
**无需在本机装 Android SDK / Node 全量环境**——全在云端完成。

> 🔧 随查随抄的命令行版本见 **`App端命令速查.md`**（含 GitHub Actions 推法、本机出包、安装验收、排错）。
> ⚠️ **v4.2 必须重新出包，且必须先卸载旧 App 再安装**：
> 1. `appendUserAgent`（v34 环境标记）与 `androidScheme: 'https'`（v35 实时取景解锁）都是原生配置，只有重新构建 APK 才生效；
> 2. androidScheme 变更会更换 WebView 存储源（旧 localStorage 里的 NAS 地址会丢），所以不能覆盖安装。
> 装好后版本应为 **4.9.7**（workflow 会自动把 versionName 改成 4.9.7；看到 4.9.7 才说明含原生拍照页 + 启动页关闭按钮）。

## 目录内容
```
App/
├── package.json              # 已加 @capacitor/camera（原生相机）+ @zxing/library（本地解码）
├── capacitor.config.ts       # Camera 插件 + UA 标记 + androidScheme https（v35 实时取景解锁）
├── tsconfig.json
├── .github/workflows/build-android.yml   # 构建流程（拷贝 zxing UMD + 原生 Java + 相机权限硬校验）
├── www/index.html            # 启动页（实时取景连续扫码 + Worker 后台解码 + 拍照识别兜底 + NAS 服务端解码）
├── native/                   # ⚠️ v4.8 起必须有！少推这个目录 → 拍照会退回系统相机（多一步「确定」）
│   ├── BarcodeScannerBridge.java   # 原生扫码桥接（window.BarcodeScannerNative）
│   ├── BarcodeScannerActivity.java # 全屏原生扫码页（CameraX + ZXing，不依赖 GMS）
│   ├── PhotoShootBridge.java       # 原生拍照桥接（window.PhotoShootNative）
│   ├── PhotoShootActivity.java     # 全屏原生拍照页（连拍、拍完免按「确定」）★v4.9.7 版面重做 + 内存加固
│   └── AppControlBridge.java       # v4.9.7：App 控制桥（启动页「关闭」按钮真正退出）
└── NAS_WEB_PATCH/            # NAS 端 app.js 等，备查/离线部署用（不影响 App 构建）
```

> ⚠️ **最容易漏的一步**：`native/` 是隐藏在文档里的关键目录。只推 `www/` + 配置文件也能构建成功，
> 但 APK 里不会有原生拍照页/原生扫码页，现象是**拍照必须按「确定」且不能连拍**。
> 判断方法：手机「设置 → 应用信息」看版本号，含原生拍照页 + 关闭按钮的包是 **4.9.7**。

## 为什么从 ML Kit 换方案
原版扫码用 `@capacitor-mlkit/barcode-scanning`，其默认 flavor **依赖 Google Play 服务（gms）**。
在国产 ROM（无 GMS 的 OPPO/realme/vivo/小米/华为等）上表现就是**启动页黑屏**或 `scan failed`——
这是整类手机的通病，不是个别机型问题。

新方案：**`@capacitor/camera` 调系统相机拍照 + zxing 纯 JS 本地静态解码**。
- 系统相机是所有安卓机 100% 支持的原生能力，**完全绕开 gms 与 CameraX 预览兼容问题**；
- zxing 在 WebView 内运行，离线可用、零原生依赖，支持 QR 与常见一维码；
- 与上传页拍照键**同一条原生相机链路**，整机行为一致、最稳。

## 构建步骤
1. **新建/复用**一个 GitHub 仓库（公开私有均可）。
2. 把本目录里的文件**按原结构上传/覆盖**到仓库根目录（**本目录里的内容直接放仓库根，不要再套一层 `App/`**）：
   - 根目录：`package.json`、`capacitor.config.ts`、`tsconfig.json`
   - `.github/workflows/build-android.yml`（隐藏目录）
   - `www/index.html`
   - **`native/*.java`（v4.8 起必须有：原生扫码页 + 原生拍照页；v4.9.7 新增 AppControlBridge.java）**
   - （`NAS_WEB_PATCH/` 可一并上传，便于归档，不影响构建）
   > 注意 `.github` 是隐藏目录：用 GitHub 网页「Add file → Create new file」手动建路径 `.github/workflows/build-android.yml`，
   > 或**直接整目录 push**（推荐，见下方命令），别只拖部分文件。
   >
   > 命令行推法（推荐，一次到位不会漏）：
   > ```bash
   > cd photo-uploader-最终版/App
   > git init -b main
   > git remote add origin git@github.com:<你的账号>/<仓库名>.git
   > git add -A
   > git status        # 确认 .github/workflows/build-android.yml 与 native/*.java 都在列表里
   > git commit -m "v4.9.7: 原生拍照页版面重做 + 启动页关闭按钮 + 出图内存加固"
   > git push -u origin main
   > ```
3. push 到 `main` / `master` 分支（或手动在 Actions 点 `Run workflow`）。
4. 等待 `Build Android APK` 跑完（约 3–6 分钟）。
   - **必须看到日志** `✅ 相机权限已包含在 APK 中`；否则构建会标红（缺相机权限=哑包）。
   - 另需看到 `www/zxing.min.js` 拷贝成功（Copy 步骤的输出）。
5. 在 Actions 右侧 **Artifacts** 下载 `photo-uploader-debug-apk` → 解压得 `app-debug.apk`。

## 安装与验证
1. **先卸载手机上的旧 App**（避免版本混淆）。
2. 装 `app-debug.apk` → 「设置-应用信息」确认：版本 **4.9.7**、权限列表出现 **相机**。
   - 看到 4.9.7 = 含原生拍照页：上传页点快门进全屏拍照页，**拍完直接回页面、可连拍、没有「确定」**；
   - 仍是 4.8/4.2 = 旧包（`native/` 没推上去或没更新），拍照会走系统相机、多一步「确定」，启动页也没有关闭按钮。
3. 打开 App → 填/探测 `http://<NAS_IP>:3080` → 测试连接 → **开始扫码** → 调起系统相机拍照 → 自动识别后跳上传页。
   - 识别不出时提示「没认出条码，请对准后重拍」，不会卡死；也可用「手动填写追溯码」兜底。
4. 上传页点**拍照键** → 进原生拍照页 → 拍完直接回页面落库（可连拍），**没有「确定」这一步**。
5. 查询输**后 8 位**追溯码命中。

## 说明
- App 不写死 NAS 地址：启动页运行时填，换 IP/网段不需要重新打包。
- 扫码与拍照都走原生 `@capacitor/camera`，解码用 zxing（**无任何 Google 服务依赖**）——适配所有安卓机型。
- 版本号由 workflow 自动改成 4.9.7（`build.gradle`），装好后看到 4.9.7 即确认装的是含原生拍照页 + 关闭按钮的新包。
- **v34 的 UA 标记**：`capacitor.config.ts` 追加了 `appendUserAgent: ' PhotoUploaderShell/1.0'`，
  NAS 上传页靠它稳定识别「此刻在 App 里」，不会再把 App 误判成浏览器。这是**原生工程配置**，
  **改了必须重新构建 APK**才会写进 WebView 设置；NAS 那半边用 `deploy-nas.sh` 热注入即可，两边不必同批次。
