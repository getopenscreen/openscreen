#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <libavformat/avformat.h>

/* Compatibility shim for libva < 2.22 (e.g. Ubuntu 24.04 LTS with libva 2.20).
 * The vendored FFmpeg 8.1 build links libva via implib-gen and resolves
 * vaMapBuffer2 at runtime via dlsym(). On libva < 2.22, vaMapBuffer2 is absent
 * and the implib trampoline aborts the process. When dlsym(handle, "vaMapBuffer2")
 * returns NULL on a handle that exports vaMapBuffer, forward vaMapBuffer2 to
 * vaMapBuffer(dpy, buf_id, pbuf). */
typedef int VAStatus;
typedef void *VADisplay;
typedef unsigned int VABufferID;

#ifndef VA_STATUS_ERROR_UNKNOWN
#define VA_STATUS_ERROR_UNKNOWN 0xFFFFFFFF
#endif

typedef void *(*dlsym_fn)(void *, const char *);
typedef VAStatus (*vaMapBuffer_fn)(VADisplay, VABufferID, void **);

/* Both pointers are read and written from any thread that calls dlsym or
 * vaMapBuffer2, so every access is atomic. Two threads racing on the first
 * call resolve the same value; the atomics only make that race defined. */
static dlsym_fn real_dlsym_fn = NULL;
static vaMapBuffer_fn real_vaMapBuffer_fn = NULL;

#if defined(__aarch64__)
#define OSC_DLSYM_GLIBC_VER "GLIBC_2.17"
#else
#define OSC_DLSYM_GLIBC_VER "GLIBC_2.2.5"
#endif

/**
 * Resolves the underlying glibc `dlsym` implementation using the architecture's
 * base symbol version (`GLIBC_2.17` on aarch64, `GLIBC_2.2.5` on x86_64) with a
 * `GLIBC_2.34` fallback so `real_dlsym_fn` is never left NULL when available.
 */
static dlsym_fn resolve_real_dlsym(void)
{
    dlsym_fn fn = __atomic_load_n(&real_dlsym_fn, __ATOMIC_ACQUIRE);
    if (!fn) {
        fn = (dlsym_fn)dlvsym(RTLD_NEXT, "dlsym", OSC_DLSYM_GLIBC_VER);
        if (!fn) {
            fn = (dlsym_fn)dlvsym(RTLD_DEFAULT, "dlsym", OSC_DLSYM_GLIBC_VER);
        }
        if (!fn) {
            fn = (dlsym_fn)dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.34");
        }
        if (!fn) {
            fn = (dlsym_fn)dlvsym(RTLD_DEFAULT, "dlsym", "GLIBC_2.34");
        }
        if (fn) {
            __atomic_store_n(&real_dlsym_fn, fn, __ATOMIC_RELEASE);
        }
    }
    return fn;
}

/**
 * Compatibility entry point for `vaMapBuffer2` (added in libva 2.22) that
 * forwards buffer mapping calls to `vaMapBuffer` on older libva runtimes.
 */
VAStatus vaMapBuffer2(VADisplay dpy, VABufferID buf_id, void **pbuf, unsigned int flags)
{
    (void)flags;
    vaMapBuffer_fn map = __atomic_load_n(&real_vaMapBuffer_fn, __ATOMIC_ACQUIRE);
    if (!map) {
        dlsym_fn real = resolve_real_dlsym();
        void *h = dlopen("libva.so.2", RTLD_LAZY | RTLD_NOLOAD);
        if (!h) {
            h = dlopen("libva.so.2", RTLD_LAZY);
        }
        if (h && real) {
            map = (vaMapBuffer_fn)real(h, "vaMapBuffer");
            if (map) {
                __atomic_store_n(&real_vaMapBuffer_fn, map, __ATOMIC_RELEASE);
            }
        }
    }
    if (!map) {
        return VA_STATUS_ERROR_UNKNOWN;
    }
    return map(dpy, buf_id, pbuf);
}

/**
 * Interposes `dlsym` so lookups for `vaMapBuffer2` fall back to our
 * `vaMapBuffer`-backed shim when the loaded `libva.so.2` predates 2.22.
 *
 * NOTE: Overriding dlsym process-wide causes any internal RTLD_NEXT lookups
 * in loaded shared objects to resolve relative to this helper binary rather
 * than the caller library. In openscreen-pipewire-helper, this interposition
 * specifically handles libavutil's runtime resolution of vaMapBuffer2.
 */
void *dlsym(void *handle, const char *name)
{
    dlsym_fn real = resolve_real_dlsym();
    void *sym = real ? real(handle, name) : NULL;
    if (!sym && strcmp(name, "vaMapBuffer2") == 0) {
        void *map1 = real ? real(handle, "vaMapBuffer") : NULL;
        if (map1) {
            __atomic_store_n(&real_vaMapBuffer_fn, (vaMapBuffer_fn)map1, __ATOMIC_RELEASE);
            return (void *)&vaMapBuffer2;
        }
    }
    return sym;
}

/* FFmpeg 8 exposes AVFormatContext as opaque to bindgen on some clang builds.
 * Keep these field reads in C, compiled against the exact headers being linked. */
AVIOContext **osc_avformat_pb(AVFormatContext *context)
{
    return context != NULL ? &context->pb : NULL;
}

AVStream *osc_avformat_stream(AVFormatContext *context, unsigned int index)
{
    if (context == NULL || index >= context->nb_streams) {
        return NULL;
    }
    return context->streams[index];
}

unsigned int osc_avformat_nb_streams(AVFormatContext *context)
{
    return context != NULL ? context->nb_streams : 0;
}
