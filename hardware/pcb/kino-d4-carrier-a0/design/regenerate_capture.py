"""Regenerate schematic sheets, parts.json, BOM and pin matrix from circuit.py without touching the board."""
from build import schematics, outputs
from rework import TARGET
from circuit import PARTS
import release
schematics()
outputs({'status': release.STATUS, 'verdict': release.VERDICT, 'release_date': release.DATE, 'board': TARGET.name, 'components': len(PARTS)}, 'A02-CAPTURE-STATUS.json')
