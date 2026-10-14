/*
 * estate-node-jni —— Node 运行时 JNI 桥接层
 *
 * 职责：把 Java 层的 startNodeWithArguments() 转成 node::Start(argc, argv)，
 * 让 Node 以「进程内库」的方式跑在 Android 应用进程里（nodejs-mobile 方案，
 * libnode.so 只提供 .so，没有可执行文件，必须进程内加载）。
 *
 * 与 nodejs-mobile-cordova 官方封装的差异：砍掉了 JS<->Java 消息通道
 * （本应用的通信全部走 HTTP/WebView，不需要桥接消息），保留 stdout/stderr
 * 重定向到 logcat 便于排错。
 */
#include <jni.h>
#include <string.h>
#include <stdlib.h>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

#define LOG_TAG "estate-node"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

/* ---------------- stdout / stderr -> logcat ---------------- */

static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;

static void redirect_pipe(int pipe, int log_level) {
    char buf[2048];
    ssize_t n;
    while ((n = read(pipe, buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(log_level, LOG_TAG, buf);
    }
}

static void *thread_stdout_func(void *) {
    redirect_pipe(pipe_stdout[0], ANDROID_LOG_INFO);
    return nullptr;
}

static void *thread_stderr_func(void *) {
    redirect_pipe(pipe_stderr[0], ANDROID_LOG_ERROR);
    return nullptr;
}

static int start_redirecting_stdout_stderr() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    if (pipe(pipe_stdout) != 0) return -1;
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(pipe_stderr) != 0) return -1;
    dup2(pipe_stderr[1], STDERR_FILENO);

    if (pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr) != 0) return -1;
    pthread_detach(thread_stdout);
    if (pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr) != 0) return -1;
    pthread_detach(thread_stderr);
    return 0;
}

/* ---------------- JNI 入口 ---------------- */

extern "C" JNIEXPORT jint JNICALL
Java_com_estate_admin_NodeRuntime_startNodeWithArguments(
        JNIEnv *env, jclass /* clazz */, jobjectArray arguments, jstring nodePath) {

    if (nodePath != nullptr) {
        const char *p = env->GetStringUTFChars(nodePath, nullptr);
        setenv("NODE_PATH", p, 1);
        env->ReleaseStringUTFChars(nodePath, p);
    }

    const jsize argc = env->GetArrayLength(arguments);

    // libuv 要求 argv 位于连续内存，先量出总字节数
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }

    char *buffer = (char *) calloc(total + 1, 1);
    char **argv = (char **) calloc((size_t) argc + 1, sizeof(char *));
    if (buffer == nullptr || argv == nullptr) {
        LOGE("argv 内存分配失败");
        free(buffer); free(argv);
        return (jint) -1;
    }

    size_t pos = 0;
    for (jsize i = 0; i < argc; i++) {
        jstring s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(c);
        memcpy(buffer + pos, c, len);
        buffer[pos + len] = '\0';
        argv[i] = buffer + pos;
        pos += len + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    argv[argc] = nullptr;

    if (start_redirecting_stdout_stderr() != 0) {
        LOGE("stdout/stderr 重定向到 logcat 失败（不影响运行）");
    }

    LOGI("node::Start(argc=%d) 启动，脚本：%s", (int) argc, argc > 1 ? argv[1] : "(未知)");
    const int exit_code = node::Start((int) argc, argv);
    LOGI("node::Start 返回 exit=%d", exit_code);

    free(buffer);
    free(argv);
    return (jint) exit_code;
}
