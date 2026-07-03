# Trimmed for inference-only use (cinematic_audio_separation).
# The original BandIt training system (LightningSystem, optimizer/loss/metric
# parsers) pulled in heavy training-only deps (asteroid, pedalboard, pyloudnorm,
# torch_audiomentations) at import time. None are needed to build/run the
# inference model `models.bandit.core.model.MultiMaskMultiSourceBandSplitRNNSimple`,
# and nothing in the inference path imports from this package __init__.
# Original preserved as __init__.py.orig_bak — re-apply this trim if MSST updates.
