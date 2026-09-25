# App 端命令速查（v4.1 / 最终版）

## 0. 先说清楚：为什么这次必须重新打包

v34 修的「App 里却被当成浏览器」这个 bug，一半在 NAS（已热注入生效），另一半在 App：

```ts
// capacitor.config.ts
appendUserAgent: ' PhotoUploaderShell/1.0'
```

`appendUserAgent` 是**原生工程配置**，写在 WebView 的 WebSettings 里，**只有重新构建 APK 才带得进去**。
所以旧 APK 装上去，NAS 那半边的修复等于只发挥了一半（靠 URL 参数兜底，一刷新就丢）。

**版本对照**：装好后手机「设置 → 应用信息」看到 **4.1** 才是新包（4.0 是旧包）。

---

## 路线 A：GitHub Actions 云端构建（当前在用的路子）

### 需要覆盖到仓库根目录的文件
```
package.json                                （根目录）
capacitor.config.ts                         （根目录，含 appendUserAgent）
tsconfig.json
.github/workflows/build-android.yml         （隐藏目录！别漏）
www/index.html                              （含 serverDecode 双引擎）
native/*.java                               （v4.8 起必须！漏推 = 拍照要按「确定」、不能连拍）
                                             v4.9.7 共 5 个 java（含 AppControlBridge.java）
  ├─ BarcodeScannerBridge.java / BarcodeScannerActivity.java
  └─ PhotoShootBridge.java / PhotoShootActivity.java / AppControlBridge.java
NAS_WEB_PATCH/                              （可选，备查，不参与构建）
```

> 最省事的做法：**整目录打包后解压到仓库根目录**（`App/` 里的东西直接放仓库根，不要再套一层 `App/`）。
> 现在交付的 `photo-uploader-v4.9.7-App源码包.zip` 就是这种结构，解压即用。

### 命令行推法（有仓库权限时）
```bash
cd photo-uploader-最终版/App
git init -b main                       # 已是 git 仓库则跳过
git remote add origin git@github.com:<你的账号>/<仓库名>.git
git add -A
git status                              # 确认 .github/workflows/build-android.yml 在列表里
git commit -m "v4.1: UA 标记 + 双引擎解码"
git push -u origin main
```

### 网页上传法（github.com 登不上时的变通）
`.github` 是隐藏目录，**拖拽上传经常不带上它**。若在仓库里看不到 `.github/workflows/`，用网页建：
`Add file → Create new file`，文件名直接填：
```
.github/workflows/build-android.yml
```
把本地那个 YAML 全文粘进去 → Commit。其余文件（根目录 3 个 + `www/index.html`）用网页上传即可。

### 触发与下载
- 推到 `main`/`master` 自动跑；或在 Actions 页选 `Build Android APK` → `Run workflow`。
- 正常 3–6 分钟。**必须看到** `✅ 相机权限已包含在 APK 中`，否则构建标红 = 哑包，别装。
- 右侧 **Artifacts** 下载 `photo-uploader-debug-apk` → 解压得 `app-debug.apk`。

> 超过 15 分钟没动静 = runner 抖动，Cancel 后 `Re-run jobs`；连续两次卡住就用路线 B。

---

## 路线 B：本机自己构建（绕开 GitHub，推荐给"登不上 github"的情况）

### 前置（一次性）
- **Node 20+**：`node -v`
- **JDK 21**（Capacitor 8 硬要求，17 会报 `invalid source release: 21`）：`java -version`
- **Android SDK**：Android Studio 装 `Android SDK Platform 34/35` + `Build-Tools`；或只装 `cmdline-tools` 后：
```bash
sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```
- 环境变量（Windows 用系统变量面板，或 PowerShell 临时设）：
```bash
export ANDROID_HOME=$HOME/Android/Sdk      # Windows: C:\Users\<你>\AppData\Local\Android\Sdk
export JAVA_HOME=<JDK21 安装路径>
```

