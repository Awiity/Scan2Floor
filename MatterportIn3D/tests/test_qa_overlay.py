"""Testy QA overlay — promítání instancí (max-dist filtr)."""
from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "pozice,cam,max_dist,expected",
    [
        ({"x": 1, "y": 0, "z": 0}, {"x": 0, "y": 0, "z": 0}, 5.0, True),
        ({"x": 6, "y": 0, "z": 0}, {"x": 0, "y": 0, "z": 0}, 5.0, False),
        ({"x": 4, "y": 3, "z": 0}, {"x": 0, "y": 0, "z": 0}, 5.0, True),  # hypot 5.0
        ({"x": 4, "y": 3, "z": 1}, {"x": 0, "y": 0, "z": 0}, 5.0, False),  # hypot 5.04
    ],
)
def test_dist3d_filter(pozice, cam, max_dist, expected):
    from tools.qa_overlay import dist3d

    d = dist3d(pozice, cam)
    assert (d <= max_dist) == expected
