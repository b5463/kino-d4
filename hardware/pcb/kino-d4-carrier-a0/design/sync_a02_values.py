"""Board footprint values from circuit.py (KiCad 10 python). Run after a value change in circuit.py and
regenerate_capture.py, so the board, schematic and BOM agree. Prints each change; footprints without a
schematic part (fiducials) are left alone.
"""
import pcbnew as pcb
from rework import TARGET
from circuit import PARTS

parts = {p['ref']: p for p in PARTS}
b = pcb.LoadBoard(str(TARGET))
changed = []
for f in b.GetFootprints():
    p = parts.get(f.GetReference())
    if p and f.GetValue() != p['value']:
        changed.append(f'{f.GetReference()} {f.GetValue()} -> {p["value"]}'); f.SetValue(p['value'])
pcb.SaveBoard(str(TARGET), b)
print('values changed:', '; '.join(changed) or 'none', flush=True)
import os; os._exit(0)
