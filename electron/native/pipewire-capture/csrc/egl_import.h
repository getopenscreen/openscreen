#ifndef OSC_EGL_IMPORT_H
#define OSC_EGL_IMPORT_H

#include <stddef.h>
#include <stdint.h>

/*
 * GPU import of a compositor dmabuf through EGL + OpenGL ES, read back to system
 * memory (issue #1503). This is the path for a GPU whose VAAPI cannot import a
 * dmabuf, the case of the proprietary NVIDIA driver: it is how OBS reads tiled
 * NVIDIA buffers. The VAAPI zero-copy path (dmabuf_import.rs) stays first
 * wherever it builds.
 *
 * libEGL and libGLESv2 are dlopen'd, like libpipewire: no dev package at build
 * time, and a machine without them simply reports the path unavailable.
 */

/* 1 when an EGL display on a hardware GPU can import dmabufs with modifiers and
 * a GLES2 context can be made on it. Opens that display once per process. */
int osc_egl_import_available(void);

/* Modifiers the EGL display above imports for `fourcc` as a plain 2D texture
 * (external-only ones are skipped: a GL_TEXTURE_EXTERNAL_OES cannot be read
 * through a framebuffer). Returns the count written, 0 when unavailable. */
int osc_egl_query_modifiers(uint32_t fourcc, uint64_t *out, int max_out);

/* Imports one dmabuf and reads it into `dst` as tightly packed R,G,B,A bytes
 * (SPA RGBx/RGBA order), width * 4 bytes per row, top row first. Must run on
 * one thread at a time; the context is released before returning, so the caller
 * may change threads between calls. Returns 1 on success, 0 with `err` filled. */
int osc_egl_readback(int32_t width, int32_t height, uint32_t fourcc, uint64_t modifier,
                     int n_planes, const int *fds, const int32_t *offsets,
                     const int32_t *strides, uint8_t *dst, char *err, size_t err_len);

/* Writes the eglCreateImageKHR attribute list for a dmabuf into `out` (EGL_NONE
 * terminated) and returns the number of EGLint written, or 0 when `n_planes` is
 * out of range or `out_len` is too small. Split out so a unit test can check the
 * attribute constants without a GPU. */
int osc_egl_dmabuf_attribs(int32_t width, int32_t height, uint32_t fourcc, uint64_t modifier,
                           int n_planes, const int *fds, const int32_t *offsets,
                           const int32_t *strides, int32_t *out, int out_len);

#endif
