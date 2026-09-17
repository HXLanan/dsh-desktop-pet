"""Generate a small PNG sprite set so the asset pipeline can be verified
without waiting for the real artwork."""
import os, math
from PyQt5.QtGui import QPixmap, QPainter, QColor, QLinearGradient, QRadialGradient
from PyQt5.QtCore import Qt
from PyQt5.QtWidgets import QApplication
import sys

app = QApplication(sys.argv[:1])
base = r"D:\DeepseekHarness\plugins\dsh-desktop-pet\pet\_assets_test"
size = 128
palette = {
    "idle":     ((120,190,255),(80,130,240)),
    "thinking": ((186,160,255),(130,110,235)),
    "happy":    ((255,210,120),(245,165,70)),
}
made = 0
for mood,(top,bot) in palette.items():
    folder = os.path.join(base, "assets", mood)
    os.makedirs(folder, exist_ok=True)
    for i in range(6):
        pm = QPixmap(size, size); pm.fill(Qt.transparent)
        p = QPainter(pm); p.setRenderHint(QPainter.Antialiasing)
        # Squash/stretch to make motion obvious in the frame sequence.
        t = i / 6.0
        squash = 1.0 + 0.12 * math.sin(t * 2 * math.pi)
        w = size * 0.82 / squash
        h = size * 0.82 * squash
        x = (size - w) / 2; y = (size - h) / 2
        g = QLinearGradient(0, y, 0, y + h)
        g.setColorAt(0, QColor(*top, 255)); g.setColorAt(1, QColor(*bot, 255))
        p.setBrush(g); p.setPen(Qt.NoPen)
        p.drawEllipse(int(x), int(y), int(w), int(h))
        # A rotating dot proves frames are really being cycled.
        ang = t * 2 * math.pi
        cx = size/2 + math.cos(ang) * size*0.34
        cy = size/2 + math.sin(ang) * size*0.34
        rg = QRadialGradient(cx, cy, size*0.11)
        rg.setColorAt(0, QColor(255,255,255,235)); rg.setColorAt(1, QColor(255,255,255,0))
        p.setBrush(rg); p.drawEllipse(int(cx-size*0.11), int(cy-size*0.11), int(size*0.22), int(size*0.22))
        p.end()
        path = os.path.join(folder, f"frame_{i+1:02d}.png")
        pm.save(path, "PNG")
        made += 1
print(f"generated {made} frames under {base}")
