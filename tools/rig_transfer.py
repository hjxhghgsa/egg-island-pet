#!/usr/bin/env python3
"""把蛋糕纯的骨架 + 蒙皮权重迁移到 AI 重建的静态网格上，输出真正带 glTF skin 的 GLB。

为什么这么做：
  AI 图生 3D 出来的模型是 0 骨骼 / 0 动画的静态网格，直接换上去会废掉桌宠
  全部程序化骨骼节目（走路 / 秋千 / 贴边探头 / 15 套动作 / 手势）。
  重建模型本来就是照着蛋糕纯生成的，所以最稳的不是重新猜骨骼位置，
  而是把那份已经被验证过能跑动画的骨架整棵搬过来，再按空间最近邻
  把每个顶点的蒙皮权重迁移过去。

做法：
  1) 重建模型的顶点是躺倒的，靠 node 上 Rx(90°) 的四元数才立起来。
     先把这个旋转烘焙进 POSITION / NORMAL，去掉 node 的 rotation。
  2) 按身高把立姿坐标缩放/对中到蛋糕纯的空间（y 0~1），再绕 Y 转 +90°
     旋进蛋糕纯的 POSITION 坐标系（cake 原始正面朝 +X，重建模型朝 +Z）。
  3) 空间哈希找重建顶点最近的 4 个蛋糕纯顶点，按距离倒数混合它们的
     JOINTS_0 / WEIGHTS_0（取权重最大的 4 根骨骼并归一化）。
  4) 连同 node_0（带 Ry(-90°) 坐标转换）和 Armature 一起复制骨骼父链，
     47 根骨骼 + inverseBindMatrices 原样搬过来。node_0 会把第 2 步的
     +90° 转回屏幕正面，所以视觉朝向不变，但网格 / 骨骼 / 权重三者同坐标系。
     skin.joints 顺序保持不变，所以 joint 索引不用改。
  5) 网格节点加 skin，重排 bufferView / accessor，重建 GLB。

最容易踩的坑：只搬 Hips 子树、把骨骼直接挂到 scene 根，就等于丢掉
node_0 那层坐标转换。表现是人变成 3/4 侧身甚至背面、抬手和走路方向
整体偏 90°，但网格不撕裂，很容易误判成「AI 生成模型本来就是歪的」。
用 tools/inspect_rig.py 比一下 jointWorld*IBM 和 meshWorld 就能查出来。

用法： python tools/rig_transfer.py
      可用 RIG_ALIGN_YAW / RIG_OUT 覆盖对齐角度与输出路径（调参时用）。
产物： models/character-rebuilt-rigged.glb
"""
import json
import math
import os
import struct
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAKE = os.path.join(ROOT, 'models', 'character-cake.glb')
SRC = os.path.join(ROOT, 'models', 'character-rebuilt.glb')
OUT = os.environ.get('RIG_OUT') or os.path.join(ROOT, 'models', 'character-rebuilt-rigged.glb')
# 重建模型烘焙成 Y-up 后，正面朝 +Z；cake 的 POSITION 是正面朝 +X，
# 靠 node_0 的 Ry(-90°) 才转成屏幕正面。两边差 90°，所以先把重建顶点
# 也旋到 cake 空间（权重查询才对得上），再由 node_0 转回来，视觉朝向不变。
ALIGN_YAW = math.radians(float(os.environ.get('RIG_ALIGN_YAW', '90')))

NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
FMT = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}


def load_glb(path):
    d = open(path, 'rb').read()
    _, _, length = struct.unpack_from('<4sII', d, 0)
    off, chunks = 12, []
    while off < length:
        n, t = struct.unpack_from('<I4s', d, off)
        off += 8
        chunks.append((t.decode('latin1'), d[off:off + n]))
        off += n
    j = json.loads(chunks[0][1].decode('utf-8'))
    b = bytearray(next(x for t, x in chunks if t.startswith('BIN')))
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


