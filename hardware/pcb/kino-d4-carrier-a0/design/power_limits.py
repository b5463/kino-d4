"""Datasheet-based fallback ILIM calculation, not measured USB qualification."""
import itertools,json
from pathlib import Path
root=Path(__file__).resolve().parent.parent
top,bottom=30100,10000
corners=[]
for v,rt,rb,leak in itertools.product((4.6,5.2),(top*.99,top*1.01),(bottom*.99,bottom*1.01),(-1.5e-6,1.5e-6)):
    bias=v*rb/(rt+rb)+leak*rt*rb/(rt+rb)
    corners.append({'regn_v':v,'top_ohm':rt,'bottom_ohm':rb,'leakage_a':leak,
                    'ilim_v':bias,'analog_current_command_a':max(.1,(bias-1)/.8)})
result={
    'source':'https://www.ti.com/lit/ds/symlink/bq25798.pdf',
    'datasheet':'SLUSDV2C, June 2026; REGN table and section 7.3.4.3',
    'regn_note':'4.6-5.0 V specified at 5 V VBUS; 4.8-5.2 V at 15 V VBUS, IREGN=20mA. Intermediate conditions require validation.',
    'resistors_ohm':{'R1104':top,'R1105':bottom},'resistor_tolerance':.01,
    'leakage_assumption_a':1.5e-6,'leakage_note':'Datasheet limit is tested at ILIM=4 V; used here as a conservative calculation assumption, not a new guaranteed test condition.',
    'minimum_calculated_ilim_v':min(c['ilim_v'] for c in corners),
    'maximum_calculated_ilim_v':max(c['ilim_v'] for c in corners),
    'analog_command_range_a':[min(c['analog_current_command_a'] for c in corners),max(c['analog_current_command_a'] for c in corners)],
    'includes_adc_regulation_error':False,'measured':False,
    'former_453k_100k_ilim_v_at_regn_limits':[v*100/553 for v in (4.6,5.2)],
    'full_load_usb_operation_qualified':False,
    'limitations':['Fallback for an appropriately rated source, not a complete USB source-current policy.',
                   'USB-A/BC1.2 detection is absent; do not assume universal legacy-source compatibility.',
                   'Do not disable external ILIM until a valid contract and hardware response to source loss are qualified.',
                   'CE/NTC and off-state charging remain unresolved.'],
    'corners':corners}
(root/'outputs/A02-POWER-LIMITS.json').write_text(json.dumps(result,indent=2)+'\n')
print('Calculated ILIM voltage:',result['minimum_calculated_ilim_v'],result['maximum_calculated_ilim_v'])
print('Analog current command:',result['analog_command_range_a'])
