/*
 * NodeRuntime —— 在 Android 应用进程内运行 Node.js 后端服务
 *
 * 资产布局（打包时由 tools/build-android.js 生成）：
 *   assets/app/server/    后端全部源码（零第三方依赖，纯 Node 内置模块）
 *   assets/app/web/       单文件前端（tools/build.js 产物 index.html）
 *   assets/app/data/      种子数据 db.json（首次安装时落盘）
 *
 * 运行期：
 *   首次启动把 assets/app 拷到 files/app，之后进程内启动
 *   node server/server.js，监听 127.0.0.1:8787，WebView 直接访问。
 *   升级安装时只覆盖 server/ 与 web/，保留 data/（用户数据不丢）。
 */
package com.estate.admin;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.system.Os;
import android.system.ErrnoException;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class NodeRuntime {

    private static final String LOG_TAG = "estate-node";
    private static final String PREFS = "EstateNodePrefs";
    private static final String KEY_APK_UPDATE = "apkLastUpdateTime";
    private static final String ASSET_ROOT = "app";       // assets/app
    private static final String SEED_DIR = "data";        // 升级时保留

    static {
        System.loadLibrary("node");
        System.loadLibrary("estate-node-jni");
    }

    /** JNI 入口，见 jni/node-jni.cpp；阻塞直到 Node 退出（静态：供后台线程直接调用） */
    public static native int startNodeWithArguments(String[] arguments, String nodePath);

    private static String filesDir;
    private static volatile boolean started = false;

    /** 应用私有目录（Node 的工作根目录，含 server/ web/ data/） */
    public static String appRoot(Context ctx) {
        return new File(ctx.getFilesDir(), ASSET_ROOT).getAbsolutePath();
    }

    /**
     * 首次启动（或 APK 更新后）把 assets 里的 server/web 解压到 files/app。
     * data/ 只在不存在时拷贝，保护用户已录入的数据。
     */
    public static synchronized void prepare(Context ctx) throws IOException {
        filesDir = ctx.getFilesDir().getAbsolutePath();

        // Node 的 os.tmpdir() 走 TMPDIR，指向应用缓存目录
        try {
            Os.setenv("TMPDIR", ctx.getCacheDir().getAbsolutePath(), true);
        } catch (ErrnoException e) {
            Log.w(LOG_TAG, "TMPDIR 设置失败: " + e);
        }

        File appDir = new File(filesDir, ASSET_ROOT);
        boolean fresh = !new File(appDir, "server/server.js").exists();
        if (!fresh && !apkUpdated(ctx)) {
            return; // 已初始化且 APK 未更新
        }

        Log.i(LOG_TAG, "解压 Node 资产到 " + appDir.getAbsolutePath());

        // 首选构建时生成的清单（file.list/dir.list）：AssetManager.list() 在部分
        // 机型与大资产树下会返回空（nodejs-mobile 官方同样改用清单拷贝）
        List<String> files = readAssetLines(ctx, ASSET_ROOT + "/file.list");
        if (!files.isEmpty()) {
            for (String d : readAssetLines(ctx, ASSET_ROOT + "/dir.list")) {
                new File(appDir, d).mkdirs();
            }
            for (String f : files) {
                String top = f.contains("/") ? f.substring(0, f.indexOf('/')) : f;
                // data/ 目录可能已由 dir.list 建出（空目录），必须查种子文件本身是否在
                if (SEED_DIR.equals(top) && new File(appDir, SEED_DIR + "/db.json").exists()) {
                    continue; // 用户数据已存在，跳过种子
                }
                copyAssetFile(ctx, ASSET_ROOT + "/" + f, new File(appDir, f));
            }
        } else {
            // 回退：枚举拷贝
            copyAssetDir(ctx, ASSET_ROOT + "/server", new File(appDir, "server"));
            copyAssetDir(ctx, ASSET_ROOT + "/web", new File(appDir, "web"));
            File dataDir = new File(appDir, SEED_DIR);
            if (!dataDir.exists()) {
                copyAssetDir(ctx, ASSET_ROOT + "/data", dataDir);
            }
        }
        saveApkUpdateTime(ctx);
        Log.i(LOG_TAG, "Node 资产就绪");
    }

    /** 在子线程启动 Node 后端（阻塞调用，勿在主线程执行） */
    public static void startServer(Context ctx) {
        if (started) return;
        started = true;
        final String script = appRoot(ctx) + "/server/server.js";
        final String nodePath = appRoot(ctx) + "/server";
        new Thread(() -> {
            int code = startNodeWithArguments(new String[]{"node", script}, nodePath);
            Log.e(LOG_TAG, "Node 进程退出 code=" + code);
            started = false;
        }, "node-server").start();
    }

    /* ---------------- assets 拷贝 ---------------- */

    /** 读取构建时生成的清单文件（每行一条相对路径）；不存在时返回空列表 */
    private static List<String> readAssetLines(Context ctx, String assetPath) {
        List<String> lines = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(ctx.getAssets().open(assetPath), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (!line.isEmpty()) lines.add(line);
            }
        } catch (IOException e) {
            Log.d(LOG_TAG, "无清单文件 " + assetPath + "，改用枚举拷贝");
        }
        return lines;
    }

    private static void copyAssetDir(Context ctx, String assetPath, File dest) throws IOException {
        String[] children = ctx.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFile(ctx, assetPath, dest);
            return;
        }
        if (!dest.exists() && !dest.mkdirs()) {
            throw new IOException("无法创建目录: " + dest);
        }
        for (String child : children) {
            copyAssetDir(ctx, assetPath + "/" + child, new File(dest, child));
        }
    }

    private static void copyAssetFile(Context ctx, String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录: " + parent);
        }
        try (InputStream in = ctx.getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        }
    }

    /* ---------------- APK 更新检测 ---------------- */

    private static boolean apkUpdated(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long saved = prefs.getLong(KEY_APK_UPDATE, 0);
        long current = 0;
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            current = pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        return current != saved;
    }

    private static void saveApkUpdateTime(Context ctx) {
        long current = 0;
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            current = pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        prefs(ctx).edit().putLong(KEY_APK_UPDATE, current).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
