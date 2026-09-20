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
    QCursor,
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
#:
#: `approval` and `question` are the two "the human is blocking the agent"
#: states. They are listed first because they are ranked highest: a pet that
#: keeps showing "working" while a permission dialog waits for an answer is
#: actively misleading, and the whole point of the pet is to say when the run
#: needs you.
KNOWN_MOODS = ("approval", "question", "idle", "thinking", "working", "happy", "error", "sleep")

#: Moods that mean the agent cannot proceed without the user.
ATTENTION_MOODS = ("approval", "question")

#: Mood used when state.json is missing or names something unknown.
DEFAULT_MOOD = "idle"

#: How long one placeholder frame is shown, in ms, per mood. Real sprite
#: folders carry their own pacing via frame count; this only drives the
#: procedural placeholder so it still feels alive.
PLACEHOLDER_FRAME_MS = 120

#: Frames in the attention halo's breath cycle. More frames than the plain
#: two-frame bob because a coarse pulse on a ring looks like a flicker.
ATTENTION_PULSE_FRAMES = 8

#: Frames in the one-shot poke reaction, and how fast they run. Short and
#: snappy: a reaction should feel like a flinch, not a mood.
POKE_FRAMES = 8
POKE_FRAME_MS = 60


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
    #
    # The two attention moods use saturated, warm-vs-cool distinct hues so they
    # are unmistakable at a glance from across the desk — their whole job is to
    # pull the eye when the agent is blocked.
    palette = {
        "idle": (QColor(120, 190, 255), QColor(80, 130, 240), QColor(28, 34, 48), None),
        "thinking": (QColor(186, 160, 255), QColor(130, 110, 235), QColor(28, 34, 48), None),
        "working": (QColor(120, 220, 200), QColor(70, 175, 165), QColor(28, 34, 48), None),
        "happy": (QColor(255, 210, 120), QColor(245, 165, 70), QColor(90, 55, 20), None),
        "error": (QColor(255, 150, 150), QColor(225, 95, 95), QColor(70, 20, 20), None),
        "sleep": (QColor(160, 170, 195), QColor(115, 125, 155), QColor(40, 45, 60), None),
        # Blocked on a permission decision: amber, the universal "needs you".
        "approval": (QColor(255, 196, 92), QColor(238, 148, 40), QColor(74, 44, 8), None),
        # Waiting on an answer: cyan, distinct from both idle blue and approval.
        "question": (QColor(120, 226, 240), QColor(58, 178, 205), QColor(16, 52, 64), None),
    }
    top, bottom, eye, accent = palette.get(mood, palette[DEFAULT_MOOD])

    # Gentle bob: idle sleeps breathe slowly, working moves faster. The
    # attention moods bob fastest so motion alone draws the eye even before the
    # colour registers.
    speed = {
        "idle": 1.0, "thinking": 1.4, "working": 2.0,
        "happy": 2.6, "error": 1.2, "sleep": 0.5,
        "approval": 2.8, "question": 2.4,
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
        # Wider eyes for error; widest for the attention moods, which read as
        # "alert and looking at you".
        scale_h = 1.25 if mood == "error" else 1.0
        if mood in ATTENTION_MOODS:
            scale_h = 1.4
        # The question mood glances sideways, which is what makes it read as
        # puzzled rather than merely alert.
        offset_x = size * 0.035 if mood == "question" else 0
        painter.setBrush(eye)
        for x in (left_x, right_x):
            painter.drawEllipse(
                int(x + offset_x), int(eye_y), int(eye_w), int(eye_h * scale_h),
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
    elif mood == "approval" or mood == "question":
        # A small round mouth reads as a soft "oh?" rather than the idle line.
        painter.setBrush(eye)
        painter.setPen(Qt.NoPen)
        painter.drawEllipse(
            int(size * 0.46), int(size * 0.63), int(size * 0.085), int(size * 0.085),
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

    # Attention moods: a pulsing halo ring. This is the strongest available
    # signal on a mostly-transparent window, and it reads from across a room
    # without being a flashing distraction — a slow breath, not a strobe.
    if mood in ATTENTION_MOODS:
        import math

        pulse = 0.5 + 0.5 * math.sin((frame_index % ATTENTION_PULSE_FRAMES)
                                     / ATTENTION_PULSE_FRAMES * 2 * math.pi)
        ring_alpha = int(70 + 110 * pulse)
        ring_width = max(1.5, size * (0.018 + 0.010 * pulse))
        ring_inset = size * (0.015 + 0.022 * pulse)
        halo = QColor(top)
        halo.setAlpha(ring_alpha)
        ring_pen = painter.pen()
        ring_pen.setColor(halo)
        ring_pen.setWidthF(ring_width)
        painter.setPen(ring_pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawEllipse(
            int(ring_inset), int(ring_inset + bob),
            int(size - 2 * ring_inset), int(size - 2 * ring_inset - bob),
        )
        painter.setPen(Qt.NoPen)

    painter.end()
    return pixmap


def draw_poke_frame(size: int, frame_index: int, total: int) -> QPixmap:
    """
    Draw one frame of the poke reaction.

    The shape is a squash-and-stretch: the pet flinches inward, overshoots
    outward, then eases back. Frames past the overshoot settle, so the strip
    ends exactly where the resting pose sits and the hand-off back to the mood
    animation is invisible.
    """
    import math

    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.transparent)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing, True)
    painter.setRenderHint(QPainter.SmoothPixmapTransform, True)

    t = frame_index / max(1, total)
    # The reaction is a damped spring that starts at full compression: the
    # impact frame is the first thing the eye sees, which is what makes the
    # click feel answered. Starting from rest instead would waste the one frame
    # the user is actually looking at on a pose indistinguishable from idle.
    decay = 1.0 - t
    wobble = math.cos(t * 2.5 * math.pi) * decay * 0.30
    squash = 1.0 + wobble
    lateral = math.sin(t * 3.5 * math.pi) * decay * size * 0.05
    # A vertical hop on the impact, damping out with the rest.
    hop = math.sin(t * math.pi) * decay * size * 0.06

    body_w = (size * 0.88) * squash
    body_h = (size * 0.88) / squash
    x = (size - body_w) / 2 + lateral
    y = (size - body_h) / 2 - hop

    gradient = QLinearGradient(0, y, 0, y + body_h)
    gradient.setColorAt(0.0, QColor(255, 214, 140))
    gradient.setColorAt(1.0, QColor(246, 166, 74))
    painter.setPen(Qt.NoPen)
    painter.setBrush(gradient)
    painter.drawEllipse(int(x), int(y), int(body_w), int(body_h))

    painter.setPen(QColor(255, 255, 255, 80))
    painter.setBrush(Qt.NoBrush)
    painter.drawEllipse(int(x), int(y), int(body_w), int(body_h))

    # Startled eyes: wide and short, riding the wobble.
    eye = QColor(74, 44, 8)
    eye_w = body_w * 0.11
    eye_h = body_h * 0.13
    eye_y = y + body_h * 0.40
    painter.setPen(Qt.NoPen)
    painter.setBrush(eye)
    painter.drawEllipse(int(x + body_w * 0.28), int(eye_y), int(eye_w), int(eye_h))
    painter.drawEllipse(int(x + body_w * 0.56), int(eye_y), int(eye_w), int(eye_h))

    # A round open mouth sells the little "oh!".
    painter.drawEllipse(
        int(x + body_w * 0.44), int(y + body_h * 0.62),
        int(body_w * 0.11), int(body_h * 0.11),
    )

    painter.end()
    return pixmap


def build_placeholder_animation(mood: str, size: int) -> Animation:
    """
    Build a placeholder animation for `mood`.

    Most moods need only two frames to suggest breathing. The attention moods
    drive a halo ring through a full cycle, so they get a longer strip — a
    two-frame pulse on a ring reads as a flicker rather than a breath.
    """
    if mood in ATTENTION_MOODS:
        frames = [draw_placeholder(mood, size, i) for i in range(ATTENTION_PULSE_FRAMES)]
        return Animation(frames=frames, frame_ms=PLACEHOLDER_FRAME_MS)
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

        # Alpha-sampling cache for hit testing, keyed by (mood, frame) so the
        # per-pixel lookup runs once per displayed frame rather than per mouse
        # move.
        self._alpha_cache = None
        self._alpha_cache_key = None

        # Poke reaction: frames, and how many are left to play (0 = not
        # playing). The last seen counter lets a poll tell a new poke from the
        # same one still sitting in state.json.
        self._poke_frames: List[QPixmap] = []
        self._poke_frames_left = 0
        self._last_poke_count = 0

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

        # Deliver mouse-move events even with no button held. Without this the
        # cursor could only update while dragging, because Qt suppresses
        # buttonless moves unless tracking is on.
        self.setMouseTracking(True)

        self._build_animations()
        self._build_poke_animation()
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
        # While the poke reaction plays it owns the frame; everything else
        # (hit testing, painting, sizing) reads through here, so the special
        # case lives in exactly one place.
        if self._poke_frames_left > 0 and self._poke_frames:
            index = min(self.frame_index, len(self._poke_frames) - 1)
            return self._poke_frames[index]
        return self._current_animation().frame_at(self.frame_index)

    def _resize_to_mood(self) -> None:
        pixmap = self._current_pixmap()
        if pixmap is None:
            return
        self._resize_for(pixmap)

    def _resize_for(self, pixmap: QPixmap) -> None:
        """Size the window to one frame, at the configured scale."""
        width = max(16, int(round(pixmap.width() * self.scale)))
        height = max(16, int(round(pixmap.height() * self.scale)))
        if (width, height) != (self.width(), self.height()):
            self.setFixedSize(width, height)

    # -- mood -------------------------------------------------------------

    def _build_poke_animation(self) -> None:
        """
        Build the one-shot "you poked me" reaction.

        Loaded from `<PetDir>/assets/poke/*.png` when supplied, otherwise drawn:
        a quick squash-and-stretch with a startled expression, which reads as a
        reaction rather than another mood.
        """
        frames = load_sprite_frames(self.pet_dir, "poke")
        if frames:
            self._poke_frames = frames
            log_line(self.pet_dir, f"poke reaction: {len(frames)} sprite frame(s)")
            return
        size = 160
        self._poke_frames = [draw_poke_frame(size, i, POKE_FRAMES) for i in range(POKE_FRAMES)]
        log_line(self.pet_dir, f"poke reaction: {POKE_FRAMES} drawn frame(s)")

    def _play_poke(self) -> None:
        """Start the poke reaction once, from the first frame."""
        if not self._poke_frames:
            return
        self._poke_frames_left = len(self._poke_frames)
        self.frame_index = 0
        self._resize_for(self._poke_frames[0])
        # A snappier cadence than the mood loop: this is a reaction, not a
        # resting state, so it should feel quick.
        self.frame_timer.start(POKE_FRAME_MS)
        self.update()

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
        # A mood change can resize the window and reshape the silhouette.
        self._refresh_cursor_if_inside()

    def _advance_frame(self) -> None:
        # A poke reaction owns the frames while it plays, then hands control
        # back to whatever mood is currently in effect.
        if self._poke_frames_left > 0:
            self._poke_frames_left -= 1
            self.frame_index = (self.frame_index + 1) % max(1, len(self._poke_frames))
            self.update()
            self._refresh_cursor_if_inside()
            if self._poke_frames_left == 0:
                # Reaction finished: restore the mood's own animation.
                self.frame_index = 0
                self._resize_to_mood()
                self.frame_timer.start(max(40, self._current_animation().frame_ms))
                self.update()
            return

        animation = self._current_animation()
        if not animation.frames:
            return
        self.frame_index = (self.frame_index + 1) % len(animation.frames)
        self.update()
        # The silhouette may have changed shape between frames, so a pointer
        # resting on an edge must be re-classified.
        self._refresh_cursor_if_inside()

    def _refresh_cursor_if_inside(self) -> None:
        """Re-evaluate the cursor, but only while the mouse is over the pet."""
        try:
            if not self.underMouse() or self._dragging:
                return
            self._update_cursor(self.mapFromGlobal(QCursor.pos()))
        except Exception:
            # A cursor probe must never break the animation loop.
            pass

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

    def _hits_pet(self, pos: QPoint) -> bool:
        """
        Whether a widget-local point lands on a visible pixel of the pet.

        The window is a transparent square around an arbitrary silhouette, so
        treating the whole rect as the pet would show a pointing hand over empty
        space. Sampling the frame's alpha keeps the cursor honest: the hand
        appears only where the artwork actually is.

        The lookup is memoised per frame because it runs on every mouse-move.
        """
        pixmap = self._current_pixmap()
        if pixmap is None:
            return False

        width, height = self.width(), self.height()
        if width <= 0 or height <= 0:
            return False

        # Map widget coordinates back onto the source pixmap.
        x = int(pos.x() * pixmap.width() / width)
        y = int(pos.y() * pixmap.height() / height)
        if x < 0 or y < 0 or x >= pixmap.width() or y >= pixmap.height():
            return False

        # A pixmap without an alpha channel is fully opaque: every point hits.
        if not pixmap.hasAlphaChannel():
            return True

        image = self._alpha_cache
        if image is None or self._alpha_cache_key != (self.mood, self.frame_index):
            image = pixmap.toImage()
            self._alpha_cache = image
            self._alpha_cache_key = (self.mood, self.frame_index)
        # A generous threshold keeps anti-aliased silhouette edges clickable.
        return image.pixelColor(x, y).alpha() > 8

    def _update_cursor(self, pos: Optional[QPoint] = None) -> None:
        """
        Point the cursor at the pet while the mouse is over it.

        A closed hand while dragging reads as "carrying the pet"; an open hand
        while merely hovering reads as "this is clickable".
        """
        if self._dragging and self._moved:
            self.setCursor(Qt.ClosedHandCursor)
            return
        if self._dragging:
            self.setCursor(Qt.OpenHandCursor)
            return
        point = pos if pos is not None else self.mapFromGlobal(QCursor.pos())
        self.setCursor(Qt.PointingHandCursor if self._hits_pet(point) else Qt.ArrowCursor)

    def enterEvent(self, event) -> None:  # noqa: N802
        self._update_cursor()

    def leaveEvent(self, event) -> None:  # noqa: N802
        # Hand the pointer back to whatever is underneath when we leave.
        self.setCursor(Qt.ArrowCursor)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self._dragging = True
            self._moved = False
            self._press_pos = event.pos()
            self._drag_offset = event.pos()
            self._update_cursor(event.pos())

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        self._update_cursor(event.pos())
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
        self._update_cursor(event.pos())
        if self._moved:
            self._save_position()
            merge_json(self.pet_file, {
                "x": self.x(), "y": self.y(),
                "event": "moved", "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            log_line(self.pet_dir, f"moved to {self.x()},{self.y()}")
        else:
            # A click (not a drag) plays the poke reaction, right here and
            # right now. Handling it locally is what makes the pet feel
            # responsive: routing it through the browser half would add a
            # poll-interval of latency to something that should be instant.
            # The click counter is still recorded so the shell can observe
            # clicks if it ever wants to.
            self._play_poke()
            current = read_json(self.pet_file) or {}
            clicks = int(current.get("clicks", 0)) + 1
            merge_json(self.pet_file, {
                "event": "click", "clicks": clicks,
                "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
            log_line(self.pet_dir, f"poked (count={clicks})")

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

        # A poke is a counter, not a flag: only a value higher than the last
        # one seen is a new poke, so the same entry sitting in the file does
        # not replay the reaction on every poll.
        pokes = state.get("pokes")
        if isinstance(pokes, int) and pokes > self._last_poke_count:
            self._last_poke_count = pokes
            self._play_poke()

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
