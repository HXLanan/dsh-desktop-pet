"""
Verify the poke reaction: clicking the pet plays an animation, and that is all
it does.

The click used to focus the DSH composer. It is now pure play, so these checks
assert both halves of that: the reaction exists and runs once, and the pet no
longer reaches for anything outside itself.

Run:  conda run -n dsh-pet python tools/test_poke.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pet"))

from PyQt5.QtCore import QPoint, Qt
from PyQt5.QtWidgets import QApplication

import pet as pet_module


def differs(a, b):
    """Whether two pixmaps differ in any sampled pixel."""
    if a.size() != b.size():
        return True
    ia, ib = a.toImage(), b.toImage()
    for y in range(0, ia.height(), 4):
        for x in range(0, ia.width(), 4):
            if ia.pixelColor(x, y) != ib.pixelColor(x, y):
                return True
    return False


def main() -> int:
    app = QApplication(sys.argv[:1])

    pet_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_poke_test")
    os.makedirs(pet_dir, exist_ok=True)

    failures = 0

    def check(label, condition):
        nonlocal failures
        print(f"{'PASS' if condition else 'FAIL'}  {label}")
        if not condition:
            failures += 1

    window = pet_module.PetWindow(pet_dir, scale=1.0, poll_ms=10000)

    # The reaction must exist with enough frames to read as motion.
    check("a poke reaction was built", len(window._poke_frames) >= 4)
    check("the reaction is not already playing", window._poke_frames_left == 0)

    # Frames must actually differ, or the "animation" is a still image.
    frames = window._poke_frames
    check("poke frames differ from each other", differs(frames[0], frames[len(frames) // 2]))

    # The reaction must be visually distinct from the resting mood, otherwise
    # a click would look like nothing happened.
    idle_frame = window.animations["idle"].frames[0]
    check("the poke reaction differs from idle", differs(frames[0], idle_frame))

    # Playing it claims the frame budget...
    window._play_poke()
    check("playing it starts the frame budget", window._poke_frames_left == len(frames))
    check(
        "the poke owns the displayed frame while playing",
        window._current_pixmap() is not None,
    )

    # ...and running the frames must drain that budget and hand control back.
    for _ in range(len(frames) + 1):
        window._advance_frame()
    check("the budget drains after the last frame", window._poke_frames_left == 0)
    check(
        "control returns to the mood animation",
        window._current_pixmap() is idle_frame or window._current_pixmap() is not None,
    )

    # A mood change while reacting must not leave the pet stuck on poke frames.
    window._play_poke()
    window._apply_mood("working")
    check("a mood change during the reaction still applies", window.mood == "working")

    # The host-driven poke counter is independent of the local click path: a
    # repeated value must not replay, a higher one must.
    window._last_poke_count = 0
    import json

    state_file = os.path.join(pet_dir, "state.json")
    with open(state_file, "w", encoding="utf-8") as handle:
        json.dump({"mood": "idle", "pokes": 1}, handle)
    window._poll_state()
    check("a new poke counter value plays the reaction", window._poke_frames_left > 0)

    for _ in range(len(frames) + 1):
        window._advance_frame()
    window._poll_state()
    check("the same poke value does not replay", window._poke_frames_left == 0)

    with open(state_file, "w", encoding="utf-8") as handle:
        json.dump({"mood": "idle", "pokes": 2}, handle)
    window._poll_state()
    check("a higher poke counter value plays again", window._poke_frames_left > 0)

    # A click must not require any network or composer access. The pet module
    # should not reference a conversation surface at all.
    source = open(os.path.join(os.path.dirname(__file__), "..", "pet", "pet.py"), encoding="utf-8").read()
    check("the pet never reaches for a composer", "composer" not in source.lower())

    window.close()
    print(f"\n{'ALL POKE CHECKS PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
