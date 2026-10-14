/*
 * MainActivity —— WebView 壳 + 本地 Node 服务引导
 *
 * 启动链路：
 *   1. 显示启动页（解压资产约 1-3 秒）
 *   2. NodeRuntime.prepare() 解压 assets/app -> files/app
 *   3. NodeRuntime.startServer() 进程内启动 Node（127.0.0.1:8789）
 *   4. 轮询端口就绪后 WebView 加载 http://127.0.0.1:8789/
 */
package com.estate.admin;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;

public class MainActivity extends Activity {

    private static final int PORT = 8789;
    private static final int FILE_CHOOSE_REQ = 9001;
    private static final long BOOT_TIMEOUT_MS = 90_000;

    private WebView webView;
    private View splash;
    private TextView splashText;
    private ProgressBar splashBar;

    private ValueCallback<Uri[]> filePathCallback;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        splash = findViewById(R.id.splash);
        splashText = findViewById(R.id.splash_text);
        splashBar = findViewById(R.id.splash_bar);
        webView = findViewById(R.id.webview);
        setupWebView();

        new Thread(this::boot).start();
    }

    private void boot() {
        try {
            setSplash("正在初始化本地服务…");
            NodeRuntime.prepare(this);
            setSplash("正在启动数据服务…");
            NodeRuntime.startServer(this);

            long deadline = System.currentTimeMillis() + BOOT_TIMEOUT_MS;
            while (System.currentTimeMillis() < deadline) {
                if (portOpen()) {
                    ui.post(this::enterApp);
                    return;
                }
                Thread.sleep(400);
            }
            ui.post(() -> showError("本地服务启动超时，请关闭应用后重试"));
        } catch (Exception e) {
            ui.post(() -> showError("启动失败：" + e.getMessage()));
        }
    }

    private void enterApp() {
        splash.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl("http://127.0.0.1:" + PORT + "/");
    }

    private void showError(String msg) {
        splashBar.setVisibility(View.GONE);
        splashText.setText(msg + "\n\n点击此处重试");
        splash.setOnClickListener(v -> {
            splashText.setText("正在重新启动…");
            splashBar.setVisibility(View.VISIBLE);
            new Thread(() -> {
                try {
                    NodeRuntime.prepare(MainActivity.this);
                    NodeRuntime.startServer(MainActivity.this);
                    long deadline = System.currentTimeMillis() + BOOT_TIMEOUT_MS;
                    while (System.currentTimeMillis() < deadline) {
                        if (portOpen()) { ui.post(MainActivity.this::enterApp); return; }
                        Thread.sleep(400);
                    }
                    ui.post(() -> showError("本地服务启动超时"));
                } catch (Exception e) {
                    ui.post(() -> showError("启动失败：" + e.getMessage()));
                }
            }).start();
        });
    }

    private void setSplash(String text) {
        ui.post(() -> splashText.setText(text));
    }

    private boolean portOpen() {
        try (Socket s = new Socket("127.0.0.1", PORT)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ---------------- WebView ---------------- */

    private void setupWebView() {
        // 调试版开启 WebView 远程检查（Chrome DevTools / CDP 可驱动真机 WebView 排查问题）
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100); // 忽略系统字体缩放，避免布局错位

        /* 缩放：允许双指捏合缩放，并按视口宽度整体适配（wide viewport + overview），
           否则小屏上页面按固定 CSS 宽度渲染，横向溢出且无法缩小看全貌 */
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false); // 不显示放大镜悬浮按钮，只保留双指手势
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        /* 用标准移动浏览器 UA（去掉 "; wv" WebView 标记）：
           腾讯地图 JS API(gljs) 等 SDK 对 WebView UA 会走特殊分支，导致地图不渲染 */
        s.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Pixel 6) "
                + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");

        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // 地图 SDK 等外部资源允许加载，但导航一律留在站内
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost()) || "localhost".equals(u.getHost())) return false;
                return false; // 不拦截：SDK 子资源与外链均由 WebView 自行处理
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (("http://127.0.0.1:" + PORT + "/").equals(url)) {
                    webView.setVisibility(View.VISIBLE);
                    splash.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode,
                                        String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith("http://127.0.0.1")) {
                    showError("页面加载失败：" + description);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                // 前端 console 转到 logcat，便于在真机上定位地图/脚本问题
                if (cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e("estate-web", cm.message() + " @ " + cm.sourceId() + ":" + cm.lineNumber());
                }
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 图片上传：调用系统文件选择器（无需存储权限）
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                boolean multiple = params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择图片"), FILE_CHOOSE_REQ);
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSE_REQ) return;
        if (filePathCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            Uri single = data.getData();
            if (single != null) {
                results = new Uri[]{single};
            } else if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                results = new Uri[Math.min(n, 3)]; // 每条房产最多 3 张
                for (int i = 0; i < results.length; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            }
        }
        // 把 content:// 读成字节再回传，避免 WebView 无权限读原始 URI
        if (results != null && results.length > 0) {
            results = copyToCache(results);
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    /** 复制到缓存目录，返回 file:// URI（部分机型 WebView 直接读 content:// 上传会 403） */
    private Uri[] copyToCache(Uri[] uris) {
        Uri[] out = new Uri[uris.length];
        for (int i = 0; i < uris.length; i++) {
            try {
                String name = "upload_" + System.currentTimeMillis() + "_" + i + ".jpg";
                File f = new File(getCacheDir(), name);
                try (InputStream in = getContentResolver().openInputStream(uris[i]);
                     OutputStream os = new java.io.FileOutputStream(f)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
                }
                out[i] = Uri.fromFile(f);
            } catch (Exception e) {
                out[i] = uris[i]; // 失败则退回原始 URI
            }
        }
        return out;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
