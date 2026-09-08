# Q 版飞机素材与机头方向

- 已替换桌面、平板、手机棋盘中 48 个飞机图层；大厅插画沿用用户已确认的 Q 版参考。
- 原始素材：`assets/planes-q-atlas.png`；网页与 Pixso 同一版本：`assets/planes-q-atlas.jpg`（仅格式转换）。
- 生成方式：内置 imagegen。以用户提供的 Q 版飞机参考为样式输入，未使用 CLI 回退。
- 本地 Pixso 导出参考（不纳入 Git）：`design/pixso-export/qplanes/source.html`，159 个图片/字体资源已本地化；实际网页复用既有语义按钮与布局，替换素材并实现动态机头方向。

## 可见度

实际棋子以原色不透明显示，取消与棋盘的正片叠底混合。用小面积圆形浅色衬底和柔和阴影分离飞机与彩色格，半透明仅用于落点预览。

## 方向行为

- 在机场面向起飞点；停在跑道上面向下一格。
- 走步、跳跃、飞行和被撞回机场时，先转向本段目标，再沿直线移动。每次转向选择不超过 180° 的短路径。
- 终点反弹时转回返程方向；停稳后再面向下一次前进方向。
- 只旋转飞机图案，编号与点击目标保持正向。减少动态效果设置下直接显示最终状态。

## 最终生成提示词

Use case: stylized-concept. Asset type: a single production game sprite atlas, four matching cute toy airplane sprites in a precise equal 2 by 2 grid. Use the attached user image as the STYLE reference: round chubby plastic toy bodies, thick broad rounded wings, large ivory cockpit windshield, soft glossy shading, adorable proportions. Adapt to a strictly overhead top-down orthographic view so the airplane nose direction is unambiguous. Every plane nose points straight UP to twelve o'clock, tail at bottom, wings symmetric left/right. Top-left coral red (#EF775D), top-right warm golden yellow (#F1BC46), bottom-left sky blue (#539DC8), bottom-right mint green (#75B5A0). Same exact silhouette, geometry, scale and alignment in all four quadrants. Each plane centered exactly in its own quadrant, fully visible, occupying 78 percent of quadrant width and height, with generous even white margins and no overlaps across quadrants. Rounded blunt nose and bulbous body, visibly wide stubby wings, small tail wings; not skinny, not an airliner, not a missile, no propellers, no tiny lines. Pure solid WHITE background #FFFFFF everywhere outside aircraft, flat empty and NO ground shadows, no gradient, no checkered transparency pattern, no dice, no trails, no text, no border or grid lines. Clean high quality 3D clay-toy material with readable contrast at 32 px. Square atlas canvas.
