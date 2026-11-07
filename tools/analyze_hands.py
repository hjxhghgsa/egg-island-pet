#!/usr/bin/env python3
"""量一下各模型「手部区域」有没有可驱动的顶点，以及手指骨权重缺多少。

IBM_i 就是 joint 在网格坐标系里 bind 世界矩阵的逆，所以对刚体矩阵取
-R^T * t 就能得到每根骨骼的位置，不用自己沿父链推坐标转换。
然后用它跟 POSITION 做距离统计，判断补权重有没有意义。

用法： python tools/analyze_hands.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inspect_rig import load, read_acc, from_gltf  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, 'models')


def joint_positions(ibms):
    """刚体矩阵 M=[R|t] 的逆是 [R^T | -R^T t]，取平移就是骨骼 bind 位置。"""
    out = []
    for ibm in ibms:
        m = from_gltf(ibm)
        t = [m[i][3] for i in range(3)]
        p = [-sum(m[i][c] * t[i] for i in range(3)) for c in range(3)]
        out.append(tuple(p))
    return out


def main():
    for f in ['character-cake.glb', 'character-jade.glb', 'character-rebuilt-rigged.glb']:
        j, b = load(os.path.join(MODELS, f))
        pr = j['meshes'][0]['primitives'][0]
        pos = read_acc(j, b, pr['attributes']['POSITION'])
        js = read_acc(j, b, pr['attributes']['JOINTS_0'])
        ws = read_acc(j, b, pr['attributes']['WEIGHTS_0'])
        ibms = read_acc(j, b, j['skins'][0]['inverseBindMatrices'])
        names = [j['nodes'][x].get('name', '') for x in j['skins'][0]['joints']]
        jp = joint_positions(ibms)

        finger_idx = [i for i, n in enumerate(names)
                      if any(k in n for k in ('Index', 'Middle', 'Ring', 'Pinky', 'Thumb'))]
        weighted = set()
        for a, w in zip(js, ws):
            for k in range(4):
                if w[k] > 0.001:
                    weighted.add(a[k])

        print('\n=== %s ===' % f)
        print('verts=%d  fingerBones=%d  fingerBonesWithWeight=%d'
              % (len(pos), len(finger_idx), sum(1 for i in finger_idx if i in weighted)))
        for rad in (0.03, 0.06, 0.10):
            near = 0
            for p in pos:
                for i in finger_idx:
                    q = jp[i]
                    if (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 < rad ** 2:
                        near += 1
                        break
            print('  verts within %.2f of any finger bone: %d' % (rad, near))
        print('  sample finger joints:')
        for i in finger_idx[:4]:
            print('    %-32s pos=(%.3f, %.3f, %.3f) weighted=%s'
                  % (names[i], *jp[i], i in weighted))


if __name__ == '__main__':
    main()
