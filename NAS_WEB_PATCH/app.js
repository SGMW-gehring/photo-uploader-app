/* 飞牛NAS 手机扫码拍照上传 —— 单屏版前端逻辑 */
(function () {
  'use strict';

  // ---------- 全局状态 ----------
  const state = {
    photographer: localStorage.getItem('photographer') || '',
    workstation: localStorage.getItem('workstation') || '', // 工位：跨刷新/关页恢复
    qr: null,
    stream: null,
    scanning: false,
    torchOn: false,
    photos: [], // { blob, url, capturedAt, seq, uploaded, uploading, failed }
    seq: 0,
    realtime: true, // v4.4：默认开启实时上传（拍一张立即传一张），不再需要手动点「上传」
    watermark: localStorage.getItem('watermark') !== '0', // 照片文字水印，默认开
    ocrWorker: null,
    cfg: { dayStart: 8, nightStart: 20 },
  };

  const TARGET = 20; // 每组约 20 张（软提示，不强制）
  const RING_LEN = 2 * Math.PI * 34; // 快门进度环周长 ≈213.6

  // ---------- 离线持久化（IndexedDB）：照片与上传状态跨刷新/关页存活 ----------
  // 拍照后立即写库；上传成功标记 uploaded；本机存储不可用时静默降级为纯内存模式。
  const DB = (function () {
    const DB_NAME = 'fnnas_photos', STORE = 'photos', V = 1;
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, V);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    function put(rec) {
      return open().then((db) => new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = () => res(rec);
        tx.onerror = () => rej(tx.error);
      }));
    }
    function getAll() {
      return open().then((db) => new Promise((res, rej) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      }));
    }
    function del(id) {
      return open().then((db) => new Promise((res) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.onerror = () => {};
        tx.oncomplete = () => res();
      }));
    }
    // 换追溯码/放弃本组时，清掉所有「未上传」记录（已上传的保留在 NAS，不必动）
    function clearPending() {
      return getAll().then((recs) => Promise.all(recs.filter((r) => !r.uploaded).map((r) => del(r.id))));
    }
    // v4.9.7：整组清空（含已上传记录）。「拍完一组 → 上传完毕 → 启动下一组」时调用，
    // 保证手机里不再残留上一组的任何副本（此前只清未上传的，已上传的大图会一直躺在本机库里）
    function clearAll() {
      return getAll().then((recs) => Promise.all(recs.map((r) => del(r.id))));
    }
    return { put, getAll, del, clearPending, clearAll, available: typeof indexedDB !== 'undefined' };
  })();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const cam = $('cam');

  // ---------- 工具 ----------
  function showModal(id) { $(id).classList.add('show'); }
  function hideModal(id) { $(id).classList.remove('show'); }
  function anyModalOpen() { return !!document.querySelector('.modal.show'); }

  let toastTimer;
  let toastAction = null;
  function toast(msg, opts) {
    const t = $('toast');
    const b = $('toastBtn');
    $('toastMsg').textContent = msg;
    toastAction = null;
    if (opts && typeof opts.action === 'function' && opts.label) {
      toastAction = opts.action;
      b.textContent = opts.label;
      b.classList.add('show');
    } else {
      b.classList.remove('show');
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      toastAction = null;
    }, (opts && opts.duration) || 2600);
  }
  $('toastBtn').addEventListener('click', () => {
    const fn = toastAction;
    toastAction = null;
    $('toast').classList.remove('show');
    clearTimeout(toastTimer);
    if (fn) fn();
  });

  function shiftOf(date) {
    const h = date.getHours();
    return h >= state.cfg.dayStart && h < state.cfg.nightStart ? '白班' : '夜班';
  }

  // ---------- 配置 / 连接状态 ----------
  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 8000);
    return fetch(url, { signal: ctrl.signal, cache: 'no-store' }).finally(() => clearTimeout(timer));
  }

  let connRetryTimer = null;
  async function loadConfig() {
    const el = $('connStatus');
    const dot = $('connDot');
    try {
      const r = await fetchWithTimeout('/api/config');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      state.cfg.dayStart = d.dayStart;
      state.cfg.nightStart = d.nightStart;
      el.textContent = '已连接';
      el.className = 'conn ok';
      dot.className = 'dot ok';
      retryFailed(); // 网络恢复：自动重试之前失败的项
      clearTimeout(connRetryTimer);
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? '请求超时' : (e.message || '网络错误');
      el.textContent = '连接失败(' + reason + ')';
      el.className = 'conn err';
      dot.className = 'dot err';
      clearTimeout(connRetryTimer);
      connRetryTimer = setTimeout(loadConfig, 5000);
    }
  }

  // ---------- 摄像头 ----------
  async function startCamera() {
    stopCamera();
    // v31：App 原生壳经 http 直连时 WebView 是非安全源，不暴露 navigator.mediaDevices，
    // 网页相机整体不可用 → 标记 noWebcam，拍照改走系统相机、扫码改走原生引擎
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      state.noWebcam = true;
      setupNoWebcamUI();
      throw new Error(inShell()
        ? 'App 拍照已就绪：点 ⭕ 快门即可拍'
        : '当前为 http 页面，网页相机不可用：请用 App 打开，或改用 https://' + location.hostname + ':3000 访问');
    }
    const tries = [
      // v27：ideal 降到 1920x1440（4:3 传感器全幅视野）。过高的 ideal（3000x2000）在部分
      // 手机上会触发传感器裁切（等效数码变焦），画面发糊且视野变小；1920x1440 兼顾视野与解析力
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920, max: 4096 }, height: { ideal: 1440, max: 4096 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920, max: 4096 }, height: { ideal: 1080, max: 2160 } } },
      { audio: false, video: { facingMode: 'environment' } },
      { audio: false, video: true },
    ];
    let lastErr = null;
    for (const c of tries) {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia(c);
        cam.srcObject = state.stream;
        await cam.play();
        state.torchOn = false;
        // 引导连续自动对焦（多数安卓支持；近距拍条码更清晰）
        try {
          const t = state.stream.getVideoTracks()[0];
          await t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (e) { /* 设备不支持则忽略 */ }
        return;
      } catch (e) {
        lastErr = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
      }
    }
    throw lastErr || new Error('摄像头启动失败');
  }

  // 变焦（设备支持时）：factor>1 放大，<1 缩小
  async function setZoom(factor) {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const settings = track.getSettings ? track.getSettings() : {};
      if (!caps.zoom) { toast('该设备不支持变焦，请靠近条码'); return; }
      const cur = settings.zoom || caps.zoom.min || 1;
      const next = Math.min(caps.zoom.max, Math.max(caps.zoom.min, cur * factor));
      await track.applyConstraints({ advanced: [{ zoom: next }] });
    } catch (e) {
      toast('变焦不可用，请靠近条码');
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    if (cam) cam.srcObject = null;
  }

  // ---------- v34：原生壳判定（兼容 v4 架构，修复「App 内被判成浏览器」） ----------
  // 历史 bug：旧判定用「是否存在 BarcodeScanner 插件」识别 App 内环境；v4 移除 ML Kit 后该插件不再注册，
  // 条件恒 false → 明明在 App 里却走了浏览器分支，提示「请用 https:// 访问，或使用 App」。
  // 现改为多信号叠加，任一命中即为原生壳：
  //   ① URL 带 ?shell=1（App 启动页跳转时附加）→ 写入 sessionStorage，页面刷新/后退仍生效
  //   ② sessionStorage 标记（命中过 ① 即长期有效，直到 ?shell=0）
  //   ③ Capacitor 桥接存在且 isNativePlatform()（远程 http 页面若被注入桥接也能认出来）
  //   ④ UA 含 PhotoUploaderShell（App 端 android.appendUserAgent 设置的后缀，跨跳转最可靠）
  const SHELL_UA_RE = /PhotoUploaderShell/i;
  const SHELL_KEY = 'pu_shell';
  function inShell() {
    try {
      const p = new URLSearchParams(location.search).get('shell');
      if (p === '1') { try { sessionStorage.setItem(SHELL_KEY, '1'); } catch (e) {} return true; }
      if (p === '0') { try { sessionStorage.removeItem(SHELL_KEY); } catch (e) {} return false; }
      try { if (sessionStorage.getItem(SHELL_KEY) === '1') return true; } catch (e) {}
      try {
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return true;
      } catch (e) {}
      return SHELL_UA_RE.test(navigator.userAgent || '');
    } catch (e) { return false; }
  }

  // 原生相机插件是否可用（v4 只保留 @capacitor/camera，已无 BarcodeScanner）
  function hasNativeCamera() {
    try {
      const C = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
      return !!(C && C.getPhoto);
    } catch (e) { return false; }
  }

  // v4.3.1：原生相机预览插件（@capacitor-community/camera-preview，方案①）
  // 在 WebView 之上叠加原生预览层并嵌入取景区，规避 http 非安全源下网页相机不可用的限制；
  // 任何失败一律静默回退到既有「系统相机 / 原生相机」通道，绝不破坏现有功能。
  const CamPreview = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CameraPreview) || null;
  const hasCamPreview = !!CamPreview;
  let camPreviewOn = false;

  // ---------- v4.5：原生 ZXing 扫码桥接（注入 WebView 的 BarcodeScannerNative，不依赖 GMS，体验同微信/QQ） ----------
  // MainActivity 通过 addJavascriptInterface 暴露 window.BarcodeScannerNative._scan(cbId)（原生全屏扫码）；
  // 这里封装成 Promise 化的 scan()，并把结果回传函数挂在 window.__barcodeResolve 上。
  // 浏览器/无原生桥接环境：window.BarcodeScannerNative._scan 不存在 → hasNativeZXing() 为 false → 调用方自动回退既有方案。
  window.__barcodeCbs = window.__barcodeCbs || {};
  window.__barcodeResolve = function (cbId, value) {
    const r = window.__barcodeCbs[cbId];
    if (r) { delete window.__barcodeCbs[cbId]; r(value || null); }
  };
  if (window.BarcodeScannerNative && window.BarcodeScannerNative._scan && !window.BarcodeScannerNative.scan) {
    window.BarcodeScannerNative.scan = function () {
      return new Promise((resolve) => {
        const id = 'bs_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        window.__barcodeCbs[id] = resolve;
        try { window.BarcodeScannerNative._scan(id); } catch (e) { delete window.__barcodeCbs[id]; resolve(null); }
        // 兜底：原生未回传（异常/用户关闭）则 15s 后自动取消，避免 Promise 永远 pending
        setTimeout(() => { if (window.__barcodeCbs[id]) { delete window.__barcodeCbs[id]; resolve(null); } }, 15000);
      });
    };
  }
  function hasNativeZXing() {
    return !!(window.BarcodeScannerNative && window.BarcodeScannerNative._scan);
  }
  async function nativeScanZXing() {
    if (!hasNativeZXing()) return null;
    try { return await window.BarcodeScannerNative.scan(); } catch (e) { return null; }
  }

  // ---------- v4.8：原生拍照桥接（window.PhotoShootNative，addJavascriptInterface 注入） ----------
  // 为什么需要它：Capacitor 的插件桥只注入本地源页面，远程 http://NAS 页面拿不到 window.Capacitor，
  // 于是 CameraPreview / Camera 插件都不存在，拍照只能靠文件选择器唤起系统相机（自带「确定」页）。
  // 这里改走与原生扫码同款的 JavascriptInterface 通道：拉起全屏原生拍照页，
  // 每拍一张分块回传 base64，页面复用既有水印/落库/上传管线，全程无「确定」步骤、可连拍。
  window.__shotBuf = window.__shotBuf || {};
  window.__shotSessions = window.__shotSessions || {};
  window.__shotBegin = function (id, total) { try { window.__shotBuf[id] = new Array(total); } catch (e) {} };
  window.__shotChunk = function (id, i, part) { try { const b = window.__shotBuf[id]; if (b) b[i] = part; } catch (e) {} };
  window.__shotDone = function (id) {
    try {
      const b = window.__shotBuf[id]; if (!b) return; delete window.__shotBuf[id];
      const s = window.__shotSessions[id];
      if (s && s.onShot) s.onShot(b.join(''));
    } catch (e) {}
  };
  window.__shotEnd = function (id) {
    try { const s = window.__shotSessions[id]; if (s) { delete window.__shotSessions[id]; s.resolve(); } } catch (e) {}
  };
  function hasNativeShoot() {
    return !!(window.PhotoShootNative && window.PhotoShootNative._shoot);
  }

  // ---------- v4.9.6：老机型「点快门闪退」自救（不需要重打 APK） ----------
  // 现象：少数老机型（如荣耀 Play / 麒麟970 / 4GB 内存）点快门拉起原生拍照页时整个 App 闪退。
  //   原因在原生层（CameraX 绑定或出图时崩溃、或出图瞬间内存峰值被系统杀进程）——
  //   Java 的 try 抓不到这种崩溃，页面连记录的机会都没有。
  // 对策：这台机器上跳过原生拍照页，改走「页内实时预览 → 系统相机」链路，
  //   功能不缺（照片、水印、追溯码、上传全都一样），只是系统相机多一步「确定」。
  // 触发（都记在 localStorage，纯网页端生效，默认行为完全不变）：
  //   ① 手动：访问 ?noshoot=1（长期生效），?noshoot=0 恢复
  //   ② 自动：只要出现一次「进了原生拍照页却没回传任何照片」→ 判定不兼容，自动降级并提示
  // v4.9.7：阈值由「连续两次」改成「一次就跳」。荣耀 Play 实测是**一进拍照页就崩**
  //   （CameraX 在这台机上起不来，Java 层 try/catch 抓不住，进程直接没），
  //   属于确定性崩溃而非偶发 —— 让用户崩两次才降级没有意义，崩一次就永久跳过。
  //   想再试（换了 ROM / 想验证）：双击网页右上角版本号，或访问 ?noshoot=0。
  const NS_SKIP_KEY = 'pu_skip_nativeshoot';
  const NS_FAIL_KEY = 'pu_nativeshoot_fail';
  const NS_ENTER_KEY = 'pu_nativeshoot_enter';
  (function () {
    try {
      const p = new URLSearchParams(location.search).get('noshoot');
      if (p === '1') localStorage.setItem(NS_SKIP_KEY, '1');
      else if (p === '0') { localStorage.removeItem(NS_SKIP_KEY); localStorage.removeItem(NS_FAIL_KEY); }
      // 上次「进过原生拍照页」的标记还没清 → 说明那次没正常回来（多半是崩了）
      if (localStorage.getItem(NS_ENTER_KEY) === '1') {
        localStorage.removeItem(NS_ENTER_KEY);
        const n = (parseInt(localStorage.getItem(NS_FAIL_KEY) || '0', 10) || 0) + 1;
        localStorage.setItem(NS_FAIL_KEY, String(n));
        // v4.9.7：一次即跳（原为 n >= 2）。崩一次就说明这台机进不了原生拍照页，没必要再崩第二次
        if (n >= 1 && localStorage.getItem(NS_SKIP_KEY) !== '1') {
          localStorage.setItem(NS_SKIP_KEY, '1');
          // 延后 1.5s 再提示：启动阶段还有别的提示（拍照就绪等）会把它顶掉，用户就看不到原因了
          try {
            setTimeout(() => {
              try { toast('检测到本机进原生拍照页会闪退，已自动改用系统相机拍照（想再试可双击右上角版本号）', { duration: 5000 }); } catch (_) {}
            }, 1500);
          } catch (_) {}
        }
      }
    } catch (e) {}
  })();
  /** 是否跳过原生拍照页（老机型闪退自救） */
  function skipNativeShoot() { try { return localStorage.getItem(NS_SKIP_KEY) === '1'; } catch (e) { return false; } }
  function markNativeShootEnter() { try { localStorage.setItem(NS_ENTER_KEY, '1'); } catch (e) {} }
  function noteNativeShootOut(got) {
    try {
      if (got > 0) { localStorage.removeItem(NS_FAIL_KEY); localStorage.removeItem(NS_ENTER_KEY); }
      else localStorage.removeItem(NS_ENTER_KEY); // 用户主动返回（没拍照）不计入失败
    } catch (e) {}
  }
  /** 打开原生拍照页；返回本次拍到的张数（0 = 未拍/不可用，调用方继续走既有链路） */
  function nativeShoot() {
    if (!hasNativeShoot()) return Promise.resolve(0);
    return new Promise((resolve) => {
      const id = 'sh_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      let got = 0, chain = Promise.resolve();
      window.__shotSessions[id] = {
        onShot: (b64) => {
          // 串行落库，保证连拍顺序与编号一致
          chain = chain.then(async () => {
            try {
              const canvas = await b64ToCanvas(b64);
              await addCapturedPhoto(canvas);
              got++;
            } catch (e) {}
          });
          return chain;
        },
        resolve: () => chain.then(() => { noteNativeShootOut(got); resolve(got); }),
      };
      try {
        markNativeShootEnter(); // v4.9.6：记下「已进原生拍照页」，回来（含崩溃后重开）据此判断是否异常
        window.PhotoShootNative._shoot(id, String((state && state.qr) || ''));
      } catch (e) {
        delete window.__shotSessions[id]; noteNativeShootOut(0); resolve(0); return;
      }
      // 兜底：极端情况（Activity 异常未回调）5 分钟后自动结束，避免 Promise 悬挂
      setTimeout(() => { const s = window.__shotSessions[id]; if (s) { delete window.__shotSessions[id]; s.resolve(); } }, 300000);
    });
  }

  function b64ToCanvas(b64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // v4.9.6：与系统相机回图同一把尺子——超过 photoMaxEdge 就先缩，
        // 避免原生拍照页回传的大图在老机型上二次触发内存峰值
        const MAX = photoMaxEdge();
        const s = Math.min(1, MAX / Math.max(img.naturalWidth || img.width || 1, img.naturalHeight || img.height || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * s));
        c.height = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c);
      };
      img.onerror = reject;
      img.src = 'data:image/jpeg;base64,' + b64;
    });
  }

  async function startCamPreview() {
    if (!hasCamPreview || camPreviewOn) return camPreviewOn;
    try {
      // v4.7.1 修复（真机视频定位）：@capacitor-community/camera-preview 的 Android 原生端
      // 不识别 parent/宽高定位参数——预览层是叠加在容器上的全屏 Fragment，正确用法是
      // toBack:true（置于 WebView 后层）+ WebView 透明 + 页面取景区透明「挖洞」。
      // 旧写法（无 toBack）即使 start 成功，预览层也会全屏盖住 UI，部分机型直接启动失败，
      // 导致永远静默降级系统相机（视频实锤：点快门 → 跳系统相机 → 每张多一次「确定」）。
      await CamPreview.start({ position: 'rear', toBack: true, storeToFile: false });
      camPreviewOn = true;
      // 页面挖洞：body.cam-on 时 .main/#cam 背景透明（style.css），原生取景即从取景区透出
      document.body.classList.add('cam-on');
      const pill = document.getElementById('noCamPill'); if (pill) pill.style.display = 'none';
      return true;
    } catch (e) {
      camPreviewOn = false;
      try { CamPreview.stop(); } catch (_) {}
      // v4.7.1：失败原因上屏（此前静默失败，真机无日志无从定位；兜底行为不变）
      try { toast('页内预览未开启：' + ((e && (e.message || e)) || '未知原因') + '，改用系统相机拍照'); } catch (_) {}
      return false;
    }
  }

  function stopCamPreview() {
    if (!camPreviewOn) return;
    camPreviewOn = false;
    try { CamPreview.stop(); } catch (_) {}
    document.body.classList.remove('cam-on');
    const pill = document.getElementById('noCamPill'); if (pill) pill.style.display = '';
    const el = $('camPreview'); if (el) el.style.display = 'none';
  }

  // 从预览层抓一帧 → 走与网页相机/系统相机完全相同的落库 + 水印 + 上传管线
  async function captureFromPreview() {
    if (!camPreviewOn) return false;
    try {
      const res = await CamPreview.capture({ quality: 90 });
      const b64 = res && res.value;
      // v4.7.1：过短 base64 视作无效帧（相机尚未出图），返回 false 触发上层重试/降级
      if (!b64 || b64.length < 2000) return false;
      const canvas = await b64ToCanvas(b64);
      await addCapturedPhoto(canvas);
      // v4.7：白闪一帧，明确「这张已经拍下了」（连续拍摄时尤其需要即时反馈）
      try { const f = $('flash'); if (f) { f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); } } catch (_) {}
      return true; // 预览保持开启，可连拍
    } catch (e) { return false; }
  }

  function setupNoWebcamUI() {
    try {
      ['btnTorch', 'btnZoomIn', 'btnZoomOut'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      const camEl = document.getElementById('cam');
      if (camEl && camEl.parentElement && !document.getElementById('noCamTip')) {
        // v4.7：App 内已是「页面内实时预览 + 快门直拍」，不再铺整屏说明文字（此前与取景提示叠加，视觉突兀）。
        // 改为：整块画面保留为透明点击层（点哪都能拍），底部只悬一枚小胶囊提示；浏览器分支保留居中说明。
        const tip = document.createElement('div');
        tip.id = 'noCamTip';
        tip.style.cssText = 'position:absolute;inset:0;z-index:1;cursor:pointer;';
        tip.addEventListener('click', () => { try { shoot(); } catch (e) {} });
        camEl.parentElement.appendChild(tip);

        // v4.8：浏览器分支保留环境提示胶囊；v4.9.4 起 App 内不再挂「点击画面或快门」横条，
        // 该提示已集成到快门正下方的小字（.shoot-hint），画面区更干净。
        const pill = document.createElement('div');
        pill.id = 'noCamPill';
        if (!inShell()) {
          pill.textContent = '请用 App 打开，或 https 访问本页';
          pill.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--bar-h) + 14px);z-index:2;pointer-events:none;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.22);color:#fff;font-size:12px;padding:7px 14px;border-radius:999px;text-shadow:0 1px 2px #000;backdrop-filter:blur(4px);white-space:nowrap;';
          camEl.parentElement.appendChild(pill);
        }
      }
    } catch (e) {}
  }

  // 原生扫码（startScan + 事件监听，CameraX 路径不依赖 GMS），单次识别后自动停止
  function nativeScanOnce() {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;
    if (!B) return Promise.resolve(null);
    const formats = ['CODE_128','CODE_39','CODE_93','QR_CODE','DATA_MATRIX','EAN_13','EAN_8','ITF','PDF_417','UPC_A','UPC_E','AZTEC','CODABAR'];
    return new Promise((resolve) => {
      let handle = null, done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        try { const r = B.stopScan(); if (r && r.catch) r.catch(() => {}); } catch (e) {}
        try { if (handle && handle.remove) handle.remove(); } catch (e) {}
        resolve(code || null);
      };
      B.addListener('barcodeScanned', (res) => {
        const b = res && (res.barcode || (res.barcodes && res.barcodes[0]));
        const code = b && (b.rawValue || b.displayValue || b.value);
        if (code) finish(String(code).trim());
      }).then((h) => {
        handle = h;
        if (!done) {
          const p = B.startScan({ formats });
          if (p && p.catch) p.catch(() => finish(null));
        }
      }).catch(() => finish(null));
      // 兜底：个别版本 addListener 不返回 promise，稍后自行启动
      setTimeout(() => {
        if (!done && !handle) {
          const p = B.startScan({ formats });
          if (p && p.catch) p.catch(() => {});
        }
      }, 500);
      setTimeout(() => finish(null), 120000);
    });
  }

  // 系统相机拍一张（WebView 文件选择器，http 下同样可用）→ 回填到拍照管线
  let _fileCapture = null;
  function ensureFileInput() {
    if (_fileCapture) return _fileCapture;
    _fileCapture = document.createElement('input');
    _fileCapture.type = 'file';
    _fileCapture.accept = 'image/*';
    try { _fileCapture.capture = 'environment'; } catch (e) {}
    _fileCapture.style.display = 'none';
    document.body.appendChild(_fileCapture);
    _fileCapture.addEventListener('change', async () => {
      const f = _fileCapture.files && _fileCapture.files[0];
      _fileCapture.value = '';
      if (f) await shootFromFile(f);
    });
    return _fileCapture;
  }

  // 原生相机拍照（Capacitor Camera 插件）：彻底绕过 WebView 在 http(3080) 非安全源下禁用网页相机的问题。
  // 返回 true=已成功拍并落库；false=插件不可用 / 用户取消 / 异常（调用方决定要不要回退文件选择器）。
  // 取消原因记在 _lastCamErr：用户主动取消时不应再弹一次系统选择器，避免"点了返回又冒出来"。
  let _lastCamErr = null;
  async function nativeCameraCapture() {
    _lastCamErr = null;
    const C = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
    if (!C || !C.getPhoto) return false;
    try {
      const photo = await C.getPhoto({
        quality: 90,
        allowEditing: false,
        correctOrientation: true,
        saveToGallery: false,
        resultType: 'uri',
        source: 'camera',
      });
      const uri = photo && (photo.webPath || photo.path);
      if (!uri) return false;
      const blob = await (await fetch(uri)).blob();
      const file = new File([blob], 'p' + Date.now() + '.jpg', { type: blob.type || 'image/jpeg' });
      await shootFromFile(file);
      return true;
    } catch (e) {
      _lastCamErr = String((e && (e.message || e.errorMessage)) || e || '');
      return false;
    }
  }
  function userCancelledCam() { return !!_lastCamErr && /cancel/i.test(_lastCamErr); }

  // v4.9.6：系统相机回图的最大边长。
  // 原来是 4096 —— 等于几乎不缩小：4000×3000 原图解码 48MB + 画布再一份 48MB + 水印 + toBlob，
  // 峰值 150MB+，老机型（荣耀 Play / 4GB）会在这一步被系统杀进程，表现为「点快门闪退」。
  // 车间归档 1600×1200（192 万像素）完全够用，上传也更快。可用 ?maxedge=1200 再降一档。
  //
  // v4.9.7：再加一层「闪退自动降档」。荣耀 Play 这类机型即使 1600 仍可能被杀，
  // 靠人工记 URL 参数不现实 —— 改成：处理照片前置标记，处理完清除；下次开页面若标记还在，
  // 说明上次是在处理照片时被打死的，记一次崩溃并把出图边长降一档（1600 → 1200 → 1000）。
  // ⚠️ 只作用于「落库/上传的照片尺寸」，识别链路（框内抓帧 + 全帧兜底 + 服务端解码 + OCR）
  //    不从这张照片取码，因此不影响识别能力。
  const CRASH_KEY = 'pu_crash_n';
  const BUSY_KEY = 'pu_shot_busy';
  function crashLevel() {
    try { return Math.max(0, Math.min(2, parseInt(localStorage.getItem(CRASH_KEY) || '0', 10) || 0)); } catch (e) { return 0; }
  }
  function markShotBusy() { try { localStorage.setItem(BUSY_KEY, '1'); } catch (e) {} }
  function clearShotBusy() { try { localStorage.removeItem(BUSY_KEY); } catch (e) {} }

  function photoMaxEdge() {
    try {
      const p = parseInt(new URLSearchParams(location.search).get('maxedge'), 10);
      if (p >= 800 && p <= 4096) return p;
      const s = parseInt(localStorage.getItem('pu_photo_maxedge') || '0', 10);
      if (s >= 800 && s <= 4096) return s;
    } catch (e) {}
    const lvl = crashLevel();
    return lvl === 0 ? 1600 : (lvl === 1 ? 1200 : 1000);
  }

  async function shootFromFile(file) {
    if (!validQr()) { toast('请先识别追溯码，再拍摄照片'); return; }
    const MAX = photoMaxEdge();
    let canvas = null;
    // v4.9.6：优先用 createImageBitmap 边解码边缩到目标宽度 —— 不必先把整张 4000×3000 解成 48MB，
    // 内存峰值直接降到 1/4 左右（老机型闪退的主因就在这里）。不支持的老 WebView 走下方回退。
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file, { resizeWidth: MAX, resizeQuality: 'high' });
        const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bmp.width * s));
        canvas.height = Math.max(1, Math.round(bmp.height * s));
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        try { if (bmp.close) bmp.close(); } catch (e) {}
      } catch (e) { canvas = null; }
    }
    if (!canvas) {
      let img;
      try {
        img = new Image();
        img.src = URL.createObjectURL(file);
        await img.decode();
      } catch (e) { toast('照片读取失败，请重试'); return; }
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      canvas = document.createElement('canvas');
      canvas.width = Math.round((img.naturalWidth || 1) * scale);
      canvas.height = Math.round((img.naturalHeight || 1) * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      try { URL.revokeObjectURL(img.src); } catch (e) {}
    }
    await addCapturedPhoto(canvas);
  }

  // 从画布出片（原 shoot 后半段抽取，实时流与系统相机共用同一落库/上传管线）
  async function addCapturedPhoto(canvas) {
    markShotBusy(); // v4.9.7：标记「正在处理照片」，正常收尾会清掉；残留在下次开页面时即判为上次闪退
    const seq = ++state.seq;
    const qrForMark = state.qr;
    if (state.watermark) drawWatermark(canvas, seq, qrForMark);
    shutterFeedback();
    const blob = await encodeJpeg(canvas, 1 * 1024 * 1024, 2 * 1024 * 1024);
    if (!blob) { clearShotBusy(); toast('拍照失败，请重试'); return; }
    const thumb = await makeThumb(canvas, 320); // 随照片上传，供检索页缩略图网格
    const url = URL.createObjectURL(blob);
    const p = { blob, url, thumb, capturedAt: new Date().toISOString(), seq, qr: qrForMark, photographer: state.photographer, workstation: state.workstation, uploaded: false, uploading: false, failed: false, dbId: null };
    // 离线持久化：拍照即落 IndexedDB，刷新/关页后未上传照片也能恢复
    if (DB.available) {
      const rec = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        qr: qrForMark, photographer: state.photographer, workstation: state.workstation, capturedAt: p.capturedAt, seq, blob, thumb, uploaded: false, serverPath: '',
      };
      // v4.9.7：dbId 同步赋值（原来等 put 完成后才填）。实时上传几乎与落库同时发生，
      // 异步回填会让「上传成功 → 删除本机副本」找不到 id，副本就一直躺在手机里删不掉。
      p.dbId = rec.id;
      DB.put(rec).catch(() => {});
    }
    state.photos.push(p);
    renderThumbs(true);
    const f = $('flash');
    f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
    showLastShot(p.url); // v4.9.4：画面区回显刚拍的照片，确认"拍到了"
    clearShotBusy(); // v4.9.7：本张处理完毕，撤销闪退标记
    // 实时上传：已识别立即传
    if (state.realtime) uploadOne(p);
  }

  // v4.9.4：拍照回显层 —— 大图显示刚拍的照片，点击立即关；
  // v4.9.5：停留时间 2.6s → 4.5s（反馈"看不清拍到了什么"，多留一会儿确认）；
  // 定格识别等弹窗打开时不叠加（避免盖住识别流程）；旧缓存 HTML 无此层时静默跳过。
  const LAST_SHOT_MS = 4500; // v4.9.5：回显停留时长（点一下可立即关闭，不影响连拍节奏）
  let lastShotTimer = null;
  function showLastShot(url) {
    const box = $('lastShot'); const img = $('lastShotImg');
    if (!box || !img) return;
    if (document.querySelector('.modal.show')) return;
    img.src = url;
    box.classList.add('show');
    clearTimeout(lastShotTimer);
    lastShotTimer = setTimeout(hideLastShot, LAST_SHOT_MS);
  }
  function hideLastShot() {
    clearTimeout(lastShotTimer); lastShotTimer = null;
    const box = $('lastShot');
    if (box) box.classList.remove('show');
  }

  async function toggleTorch() {
    if (camPreviewOn && hasCamPreview) {
      try {
        state.torchOn = !state.torchOn;
        await CamPreview.setFlashMode(state.torchOn ? 'torch' : 'off');
        $('btnTorch').classList.toggle('on', state.torchOn);
        return;
      } catch (e) { /* 失败退回网页相机手电筒 */ }
    }
    if (!state.stream) { toast('摄像头未开启'); return; }
    const track = state.stream.getVideoTracks()[0];
    if (!track) return;
    try {
      state.torchOn = !state.torchOn;
      await track.applyConstraints([{ advanced: [{ torch: state.torchOn }] }][0]);
      $('btnTorch').classList.toggle('on', state.torchOn);
    } catch (e) {
      toast('该设备不支持手电筒');
      state.torchOn = false;
    }
  }

  // ---------- 条码解码：重解码全部交给 Web Worker（off 主线程），彻底杜绝「持续轮询解码」导致的手机发烫 ----------
  // 主线程只负责「抓帧 → 取 RGBA → 投递 Worker → 等结果」；ZXing 解码、灰度拉伸、多方向旋转都在 Worker 内完成。
  let scanRAF = null;
  let scanTimer = null;
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  // 后台解码引擎（Web Worker）：本机不支持时降级提示，不影响拍照。
  let workerBroken = false;
  let decodeWorker = null;
  let decodeSeq = 0;
  const decodePending = new Map();

  function ensureWorker() {
    if (decodeWorker || workerBroken) return decodeWorker;
    try {
      decodeWorker = new Worker('/decode-worker.js');
      decodeWorker.onmessage = (e) => {
        const { id, text } = e.data;
        const p = decodePending.get(id);
        if (p) { decodePending.delete(id); p.resolve(text); }
      };
      decodeWorker.onerror = () => {
        workerBroken = true;
        decodePending.forEach((p) => p.resolve(null));
        decodePending.clear();
        toast('后台解码引擎异常，请用「手动输入」或「识别」');
      };
      return decodeWorker;
    } catch (e) {
      workerBroken = true;
      return null;
    }
  }

  // 投递一帧 RGBA 给 Worker 解码，返回 Promise<text|null>。
  // 拷贝底层 buffer 后 transfer，保留原帧供 jsQR 兜底复用。
  // nativeOnly=true 时 Worker 只走原生 BarcodeDetector 快通道（约 10~30ms），不跑 ZXing 重解码，
  // 用于拍照前「预焙快检」，保证快门即时且不阻塞相机预览。
  function workerDecode(imageData, angles, nativeOnly) {
    const w = ensureWorker();
    if (!w) return Promise.resolve(null);
    const id = ++decodeSeq;
    return new Promise((resolve) => {
      decodePending.set(id, { resolve });
      try {
        const buf = imageData.data.buffer.slice(0);
        w.postMessage({ id, data: buf, width: imageData.width, height: imageData.height, angles: angles || [0], nativeOnly: !!nativeOnly }, [buf]);
      } catch (e) {
        decodePending.delete(id);
        resolve(null);
      }
    });
  }

  // 当前浏览器是否具备原生条码引擎（BarcodeDetector）。用于决定是否走「预焙快检」路径。
  function hasNativeDetect() {
    return (typeof BarcodeDetector !== 'undefined') || (typeof window !== 'undefined' && 'BarcodeDetector' in window);
  }

  // 任意角度旋转 ImageData（canvas 旋转，兼容 45° 等非直角，提升倾斜/俯拍条码命中率）
  function rotateImageData(src, angle) {
    if (angle === 0) return src;
    const w = src.width, h = src.height;
    const rad = angle * Math.PI / 180;
    const dw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    const dh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(dw));
    canvas.height = Math.max(1, Math.ceil(dh));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; // 旋转留白填黑，避免透明边干扰解码
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(src, 0, 0);
    ctx.drawImage(tmp, -w / 2, -h / 2);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  // ---------- v4.9.1：让出主线程 + 可中断的解码调度 ----------
  // 现象：进入「定格识别」后，点「重新拍摄 / 手动输入 / 关闭」要点好几下才响应。
  // 根因：定格之后主线程还要干一堆同步重活 —— grabFrame/getImageData 拷大数组、
  //       buffer.slice() 复制、以及 jsQR 兜底（对 Code128 一维码根本解不出，纯白跑），
  //       这些把事件循环占满，点击排不上队；更要命的是旧流程**无法中断**：
  //       点了「关闭」它仍要把「本地多尺度 → 服务端 → OCR」整条链跑完，
  //       再点「重新拍摄」还会与上一次叠加，于是越点越卡。
  // 对策：①每个耗时步骤之间主动让出主线程 ②用 run 编号让旧流程在下一个让出点立即作废
  //       ③砍掉对一维码无效的重复 jsQR 兜底 ④定格预览改用小图编码
  //       —— 以上均不动 ZXing / 服务端 / OCR 的解码口径，识别能力不变。
  function yieldUI() {
    return new Promise((r) => {
      try {
        // Chrome/Edge 新 API：让出主线程但优先于普通 setTimeout，响应更跟手
        if (typeof scheduler !== 'undefined' && scheduler.yield) { scheduler.yield().then(r, r); return; }
      } catch (e) { /* 不支持则回退 setTimeout */ }
      setTimeout(r, 0);
    });
  }

  // 定格识别的运行编号：每次开始 +1；旧流程在下一个让出点发现编号变了就立刻退出。
  let freezeRun = 0;
  let freezeCtrl = null;
  function cancelFreeze() {
    freezeRun++;
    try { if (freezeCtrl) freezeCtrl.abort(); } catch (e) {}
    freezeCtrl = null;
    // 顺带复位可能被旧流程卡住的按钮态，否则「识别」键会点不动
    try { const b = $('btnScan'); if (b) b.disabled = false; } catch (e) {}
    try { showScanFrame(false); } catch (e) {}
  }
  function beginFreeze() {
    cancelFreeze(); // 先作废可能还在跑的旧流程，避免两次解码叠加
    const ctrl = new AbortController();
    freezeCtrl = ctrl;
    return { run: freezeRun, ctrl };
  }

  // 解码一帧：优先 Worker(ZXing 全格式 + 多方向 + 灰度拉伸)，未命中再 jsQR(二维码) 主线程兜底。
  // 变为异步（返回 Promise），解码全程在 Worker 后台，主线程不卡顿、不发烫。
  // v4.9.1：opts = { jsqr:false 跳过主线程 jsQR 兜底, alive:()=>boolean 中断判定 }
  async function decodeFrame(img, angles, opts) {
    const o = opts || {};
    const alive = o.alive || (() => true);
    const list = angles || [0];
    const text = await workerDecode(img, list);
    if (text) return text;
    if (!alive()) return null;
    // 后续兜底阶段（多尺度 / 八方向）用 jsqr:false 跳过：jsQR 只认二维码，
    // 对 Code128 一维码永远解不出，白跑一遍还要阻塞主线程。
    if (o.jsqr === false) return null;
    if (typeof window.jsQR !== 'function') return null;
    // jsQR 仅对二维码有效，作为兜底（只跑一次，且每个角度之间让出主线程）
    for (const ang of list) {
      if (!alive()) return null;
      const cur = ang === 0 ? img : rotateImageData(img, ang);
      const c = window.jsQR(cur.data, cur.width, cur.height, { inversionAttempts: 'dontInvert' });
      if (c && c.data) return c.data;
      await yieldUI();
    }
    return null;
  }

  // 把屏幕上的取景框区域换算成视频像素坐标（自动适配 object-fit: cover / contain 的裁切或留黑边偏移）
  function scanBoxVideoRect() {
    const box = document.querySelector('.scan-box');
    const r = box.getBoundingClientRect();
    const VW = window.innerWidth, VH = window.innerHeight;
    const vw = cam.videoWidth, vh = cam.videoHeight;
    const fit = (getComputedStyle(cam).objectFit || 'cover').toLowerCase();
    // cover：铺满裁切（取大）；contain：完整显示留黑边（取小）；fill：拉伸（无偏移，取宽比）
    const s = fit === 'contain' ? Math.min(VW / vw, VH / vh)
      : fit === 'fill' ? VW / vw
      : Math.max(VW / vw, VH / vh);
    const ox = (vw * s - VW) / 2, oy = (vh * s - VH) / 2;
    let x = (r.left + ox) / s, y = (r.top + oy) / s;
    let w = r.width / s, h = r.height / s;
    x = Math.max(0, Math.min(vw - 2, x));
    y = Math.max(0, Math.min(vh - 2, y));
    w = Math.max(2, Math.min(w, vw - x));
    h = Math.max(2, Math.min(h, vh - y));
    return { x, y, w, h };
  }

  // 抓帧：maxEdge 限制最大边长；useBox=true 时只取取景框区域（条码像素密度更高，识别率大幅提升）
  function grabFrame(maxEdge, useBox) {
    const vw = cam.videoWidth, vh = cam.videoHeight;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (useBox) {
      const r = scanBoxVideoRect();
      sx = r.x; sy = r.y; sw = r.w; sh = r.h;
    }
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const cw = Math.max(1, Math.floor(sw * scale)), ch = Math.max(1, Math.floor(sh * scale));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    cv.getContext('2d', { willReadFrequently: true }).drawImage(cam, sx, sy, sw, sh, 0, 0, cw, ch);
    return cv;
  }

  // 条码区域定位：计算行/列边缘密度，找出条纹密集区（条码特征），返回裁剪矩形。
  // 用于「拍一张识别」前二次裁剪放大，提升低对比/倾斜场景下的 Code128 命中率。
  function locateBarcodeRegion(data, w, h) {
    const rowEdge = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let prev = -1, cnt = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const g = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
        if (prev >= 0 && Math.abs(g - prev) > 20) cnt++;
        prev = g;
      }
      rowEdge[y] = cnt;
    }
    let maxE = 0;
    for (let y = 0; y < h; y++) maxE = Math.max(maxE, rowEdge[y]);
    if (maxE < 8) return null; // 没有明显的条纹密度，放弃定位
    const thr = Math.max(8, maxE * 0.35);
    let top = h, bot = 0;
    for (let y = 0; y < h; y++) if (rowEdge[y] >= thr) { if (y < top) top = y; if (y > bot) bot = y; }
    if (bot - top < h * 0.08) return null;
    const colEdge = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let prev = -1, cnt = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const g = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
        if (prev >= 0 && Math.abs(g - prev) > 20) cnt++;
        prev = g;
      }
      colEdge[x] = cnt;
    }
    let maxC = 0;
    for (let x = 0; x < w; x++) maxC = Math.max(maxC, colEdge[x]);
    if (maxC < 8) return null;
    const thc = Math.max(8, maxC * 0.35);
    let l = w, r = 0;
    for (let x = 0; x < w; x++) if (colEdge[x] >= thc) { if (x < l) l = x; if (x > r) r = x; }
    const padY = Math.round((bot - top) * 0.05), padX = Math.round((r - l) * 0.05);
    top = Math.max(0, top - padY); bot = Math.min(h, bot + padY);
    l = Math.max(0, l - padX); r = Math.min(w, r + padX);
    return { x: l, y: top, w: r - l, h: bot - top };
  }

  // 稳健解码一帧 ImageData：原生引擎(自动旋转) → 四方向 ZXing → 定位放大 + 八方向(小码/倾斜) → jsQR(二维码兜底)。
  // 用于「识别追溯码」按钮、自动识别升级路径，统一高命中率；解码全程在 Worker 后台，主线程不卡顿。
  async function decodeImageDataRobust(id, opts) {
    const o = opts || {};
    const alive = o.alive || (() => true);
    // 让出主线程并检查本次运行是否已被用户取消
    const step = async () => { await yieldUI(); return alive(); };
    // 1) 四方向 ZXing（原生优先，见 worker）+ jsQR 二维码兜底（全程只此一次）
    let t = await decodeFrame(id, [0, 90, 180, 270], { jsqr: true, alive });
    if (t) return t;
    if (!(await step())) return null;
    // 2) 定位条码区域并做多尺度解码（v26：原尺寸/0.6x/1500/2400 四档——高密度长码并非越大越好，
    //    过度放大会把模糊插值放大，原尺寸或适当缩小反而更利落）
    const loc = locateBarcodeRegion(id.data, id.width, id.height);
    if (loc && (loc.w < id.width * 0.98 || loc.h < id.height * 0.98)) {
      const src = document.createElement('canvas');
      src.width = id.width; src.height = id.height;
      src.getContext('2d', { willReadFrequently: true }).putImageData(id, 0, 0);
      const base = Math.max(loc.w, loc.h);
      const scales = [];
      for (const target of [1, 0.6, 1500 / base, 2400 / base]) {
        const s = Math.min(4, Math.max(0.2, target));
        if (!scales.some((v) => Math.abs(v - s) < 0.05)) scales.push(s);
      }
      for (const scale of scales) {
        if (!(await step())) return null; // 每一档之间都给点击留出机会
        const cw = Math.max(1, Math.floor(loc.w * scale)), ch = Math.max(1, Math.floor(loc.h * scale));
        if (cw < 8 || ch < 8) continue;
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d', { willReadFrequently: true }).drawImage(src, loc.x, loc.y, loc.w, loc.h, 0, 0, cw, ch);
        t = await decodeFrame(cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch), [0, 45, 90, 135, 180, 225, 270, 315], { jsqr: false, alive });
        if (t) return t;
      }
    }
    // 3) 整帧八方向兜底
    if (!(await step())) return null;
    return await decodeFrame(id, [0, 45, 90, 135, 180, 225, 270, 315], { jsqr: false, alive });
  }

  // v27 服务端重型解码：本地解不出时，把定格图发给 NAS（zxing-cpp 引擎 + 定位放大 + 对比度拉伸），
  // 解码能力远强于手机浏览器；失败静默返回 null，自动落到 OCR 兜底。
  function canvasToBlob(canvas, q) {
    return new Promise((res) => {
      try { canvas.toBlob((b) => res(b || null), 'image/jpeg', q || 0.9); } catch (e) { res(null); }
    });
  }
  // v4.9.1：支持外部 signal —— 用户点「关闭 / 手动输入 / 重新拍摄」时立刻掐断这次上传，
  // 不再让一个已经没人等的结果继续占着网络和处理时间。
  async function serverDecode(canvas, signal) {
    try {
      if (signal && signal.aborted) return null;
      const blob = await canvasToBlob(canvas, 0.9);
      if (!blob) return null;
      if (signal && signal.aborted) return null;
      const fd = new FormData();
      fd.append('image', blob, 'frame.jpg');
      const ctrl = new AbortController();
      const onAbort = () => { try { ctrl.abort(); } catch (e) {} };
      if (signal) signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch('/api/decode', { method: 'POST', body: fd, signal: ctrl.signal });
        if (!r.ok) return null;
        const d = await r.json();
        return (d && d.ok && d.text) ? String(d.text).trim() : null;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    } catch (e) { return null; }
  }

  // 拍一张静止帧解码（snapScan 显式识别用）：抓整帧走稳健解码流水线。
  async function decodeStill() {
    if (!cam.videoWidth) return null;
    const full = grabFrame(1500, false);
    const id = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
    return decodeImageDataRobust(id);
  }

  // ---------- 识别模式 UI ----------
  function showScanFrame(on) { $('scanFrame').classList.toggle('show', !!on); }

  function onBarcode(data) {
    state.qr = data.trim();
    try { localStorage.setItem('pu_last_qr', state.qr); } catch (e) {} // v4.8：识别即落盘
    state.seq = 0;
    stopScan();
    showScanFrame(false);
    updateCodeChip();
    const short = state.qr.length > 16 ? state.qr.slice(0, 16) + '…' : state.qr;
    toast('已识别 ' + short + '，直接拍照');
    // v4.7：识别完成 = 立即进入拍照状态——App 内确保页面内预览已开启，并让快门脉冲提示「现在就能拍」
    if (state.noWebcam && hasCamPreview && !camPreviewOn) {
      startCamPreview().catch(() => {});
    }
    try {
      const b = $('btnShoot');
      if (b) {
        b.classList.remove('pulse');
        void b.offsetWidth;
        b.classList.add('pulse');
        setTimeout(() => b.classList.remove('pulse'), 2000);
      }
    } catch (e) {}
    // v4.8：识别完直接进拍照——App 内识别成功后自动拉起原生拍照页，省掉「再点一次快门」。
    // 仅在原生拍照桥接存在时生效（未装新版 APK 时保持原有行为，不做半吊子改动）；
    // 原生拍照页拍完可继续拍下一张，点「完成」回上传页，全程无系统相机的「确定」步骤。
    try {
      if (inShell() && validQr() && hasNativeShoot()) setTimeout(() => { try { nativeShoot(); } catch (e) {} }, 700);
    } catch (e) {}
  }

  // v28+：当运行在 Capacitor 原生壳内时，用手机原生引擎（安卓 ML Kit / iOS Vision）扫码，
  // 识别率远超浏览器 ZXing；扫码成功后直接回填追溯码。非原生环境返回 null，自动走浏览器流水线。
  async function nativeScan() {
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner;
    if (!B) return null;
    try {
      const perm = (B.requestPermissions && (await B.requestPermissions())) || {};
      const st = perm.camera || perm.barcode;
      if (st && st !== 'granted' && st !== 'authorized' && st !== 'always') return null;
      const { barcodes } = await B.scan();
      const b = barcodes && barcodes[0];
      if (!b) return null;
      return (b.rawValue || b.displayValue || '').trim();
    } catch (e) { return null; }
  }

  // 拍照识别（显式按钮）——「定格识别」流程：
  // 点击后立即抓一张静止画面固定显示在弹层里，对该张照片做多档稳健解码；
  // 用户能看清刚拍到了什么，失败可原地「重新拍摄」或转「手动输入」，不再是对着实时画面盲解。
  function showFreeze(canvas) {
    try {
      // v4.9.1：预览单独缩到 ≤1000px 再编码。原实现直接对 2400px 原图做 toDataURL，
      // 一次同步 JPEG 编码上百毫秒，正好卡在「弹层刚弹出」这一刻，显得点了没反应。
      // 缩到 1000px 画质依旧看得清条码，编码量与内存占用降到约 1/6。
      let src = canvas;
      const s = Math.min(1, 1000 / Math.max(canvas.width || 1, canvas.height || 1));
      if (s < 1) {
        src = document.createElement('canvas');
        src.width = Math.max(1, Math.round(canvas.width * s));
        src.height = Math.max(1, Math.round(canvas.height * s));
        src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height);
      }
      $('freezeImg').src = src.toDataURL('image/jpeg', 0.8);
    } catch (e) { /* 忽略 */ }
    $('freezeTip').textContent = '识别中…';
    // 收起取景框：它被定格弹层完全盖住，但里面的扫描线是 2.2s 无限循环动画，
    // 在低端机上白白占着合成资源 —— 定格期间正好不需要它。
    showScanFrame(false);
    showModal('freezeModal');
  }
  function hideFreeze() { hideModal('freezeModal'); }

  // 取一张照片的 File：优先原生 Camera 插件（直接出图，体验最好）；
  // 插件不可用（远程 http 页面未被注入桥接）或用户取消 → 回退 input[capture=environment]，
  // 由安卓系统相机接手，任何机型都可用。取消则返回 null。
  async function pickPhotoFile() {
    if (hasNativeCamera()) {
      _lastCamErr = null;
      try {
        const photo = await window.Capacitor.Plugins.Camera.getPhoto({
          quality: 90, allowEditing: false, correctOrientation: true,
          saveToGallery: false, resultType: 'uri', source: 'camera',
        });
        const uri = photo && (photo.webPath || photo.path);
        if (uri) {
          const b = await (await fetch(uri)).blob();
          return new File([b], 'scan' + Date.now() + '.jpg', { type: b.type || 'image/jpeg' });
        }
      } catch (e) {
        _lastCamErr = String((e && (e.message || e.errorMessage)) || e || '');
        if (userCancelledCam()) return null; // 用户主动取消 → 不再兜一个选择器出来
        // 插件异常 → 继续走系统相机文件选择器
      }
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      try { inp.capture = 'environment'; } catch (e) {}
      inp.style.display = 'none';
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { inp.remove(); } catch (e) {}
        resolve(v);
      };
      timer = setTimeout(() => done(null), 180000);
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.value = '';
        done(f || null);
      });
      document.body.appendChild(inp);
      try { inp.click(); } catch (e) { done(null); }
    });
  }

  // 按 File → 缩放后的 canvas（解码用，避免超大原图拖慢 zxing 与上传）。
  // v35：优先 createImageBitmap——图片解码+缩放发生在主线程之外，12MP 照片不再冻住页面。
  async function fileToCanvas(file, maxSide) {
    if (window.createImageBitmap) {
      try {
        const bmp = await createImageBitmap(file); // 解码在后台线程完成
        const w0 = bmp.width || 1, h0 = bmp.height || 1;
        const scale = Math.min(1, (maxSide || 1600) / Math.max(w0, h0));
        const cw = Math.max(1, Math.round(w0 * scale)), ch = Math.max(1, Math.round(h0 * scale));
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, cw, ch);
        try { bmp.close(); } catch (e) {}
        return cv;
      } catch (e) { /* 个别 ROM 对该格式不支持 → 落回老路径 */ }
    }
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const w0 = img.naturalWidth || 1, h0 = img.naturalHeight || 1;
    const scale = Math.min(1, (maxSide || 1600) / Math.max(w0, h0));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w0 * scale));
    cv.height = Math.max(1, Math.round(h0 * scale));
    cv.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, cv.width, cv.height);
    try { URL.revokeObjectURL(img.src); } catch (e) {}
    return cv;
  }

  // App 内（无网页相机、无 ML Kit）识别追溯码：
  // 系统相机拍一张条码 → ①本地 zxing 解全尺寸图 ②再解小图（有的码缩小反而更利落）
  // ③交给 NAS /api/decode 服务端重型引擎（对比度拉伸 + 区域定位 + zxing-cpp）。
  // 与 App 启动页 index.html 的双引擎策略保持一致。
  async function shellPhotoDecode() {
    toast(hasNativeCamera() ? '打开相机，对准条码…' : '打开系统相机，对准条码…');
    const file = await pickPhotoFile();
    if (!file) return;
    try {
      const idOf = (cv) => cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
      const full = await fileToCanvas(file, 1600);
      toast('本地识别中…');
      let text = await decodeImageDataRobust(idOf(full));
      if (!text) {
        const small = await fileToCanvas(file, 640);
        text = await decodeImageDataRobust(idOf(small));
        if (!text) {
          toast('本地未解出，发送 NAS 服务端解码…');
          text = await serverDecode(full) || await serverDecode(small);
        }
      }
      if (text) {
        onBarcode(text);
        toast('追溯码：' + text.trim());
      } else {
        toast('未识别到条码：靠近些拍满条码、避开反光，或点「手动输入追溯码」');
      }
    } catch (e) {
      toast('识别失败，可点「手动输入追溯码」');
    }
  }

  async function snapScan() {
    // v34：无网页相机时的三条通道（旧版 ML Kit 插件 / App 拍照+服务端解码 / 普通浏览器）
    if (state.noWebcam || !cam.videoWidth) {
      // v4.5：优先用原生 ZXing 扫码（全屏实时、不依赖 GMS，识别率远超 JS，体验同微信）
      if (hasNativeZXing()) {
        toast('调用原生扫码…');
        const t = await nativeScanZXing();
        if (t) { onBarcode(String(t).trim()); return; }
        // v4.6：原生 12s 未识别（超时/手动关闭）→ App 内自动切「系统相机拍照+本地/服务端解码」，
        // 这条链路（含 NAS 服务端重型解码）就是网页版识别力的来源，确保 App 不弱于网页版
        if (inShell()) { toast('原生未识别，切换拍照识别…'); await shellPhotoDecode(); return; }
        toast('未识别到条码，可点「手动输入追溯码」或重试');
        return;
      }
      if (inShell()) { await shellPhotoDecode(); return; }
      toast('当前环境无相机：请用 App 打开，或浏览器以 https:// 访问');
      return;
    }
    // v4.5：原生壳内优先用原生 ZXing 扫码（全屏实时识别，比网页流水线快且准），一步到位
    if (hasNativeZXing()) {
      toast('调用原生扫码…');
      const t = await nativeScanZXing();
      if (t) { onBarcode(String(t).trim()); return; }
      // 原生没扫到不阻塞，继续走浏览器流水线兜底
    }
    const btn = $('btnScan');
    if (btn.disabled) return;
    btn.disabled = true;
    showScanFrame(true);

    // v4.9.1：本次运行的「编号 + 中断器」。旧流程在下一个让出点发现编号变了就自行退出，
    // 用户点任意操作键都能立刻停掉还在跑的解码，界面不再被拖住。
    const { run, ctrl } = beginFreeze();
    const alive = () => run === freezeRun;
    // 自动识别开着时先暂停轮询：它与定格解码抢同一条主线程，是卡顿的帮凶之一
    const wasAuto = autoScan;
    if (wasAuto) stopScan();

    try {
      // 定格两份：取景框区域（条码像素密度高）+ 整帧高清（保底）
      const full = grabFrame(2400, false);
      if (!alive()) return;
      showFreeze(full); // 先把定格画面上屏（预览已改小图编码，几乎不掉帧）
      await yieldUI();
      if (!alive()) return;
      const box = grabFrame(1600, true);
      if (!alive()) return;
      $('freezeTip').textContent = '识别中…（对定格画面解码）';
      const idOf = (cv) => cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
      let text = await decodeImageDataRobust(idOf(box), { alive });
      if (!alive()) return;
      if (!text) {
        await yieldUI();
        if (!alive()) return;
        text = await decodeImageDataRobust(idOf(full), { alive });
        if (!alive()) return;
      }
      // v27 兜底①：条码解码失败 → 发给 NAS 服务端重型解码（zxing-cpp，定位放大 + 对比度拉伸）
      if (!text) {
        $('freezeTip').textContent = '条码未解出，发送 NAS 服务端解码中…';
        text = await serverDecode(full, ctrl.signal);
        if (!alive()) return;
        if (!text) text = await serverDecode(box, ctrl.signal);
        if (!alive()) return;
      }
      // 兜底②：仍失败 → 自动 OCR 读取条码下方的印刷数字（28位明文很清晰）
      if (!text) {
        $('freezeTip').textContent = '条码未解出，自动 OCR 读取数字中…（首次加载模型约几秒）';
        try {
          text = await ocrDecode(box);
          if (!alive()) return;
          if (!text) text = await ocrDecode(full);
          if (!alive()) return;
        } catch (e) { /* OCR 不可用则维持失败 */ }
      }
      if (!alive()) return;
      if (text) {
        hideFreeze();
        onBarcode(text);
      } else {
        $('freezeTip').textContent = '这张没识别出来：靠近些让条码占满取景框、避开反光，点「重新拍摄」再试，或直接「手动输入」';
      }
    } finally {
      // v4.3：无论成功/失败/异常，必须复位按钮与扫描框，否则按钮会永久卡在 disabled（用户反馈“换码后再识别无反应”）
      // v4.9.1：若本次运行已被用户取消，复位交给 cancelFreeze 处理，避免把新流程的状态覆盖掉
      if (alive()) {
        btn.disabled = false;
        showScanFrame(false);
        // 识别成功时 onBarcode 已 stopScan，这里不再重启自动识别
        if (wasAuto && autoScan && !state.qr) { state.scanning = true; loopScan(); }
      }
    }
  }

  // 自动连续识别
  // v4.9.2：默认保持关闭（省电、不发烫）；开启前必须弹窗告知「耗电快、容易发烫」，确认后才真正开启。
  // 关的方向不做拦截——想停即刻停，不增加任何操作负担。
  let autoScan = false;
  function setAutoScan(on, quiet) {
    autoScan = on;
    const btn = $('btnAutoScan');
    if (btn) btn.setAttribute('aria-checked', on ? 'true' : 'false');
    if (on) {
      state.scanning = true;
      showScanFrame(true);
      $('scanTip').textContent = '自动识别中…把条码放入框内';
      loopScan();
      toast('已开启自动识别：耗电快、易发烫，不用时记得关掉');
    } else {
      stopScan();
      showScanFrame(false);
      if (!quiet) toast('已关闭自动识别（省电、不发烫）');
    }
  }
  function toggleAutoScan() {
    if (autoScan) { setAutoScan(false); return; }
    const m = $('autoScanModal');
    if (m) { showModal('autoScanModal'); return; }
    // v4.9.3 兜底：弹层缺失（如手机缓存了旧版 HTML）时改用系统对话框，绝不静默直接开
    let ok = false;
    try { ok = window.confirm('开启自动识别会让摄像头持续不停解码：\n\n· 耗电快\n· 手机容易发烫\n\n建议保持关闭，用「识别追溯码」按需识别。\n\n仍要开启吗？'); } catch (e) { ok = false; }
    if (ok) setAutoScan(true);
    else { const b = $('btnAutoScan'); if (b) b.setAttribute('aria-checked', 'false'); }
  }

  // ---------- OCR 兜底（离线 Tesseract，读取条码下方印刷文字） ----------
  async function getOcrWorker() {
    if (state.ocrWorker) return state.ocrWorker;
    if (typeof Tesseract === 'undefined') throw new Error('OCR 引擎未加载（请检查 /lib/tesseract 资源）');
    const w = await Tesseract.createWorker('eng', 1, {
      corePath: '/lib/tesseract/tesseract-core.wasm.js',
      workerPath: '/lib/tesseract/worker.min.js',
      langPath: '/lib/tesseract/',
      gzip: false,
      logger: () => {},
    });
    await w.setParameters({ tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-' });
    state.ocrWorker = w;
    return w;
  }

  async function ocrDecode(canvas) {
    const w = await getOcrWorker();
    const { data } = await w.recognize(canvas);
    const txt = (data && data.text) ? data.text.toUpperCase() : '';
    const tokens = txt.match(/[A-Z0-9-]{6,}/g) || [];
    if (!tokens.length) return null;
    tokens.sort((a, b) => b.length - a.length);
    return tokens[0];
  }

  async function onOcrScan() {
    if (!cam.videoWidth) { toast('摄像头未就绪，请稍候'); return; }
    const btn = $('btnOcr');
    if (btn.disabled) return;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '识别中…';
    showScanFrame(true);
    $('scanTip').textContent = 'OCR 识别中（首次需加载模型，约几秒）…';
    try {
      // 优先取景框区域（放大后文字更清晰），失败再试全画面
      let cv = grabFrame(1600, true);
      let t = await ocrDecode(cv);
      if (!t) {
        cv = grabFrame(1600, false);
        t = await ocrDecode(cv);
      }
      showScanFrame(false);
      if (t) onBarcode(t);
      else { $('scanTip').textContent = '未读到条码文字，可手动输入或重试'; toast('OCR 未读到条码下方文字，请手动输入'); }
    } catch (e) {
      showScanFrame(false);
      $('scanTip').textContent = 'OCR 失败：' + (e && e.message || e);
      toast('OCR 失败：' + (e && e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  let lastRotateTry = 0;
  // 自动识别（增强模式，需手动开启）：解码已移入 Worker，主线程几乎零负担；
  // 轮询间隔拉长到 400ms，平时不抓帧、不解码，彻底消除发烫。默认关闭，按需开启。
  function loopScan() {
    if (!state.scanning) return;
    if (cam.readyState >= 2 && cam.videoWidth > 0) {
      // 轻量快通道：取景框小图，Worker 内仅 0° 单次（最快）
      const box = grabFrame(1000, true);
      const bid = box.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, box.width, box.height);
      workerDecode(bid, [0]).then((text) => {
        if (state.scanning && text) { onBarcode(text); return; }
        // 兜底：失败才升级定位放大 + 八方向，且放慢到 ~500ms 一次
        const now = performance.now();
        if (state.scanning && !text && now - lastRotateTry > 500) {
          lastRotateTry = now;
          const full = grabFrame(1500, false);
          const id = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
          decodeImageDataRobust(id).then((t2) => {
            if (state.scanning && t2) onBarcode(t2);
          }).catch(() => {});
        }
      }).catch(() => {});
    }
    // 节流：轮询间隔 400ms（v22：解码在 Worker，主线程空闲；仅控制抓帧节奏）
    scanTimer = setTimeout(loopScan, 400);
  }

  function stopScan() {
    state.scanning = false;
    if (scanRAF) cancelAnimationFrame(scanRAF);
    scanRAF = null;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
  }

  // 重新开始（换追溯码）：清空本组。v22 不再持续轮询（发烫根因），改为「直接拍照即自动识别」或点「识别」。
  function restartScan() {
    state.photos.forEach((p) => { if (p.url) URL.revokeObjectURL(p.url); });
    // v4.9.7：启动下一组 = 本机上一组的照片副本整组清空（含已上传记录），手机里不再残留
    if (DB.available) DB.clearAll().catch(() => {});
    state.photos = [];
    state.seq = 0;
    state.qr = null;
    try { localStorage.removeItem('pu_last_qr'); } catch (e) {} // v4.8：换码即清缓存，避免刷新后被补回旧码
    updateCodeChip();
    renderThumbs();
    showScanFrame(false);
    stopScan();
    state.scanning = false;
    autoScan = false;
    const a = $('btnAutoScan'); if (a) a.setAttribute('aria-checked', 'false');
    // 提示用户：无需先扫描，直接拍照即可后台识别追溯码；或点「识别」/「手动输入」
    toast('已换追溯码：上一组本机照片已清理，直接拍照即可开新一组');
    // v4.3：兜底清掉可能卡死的按钮态（识别键若此前中途异常会停在 disabled），换码即重置
    const bs = $('btnScan'); if (bs) bs.disabled = false;
    const bo = $('btnOcr'); if (bo) bo.disabled = false;
  }

  // ---------- 拍照 ----------
  let audioCtx = null;
  function shutterFeedback() {
    try { if (navigator.vibrate) navigator.vibrate(35); } catch (e) {}
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 1500;
      g.gain.setValueAtTime(0.10, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.09);
    } catch (e) {}
  }

  // 体积自适应编码：优先高画质，目标把单张压在 1~2MB 区间。
  // 从高质量试起，若超过 maxBytes(2MB) 则逐级降质量到 ≤2MB；
  // 若最高质量仍 < minBytes(1MB) 也接受（已是最清晰，不强撑体积）。
  function encodeJpeg(canvas, minBytes, maxBytes) {
    minBytes = minBytes || 1 * 1024 * 1024;
    maxBytes = maxBytes || 2 * 1024 * 1024;
    return new Promise((resolve) => {
      // 高质量阶梯：起点抬高到 0.96，清晰照片自然落在 1~2MB
      const quals = [0.96, 0.93, 0.90, 0.86, 0.82, 0.78];
      let idx = 0;
      const step = () => {
        canvas.toBlob((blob) => {
          if (!blob) return resolve(null);
          // 命中：不超过上限；或已是最高质量档（即便偏小也接受）
          if (blob.size <= maxBytes || idx >= quals.length - 1) return resolve(blob);
          idx++;
          step();
        }, 'image/jpeg', quals[idx]);
      };
      step();
    });
  }

  // 生成缩略图：长边缩放到 maxSide，编码 JPEG(0.7)。随照片一并上传，供检索页秒开网格（不拖原图）。
  function makeThumb(canvas, maxSide) {
    return new Promise((resolve) => {
      try {
        const ms = maxSide || 320;
        const scale = Math.min(1, ms / Math.max(canvas.width, canvas.height));
        const w = Math.max(1, Math.round(canvas.width * scale));
        const h = Math.max(1, Math.round(canvas.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(canvas, 0, 0, w, h);
        c.toBlob((b) => resolve(b || null), 'image/jpeg', 0.7);
      } catch (e) { resolve(null); }
    });
  }

  // 拍照即识别（v23）：抓拍即时落盘（快门不被 ZXing 拖住），再后台回填追溯码。
  // 预焙前先用「原生条码引擎」做 ~10–30ms 快检：命中即水印正确且快门无感；
  // 无原生引擎/未命中则出片后后台 ZXing 重试回填芯片与记录，该张水印可能暂标「未识别」，后续张正确。
  // 二维码有效性：空 / '未识别' / 'null' 均视为无效，禁止拍照与上传，杜绝无效文件污染归档。
  function validQr() {
    const q = state.qr;
    return !!q && q !== '未识别' && q !== 'null' && q.trim().length > 0;
  }

  async function shoot() {
    // v34：无网页相机（http 非安全源）→ 原生相机插件优先，失败回退系统相机文件选择器
    if (state.noWebcam) {
      if (!validQr()) {
        // 没码不直接卡死：壳内顺手发起一次「拍条码」识别，浏览器则给出明确指引
        toast('请先识别追溯码');
        if (inShell()) await shellPhotoDecode();
        else if (cam.videoWidth) await snapScan();
        else toast('当前环境无相机：请用 App 打开，或浏览器以 https:// 访问');
        return;
      }
      // v4.8：原生拍照页优先（全屏取景、拍完不退出、可连拍、无系统相机的「确定」步骤）
      // 没拍到（相机不可用/用户直接返回）则继续走下方既有链路，行为与旧版一致
      // v4.9.6：本机被判定为「原生拍照页会闪退」时跳过它，走下方预览/系统相机链路
      if (hasNativeShoot() && !skipNativeShoot()) {
        const n = await nativeShoot();
        if (n > 0) return;
      }
      // v4.3.1：原生相机预览插件可用 → 页面内实时预览 + 点快门拍照（方案①，优先于系统相机）
      // v4.7：每一次快门都要「出片」——预览未开 → 开启后等出图自动补一拍；
      // 抓帧失败自动重试一次；都失败才降级系统相机（系统相机自带「确认」页，能不进就不进）
      if (hasCamPreview) {
        if (!camPreviewOn) {
          if (await startCamPreview()) {
            await new Promise((r) => setTimeout(r, 1200)); // 等预览出图/对焦稳定（原生相机冷启动，稍长更稳）
            if (await captureFromPreview()) return;
          }
          // 预览启动失败 → 继续走下方原生/系统相机兜底
        } else {
          if (await captureFromPreview()) return;
          await new Promise((r) => setTimeout(r, 300));
          if (await captureFromPreview()) return; // 重试一次再降级
        }
      }
      if (hasNativeCamera()) {
        toast('打开相机…');
        const ok = await nativeCameraCapture();
        if (ok) return;
        if (userCancelledCam()) return; // 用户主动按了返回，别再弹一次选择器
        // 插件不可用 / 异常 → 回退到系统相机文件选择器
      } else {
        toast('调用系统相机…');
      }
      ensureFileInput().click();
      return;
    }
    if (!cam.videoWidth) { toast('摄像头未就绪，请稍候'); return; }
    // 硬锁定：没有有效追溯码禁止拍照（杜绝「未识别/null」照片）。
    // 没码时点快门 = 触发一次识别；识别到码后再次点快门才真正拍摄。
    if (!validQr()) {
      toast('请先识别追溯码：点「识别追溯码」或开启「自动识别」');
      if (cam.videoWidth) snapScan();
      return;
    }
    // —— 即时抓拍 + 水印（追溯码此时必已存在）——
    const canvas = document.createElement('canvas');
    canvas.width = cam.videoWidth; canvas.height = cam.videoHeight;
    canvas.getContext('2d').drawImage(cam, 0, 0);
    await addCapturedPhoto(canvas);
  }

  // v4.4：连拍（消除「拍一张→确认→再拍」的繁琐）。优先走相机预览插件（capture 即时无确认弹窗），
  // 否则用网页相机实时流连抓 N 张。预览/实时流路径下根本不出现系统相机的「确认」界面。
  async function burstCapture(n) {
    n = n || 3;
    // v4.8：App 内连拍直接进原生拍照页（可连续拍任意张，拍完点「完成」即全部入库）
    if (state.noWebcam && hasNativeShoot() && !skipNativeShoot()) { await nativeShoot(); return; }
    if (state.noWebcam && !camPreviewOn) {
      if (hasCamPreview) {
        const ok = await startCamPreview();
        if (!ok) { toast('请先开启实时预览，或点画面调系统相机'); return; }
        await new Promise((r) => setTimeout(r, 1000)); // 等原生预览出图，首帧不空拍
      } else {
        toast('当前环境不支持连拍：点画面调系统相机逐张拍即可'); return;
      }
    }
    toast('连拍 ' + n + ' 张…');
    for (let i = 0; i < n; i++) {
      let ok = false;
      try {
        if (hasCamPreview && camPreviewOn) ok = await captureFromPreview();
        else if (!state.noWebcam && cam.videoWidth) {
          const canvas = document.createElement('canvas');
          canvas.width = cam.videoWidth; canvas.height = cam.videoHeight;
          canvas.getContext('2d').drawImage(cam, 0, 0);
          await addCapturedPhoto(canvas); ok = true;
        }
      } catch (e) { /* 忽略单张失败，继续 */ }
      if (!ok) { toast('连拍中断：第 ' + (i + 1) + ' 张未成功'); break; }
      if (i < n - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 拍照后仍未识别：后台异步跑一次更重的多方向解码（不阻塞继续拍照），命中则回填芯片与记录。
  function backgroundRetryCode(p) {
    try {
      const full = grabFrame(1300, false);
      const id = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
      workerDecode(id, [0, 45, 90, 135, 180, 225, 270, 315]).then((text) => {
        if (text && !state.qr) {
          state.qr = text.trim();
          updateCodeChip();
          toast('已后台识别追溯码：' + state.qr);
          // 回填补全本张照片记录，并触发其实时上传（若有）
          if (p && p.qr === '未识别') {
            p.qr = state.qr;
            if (DB.available && p.dbId) DB.put({ id: p.dbId, qr: state.qr }).catch(() => {});
            if (state.realtime && !p.uploaded) uploadOne(p);
          }
        }
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  }

  // 在照片底部烧入文字水印：追溯码 / 拍摄者(班次) / 工位 / 拍摄时间 / 序号。
  // 直接画进 JPEG，与照片合为一体，归档后翻图即可溯源。
  // qr 可选：传入则用于本张水印；缺省回退 state.qr（兼容旧调用）。
  function drawWatermark(canvas, seq, qr) {
    const qrText = (qr != null) ? qr : (state.qr || '未识别');
    try {
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const ts =
        now.getFullYear() + '.' + p2(now.getMonth() + 1) + '.' + p2(now.getDate()) +
        ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds());
      const lines = [
        '追溯码: ' + qrText,
        '拍摄者: ' + (state.photographer || '未知') + '（' + shiftOf(now) + '）',
        '工位: ' + (state.workstation || '—'),
        '时间: ' + ts,
        '第 ' + String(seq).padStart(3, '0') + ' 张',
      ];
      const fs = Math.max(10, Math.round(W * 0.010)); // 更轻量字号：约占图高 10%（v20 水印优化：比 v16 的 0.012 更小）
      const lh = Math.round(fs * 1.18);
      const padX = Math.round(fs * 0.45);
      const padY = Math.round(fs * 0.25);
      const blockH = lines.length * lh + padY;
      // 背景全透明（不画底色块）；不加粗、半透明白字(alpha 0.8) + 柔和阴影：低调不抢画面、亮暗背景都清晰
      ctx.font = fs + 'px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 0;
      ctx.strokeStyle = 'rgba(0,0,0,0)';
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; // 约 80% 透明
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.round(fs * 0.1);
      let y = H - blockH;
      for (const line of lines) {
        ctx.fillText(line, padX, y);
        y += lh;
      }
    } catch (e) { /* 水印绘制失败不影响照片本身 */ }
  }

  function updateCounter() {
    const n = state.photos.length;
    $('photoCount').textContent = n;
    const ct = $('countTarget'); if (ct) ct.textContent = TARGET;
    const pct = Math.min(1, n / TARGET);
    $('ringFg').style.strokeDashoffset = String(RING_LEN * (1 - pct));
    $('btnShoot').classList.toggle('done', n >= TARGET);
    const btn = $('btnUpload');
    btn.disabled = n === 0 || btn.classList.contains('busy');
    const pending = state.photos.filter((p) => !p.uploaded).length;
    $('uploadLabel').textContent = pending > 0 ? '上传(' + pending + ')' : (n > 0 ? '已传完' : '上传');
    updateRealtimeStatus();
  }

  // v4.9.5：这枚 chip 已移到顶栏「追溯码」正下方（左对齐 + 外框），
  // 内容为空时整块隐藏，避免留一个空框白占一行。
  function updateRealtimeStatus() {
    const el = $('rtStatus');
    if (!el) return;
    if (!state.realtime) { el.innerHTML = ''; el.hidden = true; return; }
    const total = state.photos.length;
    const done = state.photos.filter((p) => p.uploaded).length;
    const fail = state.photos.filter((p) => p.failed).length;
    let s = `实时上传中 · 已传 <b>${done}</b> / 共 ${total}`;
    if (fail) s += ` · <span style="color:var(--danger)">${fail} 张失败</span>`;
    el.innerHTML = s;
    el.hidden = false;
  }

  // ---------- 缩略条（可收起） ----------
  function collapseThumbs(collapsed) {
    $('thumbsWrap').classList.toggle('collapsed', collapsed);
    $('thumbsCaret').textContent = collapsed ? '▾' : '▴';
  }

  function renderThumbs(animateLast) {
    const box = $('thumbs');
    box.innerHTML = '';
    // 没照片时整个缩略区隐藏（含「0 张」开关），避免与「0/20」计数重复占屏
    $('thumbsWrap').classList.toggle('has', state.photos.length > 0);
    state.photos.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      let extra = '';
      if (p.uploading) extra = '<div class="spin"></div>';
      else if (p.uploaded) extra = '<div class="badge up">✓</div>';
      else if (p.failed) extra = '<div class="badge fail">!</div>';
      d.innerHTML = `<img src="${p.url}" alt=""><span class="idx">${p.seq || (i + 1)}</span>${extra}`;
      d.addEventListener('click', () => { if (p.failed) retryFailed(); else confirmDelete(i); });
      box.appendChild(d);
    });
    if (animateLast) {
      const last = box.lastElementChild;
      if (last) last.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
    }
    $('thumbsCount').textContent = state.photos.length;
    updateMiniShot(); // v4.9.8：同步右下角常驻小缩略图（所有照片变化路径都会走到这里）
    updateCounter();
    // 实时上传且有已传照片时，自动收起缩略条，避免占用画面
    if (state.realtime && state.photos.some((p) => p.uploaded)) collapseThumbs(true);
  }

  // ---------- v4.9.8：常驻小缩略图（画面右下角） ----------
  // 相机 App 的使用习惯：拍完一眼看到"刚才那张 + 拍了几张 + 传没传上"。
  // 数据源与缩略条同源（state.photos），任何增删/状态变化经 renderThumbs() 汇聚到这里。
  // 状态点：绿✓=全部已传 · 蓝=上传中 · 红!=有失败 · 橙=待上传；角标=本组张数。
  function updateMiniShot() {
    const box = $('miniShot'), img = $('miniShotImg'), n = $('miniShotN'), st = $('miniShotState');
    if (!box || !img) return; // 旧缓存 HTML 没这块，静默跳过
    if (state.photos.length === 0) { box.hidden = true; return; }
    const last = state.photos[state.photos.length - 1];
    if (!last.url) { box.hidden = true; return; }
    img.src = last.url;
    n.textContent = String(state.photos.length);
    const pending = state.photos.some((p) => !p.uploaded);
    const uploading = state.photos.some((p) => p.uploading);
    const failed = state.photos.some((p) => p.failed && !p.uploaded);
    st.className = 'ms-state';
    if (uploading) { st.textContent = '…'; st.classList.add('busy'); }
    else if (failed) { st.textContent = '!'; st.classList.add('err'); }
    else if (pending) { st.textContent = ''; }
    else { st.textContent = '✓'; st.classList.add('ok'); }
    box.hidden = false;
  }

  // 删除确认（大按钮，戴手套也好点）
  let pendingDeleteIndex = -1;
  function confirmDelete(i) {
    const p = state.photos[i];
    if (!p) return;
    pendingDeleteIndex = i;
    $('confirmTitle').textContent = '删除第 ' + (p.seq || (i + 1)) + ' 张？';
    $('confirmMsg').textContent = '删除后可在下方「撤销」恢复（4 秒内）。';
    showModal('confirmModal');
  }
  function doDelete(i) {
    const removed = state.photos.splice(i, 1)[0];
    if (!removed) return;
    if (removed.dbId) DB.del(removed.dbId).catch(() => {});
    renderThumbs();
    toast(`已删除第 ${(removed.seq) || (i + 1)} 张`, {
      label: '撤销',
      action: () => { state.photos.splice(i, 0, removed); renderThumbs(); },
      duration: 4000,
    });
    setTimeout(() => { if (!state.photos.includes(removed)) URL.revokeObjectURL(removed.url); }, 4200);
  }

  // ---------- 上传 ----------
  function uploadOne(p) {
    if (!p || p.uploaded || p.uploading) return;
    if (!validQr()) { toast('没有有效追溯码，无法上传'); return; }
    p.uploading = true;
    renderThumbs();
    const fd = new FormData();
    fd.append('qr', p.qr || state.qr);
    fd.append('photographer', p.photographer || state.photographer);
    fd.append('workstation', p.workstation || state.workstation || '');
    fd.append('metadata', JSON.stringify([{ capturedAt: p.capturedAt, seq: p.seq }]));
    fd.append('photos', p.blob, `p${p.seq}.jpg`);
    if (p.thumb) fd.append('thumbs', p.thumb, 't' + p.seq + '.jpg');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.onload = () => {
      p.uploading = false;
      let d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = null; }
      p.uploaded = !!(xhr.status >= 200 && xhr.status < 300 && d && d.ok);
      if (!p.uploaded) p.failed = true;
      // v4.9.7：以前这里是把整张原图「连 blob 一起」回写成 uploaded:true 存回本机库
      // —— 已上传的大图从此永久躺在手机里（换组时 clearPending 又只清未上传的，删不掉）。
      // 现在统一走 markUploaded：顺手删掉本机副本，手机里不再留已上传的照片。
      if (p.uploaded) markUploaded(p);
      renderThumbs();
      if (p.uploaded) { try { navigator.vibrate && navigator.vibrate(15); } catch (e) {} }
    };
    xhr.onerror = () => { p.uploading = false; p.failed = true; renderThumbs(); };
    xhr.send(fd);
  }

  function setUploadBusy(busy) {
    const btn = $('btnUpload');
    btn.classList.toggle('busy', busy);
    $('btnShoot').classList.toggle('disabled', busy);
    $('btnShoot').disabled = busy;
    updateCounter();
  }

  // 标记某张为已上传（内存 + IndexedDB 同步）
  function markUploaded(p) {
    p.uploaded = true; p.failed = false; p.uploading = false;
    // v4.9.7：上传成功即删掉本机 IndexedDB 里的整张原图副本。
    // 单张 1~2MB，一组十几张就是几十 MB 长期躺在本机 —— 照片已在 NAS 落库，本机再留一份毫无意义。
    // 界面缩略图走 p.url / p.thumb（仍在内存，观感完全不变），刷新后也不再把这些已传照片恢复回来。
    if (p.dbId) { const id = p.dbId; p.dbId = null; try { DB.del(id); } catch (e) {} }
    try { p.blob = null; } catch (e) {}
  }

  // 失败重试：把失败且未上传的项重新发起上传（网络恢复时自动调用，也可手动点）
  function retryFailed() {
    const f = state.photos.filter((p) => p.failed && !p.uploaded && !p.uploading);
    if (!f.length) return;
    f.forEach((p) => { p.failed = false; uploadOne(p); });
    toast(`正在重试 ${f.length} 张失败照片`);
  }

  // 后台批量上传（不跳页，Toast 提示结果）
  function uploadBatch() {
    if (!validQr()) { toast('没有有效追溯码，无法上传'); return; }
    const pending = state.photos.filter((p) => !p.uploaded && !p.uploading);
    if (pending.length === 0) { toast('没有待上传的照片'); return; }
    setUploadBusy(true);
    $('uploadLabel').textContent = '上传中…';
    const fd = new FormData();
    fd.append('qr', state.qr);
    fd.append('photographer', state.photographer);
    fd.append('workstation', state.workstation || '');
    fd.append('metadata', JSON.stringify(pending.map((p) => ({ capturedAt: p.capturedAt, seq: p.seq }))));
    pending.forEach((p) => {
      fd.append('photos', p.blob, `p${p.seq}.jpg`);
      if (p.thumb) fd.append('thumbs', p.thumb, 't' + p.seq + '.jpg');
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $('uploadLabel').textContent = '上传中 ' + Math.round((e.loaded / e.total) * 100) + '%';
    };
    xhr.onload = () => {
      setUploadBusy(false);
      let d = null; try { d = JSON.parse(xhr.responseText); } catch (e) { d = { ok: false, saved: [], error: '服务器返回异常' }; }
      const okSeqs = (d && d.saved) ? d.saved.map((s) => s.seq) : [];
      if (xhr.status >= 200 && xhr.status < 300 && d.ok) {
        pending.forEach((p) => markUploaded(p));
        renderThumbs();
        // v4.9.7：明确告知本机副本已释放、下一组怎么开（此前用户不知道照片还留在手机里）
        toast(`✅ 已上传 ${d.count} 张到飞牛NAS（本机副本已释放，点「更换追溯码」开下一组）`);
        try { navigator.vibrate && navigator.vibrate([40, 60, 40]); } catch (e) {}
      } else {
        // 服务端返回逐张结果：精确标记成功/失败，失败的可稍后重试（绝不静默丢弃）
        pending.forEach((p) => {
          if (okSeqs.indexOf(p.seq) >= 0) markUploaded(p);
          else p.failed = true;
        });
        renderThumbs();
        toast('部分/全部上传失败（' + (d && d.error || '未知错误') + '），点失败角标或「上传」可重试');
      }
    };
    xhr.onerror = () => {
      setUploadBusy(false);
      pending.forEach((p) => { p.failed = true; });
      renderThumbs();
      toast('网络错误，上传失败，可再点上传重试');
    };
    xhr.send(fd);
  }

  // ---------- 顶栏信息 ----------
  // v4.9.2：追溯码要求「不折行」且整码可见 → 按实际宽度自动降字号（最短到 8px），
  // 保证再长的码也能单行完整显示，不会出现「…」截断，也不会竖着折成两三行。
  function fitChipFont(el) {
    el.style.fontSize = '';
    if (!el.clientWidth) return; // 尚未布局（页面未显示）时不做测量，避免误判成极小字号
    const base = Math.round(parseFloat(getComputedStyle(el).fontSize) || 12);
    for (let s = base; s >= 8; s--) {
      el.style.fontSize = s + 'px';
      if (el.scrollWidth <= el.clientWidth) return;
    }
  }

  function updateCodeChip() {
    const el = $('codeChip');
    if (state.qr) {
      el.textContent = '追溯码：' + state.qr;
      el.title = '点击复制：' + state.qr;
      el.classList.remove('warn');
      // v4.8：按码长自适应字号，保证整条码完整可见（不再出现「…」截断）
      const n = String(state.qr).length;
      el.classList.toggle('long', n > 22 && n <= 34);
      el.classList.toggle('xlong', n > 34 && n <= 45);
      el.classList.toggle('xxlong', n > 45);
      fitChipFont(el);
    } else {
      el.textContent = '追溯码：未识别';
      el.title = '点击识别追溯码';
      el.style.fontSize = '';
      el.classList.remove('long', 'xlong', 'xxlong');
      el.classList.add('warn');
    }
    $('whoChip').textContent = '拍摄者：' + (state.photographer || '—');
    $('stationChip').textContent = '工位：' + (state.workstation || '—');
    // 快门锁：无有效追溯码时变灰提示，引导先识别
    const shootBtn = $('btnShoot');
    if (shootBtn) shootBtn.classList.toggle('locked', !validQr());
  }

  // ---------- 事件绑定 ----------
  function openWhoModal() {
    $('photographer').value = state.photographer;
    $('workstation').value = state.workstation;
    showModal('whoModal');
    setTimeout(() => $('photographer').focus(), 50);
  }
  function bind() {
    // 拍摄者
    $('photographer').addEventListener('input', (e) => {
      state.photographer = e.target.value.trim();
      localStorage.setItem('photographer', state.photographer);
      updateCodeChip();
    });
    $('btnWhoOk').addEventListener('click', () => {
      state.photographer = $('photographer').value.trim();
      localStorage.setItem('photographer', state.photographer);
      // 工位可选填写，不强制
      state.workstation = $('workstation').value.trim();
      localStorage.setItem('workstation', state.workstation);
      if (!state.photographer) { toast('请先填写拍摄者姓名'); return; }
      updateCodeChip();
      hideModal('whoModal');
    });
    $('whoChip').addEventListener('click', openWhoModal);
    $('stationChip').addEventListener('click', openWhoModal);

    // 顶栏开关
    $('btnRealtime').addEventListener('click', () => {
      state.realtime = !state.realtime;
      $('btnRealtime').setAttribute('aria-checked', state.realtime ? 'true' : 'false');
      updateRealtimeStatus();
      toast(state.realtime ? '已开启实时上传：每拍一张立即上传' : '已关闭实时上传');
    });
    // v4.9.7：水印开关整体移到启动区的「事件委托」（见 bindAllAutoScan）。
    // 真机反馈「关闭水印按钮还是无提示」——留在 bind() 里一旦前面任一个绑定抛异常，
    // 后面整段都会失效（按钮静默无反应）。委托层只要页面活着就一定响应，
    // 并且关闭水印改为先弹确认层（与「自动识别」一致），不再只是一闪而过的 toast。
    // v4.4：换追溯码后自动接续「识别」，把「换码 + 识别」两步合成一步，点一次即开相机扫新码
    function afterChangeCode() {
      restartScan();
      // 由 snapScan 内部按环境分流（系统相机拍条码 / 原生引擎 / 网页流水线），无需用户再点一次「识别」
      setTimeout(() => { try { snapScan(); } catch (e) {} }, 250);
    }
    // 换追溯码：顶部与竖屏底部两处入口共用
    const onNewQrClick = () => {
      stopScan(); // 立即暂停自动识别循环，把主线程让给本次点击，按钮响应即时
      const unsaved = state.photos.filter((p) => !p.uploaded).length;
      if (unsaved > 0) {
        $('confirmTitle').textContent = '放弃本组？';
        $('confirmMsg').textContent = `还有 ${unsaved} 张未上传，确定放弃并换追溯码？`;
        pendingDeleteIndex = -2; // 特殊标记：确认后执行 afterChangeCode
        showModal('confirmModal');
      } else {
        afterChangeCode();
      }
    };
    $('btnNewQr').addEventListener('click', onNewQrClick);
    const btnNewQr2 = document.getElementById('btnNewQr2');
    if (btnNewQr2) btnNewQr2.addEventListener('click', onNewQrClick);

    // 追溯码点击：未识别时点一下即显式识别（拍照即识别的手动入口）；已识别则复制
    $('codeChip').addEventListener('click', async () => {
      if (!state.qr) { snapScan(); return; }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(state.qr);
        else { const ta = document.createElement('textarea'); ta.value = state.qr; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
        toast('追溯码已复制');
      } catch (e) { toast('复制失败，可长按追溯码手动复制'); }
    });

    // 底部操作栏
    $('btnScan').addEventListener('click', snapScan);
    $('btnShoot').addEventListener('click', shoot);
    $('btnBurst').addEventListener('click', () => burstCapture(3));
    $('btnUpload').addEventListener('click', uploadBatch);
    $('btnTorch').addEventListener('click', toggleTorch);

    // 识别模式内按钮
    $('btnOcr').addEventListener('click', onOcrScan);
    $('btnZoomIn').addEventListener('click', () => setZoom(1.3));
    $('btnZoomOut').addEventListener('click', () => setZoom(1 / 1.3));
    $('btnManual').addEventListener('click', () => { $('manualInput').value = ''; showModal('manualModal'); setTimeout(() => $('manualInput').focus(), 50); });
    // 定格识别弹层按钮
    // v4.9.1：三个按钮都先 cancelFreeze() —— 先掐断还在跑的解码链，再做各自的动作。
    // 顺序很关键：以前是先 hideFreeze 再慢悠悠触发新流程，而旧解码仍在后台占满主线程，
    // 于是界面看着关了、实际还在转圈，连点几下才停。现在点了就是立刻停。
    $('btnFreezeRetry').addEventListener('click', () => { cancelFreeze(); hideFreeze(); setTimeout(() => snapScan(), 60); });
    $('btnFreezeManual').addEventListener('click', () => { cancelFreeze(); hideFreeze(); $('manualInput').value = ''; showModal('manualModal'); setTimeout(() => $('manualInput').focus(), 50); });
    $('btnFreezeClose').addEventListener('click', () => { cancelFreeze(); hideFreeze(); });
    function manualSubmit() {
      const v = $('manualInput').value.trim();
      if (!v) { toast('请输入条码下方的数字/字母'); return; }
      hideModal('manualModal');
      onBarcode(v);
    }
    $('btnManualOk').addEventListener('click', manualSubmit);
    $('manualInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualSubmit(); });
    $('btnManualCancel').addEventListener('click', () => hideModal('manualModal'));

    // 缩略条收起
    $('thumbsToggle').addEventListener('click', () => {
      const collapsed = $('thumbsWrap').classList.toggle('collapsed');
      $('thumbsCaret').textContent = collapsed ? '▾' : '▴';
    });

    // 通用确认弹层
    $('confirmCancel').addEventListener('click', () => { hideModal('confirmModal'); pendingDeleteIndex = -1; });
    $('confirmOk').addEventListener('click', () => {
      hideModal('confirmModal');
      if (pendingDeleteIndex === -2) { afterChangeCode(); }
      else if (pendingDeleteIndex >= 0) { doDelete(pendingDeleteIndex); }
      pendingDeleteIndex = -1;
    });

    // v4.9.8：点右下角常驻小缩略图 → 展开底部缩略条看全部（收起态时展开；已展开时无感）
    const msBtn = $('miniShot');
    if (msBtn) {
      msBtn.addEventListener('click', () => {
        collapseThumbs(false);
        const strip = $('thumbs');
        if (strip && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = strip.scrollWidth;
      });
    }

    // 音量键快门
    document.addEventListener('keydown', (e) => {
      if (anyModalOpen()) return;
      if (e.key === 'AudioVolumeDown' || e.key === 'AudioVolumeUp') { e.preventDefault(); shoot(); }
    });

    // 离开页面前提醒未上传
    window.addEventListener('beforeunload', (e) => {
      if (state.photos.some((p) => !p.uploaded)) { e.preventDefault(); e.returnValue = ''; }
    });

    // v4.3.1：离开/切后台时关闭原生相机预览层，避免相机被长期占用
    window.addEventListener('pagehide', stopCamPreview);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamPreview(); });

    // 切后台停止自动扫描，省电
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.scanning) stopScan();
    });
  }

  // ---------- 启动前恢复：跨刷新/关页保住未上传照片 ----------
  async function restoreFromDB() {
    if (!DB.available) return;
    try {
      const recs = await DB.getAll();
      const need = recs.filter((r) => !r.uploaded && r.blob);
      if (!need.length) return;
      need.forEach((r) => {
        const p = { blob: r.blob, url: URL.createObjectURL(r.blob), thumb: r.thumb || null, capturedAt: r.capturedAt, seq: r.seq, qr: r.qr, photographer: r.photographer, workstation: r.workstation, uploaded: r.uploaded || false, uploading: false, failed: false, dbId: r.id };
        state.photos.push(p);
        if (r.seq > state.seq) state.seq = r.seq;
      });
      renderThumbs();
      toast(`已恢复 ${need.length} 张未上传照片，可继续上传`);
      if (state.realtime) state.photos.forEach((p) => { if (!p.uploaded) uploadOne(p); });
    } catch (e) { /* 恢复失败不影响正常使用 */ }
  }

  // ---------- 启动 ----------
  // v4.9.7：上次是否在「处理照片」途中被系统杀掉（老机型闪退）→ 自动降一档出图尺寸。
  // 这是纯自救逻辑：不改任何既有行为，只在真的崩过之后才降档，并明确告知用户降到多少。
  (function detectLastCrash() {
    try {
      if (localStorage.getItem(BUSY_KEY) !== '1') return;
      localStorage.removeItem(BUSY_KEY);
      const n = Math.min(2, crashLevel() + 1);
      localStorage.setItem(CRASH_KEY, String(n));
      const edge = photoMaxEdge();
      setTimeout(() => {
        try { toast(`上次拍照时被系统中断，已自动把照片尺寸降到 ${edge}px（更省内存，连拍更稳）`); } catch (e) {}
      }, 900);
    } catch (e) {}
  })();

  // v4.9.3：自动识别弹窗改为「document 捕获层事件委托」，独立于 bind() 存在。
  // 真机上若 bind() 中途抛异常（某个绑定失败会让后面的绑定全部失效），开关就会"点了没反应"；
  // 委托只要页面活着就一定响应，并且任何异常都被 catch 住，不允许拖垮页面。
  (function bindAllAutoScan() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      try {
        if (t.closest('#btnAutoScan')) { toggleAutoScan(); return; }
        if (t.closest('#autoScanCancel')) { hideModal('autoScanModal'); setAutoScan(false, true); return; }
        if (t.closest('#autoScanOk')) { hideModal('autoScanModal'); setAutoScan(true); return; }
        // v4.9.7：水印开关（关闭前先弹层确认；开启即时生效并 toast）
        if (t.closest('#btnWatermark')) {
          const next = !state.watermark;
          if (next) { // 开启：直接生效
            state.watermark = true;
            localStorage.setItem('watermark', '1');
            $('btnWatermark').setAttribute('aria-checked', 'true');
            toast('已开启水印：照片底部显示追溯码/拍摄者/工位/时间');
            return;
          }
          // 关闭：先要拍摄者姓名（责任可追溯），再弹确认层
          if (!state.photographer) {
            toast('关闭水印需先填写拍摄者姓名');
            openWhoModal();
            $('btnWatermark').setAttribute('aria-checked', 'true');
            return;
          }
          showModal('watermarkModal');
          return;
        }
        if (t.closest('#wmCancel')) { hideModal('watermarkModal'); toast('已保持开启水印'); return; }
        if (t.closest('#wmOk')) {
          hideModal('watermarkModal');
          state.watermark = false;
          localStorage.setItem('watermark', '0');
          $('btnWatermark').setAttribute('aria-checked', 'false');
          toast('已关闭水印：照片不再烧入追溯码/拍摄者/工位/时间');
          return;
        }
        if (t.closest('#lastShot')) hideLastShot(); // v4.9.4：点击回显层立即关闭
      } catch (err) { /* 保险丝：不外溢 */ }
    }, true);
  })();
  bind();
  loadConfig();
  restoreFromDB();
  // PWA：注册 Service Worker（仅用于「可安装到主屏幕」，不缓存页面/脚本）
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  updateCodeChip();
  // v4.8：底栏高度「实测」写入 --bar-h，取代媒体查询的估值。
  // 小屏机型反馈「上传页溢出、找不到拍照按钮」多源于估值与实际底栏高度不符，浮层互相挤压；
  // 实测值随窗口/键盘/拍照后布局变化动态刷新，任何机型都能保证快门贴底可见、浮层不重叠。
  (function () {
    function measureBar() {
      try {
        const ab = document.querySelector('.capture-bar');
        if (!ab) return;
        const h = Math.round(ab.getBoundingClientRect().height);
        if (h > 40 && h < window.innerHeight * 0.5) {
          document.documentElement.style.setProperty('--bar-h', h + 'px');
        }
      } catch (e) {}
    }
    measureBar();
    setTimeout(measureBar, 400);
    window.addEventListener('resize', measureBar);
    window.addEventListener('orientationchange', () => setTimeout(measureBar, 350));
    if (window.ResizeObserver && document.querySelector('.capture-bar')) {
      try { new ResizeObserver(measureBar).observe(document.querySelector('.capture-bar')); } catch (e) {}
    }
  })();
  // v4.9.2：转屏/窗口尺寸变化后重新量一次追溯码字号，保证换行后仍是「单行不截断」
  (function () {
    const refit = () => { try { if (state.qr) fitChipFont($('codeChip')); } catch (e) {} };
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', () => setTimeout(refit, 400));
  })();
  // v28：支持从任意原生扫码 App 经 URL 传入追溯码（无开发机也能用手机原生引擎扫码）
  // 配置扫码 App 的「扫描后打开网址」为 https://你的NAS:3000/?code=%s 即可，%s 会被替换为扫到的内容
  try {
    const _p = new URLSearchParams(location.search);
    const _code = (_p.get('code') || _p.get('qr') || '').trim();
    if (_code) {
      state.qr = _code;
      try { localStorage.setItem('pu_last_qr', _code); } catch (e) {} // v4.8：持久化，防极端机型时序丢码
      updateCodeChip();
      toast('追溯码：' + _code);
      // v4.8 兜底：某些新机（Xiaomi 17 Pro Max 等）首帧 DOM 尚未就绪时更新会被后续渲染覆盖，
      // 两个时点各刷一次，确保追溯码一定落到 chip 上
      setTimeout(() => { if (state.qr === _code) updateCodeChip(); }, 300);
      setTimeout(() => { if (!state.qr) { state.qr = _code; } updateCodeChip(); }, 1500);
    } else {
      // v4.8：无 code 参数但本地存过最近一次码（如页面被刷新/后退重载），补回来避免「识别了却空着」
      try {
        const last = localStorage.getItem('pu_last_qr');
        if (last && !state.qr) { state.qr = last; updateCodeChip(); }
      } catch (e) {}
    }
  } catch (e) {}
  $('photographer').value = state.photographer;
  $('btnWatermark').setAttribute('aria-checked', state.watermark ? 'true' : 'false');
  // v4.3.1：原生壳内若有相机预览插件，进入上传页即开启页面内实时预览（方案①）；
  // v4.7.1：若壳内竟无预览插件（桥接未注入/插件未打包），给出一次性诊断提示，便于真机定位
  if (inShell()) {
    if (hasCamPreview) {
      startCamPreview().then((ok) => { if (ok) toast('实时预览已开启：对准后点快门拍照'); }).catch(() => {});
    } else if (!hasNativeShoot()) {
      // v4.8：两种原生拍照通道都没有（旧版 APK）时才提示；有原生拍照页则无需打扰
      toast('未检测到原生拍照组件：拍照将使用系统相机');
    }
  }
  // v4.9.6：双击右上角版本标签 = 手动切换「是否使用原生拍照页」。
  // 老机型点快门闪退时可双击一次切到系统相机通道；换机/修好后双击一次切回来。
  // （放在这里而不是 URL 参数，是因为 App 内无法改地址栏，且避免误判后只能靠清缓存恢复）
  try {
    const vt = document.querySelector('.ver-tag');
    if (vt) {
      vt.addEventListener('dblclick', function () {
        try {
          const on = localStorage.getItem(NS_SKIP_KEY) === '1';
          if (on) { localStorage.removeItem(NS_SKIP_KEY); localStorage.removeItem(NS_FAIL_KEY); }
          else localStorage.setItem(NS_SKIP_KEY, '1');
          toast(on ? '已恢复：拍照使用原生拍照页（可连拍、免按确定）'
                   : '已切换：拍照改用系统相机（原生拍照页已跳过）');
        } catch (e) {}
      });
    }
  } catch (e) {}
  startCamera().catch((e) => {
    const tip = (e && e.name === 'NotAllowedError') ? '摄像头权限被拒绝，请在浏览器地址栏允许后重试'
      : (e && e.name === 'NotFoundError') ? '未检测到摄像头'
      : (e && e.name === 'TypeError') ? '无法访问摄像头：' + (e && e.message)
      : (e && e.message) || '无法访问摄像头';
    toast(tip);
  });
  if (!state.photographer) openWhoModal();
})();
