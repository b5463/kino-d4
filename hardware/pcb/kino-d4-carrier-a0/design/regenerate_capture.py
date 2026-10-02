"""Regenerate schematic sheets, parts.json, BOM and pin matrix from circuit.py without touching the board."""
from build import schematics, outputs
from rework import TARGET
from circuit import PARTS
schematics()
outputs({'status': 'A02_ENGINEERING_DRAFT', 'board': TARGET.name, 'components': len(PARTS)}, 'A02-CAPTURE-STATUS.json')
