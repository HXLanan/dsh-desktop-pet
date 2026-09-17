"""
DSH Desktop Pet -- the pet window itself.

A frameless, always-on-top, per-pixel translucent window that floats on the
Windows desktop. It is launched by the dsh-desktop-pet host half through
ctx.subprocess, and can also be run standalone for debugging.

Transport: local JSON file polling (no network, no ports).

    state.json   <- written by the DSH host half; the pet reads mood/commands
    pet.json     -> written by the pet; reports liveness, position, clicks
    pos.json     -> written by the pet; remembered window position
    pet.log      -> diagnostic log

Animation model
---------------
Every mood maps to an `Animation`: an ordered list of QPixmap frames plus a
per-frame duration. Frames are loaded from `<PetDir>/assets/<mood>/*.png` when
that directory exists and holds at least one image; otherwise a procedurally
drawn placeholder is used so the pet always has something to show.

Run standalone:
    python pet.py --pet-dir <dir> [--scale 1.0] [--poll-ms 250]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from PyQt5.QtCore import QPoint, QTimer, Qt
from PyQt5.QtGui import (
    QColor,
    QFont,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPixmap,
    QRadialGradient,
)
from PyQt5.QtWidgets import QApplication, QMenu, QWidget

# --------------------------------------------------------------------------
# Moods
# --------------------------------------------------------------------------

#: Moods the pet understands. The DSH host half writes one of these into
#: state.json; an unknown value falls back to "idle".
KNOWN_MOODS = ("idle", "thinking", "working", "happy", "error", "sleep")

#: Mood used when state.json is missing or names something unknown.
DEFAULT_MOOD = "idle"

#: How long one placeholder frame is shown, in ms, per mood. Real sprite
#: folders carry their own pacing via frame count; this only drives the
#: procedural placeholder so it still feels alive.
PLACEHOLDER_FRAME_MS = 120


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def log_line(pet_dir: str, message: str) -> None:
    """Append one timestamped line to pet.log; never raise."""
    try:
        path = os.path.join(pet_dir, "pet.log")
        stamp = time.strftime("%H:%M:%S")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"[{stamp}] {message}\n")
    except Exception:
        pass


def read_json(path: str) -> Optional[dict]:
    """
    Read a JSON object from disk; return None when absent or unreadable.

    Decoded as `utf-8-sig` because the writer on the other side may be
    Windows PowerShell, whose `Set-Content -Encoding UTF8` prepends a BOM;
    that BOM is a hard parse error for a plain `utf-8` decode. The `-sig`
    codec strips it when present and is identical otherwise.
    """
    try:
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8-sig") as handle:
            raw = handle.read().strip()
        if not raw:
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def write_json(path: str, payload: dict) -> None:
    """Atomically write a JSON object (tmp + replace); never raise."""
    try:
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass


def merge_json(path: str, patch: dict) -> dict:
    """Read-modify-write `path`, preserving keys written by the other side."""
    current = read_json(path) or {}
    merged = dict(current)
    merged.update(patch)
    write_json(path, merged)
    return merged


# --------------------------------------------------------------------------
# Animation
# --------------------------------------------------------------------------


@dataclass
class Animation:
    """An ordered set of frames plus the display duration of each."""

    frames: List[QPixmap] = field(default_factory=list)
    frame_ms: int = PLACEHOLDER_FRAME_MS

    def __bool__(self) -> bool:
        return bool(self.frames)

    def frame_at(self, index: int) -> Optional[QPixmap]:
        if not self.frames:
            return None
        return self.frames[index % len(self.frames)]


def load_sprite_frames(pet_dir: str, mood: str) -> List[QPixmap]:
    """
    Load `<PetDir>/assets/<mood>/*.png` in natural sort order.

    Returns an empty list when the folder is missing or holds no loadable
    image, which makes the caller fall back to the drawn placeholder.
    """
    folder = os.path.join(pet_dir, "assets", mood)
    if not os.path.isdir(folder):
        return []

    def sort_key(name: str):
        """Natural sort so frame_2 precedes frame_10."""
        digits = "".join(ch if ch.isdigit() else " " for ch in name)
        return [int(part) if part.isdigit() else part.lower() for part in digits.split()]

    names = sorted(
        (n for n in os.listdir(folder) if n.lower().endswith(".png")),
        key=sort_key,
    )
    frames: List[QPixmap] = []
    for name in names:
        pixmap = QPixmap(os.path.join(folder, name))
        if not pixmap.isNull():
            frames.append(pixmap)
    return frames


# --------------------------------------------------------------------------
# Procedural placeholder art
# --------------------------------------------------------------------------


def draw_placeholder(mood: str, size: int, frame_index: int) -> QPixmap:
    """
    Draw one placeholder frame for `mood`.

    These exist so the whole pipeline can be exercised before real artwork is
    supplied: each mood varies hue, eye shape and a simple motion, which is
    enough to see state changes land on the pet.
    """
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.transparent)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing, True)
    painter.setRenderHint(QPainter.SmoothPixmapTransform, True)

    # Per-mood palette: (body top, body bottom, eye color, accent).
    palette = {
        "idle": (QColor(120, 190, 255), QColor(80, 130, 240), QColor(28, 34, 48), None),
        "thinking": (QColor(186, 160, 255), QColor(130, 110, 235), QColor(28, 34, 48), None),
        "working": (QColor(120, 220, 200), QColor(70, 175, 165), QColor(28, 34, 48), None),
        "happy": (QColor(255, 210, 120), QColor(245, 165, 70), QColor(90, 55, 20), None),
        "error": (QColor(255, 150, 150), QColor(225, 95, 95), QColor(70, 20, 20), None),
        "sleep": (QColor(160, 170, 195), QColor(115, 125, 155), QColor(40, 45, 60), None),
    }
    top, bottom, eye, accent = palette.get(mood, palette[DEFAULT_MOOD])

    # Gentle bob: idle sleeps breathe slowly, working moves faster.
    speed = {
        "idle": 1.0, "thinking": 1.4, "working": 2.0,
        "happy": 2.6, "error": 1.2, "sleep": 0.5,
    }.get(mood, 1.0)
    bob = int(round((size * 0.018) * speed * (1 if frame_index % 2 == 0 else -1)))

    margin = size * 0.06
    body = QPainterPath()
    body.addEllipse(margin, margin + bob, size - 2 * margin, size - 2 * margin - bob)

    gradient = QLinearGradient(0, margin, 0, size - margin)
    gradient.setColorAt(0.0, top)
    gradient.setColorAt(1.0, bottom)
    painter.fillPath(body, gradient)

    # Rim light along the top-left, which sells the "glassy" look.
    rim = QPainterPath()
    rim.addEllipse(margin, margin + bob, size - 2 * margin, size - 2 * margin - bob)
    painter.setPen(QColor(255, 255, 255, 70))
    painter.drawPath(rim)

    # Eyes: closed when sleeping, wide when surprised, crescents when happy.
    eye_w = size * 0.11
    eye_h = size * 0.15
    left_x, right_x = size * 0.30, size * 0.58
    eye_y = size * 0.42 + bob
    painter.setPen(Qt.NoPen)

    if mood == "sleep":
        pen = painter.pen()
        pen.setColor(eye)
        pen.setWidthF(max(1.5, size * 0.022))
        painter.setPen(pen)
        for x in (left_x, right_x):
            painter.drawArc(
                int(x * 1.0), int(eye_y), int(eye_w * 1.6), int(eye_h * 0.9),
                200 * 16, 140 * 16,
            )
        painter.setPen(Qt.NoPen)
    elif mood == "happy":
        pen = painter.pen()
        pen.setColor(eye)
        pen.setWidthF(max(1.5, size * 0.024))
        painter.setPen(pen)
        for x in (left_x, right_x):
            painter.drawArc(
                int(x * 1.0), int(eye_y), int(eye_w * 1.6), int(eye_h * 1.2),
                20 * 16, 140 * 16,
            )
        painter.setPen(Qt.NoPen)
    else:
        scale_h = 1.25 if mood == "error" else 1.0
        painter.setBrush(eye)
        for x in (left_x, right_x):
            painter.drawEllipse(
                int(x), int(eye_y), int(eye_w), int(eye_h * scale_h),
            )

    # Mouth: flat when idle, open when working, frown on error.
    mouth_pen = painter.pen()
    mouth_pen.setColor(eye)
    mouth_pen.setWidthF(max(1.5, size * 0.022))
    painter.setPen(mouth_pen)
    if mood == "error":
        painter.drawArc(
            int(size * 0.42), int(size * 0.66), int(size * 0.16), int(size * 0.10),
            20 * 16, 140 * 16,
        )
    elif mood == "happy":
        painter.setBrush(eye)
        painter.setPen(Qt.NoPen)
        painter.drawEllipse(
            int(size * 0.44), int(size * 0.62), int(size * 0.12), int(size * 0.10),
        )
    else:
        painter.drawArc(
            int(size * 0.43), int(size * 0.60), int(size * 0.14), int(size * 0.10),
            200 * 16, 140 * 16,
        )
    painter.setPen(Qt.NoPen)

    # Working: a small orbiting accent dot reads as "busy" at a glance.
    if mood == "working":
        import math

        angle = (frame_index % 8) / 8.0 * 2 * math.pi
        cx = size * 0.5 + math.cos(angle) * size * 0.34
        cy = size * 0.5 + math.sin(angle) * size * 0.34
        glow = QRadialGradient(cx, cy, size * 0.10)
        glow.setColorAt(0.0, QColor(255, 255, 255, 230))
        glow.setColorAt(1.0, QColor(255, 255, 255, 0))
        painter.setBrush(glow)
        painter.drawEllipse(
            int(cx - size * 0.10), int(cy - size * 0.10),
            int(size * 0.20), int(size * 0.20),
        )

    painter.end()
    return pixmap


def build_placeholder_animation(mood: str, size: int) -> Animation:
    """Two procedurally drawn frames are enough to suggest breathing."""
    return Animation(frames=[draw_placeholder(mood, size, 0),
                             draw_placeholder(mood, size, 1)])


# --------------------------------------------------------------------------
# The pet window
# --------------------------------------------------------------------------


class PetWindow(QWidget):
    """Frameless, translucent, always-on-top pet."""

    def __init__(self, pet_dir: str, scale: float = 1.0, poll_ms: int = 250):
        super().__init__()

        self.pet_dir = pet_dir
        self.scale = scale
        self.state_file = os.path.join(pet_dir, "state.json")
        self.pet_file = os.path.join(pet_dir, "pet.json")
        self.pos_file = os.path.join(pet_dir, "pos.json")

        self.mood = DEFAULT_MOOD
        self.animations: Dict[str, Animation] = {}
        self.frame_index = 0

        self._dragging = False
        self._drag_offset = QPoint()
        self._press_pos = QPoint()
        self._moved = False

        # Window flags: no frame, no taskbar entry, stay on top, never steal
        # focus from the user's work.
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
            | Qt.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        self.setWindowTitle("DSH Desktop Pet")

        self._build_animations()
        self._resize_to_mood()
        self._restore_position()

        # Frame ticker.
        self.frame_timer = QTimer(self)
        self.frame_timer.timeout.connect(self._advance_frame)

        # State poller.
        self.poll_timer = QTimer(self)
        self.poll_timer.timeout.connect(self._poll_state)
        self.poll_timer.start(max(60, poll_ms))

        # Heartbeat.
        self.hb_timer = QTimer(self)
        self.hb_timer.timeout.connect(self._heartbeat)
        self.hb_timer.start(2000)

        self._apply_mood(DEFAULT_MOOD, announce=False)

    # -- artwork ----------------------------------------------------------

    def _build_animations(self) -> None:
        """Load sprite folders, falling back to drawn placeholders per mood."""
        base_size = 160
        for mood in KNOWN_MOODS:
            frames = load_sprite_frames(self.pet_dir, mood)
            if frames:
                self.animations[mood] = Animation(frames=frames)
                log_line(self.pet_dir, f"mood '{mood}': {len(frames)} sprite frame(s)")
            else:
                self.animations[mood] = build_placeholder_animation(mood, base_size)
        log_line(self.pet_dir, "animations ready")

    def _current_animation(self) -> Animation:
        return self.animations.get(self.mood) or self.animations[DEFAULT_MOOD]

    def _current_pixmap(self) -> Optional[QPixmap]:
        return self._current_animation().frame_at(self.frame_index)

    def _resize_to_mood(self) -> None:
        pixmap = self._current_pixmap()
        if pixmap is None:
            return
        width = max(16, int(round(pixmap.width() * self.scale)))
        height = max(16, int(round(pixmap.height() * self.scale)))
        if (width, height) != (self.width(), self.height()):
            self.setFixedSize(width, height)

    # -- mood -------------------------------------------------------------

    def _apply_mood(self, mood: str, announce: bool = True) -> None:
        if mood not in self.animations:
            mood = DEFAULT_MOOD
        changed = mood != self.mood
        self.mood = mood
        self.frame_index = 0
        self._resize_to_mood()
        interval = self._current_animation().frame_ms
        self.frame_timer.start(max(40, interval))
        if changed and announce:
            log_line(self.pet_dir, f"mood -> {mood}")
        self.update()

    def _advance_frame(self) -> None:
        animation = self._current_animation()
        if not animation.frames:
            return
        self.frame_index = (self.frame_index + 1) % len(animation.frames)
        self.update()

    # -- position ---------------------------------------------------------

    def _restore_position(self) -> None:
        """Restore the saved spot, else park at the bottom-right corner."""
        screen = QApplication.primaryScreen()
        available = screen.availableGeometry() if screen else None

        saved = read_json(self.pos_file) or {}
        x, y = saved.get("x"), saved.get("y")
        if isinstance(x, int) and isinstance(y, int):
            for candidate in QApplication.screens():
                if candidate.availableGeometry().contains(QPoint(x, y)):
                    self.move(x, y)
                    log_line(self.pet_dir, f"restored position {x},{y}")
                    return
        if available is not None:
            self.move(
                available.right() - self.width() - 40,
                available.bottom() - self.height() - 40,
            )

    def _save_position(self) -> None:
        write_json(self.pos_file, {"x": self.x(), "y": self.y()})

    # -- painting ---------------------------------------------------------

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt naming)
        pixmap = self._current_pixmap()
        if pixmap is None:
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.SmoothPixmapTransform, True)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.drawPixmap(self.rect(), pixmap)

    # -- interaction ------------------------------------------------------

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._dragging = True
            self._moved = False
            self._press_pos = event.pos()
            self._drag_offset = event.pos()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if not self._dragging:
            return
        delta = event.pos() - self._press_pos
        if abs(delta.x()) > 3 or abs(delta.y()) > 3:
            self._moved = True
        if self._moved:
            self.move(self.pos() + event.pos() - self._drag_offset)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if event.button() != Qt.LeftButton:
            return
        self._dragging = False
        if self._moved:
            self._save_position()
            merge_json(self.pet_file, {
                "x": self.x(), "y": self.y(),
                "event": "moved", "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            log_line(self.pet_dir, f"moved to {self.x()},{self.y()}")
        else:
            # A click (not a drag) asks DSH to open the conversation.
            current = read_json(self.pet_file) or {}
            clicks = int(current.get("clicks", 0)) + 1
            merge_json(self.pet_file, {
                "event": "click", "clicks": clicks,
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            log_line(self.pet_dir, f"clicked (count={clicks}) -> request conversation")

    def contextMenuEvent(self, event) -> None:  # noqa: N802
        menu = QMenu(self)
        act_idle = menu.addAction("Idle")
        act_think = menu.addAction("Thinking")
        act_work = menu.addAction("Working")
        act_happy = menu.addAction("Happy")
        act_error = menu.addAction("Error")
        act_sleep = menu.addAction("Sleep")
        menu.addSeparator()
        act_quit = menu.addAction("Quit pet")

        chosen = menu.exec_(event.globalPos())
        mapping = {
            act_idle: "idle", act_think: "thinking", act_work: "working",
            act_happy: "happy", act_error: "error", act_sleep: "sleep",
        }
        if chosen in mapping:
            self._apply_mood(mapping[chosen])
        elif chosen == act_quit:
            self.close()

    # -- polling ----------------------------------------------------------

    def _poll_state(self) -> None:
        state = read_json(self.state_file)
        if not state:
            return

        mood = state.get("mood")
        if isinstance(mood, str) and mood and mood != self.mood:
            self._apply_mood(mood)

        if "visible" in state:
            want = bool(state.get("visible"))
            if want != self.isVisible():
                self.setVisible(want)

    def _heartbeat(self) -> None:
        merge_json(self.pet_file, {
            "alive": True,
            "pid": os.getpid(),
            "x": self.x(),
            "y": self.y(),
            "mood": self.mood,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        })

    # -- lifecycle --------------------------------------------------------

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        self._heartbeat()
        merge_json(self.pet_file, {
            "alive": True, "ready": True, "pid": os.getpid(),
            "x": self.x(), "y": self.y(), "mood": self.mood,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        })
        log_line(self.pet_dir, f"shown at {self.x()},{self.y()} size {self.width()}x{self.height()}")

    def closeEvent(self, event) -> None:  # noqa: N802
        self.frame_timer.stop()
        self.poll_timer.stop()
        self.hb_timer.stop()
        self._save_position()
        write_json(self.pet_file, {
            "alive": False, "event": "quit",
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        })
        log_line(self.pet_dir, "closing, pet exits")
        super().closeEvent(event)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def single_instance_pid(pet_file: str) -> Optional[int]:
    """Return the PID of a live pet reported in pet.json, if any."""
    info = read_json(pet_file)
    if not info or info.get("alive") is not True:
        return None
    pid = info.get("pid")
    if not isinstance(pid, int):
        return None
    if pid == os.getpid():
        return None
    try:
        os.kill(pid, 0)  # liveness probe; raises when the process is gone
        return pid
    except OSError:
        return None


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="DSH Desktop Pet window")
    parser.add_argument("--pet-dir", required=True, help="working directory for state files")
    parser.add_argument("--image", default="", help="optional single image to show")
    parser.add_argument("--scale", type=float, default=1.0, help="scale factor")
    parser.add_argument("--poll-ms", type=int, default=250, help="state poll interval")
    parser.add_argument("--allow-multiple", action="store_true",
                        help="skip the single-instance guard (debugging)")
    args = parser.parse_args(argv)

    pet_dir = os.path.abspath(args.pet_dir)
    os.makedirs(pet_dir, exist_ok=True)

    if not args.allow_multiple:
        existing = single_instance_pid(os.path.join(pet_dir, "pet.json"))
        if existing is not None:
            log_line(pet_dir, f"another pet is alive (PID {existing}); exiting")
            return 0

    log_line(pet_dir, f"python pet starting: pid={os.getpid()} scale={args.scale}")

    app = QApplication(sys.argv[:1])
    app.setQuitOnLastWindowClosed(True)

    window = PetWindow(pet_dir, scale=args.scale, poll_ms=args.poll_ms)

    # An explicit --image overrides the idle animation with a single still.
    if args.image and os.path.isfile(args.image):
        pixmap = QPixmap(args.image)
        if not pixmap.isNull():
            window.animations["idle"] = Animation(frames=[pixmap])
            window._apply_mood("idle", announce=False)
            log_line(pet_dir, f"using --image {args.image}")

    window.show()
    return app.exec_()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # A crash here would be invisible in a detached process, so record it.
        try:
            fallback_dir = os.path.dirname(os.path.abspath(__file__))
            log_line(fallback_dir, "FATAL:\n" + traceback.format_exc())
        except Exception:
            pass
        raise
