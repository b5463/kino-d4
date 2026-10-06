"""Printed labels for the relocated pack connector and the USB port (ODD JOBS 42/43)."""
import pcbnew as pcb
from rework import TARGET
from routing import pt

b = pcb.LoadBoard(str(TARGET))
texts = {d.GetText(): d for d in b.GetDrawings() if isinstance(d, pcb.PCB_TEXT) and d.GetLayer() == pcb.F_SilkS}
pack = texts.get('PACK + / NTC / -') or texts['- NTC +']
pack.SetText('- NTC +')                       # J1100 at 180 deg: pin 3 (-) left, pin 1 (+) right
pack.SetPosition(pt(50 + 89.34, 50 + 68.3)); pack.SetTextAngleDegrees(0)
usb = texts.get('CHARGE USB') or texts['USB']
usb.SetText('USB'); usb.SetPosition(pt(50 + 115.75, 50 + 64.9)); usb.SetTextAngleDegrees(90)
pcb.SaveBoard(str(TARGET), b)
print('labels moved')
