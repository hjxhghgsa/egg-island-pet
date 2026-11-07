#!/usr/bin/env python3
"""检查 GLB 的绑定姿势是否自洽：静止时 jointWorld * inverseBindMatrix 应该接近单位阵。

迁移骨架最容易踩的坑不是权重，而是把骨骼树从原来的父节点下摘出来：
如果 Hips 上面还有一层 Armature（常见带 scale/rotation），直接把 Hips 挂到
scene 根就会让 jointWorld 少一截变换，跟原文件的 IBM 对不上，
于是整个模型在静止状态就被凭空拧了一下，而且所有动作里都恒定存在。

用法： python tools/inspect_rig.py [a.glb b.glb ...]
"""
import json
import math
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
FMT = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}


def load(path):
    d = open(path, 'rb').read()
    _, _, length = struct.unpack_from('<4sII', d, 0)
    off, chunks = 12, []
    while off < length:
        n, t = struct.unpack_from('<I4s', d, off)
        off += 8
        chunks.append((t.decode('latin1'), d[off:off + n]))
        off += n
    j = json.loads(chunks[0][1].decode('utf-8'))
    b = next(x for t, x in chunks if t.startswith('BIN'))
    return j, b


def read_acc(j, b, idx):
    a = j['accessors'][idx]
    bv = j['bufferViews'][a['bufferView']]
    n = NCOMP[a['type']]
    f = FMT[a['componentType']]
    sz = struct.calcsize(f)
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or sz * n
    return [struct.unpack_from('<' + f * n, b, base + k * stride)
            for k in range(a['count'])]


def ident():
    return [[1.0 if i == k else 0.0 for k in range(4)] for i in range(4)]


def from_gltf(raw):
    """glTF matrix / IBM 是列主序，转成数学上的 M[row][col]"""
    return [[raw[c * 4 + r] for c in range(4)] for r in range(4)]


def mul(a, b):
    return [[sum(a[i][k] * b[k][c] for k in range(4)) for c in range(4)]
            for i in range(4)]


def trs(node):
    if 'matrix' in node:
        return from_gltf(node['matrix'])
    t = node.get('translation', [0, 0, 0])
    q = node.get('rotation', [0, 0, 0, 1])
    s = node.get('scale', [1, 1, 1])
    x, y, z, w = q
    r = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    m = [[r[i][c] * s[c] for c in range(3)] + [t[i]] for i in range(3)]
    m.append([0, 0, 0, 1])
    return m


def parents(j):
    p = {}
    for i, n in enumerate(j['nodes']):
        for c in n.get('children', []):
            p[c] = i
    return p


def chain(j, node, par):
    out = [node]
    while node in par:
        node = par[node]
        out.append(node)
    return list(reversed(out))


def world(j, node, par):
    m = ident()
    for i in chain(j, node, par):
        m = mul(m, trs(j['nodes'][i]))
    return m


def describe(m):
    """把 4x4 拆成平移 / 缩放 / 近似欧拉角，方便一眼看出差在哪"""
    tx, ty, tz = m[0][3], m[1][3], m[2][3]
    sx = math.sqrt(sum(m[i][0] ** 2 for i in range(3)))
    sy = math.sqrt(sum(m[i][1] ** 2 for i in range(3)))
    sz = math.sqrt(sum(m[i][2] ** 2 for i in range(3)))
    # 去掉缩放后取旋转部分
    r = [[m[i][c] / (sx, sy, sz)[c] for c in range(3)] for i in range(3)]
    ry = math.degrees(math.asin(max(-1, min(1, -r[2][0]))))
    rx = math.degrees(math.atan2(r[2][1], r[2][2]))
    rz = math.degrees(math.atan2(r[1][0], r[0][0]))
    return 'T=(%.4f, %.4f, %.4f) S=(%.4f, %.4f, %.4f) R=(%.1f, %.1f, %.1f)deg' % (
        tx, ty, tz, sx, sy, sz, rx, ry, rz)


def check(path):
    j, b = load(path)
    print('\n=== %s ===' % os.path.basename(path))
    print('generator:', j.get('asset', {}).get('generator'))
    print('scene roots:', [j['nodes'][i].get('name', '#%d' % i)
                           for i in j['scenes'][0]['nodes']])
    mesh_nodes = [i for i, n in enumerate(j['nodes']) if 'mesh' in n]
    print('mesh nodes:', [(i, j['nodes'][i].get('name'),
                           describe(trs(j['nodes'][i]))) for i in mesh_nodes])
    if not j.get('skins'):
        print('no skin')
        return
    skin = j['skins'][0]
    ibms = read_acc(j, b, skin['inverseBindMatrices'])
    par = parents(j)
    hips = skin['joints'][0]
    print('hips:', j['nodes'][hips].get('name'),
          'parent:', j['nodes'][par[hips]].get('name') if hips in par else None)
    print('hips local:', describe(trs(j['nodes'][hips])))
    if hips in par:
        print('hips parent local:', describe(trs(j['nodes'][par[hips]])))
        print('hips parent chain:', [j['nodes'][i].get('name', '#%d' % i)
                                    for i in chain(j, hips, par)[:-1]])
    print('node transforms on hips chain:')
    for i in chain(j, hips, par):
        n = j['nodes'][i]
        print('  #%-3d %-58s %s' % (i, n.get('name', ''), describe(trs(n))))
    if mesh_nodes:
        print('mesh parent chain:', [j['nodes'][i].get('name', '#%d' % i)
                                    for i in chain(j, mesh_nodes[0], par)])
        print('mesh world:', describe(world(j, mesh_nodes[0], par)))
    # glTF 允许把坐标转换放在 mesh 与骨骼共同的父节点上，这时 IBM 里不含那层变换，
    # 所以静止时 jointWorld*IBM 应该等于 mesh 的世界矩阵，而不是单位阵。
    # 拿它跟 meshWorld 比，能同时兼容「带 node_0 转换」和「不带」两种约定。
    mw = world(j, mesh_nodes[0], par) if mesh_nodes else ident()
    err = 0.0
    worst = []
    for k, jn in enumerate(skin['joints']):
        m = mul(world(j, jn, par), from_gltf(ibms[k]))
        e = max(abs(m[i][c] - mw[i][c]) for i in range(4) for c in range(4))
        err = max(err, e)
        worst.append((e, j['nodes'][jn].get('name', '#%d' % jn), m))
    print('bind pose max |jointWorld*IBM - meshWorld| = %.6f' % err)
    print('(接近 0 才对；明显不为 0 说明骨骼层级/IBM 与网格坐标系不匹配)')
    for e, name, m in sorted(worst, reverse=True)[:3]:
        print('  worst %-28s err=%.4f  %s' % (name, e, describe(m)))


if __name__ == '__main__':
    args = sys.argv[1:] or [
        os.path.join(ROOT, 'models', 'character-cake.glb'),
        os.path.join(ROOT, 'models', 'character-rebuilt-rigged.glb'),
    ]
    for p in args:
        check(p)
