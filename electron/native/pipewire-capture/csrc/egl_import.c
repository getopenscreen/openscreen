#include "egl_import.h"

#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * EGL and GLES2 spelled out rather than pulled from <EGL/egl.h> and
 * <GLES2/gl2.h>, for the same reason as dmabuf_modifiers.c: the build needs no
 * EGL or GL dev package. Values are from the Khronos registry headers.
 */
typedef void *EGLDisplay;
typedef void *EGLContext;
typedef void *EGLConfig;
typedef void *EGLImage;
typedef void *EGLDeviceEXT;
typedef unsigned int EGLBoolean;
typedef unsigned int EGLenum;
typedef int EGLint;
typedef intptr_t EGLAttrib;
typedef uint64_t EGLuint64KHR;

typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef int GLint;
typedef int GLsizei;

#define OSC_EGL_TRUE 1
#define OSC_EGL_NONE 0x3038
#define OSC_EGL_EXTENSIONS 0x3055
#define OSC_EGL_HEIGHT 0x3056
#define OSC_EGL_WIDTH 0x3057
#define OSC_EGL_RENDERABLE_TYPE 0x3040
#define OSC_EGL_OPENGL_ES2_BIT 0x0004
#define OSC_EGL_CONTEXT_CLIENT_VERSION 0x3098
#define OSC_EGL_OPENGL_ES_API 0x30A0
#define OSC_EGL_PLATFORM_DEVICE_EXT 0x313F
#define OSC_EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#define OSC_EGL_DRM_DEVICE_FILE_EXT 0x3233
#define OSC_EGL_DRM_RENDER_NODE_FILE_EXT 0x3377
#define OSC_EGL_LINUX_DMA_BUF_EXT 0x3270
#define OSC_EGL_LINUX_DRM_FOURCC_EXT 0x3271

/* Per plane: FD, OFFSET, PITCH, MODIFIER_LO, MODIFIER_HI. Planes 0-2 come from
 * EGL_EXT_image_dma_buf_import, plane 3 and the modifiers from its _modifiers
 * extension, hence the two ranges. */
static const EGLint osc_plane_attr[4][5] = {
    {0x3272, 0x3273, 0x3274, 0x3443, 0x3444},
    {0x3275, 0x3276, 0x3277, 0x3445, 0x3446},
    {0x3278, 0x3279, 0x327A, 0x3447, 0x3448},
    {0x3440, 0x3441, 0x3442, 0x3449, 0x344A},
};

#define OSC_DRM_FORMAT_MOD_INVALID 0x00ffffffffffffffULL

#define OSC_GL_TEXTURE_2D 0x0DE1
#define OSC_GL_TEXTURE_MAG_FILTER 0x2800
#define OSC_GL_TEXTURE_MIN_FILTER 0x2801
#define OSC_GL_NEAREST 0x2600
#define OSC_GL_FRAMEBUFFER 0x8D40
#define OSC_GL_COLOR_ATTACHMENT0 0x8CE0
#define OSC_GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define OSC_GL_RGBA 0x1908
#define OSC_GL_UNSIGNED_BYTE 0x1401
#define OSC_GL_PACK_ALIGNMENT 0x0D05
#define OSC_GL_NO_ERROR 0

static struct {
    int tried;
    int ok;
    EGLDisplay dpy;
    EGLContext ctx;
    /* GL objects, created on the first readback, inside the context. */
    GLuint tex;
    GLuint fbo;

    void *(*get_proc)(const char *);
    EGLBoolean (*make_current)(EGLDisplay, void *, void *, EGLContext);
    EGLint (*get_error)(void);
    EGLImage (*create_image)(EGLDisplay, EGLContext, EGLenum, void *, const EGLint *);
    EGLBoolean (*destroy_image)(EGLDisplay, EGLImage);
    EGLBoolean (*query_mods)(EGLDisplay, EGLint, EGLint, EGLuint64KHR *, EGLBoolean *,
                             EGLint *);

    void (*image_target_texture)(GLenum, void *);
    void (*gen_textures)(GLsizei, GLuint *);
    void (*bind_texture)(GLenum, GLuint);
    void (*tex_parameteri)(GLenum, GLenum, GLint);
    void (*gen_framebuffers)(GLsizei, GLuint *);
    void (*bind_framebuffer)(GLenum, GLuint);
    void (*framebuffer_texture_2d)(GLenum, GLenum, GLenum, GLuint, GLint);
    GLenum (*check_framebuffer_status)(GLenum);
    void (*pixel_storei)(GLenum, GLint);
    void (*read_pixels)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *);
    GLenum (*gl_get_error)(void);
} egl;

