"""
Verify the two attention moods render distinctly.

The pet is only useful as a permission signal if "needs you" is visually
unmistakable, so these checks assert the properties that make it so: the mood
is known, its animation carries a full pulse cycle, its pixels actually differ
from idle, and the halo really varies across the cycle.

Run:  conda run -n dsh-pet python tools/test_attention_moods.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pet"))

from PyQt5.QtWidgets import QApplication

import pet as pet_module


def mean_alpha(pixmap):
    """Average alpha over the image — a cheap proxy for "how much halo"."""
    image = pixmap.toImage()
    total = 0
    count = 0
    for y in range(0, image.height(), 2):
        for x in range(0, image.width(), 2):
            total += image.pixelColor(x, y).alpha()
            count += 1
    return total / max(1, count)


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

    failures = 0

    def check(label, condition):
        nonlocal failures
        print(f"{'PASS' if condition else 'FAIL'}  {label}")
        if not condition:
            failures += 1

    size = 160

    # The moods must be registered, or the host could push a state the pet
    # silently renders as idle.
    for mood in ("approval", "question"):
        check(f"'{mood}' is a known mood", mood in pet_module.KNOWN_MOODS)
    check(
        "attention moods are grouped for reuse",
        set(pet_module.ATTENTION_MOODS) == {"approval", "question"},
    )

    # A two-frame halo would flicker; the strip must carry a real cycle.
    approval_anim = pet_module.build_placeholder_animation("approval", size)
    question_anim = pet_module.build_placeholder_animation("question", size)
    check(
        "the approval halo has a full pulse cycle",
        len(approval_anim.frames) == pet_module.ATTENTION_PULSE_FRAMES,
    )
    check(
        "the question halo has a full pulse cycle",
        len(question_anim.frames) == pet_module.ATTENTION_PULSE_FRAMES,
    )

    # The halo must actually breathe rather than sit at one opacity.
    alphas = [mean_alpha(f) for f in approval_anim.frames]
    check(
        "the halo brightness varies across the cycle",
        max(alphas) - min(alphas) > 2.0,
    )

    # Approval and question must be distinguishable from each other and from
    # idle — otherwise the two states would be indistinguishable on screen.
    idle_frame = pet_module.draw_placeholder("idle", size, 0)
    approval_frame = approval_anim.frames[0]
    question_frame = question_anim.frames[0]
    check("approval looks different from idle", differs(approval_frame, idle_frame))
    check("question looks different from idle", differs(question_frame, idle_frame))
    check("approval looks different from question", differs(approval_frame, question_frame))

    print(
        f"\n{'ALL ATTENTION MOOD CHECKS PASSED' if failures == 0 else f'{failures} CHECK(S) FAILED'}"
    )
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
