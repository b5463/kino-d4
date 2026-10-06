"""Project footprint for the 0 ohm power links: Vishay CRCW1206-HP e3 reflow land (KiCad 10 python).

Vishay document 20043, revision 17-Mar-2026, page 9, recommended solder pad dimensions, reflow,
CRCW1206-HP e3: G 1.50 mm, Y 1.05 mm, X 1.80 mm, Z 3.60 mm. The stock R_1206_3216Metric land
(IPC nominal: gap 1.80, overall 4.05, pad 1.125 x 1.75 mm) is wider than that, so the land is
redrawn here: pads 1.05 x 1.80 mm at x = +/-1.275 mm. Silkscreen, fab outline and courtyard come
from the stock footprint (part body 3.1 x 1.6 mm). Writes KINO_A0.pretty/R_1206_3216Metric_Vishay_CRCW-HP.
"""
from pathlib import Path
import pcbnew as pcb

ROOT = Path(__file__).resolve().parent.parent
NAME = 'R_1206_3216Metric_Vishay_CRCW-HP'
_KS = [Path.home() / 'Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
       Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints'),
       Path('C:/Program Files/KiCad/10.0/share/kicad/footprints')]
stock = next(p for p in _KS if p.exists()) / 'Resistor_SMD.pretty'
fp = pcb.FootprintLoad(str(stock), 'R_1206_3216Metric')
for p in fp.Pads():
    p.SetSize(pcb.VECTOR2I(pcb.FromMM(1.05), pcb.FromMM(1.80)))
    p.SetPosition(pcb.VECTOR2I(pcb.FromMM(-1.275 if p.GetNumber() == '1' else 1.275), 0))
fp.SetLibDescription('0 ohm link, Vishay CRCW1206-HP e3 (doc 20043 rev 17-Mar-2026 p9 reflow land: '
                     'G 1.50, Y 1.05, X 1.80, Z 3.60 mm). KINO carrier power links JP200-JP500, JP1200.')
fp.SetKeywords('resistor jumper 0R link 1206 Vishay CRCW-HP')
fp.SetFPID(pcb.LIB_ID('KINO_A0', NAME))
pcb.FootprintSave(str(ROOT / 'KINO_A0.pretty'), fp)
pads = sorted((p.GetNumber(), pcb.ToMM(p.GetPosition().x), pcb.ToMM(p.GetSize().x), pcb.ToMM(p.GetSize().y)) for p in fp.Pads())
print('saved', NAME, pads, flush=True)
import os; os._exit(0)