### 构建命令（Linux / macOS）
```bash
cd photo-uploader-最终版/App
npm install

# 1) 拷 zxing 浏览器版到 www（启动页解码用，不依赖 GMS）
cp node_modules/@zxing/library/umd/index.min.js www/zxing.min.js 2>/dev/null \
  || cp node_modules/@zxing/library/bundles/zxing.min.js www/zxing.min.js 2>/dev/null \
  || cp node_modules/@zxing/library/build/umd/index.min.js www/zxing.min.js
ls -l www/zxing.min.js

# 2) 加安卓平台
npx cap add android

# 3) 注入相机权限（Capacitor 默认不声明，缺了就是哑包）
python3 - <<'EOF'
import re
p = 'android/app/src/main/AndroidManifest.xml'
s = open(p, encoding='utf-8').read()
if 'android.permission.CAMERA' not in s:
    s = re.sub(r'(<manifest[^>]*>)',
               r'\1\n    <uses-permission android:name="android.permission.CAMERA" />\n'
               r'    <uses-feature android:name="android.hardware.camera" android:required="false" />',
               s, count=1)
    open(p, 'w', encoding='utf-8').write(s)
print('相机权限已写入' if 'android.permission.CAMERA' in s else '写入失败')
EOF

# 4) 版本号升到 4.1
sed -i -E 's/versionName "[0-9.]+"/versionName "4.1"/' android/app/build.gradle
sed -i -E 's/versionCode [0-9]+/versionCode 5/' android/app/build.gradle
grep -n "versionName\|versionCode" android/app/build.gradle

# 5) 同步 + 出包
npx cap sync android
cd android && chmod +x gradlew && ./gradlew assembleDebug
cd ..
ls -lh android/app/build/outputs/apk/debug/*.apk
```

### Windows（PowerShell）差异
```powershell
cd photo-uploader-最终版\App
npm install
copy node_modules\@zxing\library\umd\index.min.js www\zxing.min.js
npx cap add android
# 权限：用记事本打开 android\app\src\main\AndroidManifest.xml，
#   在 <manifest ...> 下一行手动加两行（见下）
npx cap sync android
cd android; .\gradlew.bat assembleDebug; cd ..
```
手动加的两行：
```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

---

## 路线 C：在 NAS 容器里构建（最后手段）

只有 A、B 都走不通时才考虑：需要 NAS 临时联网 + 约 3GB 磁盘下载 Android SDK，构建很慢。

```bash
docker run -it --rm -v "$PWD":/src -w /src node:20 bash
# 容器内依次：装 openjdk-21、android cmdline-tools → 再跑「路线 B」的第 1~5 步
```

---

## 安装与验收

```bash
# 手机开 USB 调试后，命令行安装（比传到手机再点方便）
adb uninstall com.fnnas.photouploader        # 先卸旧包，避免版本混淆
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# 版本核对（期望 versionName=4.1）
adb shell dumpsys package com.fnnas.photouploader | grep -E "versionName|versionCode"

# 权限核对（期望出现 android.permission.CAMERA granted=true）
adb shell dumpsys package com.fnnas.photouploader | grep -i camera
```

### 硬核验证：UA 标记到底打进 APK 了吗
`appendUserAgent` 会被写进 APK 内的 `assets/capacitor.config.json`，可以直接查：
```bash
unzip -p app-debug.apk assets/capacitor.config.json | grep -o PhotoUploaderShell
```
**有输出 = 这个包带着 v34 的环境标记**，跟 NAS 端那半边能对上；没输出就是旧配置，白装。

### 手机上的最终验收
1. 打开 App → 填 `http://192.168.3.20:3080` → 测试连接
2. 「开始扫码」→ 调起**系统相机**（不是黑屏的自定义预览）→ 拍条码 → 识别后自动跳上传页
3. 上传页**应显示「原生模式（App）」**，不再是"请用 https:// 访问"
4. 拍照键 → 系统相机 → 拍完自动落库上传
5. 画廊按追溯码**后 8 位**查得到

---

## 排错速查

| 现象 | 原因 / 处理 |
|---|---|
| 构建报 `invalid source release: 21` | JDK 版本不对，必须是 **21** |
| 构建报缺 `zxing.min.js` | 第 1 步拷贝失败，检查 `node_modules/@zxing/library` 里的实际路径（umd / bundles / build/umd） |
| 装完扫码黑屏 | 装的是带 ML Kit 的旧包；确认版本 4.1 + UA 标记检查通过 |
| 权限列表里没相机 | Manifest 没注入成功，重跑第 3 步再 `npx cap sync android` |
| 上传页仍提示"请用 https:// 访问" | ① APK 不是 4.1（查 UA 标记）② NAS 端没热注入（查 `grep -c PhotoUploaderShell /app/public/app.js`） |
| 识别不出条码 | 靠近拍满、避开反光；本地 zxing 失败会自动转 NAS 服务端解码，再不行有 OCR 读数字兜底 |
| 想立刻用，不等 APK | 走 PWA：手机 Chrome 开 `https://192.168.3.20:3000` → 菜单「添加到主屏幕」，功能与 App 一致（详见 `NAS/PWA使用说明.md`） |
