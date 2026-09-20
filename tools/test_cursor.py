"""
Verify the pet's hover cursor behaviour headlessly.

Loads the real PetWindow, then asserts the alpha-based hit test and the cursor
state transitions, so "the pointer turns into a hand over the pet" is checked
by machine rather than by eye.

Run:  conda run -n dsh-pet python tools/test_cursor.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pet"))

from PyQt5.QtCore import QPoint, Qt
from PyQt5.QtWidgets import QApplication

import pet as pet_module


def main() -> int:
    app = QApplication(sys.argv[:1])

    pet_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cursor_test")
    os.makedirs(pet_dir, exist_ok=True)

    window = pet_module.PetWindow(pet_dir, scale=1.0, poll_ms=10000)

    failures = 0

    def check(label, condition):
        nonlocal failures
        print(f"{'PASS' if condition else 'FAIL'}  {label}")
        if not condition:
            failures += 1

    width, height = window.width(), window.height()
    print(f"window size: {width}x{height}")

    center = QPoint(width // 2, height // 2)
    corner = QPoint(1, 1)

    # The placeholder art is an ellipse inset from the window edge, so the
    # center is inside the silhouette and the very corner is outside it.
    check("center of the pet counts as a hit", window._hits_pet(center) is True)
    check("the window corner is outside the silhouette", window._hits_pet(corner) is False)

    # Cursor state transitions.
    window._dragging = False
    window._moved = False
    window._update_cursor(center)
    check("hovering the pet points the hand", window.cursor().shape() == Qt.PointingHandCursor)

    window._update_cursor(corner)
    check("hovering empty space restores the arrow", window.cursor().shape() == Qt.ArrowCursor)

    # Drag states.
    window._dragging = True
    window._moved = True
    window._update_cursor(center)
    check("dragging shows the closed hand", window.cursor().shape() == Qt.ClosedHandCursor)

    window._moved = False
    window._update_cursor(center)
    check("pressing without moving shows the open hand", window.cursor().shape() == Qt.OpenHandCursor)

    window._dragging = False
    window._moved = False

    # Mouse tracking must be on, or Qt never delivers buttonless moves and the
    # cursor could not follow the pointer at all.
    check("mouse tracking is enabled", window.hasMouseTracking() is True)

    # The alpha cache must key on the displayed frame.
    window._update_cursor(center)
    first_key = window._alpha_cache_key
    window.frame_index = (window.frame_index + 1) % len(window._current_animation().frames)
    window._update_cursor(center)
    check("alpha cache follows the frame change", window._alpha_cache_key != first_key)

    window.close()
    print(f"\n{'ALL CURSOR CHECKS PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