def overwrite_vec3(j, b, idx, values):
    a = j['accessors'][idx]
    bv = j['bufferViews'][a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or 12
    for k, v in enumerate(values):
        struct.pack_into('<fff', b, base + k * stride, *v)
    if 'min' in a:
        a['min'] = [min(v[i] for v in values) for i in range(3)]
    if 'max' in a:
        a['max'] = [max(v[i] for v in values) for i in range(3)]


def write_glb(path, j, b):
    js = json.dumps(j, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    nb = bytes(b) + b'\0' * ((4 - len(b) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(nb)
    out = struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<I4s', len(js), b'JSON') + js
    out += struct.pack('<I4s', len(nb), b'BIN\0') + nb
    open(path, 'wb').write(out)
    return len(out)


def add_view(j, b, raw, target=None):
    b.extend(b'\0' * ((4 - len(b) % 4) % 4))
    off = len(b)
    b.extend(raw)
    bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(raw)}
    if target:
        bv['target'] = target
    j['bufferViews'].append(bv)
    return len(j['bufferViews']) - 1


def add_acc(j, bv, ctype, comp, count, extra=None):
    a = {'bufferView': bv, 'componentType': comp, 'count': count, 'type': ctype}
    if extra:
        a.update(extra)
    j['accessors'].append(a)
    return len(j['accessors']) - 1


def main():
    jc, bc = load_glb(CAKE)
    jr, br = load_glb(SRC)

    # ---- 1. 蛋糕纯：顶点 / 权重 / 骨骼树 ----
    pr_c = jc['meshes'][0]['primitives'][0]
    cake_pos = [tuple(v) for v in read_acc(jc, bc, pr_c['attributes']['POSITION'])]
    cake_joints = read_acc(jc, bc, pr_c['attributes']['JOINTS_0'])
    cake_weights = read_acc(jc, bc, pr_c['attributes']['WEIGHTS_0'])
    ibm = read_acc(jc, bc, jc['skins'][0]['inverseBindMatrices'])
    cake_joint_nodes = jc['skins'][0]['joints']
    print('cake: verts=%d joints=%d ibm=%d' % (len(cake_pos), len(cake_joint_nodes), len(ibm)))

    hips = next(i for i, n in enumerate(jc['nodes'])
                if str(n.get('name', '')).endswith('Hips'))
    order = []
    stack = [hips]
    while stack:
        i = stack.pop()
        order.append(i)
        stack.extend(reversed(jc['nodes'][i].get('children', [])))
    base_idx = len(jr['nodes'])
    old2new = {old: base_idx + k for k, old in enumerate(order)}
    missing = [x for x in cake_joint_nodes if x not in old2new]
    assert not missing, 'joint nodes outside Hips subtree: %s' % missing[:5]

    # ---- 2. 重建模型：把 Rx(90°) 烘焙进顶点，再对齐到蛋糕纯空间 ----
    pr_r = jr['meshes'][0]['primitives'][0]
    pos = [tuple(v) for v in read_acc(jr, br, pr_r['attributes']['POSITION'])]
    nor = [tuple(v) for v in read_acc(jr, br, pr_r['attributes']['NORMAL'])]

    # 先按立姿统计：Rx(90) 后 y' = -z, z' = y
    upright = [(p[0], -p[2], p[1]) for p in pos]
    ys = sorted(p[1] for p in upright)
    xs = sorted(p[0] for p in upright)
    zs = sorted(p[2] for p in upright)
    height = ys[-1] - ys[0]
    s = 1.0 / height                       # 蛋糕纯是 y 0~1
    cx = xs[len(xs) // 2]                  # 用中位数对中，避开小蛋拉偏包围盒
    cz = zs[len(zs) // 2]
    print('rebuilt upright: height=%.4f scale=%.4f center=(%.4f, %.4f)' % (height, s, cx, cz))

    co, si = math.cos(ALIGN_YAW), math.sin(ALIGN_YAW)
    new_pos, new_nor, query = [], [], []
    for p, n in zip(pos, nor):
        # 位置：原始 (x,y,z) -> 立姿 (x,-z,y) -> 缩放对中 -> 旋进 cake 空间
        x0, y0, z0 = (p[0] - cx) * s, (-p[2] - ys[0]) * s, (p[1] - cz) * s
        q = (x0 * co + z0 * si, y0, -x0 * si + z0 * co)
        new_pos.append(q)
        query.append(q)
        # 法线：Rx(90°) 后再绕 Y 旋同样角度；均匀缩放不改方向
        nx0, ny0, nz0 = n[0], -n[2], n[1]
        new_nor.append((nx0 * co + nz0 * si, ny0, -nx0 * si + nz0 * co))
    overwrite_vec3(jr, br, pr_r['attributes']['POSITION'], new_pos)
    overwrite_vec3(jr, br, pr_r['attributes']['NORMAL'], new_nor)
    jr['nodes'][0].pop('rotation', None)   # 旋转已烘焙，别再转一次

    # ---- 3. 空间哈希最近邻迁移蒙皮权重 ----
    CELL = 0.035
    buckets = defaultdict(list)
    for i, p in enumerate(cake_pos):
        buckets[(math.floor(p[0] / CELL), math.floor(p[1] / CELL),
                 math.floor(p[2] / CELL))].append(i)

    joints_out = []
    weights_out = []
    fallback = 0
    for q in query:
        gx, gy, gz = (math.floor(q[0] / CELL), math.floor(q[1] / CELL),
                      math.floor(q[2] / CELL))
        cand = []
        for r in (1, 2, 4, 8, 20):
            cand = []
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    for dz in range(-r, r + 1):
                        for vi in buckets.get((gx + dx, gy + dy, gz + dz), ()):
                            p = cake_pos[vi]
                            d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2
                            cand.append((d2, vi))
            if len(cand) >= 4:
                break
        if len(cand) < 4:
            fallback += 1
            joints_out.append((0, 0, 0, 0))
            weights_out.append((1.0, 0.0, 0.0, 0.0))
            continue
        cand.sort(key=lambda x: x[0])
        acc = defaultdict(float)
        for d2, vi in cand[:4]:
            w = 1.0 / (d2 + 1e-5)
            for k in range(4):
                wk = cake_weights[vi][k]
                if wk > 0:
                    acc[cake_joints[vi][k]] += w * wk
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        total = sum(v for _, v in top) or 1.0
        js = [b for b, _ in top] + [0] * (4 - len(top))
        ws = [v / total for _, v in top] + [0.0] * (4 - len(top))
        joints_out.append(tuple(js))
        weights_out.append(tuple(ws))
    print('weight transfer: verts=%d fallback=%d' % (len(query), fallback))

    j_raw = struct.pack('<' + 'H' * (4 * len(joints_out)),
                        *[v for q in joints_out for v in q])
    w_raw = struct.pack('<' + 'f' * (4 * len(weights_out)),
                        *[v for q in weights_out for v in q])
    ibm_raw = struct.pack('<' + 'f' * (16 * len(ibm)),
                          *[v for m in ibm for v in m])

    jv = add_view(jr, br, j_raw, 34962)
    wv = add_view(jr, br, w_raw, 34962)
    iv = add_view(jr, br, ibm_raw)
    ja = add_acc(jr, jv, 'VEC4', 5123, len(joints_out))
    wa = add_acc(jr, wv, 'VEC4', 5126, len(weights_out))
    ia = add_acc(jr, iv, 'MAT4', 5126, len(ibm))
    pr_r['attributes']['JOINTS_0'] = ja
    pr_r['attributes']['WEIGHTS_0'] = wa

    # ---- 4. 复制骨骼树 + skin / scene ----
    for old in order:
        n = dict(jc['nodes'][old])
        if 'children' in n:
            n['children'] = [old2new[c] for c in n['children']]
        jr['nodes'].append(n)
    jr['nodes'][0]['skin'] = 0
    jr['skins'] = [{
        'name': 'transferred-from-cake',
        'joints': [old2new[x] for x in cake_joint_nodes],
        'inverseBindMatrices': ia
    }]

    # cake 的 mesh 和 Hips 同挂在 Armature 下，Armature 上面还有一层 node_0，
    # 而 node_0 带一个 Ry(90°) 的坐标转换（Tripo 导出的约定）。
    # 这层不是可有可无的：第一版把 Hips 直接挂到 scene 根，网格和骨架就都少转了
    # 这 90°，人变成 3/4 侧身对着镜头，抬手 / 走路的方向也整体偏 90°。
    # 所以连父链一起复制，让重建模型和 cake 处在完全相同的坐标系里。
    n0 = next(i for i, n in enumerate(jc['nodes']) if n.get('name') == 'node_0')
    arm = next(i for i, n in enumerate(jc['nodes']) if n.get('name') == 'Armature')
    new_n0 = len(jr['nodes'])
    node0_copy = {k: v for k, v in jc['nodes'][n0].items() if k != 'children'}
    node0_copy['name'] = 'node_0'
    jr['nodes'].append(node0_copy)
    new_arm = len(jr['nodes'])
    arm_copy = {k: v for k, v in jc['nodes'][arm].items() if k != 'children'}
    arm_copy['name'] = 'Armature'
    jr['nodes'].append(arm_copy)
    jr['nodes'][new_n0]['children'] = [new_arm]
    jr['nodes'][new_arm]['children'] = [0, old2new[hips]]
    jr['scenes'][0]['nodes'] = [new_n0]
    jr['buffers'][0]['byteLength'] = len(br)
    jr['asset'] = dict(jr.get('asset', {}))
    jr['asset']['generator'] = 'cake rig transferred by tools/rig_transfer.py'

    size = write_glb(OUT, jr, br)
    print('WROTE %s  %.2f MB  nodes=%d skins=%d joints=%d'
          % (OUT, size / 1048576, len(jr['nodes']), len(jr['skins']),
             len(jr['skins'][0]['joints'])))


if __name__ == '__main__':
    main()
