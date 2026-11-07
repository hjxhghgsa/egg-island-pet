import io

p = 'renderer/pet.js'
s = io.open(p, encoding='utf-8').read()

# 1) 探头姿态：只露头 + 歪着，身体全在画外
old = """  const peekDir = peekEdge === 'left' ? -1 : 1;
  const peekOff = peekDir * 1.14 * peekAmt;
  const peekLift = 0.56 * peekAmt;
  holder.position.x = walkX + peekOff + resistX;
  holder.position.y = peekLift;
  holder.rotation.z = peekDir * 1.36 * peekAmt;   // 横过来（78°，全躺会看不清脸）"""
new = """  const peekDir = peekEdge === 'left' ? -1 : 1;
  const peekOff = peekDir * 1.52 * peekAmt;   // 推得更远：只剩脑袋，身体全在画外
  const peekLift = 0.62 * peekAmt;
  holder.position.x = walkX + peekOff + resistX;
  holder.position.y = peekLift;
  holder.rotation.z = peekDir * 0.5 * peekAmt;   // 只歪 28°，是「歪着头」而不是躺平"""
assert old in s, 'peek block missing'
s = s.replace(old, new, 1)

# 2) 两只小手扒在边框上（模型袖子太长，手看不见，这里补两个小手）
anchor = "/* ---------------- 打字键盘 ----------------"
hands = """/* ---------------- 扒边的小手 ----------------
   模型的袖子把手包住了，做不出「手指抠住边沿」。
   所以在屏幕边框位置放两只小手（半球 + 四根短手指），只在探头时出现。 */
const peekingHands = new THREE.Group();
peekingHands.visible = false;
scene.add(peekingHands);

const handMat = new THREE.MeshStandardMaterial({ color: 0xffd8c2, roughness: 0.72 });
for (let i = 0; i < 2; i++) {
  const hand = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 10), handMat);
  palm.scale.set(1, 0.82, 0.75);
  hand.add(palm);
  for (let f = 0; f < 4; f++) {
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.013, 0.035, 3, 6), handMat);
    finger.position.set((f - 1.5) * 0.028, 0.05, 0.008);
    finger.rotation.z = (f - 1.5) * 0.12;
    hand.add(finger);
  }
  hand.userData.side = i === 0 ? 'top' : 'bottom';
  peekingHands.add(hand);
}
let handsAmt = 0;

/* ---------------- 打字键盘 ----------------"""
assert anchor in s
s = s.replace(anchor, hands, 1)

# 3) 每帧摆小手：贴在窗口那条边上，跟着呼吸轻轻动
anchor2 = "  // 撒花：四周依次绽开，偶尔飘落花瓣"
handsTick = """  // 小手贴在窗口内侧那条边上，像抓着边框
  handsAmt += ((peekAmt > 0.15 ? 1 : 0) - handsAmt) * Math.min(1, dt * 6);
  peekingHands.visible = handsAmt > 0.03;
  if (peekingHands.visible) {
    const hx = (peekEdge === 'left' ? -1 : 1) * 0.63;   // 窗口内侧约 63% 处
    peekingHands.children.forEach((hand, i) => {
      const bob = Math.sin(t * 2.2 + i * 1.6) * 0.012;
      hand.position.set(hx, 0.86 + (i === 0 ? 0.10 : -0.02) + bob, 0.16);
      hand.rotation.z = (peekEdge === 'left' ? 1 : -1) * (0.5 + bob * 3);
      hand.scale.setScalar(0.85 + handsAmt * 0.15);
      hand.visible = handsAmt > 0.4;
    });
  }

  // 撒花：四周依次绽开，偶尔飘落花瓣"""
assert anchor2 in s
s = s.replace(anchor2, handsTick, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