static void osc_egl_set_error(char *err, size_t err_len, const char *format, ...)
{
    va_list args;
    if (err == NULL || err_len == 0) {
        return;
    }
    va_start(args, format);
    vsnprintf(err, err_len, format, args);
    va_end(args);
}

static int osc_has_extension(const char *list, const char *name)
{
    size_t len = strlen(name);
    const char *at = list;
    while (list != NULL && (at = strstr(at, name)) != NULL) {
        if ((at == list || at[-1] == ' ') && (at[len] == ' ' || at[len] == '\0')) {
            return 1;
        }
        at += len;
    }
    return 0;
}

/*
 * The display has to sit on the GPU that renders the compositor's buffers, and
 * on a hardware driver. The surfaceless platform dmabuf_modifiers.c uses for the
 * VAAPI path is the wrong first choice here: under libglvnd it goes to Mesa,
 * which on an NVIDIA-only machine has no driver for the card and answers with
 * llvmpipe. So walk the EGL devices and take the first one backed by a DRM node
 * (software devices have none), honouring OPENSCREEN_LINUX_RENDER_NODE like the
 * VAAPI importer does. Surfaceless stays as the fallback for a stack without
 * EGL_EXT_platform_device.
 *
 * ponytail: first DRM-backed device wins; on a hybrid laptop whose compositor
 * renders on the other GPU, set OPENSCREEN_LINUX_RENDER_NODE.
 */
