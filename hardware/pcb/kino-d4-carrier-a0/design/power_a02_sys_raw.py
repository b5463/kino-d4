"""SYS_RAW pours and stitching from the charger to the boost inductor (KiCad 10 python). Release review H-2.

The 5 A battery path (BQ25798 SYS to L1200, TPS61288 input) was a 1.2 mm back track along the C1111-C1115
row, three vias, a 3 mm In2 track and three vias into L1200: about 55 C rise at 5 A by the IPC-2152
chart on the 16 mm back run, and up to 2.8 A per via. TI BQ25798 8.4.1 asks for wide copper and enough
parallel vias on the power nodes. Two pours carry it now, both over the existing tracks:
  B.Cu  'SYS_RAW run'   from C1116 along the capacitor row to x 69.9, down to y 50.8 (about 3.4 mm wide);
  In2   'SYS_RAW feed'  from L1200 (x 55) east to x 79 under the back pour, y 45.75-50.8 (about 4.5 mm),
                        bounded by SYS_5V to the north and the camera 5 V bus to the east.
Sixteen vias tie the two pours where they overlap (x 71.2-78.0), three more join the In2 pour to L1200's
input pad beside the existing three. Pours connect pads solidly, 0.2 mm clearance, 0.25 mm minimum width.
The charger's own SYS pin escape (0.2 then 0.4 mm, about 2.6 mm long) is unchanged: its neighbours are
the QFN's SW2 and BAT pins. Rerunning replaces the pours; the vias are ADD items (handroute phases).
Phases: rip, add (vias and stubs), then this file with 'pour' (pours, and the stitch vias marked free).
"""
import sys
from handroute import run

STITCH = [(x, 49.5) for x in (71.2, 72.0, 72.8, 73.6, 74.4, 75.2, 76.0, 77.2, 78.0)] + \
         [(x, 50.3) for x in (71.2, 72.0, 72.8, 73.6, 76.0, 77.2, 78.0)]                      # sixteen, both ends of the overlap
ADD = [('SYS_RAW', 'V', None, [p]) for p in STITCH] + \
      [item for y in (45.3, 46.2, 47.1) for item in (('SYS_RAW', 'V', None, [(55.4, y)]), ('SYS_RAW', 'B', 0.9, [(55.4, y), (56.75, y)]))]
POURS = {
    'SYS_RAW run': ('B', [(69.9, 46.95), (85.3, 46.95), (88.35, 50.0), (88.35, 51.9), (86.6, 51.9), (85.5, 50.8), (69.9, 50.8)]),
    'SYS_RAW feed': ('I2', [(55.0, 44.7), (57.3, 44.7), (57.3, 45.75), (79.0, 45.75), (79.0, 50.8), (55.0, 50.8)]),
}

if len(sys.argv) > 1 and sys.argv[1] == 'pour':
    import pcbnew as pcb
    from rework import TARGET
    from routing import pt
    b = pcb.LoadBoard(str(TARGET))
    old = [z for z in b.Zones() if not z.GetIsRuleArea() and z.GetZoneName() in POURS]
    if old:                              # Remove() leaves this build's bindings unreliable: drop, save, start again
        for z in old: b.Remove(z)
        pcb.SaveBoard(str(TARGET), b)
        import os; os.execv(sys.executable, [sys.executable] + sys.argv)
    sysraw = b.FindNet('SYS_RAW')
    for v in b.GetTracks():              # stitch vias touch no track: as 'free' vias they keep SYS_RAW instead of
        if isinstance(v, pcb.PCB_VIA) and any(abs(pcb.ToMM(v.GetPosition().x) - 50 - x) < .01 and abs(pcb.ToMM(v.GetPosition().y) - 50 - y) < .01 for x, y in STITCH):
            v.SetNet(sysraw); v.SetIsFree(True)          # taking the net of the old ground fill they sit in
    for name, (layer, area) in POURS.items():
        z = pcb.ZONE(b); z.SetLayer({'B': pcb.B_Cu, 'I2': pcb.In2_Cu}[layer]); z.SetNet(b.FindNet('SYS_RAW')); z.SetZoneName(name)
        o = z.Outline(); o.NewOutline()
        for x, y in area: o.Append(pt(50 + x, 50 + y))
        z.SetAssignedPriority(4); z.SetPadConnection(pcb.ZONE_CONNECTION_FULL)
        z.SetLocalClearance(pcb.FromMM(0.2)); z.SetMinThickness(pcb.FromMM(0.25))
        b.Add(z)
    pcb.SaveBoard(str(TARGET), b)
    print('SYS_RAW pours:', ', '.join(POURS), flush=True)
    import os; os._exit(0)
run('sys_raw stitch', [], ADD)
