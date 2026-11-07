# tools/ — 生成期与诊断期工具

这些是**开发期**脚本，全部只用 Python 标准库，没有第三方依赖。
桌宠运行时不需要 Python，`package.json` 的 `build.files` 也不会把它们打进安装包；
它们只随 git 源码分发，用来复现 / 修改 3D 重建流水线。

| 脚本 | 作用 | 产物 / 输出 |
| --- | --- | --- |
| `rig_transfer.py` | 把蛋糕纯的 47 根骨骼、蒙皮权重、`inverseBindMatrices` 和父链迁移到 AI 重建的静态网格；另外移植蛋糕纯的手掌 + 十根手指 | `models/character-rebuilt-rigged.glb` |
| `inspect_rig.py` | 校验 glTF 绑定姿势是否自洽、打印骨骼父链与各节点变换 | 控制台报告 |
| `analyze_hands.py` | 统计各模型手部区域顶点数与手指骨权重覆盖，判断补权重有没有意义 | 控制台报告 |

## 典型工作流

```bash
# 1. 重新生成带骨架的重建模型（改了参考模型 / 权重参数之后）
python tools/rig_transfer.py

# 2. 校验：cake 与重建版的 bind pose 误差都应该是 0.000000
python tools/inspect_rig.py

# 3. 查手指几何与权重覆盖
python tools/analyze_hands.py
```

`rig_transfer.py` 支持两个调参环境变量：

- `RIG_ALIGN_YAW=<角度>`：重建顶点旋进 cake 坐标系的绕 Y 角度，默认 `90`。
  实测 `-90` 会变成背面，别乱改。
- `RIG_OUT=<路径>`：改输出路径，避免调参时覆盖正式模型。

## 几个别再踩的坑

1. **只搬 `Hips` 子树不够**。cake 的 mesh 和骨骼共同挂在 `node_0` 下，
   那层带 `Ry(-90°)` 坐标转换；丢掉它网格不撕裂，但人会恒定侧倾、
   动画方向整体偏 90°，极像「AI 生成的模型本来就歪」。
2. **判定 bind pose 不要看 `jointWorld×IBM ≈ I`**。glTF 允许把坐标转换放在
   共同父节点上，此时 IBM 不含那层，正确指标是与 `meshWorld` 相等。
3. **重建模型没有手指几何**（手指骨 0.03 半径内 0 顶点）。光补权重看不见东西，
   所以 `rig_transfer.py` 直接从 cake 移植整双手，25 根手指骨全带权重。
4. 用 `python tools/inspect_rig.py <a.glb> <b.glb>` 可以同时对比任意两份 GLB。

## 窗口截图验收

生成期工具只管 GLB；渲染效果要用 Electron 的调试钩子截图（见根目录 README「开发」章节）：

```bash
env -u ELECTRON_RUN_AS_NODE \
  PET_TEST_USERDATA=<隔离目录> PET_MODEL=rebuilt PET_HIDE_FX=1 \
  PET_SHOT_WIN=<输出.png> PET_SHOT_DELAY=6200 \
  PET_GESTURE=wave PET_GESTURE_DELAY=6000 \
  ./node_modules/.bin/electron .
```