static EGLDisplay osc_egl_open_display(EGLBoolean (*egl_init)(EGLDisplay, EGLint *, EGLint *))
{
    EGLDisplay (*get_display)(EGLenum, void *, const EGLAttrib *) =
        (EGLDisplay(*)(EGLenum, void *, const EGLAttrib *))egl.get_proc("eglGetPlatformDisplayEXT");
    EGLBoolean (*query_devices)(EGLint, EGLDeviceEXT *, EGLint *) =
        (EGLBoolean(*)(EGLint, EGLDeviceEXT *, EGLint *))egl.get_proc("eglQueryDevicesEXT");
    const char *(*query_device_string)(EGLDeviceEXT, EGLint) =
        (const char *(*)(EGLDeviceEXT, EGLint))egl.get_proc("eglQueryDeviceStringEXT");
    const char *wanted = getenv("OPENSCREEN_LINUX_RENDER_NODE");
    EGLDisplay dpy;

    if (get_display == NULL) {
        return NULL;
    }
    if (query_devices != NULL && query_device_string != NULL) {
        EGLDeviceEXT devices[16];
        EGLint count = 0;
        if (query_devices(16, devices, &count) == OSC_EGL_TRUE) {
            for (EGLint i = 0; i < count; i++) {
                const char *render = query_device_string(devices[i], OSC_EGL_DRM_RENDER_NODE_FILE_EXT);
                const char *card = query_device_string(devices[i], OSC_EGL_DRM_DEVICE_FILE_EXT);
                if (render == NULL && card == NULL) {
                    continue;
                }
                if (wanted != NULL && (render == NULL || strcmp(render, wanted) != 0)) {
                    continue;
                }
                dpy = get_display(OSC_EGL_PLATFORM_DEVICE_EXT, devices[i], NULL);
                if (dpy != NULL && egl_init(dpy, NULL, NULL) == OSC_EGL_TRUE) {
                    fprintf(stderr, "[osc-egl] using EGL device %s\n",
                            render != NULL ? render : card);
                    return dpy;
                }
            }
        }
    }
    dpy = get_display(OSC_EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
    if (dpy != NULL && egl_init(dpy, NULL, NULL) == OSC_EGL_TRUE) {
        fprintf(stderr, "[osc-egl] using the surfaceless EGL platform\n");
        return dpy;
    }
    return NULL;
}

static void *osc_gl_proc(void *gles, const char *name)
{
    void *fn = gles != NULL ? dlsym(gles, name) : NULL;
    return fn != NULL ? fn : egl.get_proc(name);
}

static int osc_egl_init(void)
{
    void *lib;
    void *gles;
    EGLBoolean (*egl_init)(EGLDisplay, EGLint *, EGLint *);
    const char *(*query_string)(EGLDisplay, EGLint);
    EGLBoolean (*bind_api)(EGLenum);
    EGLContext (*create_context)(EGLDisplay, EGLConfig, EGLContext, const EGLint *);
    EGLBoolean (*choose_config)(EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *);
    const char *exts;
    EGLConfig config = NULL;
    static const EGLint ctx_attribs[] = {OSC_EGL_CONTEXT_CLIENT_VERSION, 2, OSC_EGL_NONE};

    /* RTLD_NODELETE and no dlclose: EGL keeps process-global state. */
    lib = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    if (lib == NULL) {
        fprintf(stderr, "[osc-egl] unavailable: libEGL.so.1 not found\n");
        return 0;
    }
    egl.get_proc = (void *(*)(const char *))dlsym(lib, "eglGetProcAddress");
    egl_init = (EGLBoolean(*)(EGLDisplay, EGLint *, EGLint *))dlsym(lib, "eglInitialize");
    query_string = (const char *(*)(EGLDisplay, EGLint))dlsym(lib, "eglQueryString");
    bind_api = (EGLBoolean(*)(EGLenum))dlsym(lib, "eglBindAPI");
    create_context = (EGLContext(*)(EGLDisplay, EGLConfig, EGLContext, const EGLint *))dlsym(
        lib, "eglCreateContext");
    choose_config = (EGLBoolean(*)(EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *))dlsym(
        lib, "eglChooseConfig");
    egl.make_current =
        (EGLBoolean(*)(EGLDisplay, void *, void *, EGLContext))dlsym(lib, "eglMakeCurrent");
    egl.get_error = (EGLint(*)(void))dlsym(lib, "eglGetError");
    if (egl.get_proc == NULL || egl_init == NULL || query_string == NULL || bind_api == NULL ||
        create_context == NULL || choose_config == NULL || egl.make_current == NULL ||
        egl.get_error == NULL) {
        fprintf(stderr, "[osc-egl] unavailable: libEGL lacks a core entry point\n");
        return 0;
    }

    egl.dpy = osc_egl_open_display(egl_init);
    if (egl.dpy == NULL) {
        fprintf(stderr, "[osc-egl] unavailable: no hardware EGL display\n");
        return 0;
    }
    exts = query_string(egl.dpy, OSC_EGL_EXTENSIONS);
    if (!osc_has_extension(exts, "EGL_EXT_image_dma_buf_import_modifiers") ||
        !osc_has_extension(exts, "EGL_KHR_surfaceless_context")) {
        fprintf(stderr, "[osc-egl] unavailable: display lacks dma-buf modifiers or surfaceless "
                        "contexts\n");
        return 0;
    }
    egl.create_image = (EGLImage(*)(EGLDisplay, EGLContext, EGLenum, void *, const EGLint *))
        egl.get_proc("eglCreateImageKHR");
    egl.destroy_image = (EGLBoolean(*)(EGLDisplay, EGLImage))egl.get_proc("eglDestroyImageKHR");
    egl.query_mods = (EGLBoolean(*)(EGLDisplay, EGLint, EGLint, EGLuint64KHR *, EGLBoolean *,
                                    EGLint *))egl.get_proc("eglQueryDmaBufModifiersEXT");
    if (egl.create_image == NULL || egl.destroy_image == NULL || egl.query_mods == NULL) {
        fprintf(stderr, "[osc-egl] unavailable: EGL image entry points missing\n");
        return 0;
    }

    if (bind_api(OSC_EGL_OPENGL_ES_API) != OSC_EGL_TRUE) {
        fprintf(stderr, "[osc-egl] unavailable: eglBindAPI(GLES) failed\n");
        return 0;
    }
    /* No config is needed for a context that never draws to a surface; a stack
     * without EGL_KHR_no_config_context gets any GLES2 config instead. */
    if (!osc_has_extension(exts, "EGL_KHR_no_config_context")) {
        static const EGLint want[] = {OSC_EGL_RENDERABLE_TYPE, OSC_EGL_OPENGL_ES2_BIT,
                                      OSC_EGL_NONE};
        EGLint n = 0;
        if (choose_config(egl.dpy, want, &config, 1, &n) != OSC_EGL_TRUE || n < 1) {
            fprintf(stderr, "[osc-egl] unavailable: no GLES2 config\n");
            return 0;
        }
    }
    egl.ctx = create_context(egl.dpy, config, NULL, ctx_attribs);
    if (egl.ctx == NULL) {
        fprintf(stderr, "[osc-egl] unavailable: eglCreateContext failed (0x%x)\n",
                egl.get_error());
        return 0;
    }

    gles = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    egl.image_target_texture =
        (void (*)(GLenum, void *))egl.get_proc("glEGLImageTargetTexture2DOES");
    egl.gen_textures = (void (*)(GLsizei, GLuint *))osc_gl_proc(gles, "glGenTextures");
    egl.bind_texture = (void (*)(GLenum, GLuint))osc_gl_proc(gles, "glBindTexture");
    egl.tex_parameteri = (void (*)(GLenum, GLenum, GLint))osc_gl_proc(gles, "glTexParameteri");
    egl.gen_framebuffers = (void (*)(GLsizei, GLuint *))osc_gl_proc(gles, "glGenFramebuffers");
    egl.bind_framebuffer = (void (*)(GLenum, GLuint))osc_gl_proc(gles, "glBindFramebuffer");
    egl.framebuffer_texture_2d = (void (*)(GLenum, GLenum, GLenum, GLuint, GLint))osc_gl_proc(
        gles, "glFramebufferTexture2D");
    egl.check_framebuffer_status =
        (GLenum(*)(GLenum))osc_gl_proc(gles, "glCheckFramebufferStatus");
    egl.pixel_storei = (void (*)(GLenum, GLint))osc_gl_proc(gles, "glPixelStorei");
    egl.read_pixels = (void (*)(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *))osc_gl_proc(
        gles, "glReadPixels");
    egl.gl_get_error = (GLenum(*)(void))osc_gl_proc(gles, "glGetError");
    if (egl.image_target_texture == NULL || egl.gen_textures == NULL || egl.bind_texture == NULL ||
        egl.tex_parameteri == NULL || egl.gen_framebuffers == NULL ||
        egl.bind_framebuffer == NULL || egl.framebuffer_texture_2d == NULL ||
        egl.check_framebuffer_status == NULL || egl.pixel_storei == NULL ||
        egl.read_pixels == NULL || egl.gl_get_error == NULL) {
        fprintf(stderr, "[osc-egl] unavailable: a GLES2 entry point is missing\n");
        return 0;
    }
    fprintf(stderr, "[osc-egl] dma-buf import available\n");
    return 1;
}

/* ponytail: one process-wide display and context, never torn down; the helper
 * is one process per recording. */
int osc_egl_import_available(void)
{
    if (!egl.tried) {
        egl.tried = 1;
        egl.ok = osc_egl_init();
    }
    return egl.ok;
}

int osc_egl_query_modifiers(uint32_t fourcc, uint64_t *out, int max_out)
{
    EGLuint64KHR mods[128];
    EGLBoolean external[128];
    EGLint count = 0;
    int written = 0;

    if (out == NULL || max_out <= 0 || !osc_egl_import_available()) {
        return 0;
    }
    if (egl.query_mods(egl.dpy, (EGLint)fourcc, 128, mods, external, &count) != OSC_EGL_TRUE) {
        return 0;
    }
    for (EGLint i = 0; i < count && written < max_out; i++) {
        if (!external[i]) {
            out[written++] = (uint64_t)mods[i];
        }
    }
    return written;
}

int osc_egl_dmabuf_attribs(int32_t width, int32_t height, uint32_t fourcc, uint64_t modifier,
                           int n_planes, const int *fds, const int32_t *offsets,
                           const int32_t *strides, int32_t *out, int out_len)
{
    int n = 0;
    int with_modifier = modifier != OSC_DRM_FORMAT_MOD_INVALID;

    if (n_planes < 1 || n_planes > 4 || out_len < 7 + n_planes * 10) {
        return 0;
    }
    out[n++] = OSC_EGL_WIDTH;
    out[n++] = width;
    out[n++] = OSC_EGL_HEIGHT;
    out[n++] = height;
    out[n++] = OSC_EGL_LINUX_DRM_FOURCC_EXT;
    out[n++] = (int32_t)fourcc;
    for (int p = 0; p < n_planes; p++) {
        out[n++] = osc_plane_attr[p][0];
        out[n++] = fds[p];
        out[n++] = osc_plane_attr[p][1];
        out[n++] = offsets[p];
        out[n++] = osc_plane_attr[p][2];
        out[n++] = strides[p];
        /* INVALID means "implicit layout": the modifier attributes must then be
         * absent, not set to INVALID. */
        if (with_modifier) {
            out[n++] = osc_plane_attr[p][3];
            out[n++] = (int32_t)(modifier & 0xffffffffu);
            out[n++] = osc_plane_attr[p][4];
            out[n++] = (int32_t)(modifier >> 32);
        }
    }
    out[n++] = OSC_EGL_NONE;
    return n;
}

int osc_egl_readback(int32_t width, int32_t height, uint32_t fourcc, uint64_t modifier,
                     int n_planes, const int *fds, const int32_t *offsets,
                     const int32_t *strides, uint8_t *dst, char *err, size_t err_len)
{
    EGLint attribs[64];
    EGLImage image;
    GLenum status;
    GLenum gl_error;
    int ok = 0;

    if (!osc_egl_import_available()) {
        osc_egl_set_error(err, err_len, "EGL dma-buf import is unavailable");
        return 0;
    }
    if (osc_egl_dmabuf_attribs(width, height, fourcc, modifier, n_planes, fds, offsets, strides,
                               attribs, 64) == 0) {
        osc_egl_set_error(err, err_len, "unsupported plane count %d", n_planes);
        return 0;
    }
    if (egl.make_current(egl.dpy, NULL, NULL, egl.ctx) != OSC_EGL_TRUE) {
        osc_egl_set_error(err, err_len, "eglMakeCurrent failed (0x%x)", egl.get_error());
        return 0;
    }
    if (egl.fbo == 0) {
        egl.gen_textures(1, &egl.tex);
        egl.bind_texture(OSC_GL_TEXTURE_2D, egl.tex);
        egl.tex_parameteri(OSC_GL_TEXTURE_2D, OSC_GL_TEXTURE_MIN_FILTER, OSC_GL_NEAREST);
        egl.tex_parameteri(OSC_GL_TEXTURE_2D, OSC_GL_TEXTURE_MAG_FILTER, OSC_GL_NEAREST);
        egl.gen_framebuffers(1, &egl.fbo);
    }

    image = egl.create_image(egl.dpy, NULL, OSC_EGL_LINUX_DMA_BUF_EXT, NULL, attribs);
    if (image == NULL) {
        osc_egl_set_error(err, err_len,
                          "eglCreateImageKHR failed (0x%x) for fourcc %#x modifier %#llx",
                          egl.get_error(), fourcc, (unsigned long long)modifier);
        goto out;
    }
    egl.bind_texture(OSC_GL_TEXTURE_2D, egl.tex);
    egl.image_target_texture(OSC_GL_TEXTURE_2D, image);
    egl.bind_framebuffer(OSC_GL_FRAMEBUFFER, egl.fbo);
    /* Re-attached every frame: the texture's storage was just respecified. */
    egl.framebuffer_texture_2d(OSC_GL_FRAMEBUFFER, OSC_GL_COLOR_ATTACHMENT0, OSC_GL_TEXTURE_2D,
                               egl.tex, 0);
    status = egl.check_framebuffer_status(OSC_GL_FRAMEBUFFER);
    if (status != OSC_GL_FRAMEBUFFER_COMPLETE) {
        osc_egl_set_error(err, err_len, "framebuffer incomplete (0x%x)", status);
    } else {
        /* A texture-backed framebuffer reads back in texture row order, which is
         * the dmabuf's own: top row first, no flip. Rows are width * 4 bytes, a
         * multiple of the pack alignment. */
        egl.pixel_storei(OSC_GL_PACK_ALIGNMENT, 4);
        egl.read_pixels(0, 0, width, height, OSC_GL_RGBA, OSC_GL_UNSIGNED_BYTE, dst);
        gl_error = egl.gl_get_error();
        if (gl_error != OSC_GL_NO_ERROR) {
            osc_egl_set_error(err, err_len, "glReadPixels failed (0x%x)", gl_error);
        } else {
            ok = 1;
        }
    }
    egl.bind_framebuffer(OSC_GL_FRAMEBUFFER, 0);
    egl.destroy_image(egl.dpy, image);
out:
    /* Released so a restarted stream's new PipeWire thread can take it. */
    egl.make_current(egl.dpy, NULL, NULL, NULL);
    return ok;
}
