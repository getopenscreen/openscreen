import ctypes as C, os, sys
W = int(os.environ.get('PROBE_W', 256)); H = int(os.environ.get('PROBE_H', 256)); N = int(os.environ.get('PROBE_N', 60))
def pattern(rs):
    b = bytearray(rs * H)
    for y in range(H):
        row = bytearray(rs)
        for x in range(W): row[x*4:x*4+4] = bytes((x & 255, y & 255, (x ^ y) & 255, 255))
        b[y*rs:(y+1)*rs] = row
    return b
if sys.argv[1] == 'gbm':
    g = C.CDLL('libgbm.so.1'); g.gbm_create_device.restype = C.c_void_p
    g.gbm_bo_create.restype = C.c_void_p; g.gbm_bo_create.argtypes = [C.c_void_p] + [C.c_uint]*4
    for f in ('gbm_bo_get_stride', 'gbm_bo_get_fd'): getattr(g, f).argtypes = [C.c_void_p]
    g.gbm_bo_get_modifier.restype = C.c_uint64; g.gbm_bo_get_modifier.argtypes = [C.c_void_p]
    g.gbm_bo_map.restype = C.c_void_p
    g.gbm_bo_map.argtypes = [C.c_void_p] + [C.c_uint]*5 + [C.POINTER(C.c_uint), C.POINTER(C.c_void_p)]
    g.gbm_bo_unmap.argtypes = [C.c_void_p, C.c_void_p]
    dev = g.gbm_create_device(os.open('/dev/dri/renderD128', os.O_RDWR)); assert dev
    bo = g.gbm_bo_create(dev, W, H, 0x34324241, (1 << 4) | (1 << 2)); assert bo  # AB24, LINEAR|RENDERING
    st, md = C.c_uint(), C.c_void_p(); p = g.gbm_bo_map(bo, 0, 0, W, H, 3, C.byref(st), C.byref(md)); assert p
    d = pattern(st.value); C.memmove(p, bytes(d), len(d)); g.gbm_bo_unmap(bo, md)
    fd, stride, mod = g.gbm_bo_get_fd(bo), g.gbm_bo_get_stride(bo), g.gbm_bo_get_modifier(bo)
    print(f'MKBUF gbm fd={fd} stride={stride} modifier={mod:#x}', flush=True)
else:
    stride = int(os.environ.get('PROBE_STRIDE', W*4)); mod = 0
    fd = os.memfd_create('probe'); os.write(fd, pattern(stride))
fds = [fd] + [os.dup(fd) for _ in range(N)]
for f in fds: os.set_inheritable(f, True)
os.environ.update(PROBE_FDS=','.join(map(str, fds)), PROBE_STRIDE=str(stride), PROBE_MOD=str(mod), PROBE_W=str(W), PROBE_H=str(H))
os.execvp(sys.argv[2], sys.argv[2:])
