"""P1 int8-friendly CNN for retinal event action recognition (M2).

Frozen architecture from the M3 RTL contract:
  conv1: 4x30x50 -> 8x14x24, k=3, s=2, pad=0
  conv2: 8x14x24 -> 16x6x11, k=3, s=2, pad=0
  conv3: 16x6x11 -> 24x2x5, k=3, s=2, pad=0
  fc:    240 -> 3
conv layers use ReLU, fc has no activation.  No BatchNorm, no dropout: the
integer pipeline has nowhere to hide them and M2 must stay bit-exact.

Input is the dataset X_q tensor, shape (N, 4, 30, 50), int8 in [-127, 127].
Channel order is fixed: [ON_now, OFF_now, ON_prev, OFF_prev].
"""
from __future__ import annotations

from dataclasses import dataclass

import torch
import torch.nn as nn

GRID_H = 30
GRID_W = 50
IN_CH = 4

# (out_ch, in_ch, k, stride) for the three conv stages; fc is separate.
CONV_SPECS = (
    (8, 4, 3, 2),
    (16, 8, 3, 2),
    (24, 16, 3, 2),
)
FC_IN = 24 * 2 * 5
NUM_CLASSES = 3

#: Concatenated weight/bias/shift slot counts in ROM order.
WEIGHT_COUNTS = (8 * 4 * 9, 16 * 8 * 9, 24 * 16 * 9, NUM_CLASSES * FC_IN)
BIAS_COUNTS = (8, 16, 24, NUM_CLASSES)


def conv_out_size(size: int, k: int = 3, stride: int = 2, pad: int = 0) -> int:
    return (size + 2 * pad - k) // stride + 1


@dataclass(frozen=True)
class LayerDims:
    name: str
    in_ch: int
    out_ch: int
    in_h: int
    in_w: int
    out_h: int
    out_w: int
    k: int
    stride: int


def layer_dims() -> tuple[LayerDims, ...]:
    dims: list[LayerDims] = []
    h, w = GRID_H, GRID_W
    in_ch = IN_CH
    for idx, (out_ch, c_in, k, stride) in enumerate(CONV_SPECS, start=1):
        oh = conv_out_size(h, k, stride)
        ow = conv_out_size(w, k, stride)
        dims.append(LayerDims(f"conv{idx}", c_in, out_ch, h, w, oh, ow, k, stride))
        h, w, in_ch = oh, ow, out_ch
    dims.append(LayerDims("fc", FC_IN, NUM_CLASSES, 1, 1, 1, 1, 1, 1))
    return tuple(dims)


class P1CNN(nn.Module):
    """The exact P1 topology; float32 training counterpart of the int8 RTL."""

    def __init__(self, num_classes: int = NUM_CLASSES) -> None:
        super().__init__()
        self.num_classes = int(num_classes)
        self.conv1 = nn.Conv2d(4, 8, 3, stride=2, padding=0, bias=True)
        self.conv2 = nn.Conv2d(8, 16, 3, stride=2, padding=0, bias=True)
        self.conv3 = nn.Conv2d(16, 24, 3, stride=2, padding=0, bias=True)
        self.fc = nn.Linear(FC_IN, self.num_classes, bias=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = torch.relu(self.conv1(x))
        x = torch.relu(self.conv2(x))
        x = torch.relu(self.conv3(x))
        x = torch.flatten(x, 1)
        return self.fc(x)

    @property
    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())


def build_model(num_classes: int = NUM_CLASSES) -> P1CNN:
    return P1CNN(num_classes=num_classes)
