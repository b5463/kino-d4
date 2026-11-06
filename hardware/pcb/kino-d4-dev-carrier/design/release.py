"""Write the dev carrier D1 fabrication package to outputs/fab-d1/.

Gerbers and drill from kicad-cli; the JLC BOM, the JLC placement file and the hand-fit list
from circuit.py and the board. DRC and ERC reports go to outputs/. Run with KiCad 10's python.exe.
"""
import csv
import json
import subprocess
from pathlib import Path
import pcbnew as pcb
from circuit import PARTS

ROOT = Path(__file__).resolve().parent.parent
NAME = 'KINO_D4_Dev_Carrier_D1'
CLI = Path('C:/Program Files/KiCad/10.0/bin/kicad-cli.exe')
OUT = ROOT / 'outputs'
FAB = OUT / 'fab-d1'
LAYERS = 'F.Cu,B.Cu,F.Paste,B.Paste,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts'


def run(*args):
    subprocess.run([str(CLI), *args], check=True, capture_output=True)


def gerbers():
    FAB.mkdir(parents=True, exist_ok=True)
    for f in FAB.glob('*'):
        if f.suffix in ('.gbr', '.drl', '.gbrjob'):
            f.unlink()
    run('pcb', 'export', 'gerbers', '--layers', LAYERS, '--no-x2', '--use-drill-file-origin', '--subtract-soldermask',
        '--output', str(FAB) + '/', str(ROOT / (NAME + '.kicad_pcb')))
    run('pcb', 'export', 'drill', '--format', 'excellon', '--excellon-units', 'mm', '--drill-origin', 'absolute',
        '--generate-map', '--map-format', 'gerberx2', '--output', str(FAB) + '/', str(ROOT / (NAME + '.kicad_pcb')))


def checks():
    run('pcb', 'drc', '--format', 'json', '--severity-all', '--output', str(OUT / 'DRC-D1.json'), str(ROOT / (NAME + '.kicad_pcb')))
    run('sch', 'erc', '--format', 'json', '--severity-all', '--output', str(OUT / 'ERC-D1.json'), str(ROOT / (NAME + '.kicad_sch')))
    drc = json.loads((OUT / 'DRC-D1.json').read_text(encoding='utf-8'))
    erc = json.loads((OUT / 'ERC-D1.json').read_text(encoding='utf-8'))
    return {'drc_violations': len(drc['violations']), 'unconnected': len(drc['unconnected_items']),
            'erc_violations': sum(len(s['violations']) for s in erc['sheets'])}


def bom():
    smt = [p for p in PARTS if p['fit'] == 'smt']
    groups = {}
    for p in smt:
        groups.setdefault((p['value'], p['footprint'].split(':', 1)[1], p['mpn'], p['lcsc']), []).append(p['ref'])
    with (FAB / 'BOM-D1-JLC.csv').open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['Comment', 'Designator', 'Footprint', 'LCSC Part #', 'Manufacturer Part', 'Quantity', 'JLC library'])
        for (value, fp, mpn, lcsc), refs in sorted(groups.items(), key=lambda kv: kv[1][0]):
            basic = next(p['basic'] for p in smt if p['ref'] == refs[0])
            w.writerow([value, ','.join(refs), fp, lcsc, mpn, len(refs), 'basic' if basic else 'extended'])
    with (FAB / 'BOM-D1-HANDFIT.csv').open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['Designator', 'Value', 'Part', 'Note'])
        for p in PARTS:
            if p['fit'] == 'hand':
                w.writerow([p['ref'], p['value'], p['mpn'], p['note']])
    return {'smt_lines': len(groups), 'smt_parts': len(smt), 'extended_lines': sum(1 for k in groups if not next(p['basic'] for p in smt if p['ref'] in groups[k])),
            'handfit_parts': sum(1 for p in PARTS if p['fit'] == 'hand')}


def cpl():
    b = pcb.LoadBoard(str(ROOT / (NAME + '.kicad_pcb')))
    fit = {p['ref']: p['fit'] for p in PARTS}
    rows = []
    for fp in b.GetFootprints():
        if fit.get(fp.GetReference()) != 'smt':
            continue
        pos = fp.GetPosition()
        rows.append([fp.GetReference(), f'{pos.x / 1e6 - 50:.3f}mm', f'{-(pos.y / 1e6 - 50):.3f}mm',
                     'Bottom' if fp.IsFlipped() else 'Top', f'{fp.GetOrientationDegrees():.1f}'])
    rows.sort()
    with (FAB / 'CPL-D1-JLC.csv').open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])
        w.writerows(rows)
    sides = {r[3] for r in rows}
    return {'placed': len(rows), 'sides': sorted(sides)}


def notes(summary):
    (FAB / 'FAB-NOTES.txt').write_text(f'''KINO D4 DEV CARRIER D1 - fabrication and assembly notes

Board: 117.01 x 69.41 mm, 2 layers, 1.6 mm FR-4, 1 oz copper, HASL or ENIG, any mask colour.
Minimum track and gap 0.15 mm, minimum drill 0.3 mm, no via-in-pad, no castellations.
Assembly: SMT on the BOTTOM face only ("SIDE B" on the legend). {summary['cpl']['placed']} placements,
{summary['bom']['smt_lines']} BOM lines, {summary['bom']['extended_lines']} from the extended library.
Placement coordinates: KiCad board origin, Y up, mm. Rotations are KiCad's: check the assembler's preview
for the SOT-23-6 switches (U200-U500), the diodes and the LEDs before confirming.
Hand-fit after assembly (BOM-D1-HANDFIT.csv): XIAO sockets, the P4 ribbon header, the C6 and remote headers,
the four LINK headers, the shutter switch.
The JLC order number goes on the text JLCJLCJLCJLC on the bottom silk.
Checks at release: DRC {summary['checks']['drc_violations']} violations, {summary['checks']['unconnected']} unconnected,
ERC {summary['checks']['erc_violations']} violations.
''', encoding='utf-8')


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    gerbers()
    summary = {'board': NAME, 'checks': checks(), 'bom': bom(), 'cpl': cpl()}
    notes(summary)
    (OUT / 'BUILD_STATUS.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary))
