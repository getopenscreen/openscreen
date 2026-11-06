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

static void *(*real_dlsym_fn)(void *, const char *) = NULL;
static VAStatus (*real_vaMapBuffer_fn)(VADisplay, VABufferID, void **) = NULL;

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
static void resolve_real_dlsym(void)
{
    if (!real_dlsym_fn) {
        real_dlsym_fn = (void *(*)(void *, const char *))dlvsym(RTLD_NEXT, "dlsym", OSC_DLSYM_GLIBC_VER);
        if (!real_dlsym_fn) {
            real_dlsym_fn = (void *(*)(void *, const char *))dlvsym(RTLD_DEFAULT, "dlsym", OSC_DLSYM_GLIBC_VER);
        }
        if (!real_dlsym_fn) {
            real_dlsym_fn = (void *(*)(void *, const char *))dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.34");
        }
        if (!real_dlsym_fn) {
            real_dlsym_fn = (void *(*)(void *, const char *))dlvsym(RTLD_DEFAULT, "dlsym", "GLIBC_2.34");
        }
    }
}

/**
 * Compatibility entry point for `vaMapBuffer2` (added in libva 2.22) that
 * forwards buffer mapping calls to `vaMapBuffer` on older libva runtimes.
 */
VAStatus vaMapBuffer2(VADisplay dpy, VABufferID buf_id, void **pbuf, unsigned int flags)
{
    (void)flags;
    if (!real_vaMapBuffer_fn) {
        resolve_real_dlsym();
        void *h = dlopen("libva.so.2", RTLD_LAZY | RTLD_NOLOAD);
        if (!h) {
            h = dlopen("libva.so.2", RTLD_LAZY);
        }
        if (h && real_dlsym_fn) {
            real_vaMapBuffer_fn =
                (VAStatus (*)(VADisplay, VABufferID, void **))real_dlsym_fn(h, "vaMapBuffer");
        }
    }
    if (!real_vaMapBuffer_fn) {
        return VA_STATUS_ERROR_UNKNOWN;
    }
    return real_vaMapBuffer_fn(dpy, buf_id, pbuf);
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
    resolve_real_dlsym();
    void *sym = real_dlsym_fn ? real_dlsym_fn(handle, name) : NULL;
    if (!sym && strcmp(name, "vaMapBuffer2") == 0) {
        void *map1 = real_dlsym_fn ? real_dlsym_fn(handle, "vaMapBuffer") : NULL;
        if (map1) {
            real_vaMapBuffer_fn = (VAStatus (*)(VADisplay, VABufferID, void **))map1;
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
