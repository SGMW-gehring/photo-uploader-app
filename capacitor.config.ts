import { CapacitorConfig } from '@capacitor/cli';

// 说明（重要）：
// 本 App 不再把 NAS 地址写死进安装包。启动页（www/index.html）由 App 本地加载，
// 用户在 App 内填写/探测 NAS 地址，运行时跳转过去 —— 以后换 IP、加网段都不用重新打包。
//
// 关键点（v35 更新）：
// - 不设 server.url：加载本地 www（本地源才带 Capacitor 桥接，Camera 插件可用）
// - allowNavigation: ['*']：允许 WebView 内跳转到任意 NAS 地址（Capacitor 用 HostMask，"*" 匹配任意 host）
// - androidScheme 'https'（v35 改动）：本地启动页变成 https://localhost 安全上下文，
//   navigator.mediaDevices 才会被注入 → 启动页可开【实时取景 + 连续扫码】。
//   Capacitor 8 的 BridgeWebChromeClient 已内置 onPermissionRequest 处理：
//   网页相机请求会自动映射到 App 的 CAMERA 运行时权限，授权后放行。
// - allowMixedContent 保留：https 本地页仍可访问 http://NAS:3080（兼容模式）
// - appendUserAgent：给 WebView 打 UA 标记，跳转后 NAS 页面才能稳定识别「我在 App 里」
// ⚠️ androidScheme 变更会更换 WebView 存储源（localStorage/cookie 全新开始），
//    升级此版必须先卸载旧 App 再安装。
const config: CapacitorConfig = {
  appId: 'com.fnnas.photouploader',
  appName: '照片追溯上传',
  webDir: 'www',
  // v34：给 WebView 的 UA 追加固定后缀。跳到 NAS 的 http 页面后，
  // 上传页靠它稳定识别「我在 App 里」，不再依赖 URL 参数（刷新/后退/手输地址都不会丢）。
  // NAS 端 public/app.js 的 inShell() 会检测 /PhotoUploaderShell/。
  appendUserAgent: ' PhotoUploaderShell/1.0',
  server: {
    androidScheme: 'https', // v35：https 安全上下文 → 本地启动页可开实时取景相机（getUserMedia）
    cleartext: true, // 允许 http（3080 直连），Android 会设置 usesCleartextTraffic
    // '*' 让 WebView 能跳转到运行时的任意 NAS 地址（换 IP 不用重新打包）；
    // 已装机地址再显式列一份，Capacitor 会把桥接 JS 注入该页面（上传页内即可直接用原生相机）
    allowNavigation: ['*', '192.168.31.10:3080', '192.168.3.20:3080'],
  },
  android: {
    allowMixedContent: true,
    // 部分 ROM 上，需要显式在 android 节点声明才生效；两条同时写，谁先生效都不影响后缀内容
    appendUserAgent: ' PhotoUploaderShell/1.0',
  },
  plugins: {
    // 原生相机：扫码(拍照)与上传页拍照都走原生通道，绕过 WebView 在非安全源(http 3080)下禁用网页相机的限制
    Camera: {},
  },
};

export default config;
