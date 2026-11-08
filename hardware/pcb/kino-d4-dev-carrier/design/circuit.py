"""KINO D4 dev carrier D1: electrical capture.

The low-cost bench carrier for issue #250. It carries what the firmware drives
today (firmware/p4/main/board_d4v1.h): four camera UARTs, SYNC_OUT, CAM_PWR_EN,
the shutter and the P4 I2C bus. None of the A0.2 power, charger, gauge, haptic or
sensor parts are on it. The P4 JP1 map is the measured one (ECN-0002/0003).

Every SMD part is a JLC part on the back face; through-hole parts are hand-fitted.
`lcsc` is the JLC/LCSC part checked against the JLC library on 2026-11-05;
`basic` is False for the three extended-library lines.
"""

PARTS = []
SHEETS = {}


def sheet(key, title, note):
    SHEETS[key] = {'title': title, 'note': note}


def add(sh, ref, value, nets, pin_defs, footprint, mpn='', lcsc='', basic=True, fit='smt', note='', source=''):
    nets = {str(k): v for k, v in nets.items()}
    pins = {str(k): {'name': v[0], 'type': v[1]} for k, v in pin_defs.items()}
    assert set(nets) == set(pins), (ref, set(nets) ^ set(pins))
    PARTS.append(dict(sheet=sh, ref=ref, value=value, nets=nets, pins=pins, footprint=footprint,
                      mpn=mpn or value, lcsc=lcsc, basic=basic, fit=fit, note=note, source=source, dnp=False))


# JLC basic-library passives, 0603 1 % thick film unless stated.
RES = {'0R': 'C21189', '470R': 'C23179', '1k': 'C21190', '2.2k': 'C4190', '4.7k': 'C23162', '5.1k': 'C23186', '24k': 'C23352', '100k': 'C25803'}
RES_MPN = {'0R': '0603WAF0000T5E', '470R': '0603WAF4700T5E', '1k': '0603WAF1001T5E', '2.2k': '0603WAF2201T5E', '4.7k': '0603WAF4701T5E',
           '5.1k': '0603WAF5101T5E', '24k': '0603WAF2402T5E', '100k': '0603WAF1003T5E'}
CAPS = {'100n': ('CC0603KRX7R9BB104', 'C14663', '0603'), '1u': ('CL10A105KB8NNNC', 'C15849', '0603'),
        '22u': ('CL21A226MAQNNNE', 'C45783', '0805')}


def two(sh, ref, value, a, b, footprint, names=('1', '2'), **kw):
    return add(sh, ref, value, {1: a, 2: b}, {1: (names[0], 'passive'), 2: (names[1], 'passive')}, footprint, **kw)


def res(sh, ref, value, a, b, note='', fit='smt'):
    return two(sh, ref, value, a, b, 'Resistor_SMD:R_0603_1608Metric', mpn=RES_MPN[value], lcsc=RES[value], note=note, fit=fit)


def cap(sh, ref, value, net, note=''):
    mpn, lcsc, size = CAPS[value]
    fp = f'Capacitor_SMD:C_{size}_{"1608" if size == "0603" else "2012"}Metric'
    return two(sh, ref, value, net, 'GND', fp, mpn=mpn, lcsc=lcsc, note=note)


def led(sh, ref, colour, anode, cathode):
    fp, mpn, lcsc = {'green': ('LED_SMD:LED_0805_2012Metric', 'KT-0805G', 'C2297'),
                     'red': ('LED_SMD:LED_0603_1608Metric', 'KT-0603R', 'C2286')}[colour]
    return two(sh, ref, f'LED {colour}', cathode, anode, fp, names=('K', 'A'), mpn=mpn, lcsc=lcsc)


def con(sh, ref, value, nets, footprint, fit='hand', **kw):
    return add(sh, ref, value, nets, {k: (str(v or 'NC'), 'passive') for k, v in nets.items()}, footprint, fit=fit, **kw)


def tp(sh, ref, net):
    return con(sh, ref, net, {1: net}, 'TestPoint:TestPoint_Pad_D1.5mm', fit='none', mpn='PCB feature')


# --- P4 header, controls, I2C, C6 service -------------------------------------------
sheet('01_p4', 'P4 header, controls and I2C',
      'JP1 map measured (board_d4v1.h, ECN-0002/0003). Pin 15 is GPIO35, the P4 boot strap: never connect it. '
      'CAM_PWR_EN (GPIO31) enables all four camera switches; R100 holds them off from P4 reset.')
p4 = {1: 'P4_3V3', 2: 'P4_5V', 3: 'P4_3V3', 4: 'P4_5V', 5: 'GND', 6: 'GND', 7: 'P4_TX1', 8: 'P4_RX3',
      9: 'P4_RX1', 10: 'CAM_PWR_EN', 11: 'P4_TX2', 12: 'P4_TX4', 13: 'P4_RX2', 14: 'P4_RX4', 15: None,
      16: 'GND', 17: 'P4_TX3', 18: 'C6_3V3', 19: 'SYNC_MASTER', 20: 'C6_RX', 21: 'SHUTTER_N', 22: 'C6_TX',
      23: 'P4_SDA', 24: 'C6_IO9', 25: 'P4_SCL', 26: 'C6_EN'}
con('01_p4', 'J100', 'P4 JP1 - 26 pin IDC', p4, 'Connector_IDC:IDC-Header_2x13_P2.54mm_Vertical',
    mpn='Wurth 61202621621 (any keyed 2x13 2.54 mm box header)', note='Same position as A0.2 J100; keyed ribbon to P4 JP1.')
con('01_p4', 'J101', 'C6 service', {1: 'GND', 2: 'C6_3V3', 3: 'C6_RX', 4: 'C6_TX', 5: 'C6_IO9', 6: 'C6_EN'},
    'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical', mpn='1x06 2.54 mm pin header',
    note='C6_3V3 is the C6 supply: sense only, do not feed.')
con('01_p4', 'J102', 'QWIIC 3V3 I2C', {1: 'GND', 2: 'P4_3V3', 3: 'P4_SDA', 4: 'P4_SCL'},
    'Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal', fit='smt',
    mpn='SM04B-SRSS-TB(LF)(SN)', lcsc='C160404', basic=False,
    note='Qwiic/STEMMA QT pinout. Shares the P4 bus with the touch controller (0x5D); breakout pull-ups add in parallel.')
con('01_p4', 'J103', 'SHUTTER', {1: 'SHUTTER_N', 2: 'GND'},
    'Connector_JST:JST_XH_B2B-XH-A_1x02_P2.50mm_Vertical', mpn='JST B2B-XH-A (keyed 2-way socket)',
    note='The shutter button lead plugs in here: a dry contact to GND. GPIO28 has the internal pull-up and the '
         '25 ms debounce in buttons.c; no resistor. Keyed, so it cannot go in reversed.')
res('01_p4', 'R102', '4.7k', 'P4_SDA', 'P4_3V3', fit='none',
    note='DNP. The P4 bus has the touch controller pull-ups; fit only for a breakout that has none.')
res('01_p4', 'R103', '4.7k', 'P4_SCL', 'P4_3V3', fit='none', note='DNP, as R102.')
res('01_p4', 'R100', '4.7k', 'CAM_PWR_EN', 'GND',
    note='Camera bank off while GPIO31 is Hi-Z from reset, and still off (0.3 V) against the P4 45k internal pull-up if firmware ever enables it.')
res('01_p4', 'R101', '4.7k', 'SYNC_MASTER', 'GND', note='GPIO32 is Hi-Z from reset; holds the shared sync low against the 45k internal pull-up too.')
cap('01_p4', 'C100', '100n', 'P4_3V3')
for i, net in enumerate(['P4_3V3', 'P4_5V', 'SYNC_MASTER', 'CAM_PWR_EN', 'SHUTTER_N', 'GND', 'GND']):
    tp('01_p4', f'TP{100 + i}', net)
tp('01_p4', 'TP107', 'FAULT_N')
# The same signals again on the top face, reachable with the carrier mounted.
for i, net in enumerate(['P4_3V3', 'P4_5V', 'SYNC_MASTER', 'CAM_PWR_EN', 'SHUTTER_N', 'GND', 'FAULT_N', '5V_IN']):
    tp('01_p4', f'TP{110 + i}', net)
for i in range(1, 4):   # scope-probe grounds: a wire loop each, hand-fitted
    con('01_p4', f'GL{i}', 'GND loop', {1: 'GND'}, 'TestPoint:TestPoint_Loop_D2.50mm_Drill1.0mm',
        mpn='0.8 mm tinned wire loop', note='Scope probe ground.')
for i in range(1, 4):   # assembly fiducials on the SMT face
    add('01_p4', f'FID{i}', 'Fiducial', {}, {}, 'Fiducial:Fiducial_1mm_Mask2mm', fit='none', mpn='PCB feature')

# --- 5 V input ----------------------------------------------------------------------------
sheet('02_power', '5 V input',
      'USB-C sink at 5 V only: 5.1k Rd on CC1/CC2, up to 3 A from a Type-C source, USBLC6 clamp on VBUS and CC, 3 A polyfuse. '
      'J1001 hands the fused VBUS to the SW6106 charger/boost module (the battery charges from the carrier USB-C) and takes '
      'the 5 V rail back from it. JP1001 (closed) feeds the rail from USB directly for a bench without the module: open it '
      'when the SW6106 is in the loop. U1001 (ideal diode) feeds the rail to the P4 5 V pins and blocks the P4 USB from the rail.')
usb = {'A1': 'GND', 'A12': 'GND', 'B1': 'GND', 'B12': 'GND', 'A4': 'VBUS', 'A9': 'VBUS', 'B4': 'VBUS', 'B9': 'VBUS',
       'A5': 'USB_CC1', 'B5': 'USB_CC2', 'A6': None, 'A7': None, 'B6': None, 'B7': None, 'A8': None, 'B8': None, 'SH': 'GND'}
con('02_power', 'J1000', 'USB-C 5V', usb, 'KINO_DEV:USB_C_GCT_USB4105_KINO_GND0.05', fit='smt',
    mpn='GCT USB4105-GF-A', lcsc='C3020560', basic=False, note='Power only; data pins open. A0.2 land pattern.')
two('02_power', 'F1000', 'PPTC 3A', 'VBUS', 'VBUS_F', 'Fuse:Fuse_1812_4532Metric', fit='hand',
    mpn='SMD1812P300TF (LCSC C21004, extended library: hand-fit)',
    note='Protects the board and the source if the rail shorts; the TPS2553s only protect the nodes.')
add('02_power', 'U1000', 'USBLC6-2SC6', {1: 'USB_CC1', 2: 'GND', 3: 'USB_CC2', 4: 'USB_CC2', 5: 'VBUS', 6: 'USB_CC1'},
    {1: ('IO1', 'passive'), 2: ('GND', 'power_in'), 3: ('IO2', 'passive'), 4: ('IO2', 'passive'), 5: ('VBUS', 'power_in'), 6: ('IO1', 'passive')},
    'Package_TO_SOT_SMD:SOT-23-6', lcsc='C7519', basic=False, source='https://www.st.com/resource/en/datasheet/usblc6-2.pdf',
    note='ESD clamp: VBUS (6 V) and both CC pins through the line channels.')
two('02_power', 'JP1001', 'USB > RAIL', 'VBUS_F', '5V_IN', 'Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm',
    fit='none', mpn='PCB feature (solder bridge, closed)',
    note='Closed: the fused USB VBUS is the 5 V rail (bench, no battery module). Open when the SW6106 feeds the rail on J1001.')
# Ideal diode from the fused VBUS toward the module: the SW6106's own input port is the same node as J1001 1-2,
# so a charger on that port would otherwise back-drive the carrier's USB-C. LM74700 + N-FET, EN tied to ANODE.
add('02_power', 'U1002', 'LM74700QDBVRQ1', {1: 'VCAP1002', 2: 'GND', 3: 'VBUS_F', 4: 'VBUS_M', 5: 'GATE1002', 6: 'VBUS_F'},
    {1: ('VCAP', 'passive'), 2: ('GND', 'power_in'), 3: ('EN', 'input'), 4: ('CATHODE', 'passive'), 5: ('GATE', 'output'), 6: ('ANODE', 'passive')},
    'Package_TO_SOT_SMD:SOT-23-6', lcsc='C2941042', basic=False, source='https://www.ti.com/lit/ds/symlink/lm74700-q1.pdf',
    note='Forward regulation 20 mV across the FET, off at -11 mV. 4-60 V in. Blocks the module port from feeding J1000.')
add('02_power', 'Q1000', 'AO3400A', {1: 'GATE1002', 2: 'VBUS_F', 3: 'VBUS_M'}, {1: ('G', 'input'), 2: ('S', 'passive'), 3: ('D', 'passive')},
    'Package_TO_SOT_SMD:SOT-23', lcsc='C20917', mpn='AO3400A', note='N-channel, 30 V, 5.7 A, 26 mOhm; 0.23 W at 3 A, a warm SOT-23.')
two('02_power', 'C1005', '100n', 'VCAP1002', 'VBUS_F', 'Capacitor_SMD:C_0603_1608Metric', mpn='CC0603KRX7R9BB104', lcsc='C14663',
    note='LM74700 charge-pump capacitor, VCAP to ANODE.')
con('02_power', 'J1001', 'POWER MODULE', {1: 'VBUS_M', 2: 'VBUS_M', 3: 'GND', 4: 'GND', 5: '5V_IN', 6: '5V_IN'},
    'Connector_JST:JST_XH_B6B-XH-A_1x06_P2.50mm_Vertical', mpn='JST B6B-XH-A (keyed, 3 A per contact)',
    note='Two contacts per rail. 1-2 VBUS out through U1002 to the SW6106 input (the battery charges from the carrier USB-C), '
         '3-4 GND, 5-6 the 5 V rail back from the SW6106 output. 20 AWG to the module.')
res('02_power', 'R1000', '5.1k', 'USB_CC1', 'GND')
res('02_power', 'R1001', '5.1k', 'USB_CC2', 'GND')
cap('02_power', 'C1000', '22u', '5V_IN')
cap('02_power', 'C1001', '22u', '5V_IN')
cap('02_power', 'C1002', '100n', '5V_IN')
# Board status, three LEDs at the bottom edge: 5 V in, camera bank enabled, any channel in fault.
led('02_power', 'D1000', 'green', '5V_IN_LED', 'GND')
res('02_power', 'R1002', '1k', '5V_IN', '5V_IN_LED')
led('02_power', 'D1001', 'green', 'CAM_PWR_EN', 'CAM_EN_LED')
res('02_power', 'R1003', '470R', 'CAM_EN_LED', 'GND', note='About 2.5 mA from GPIO31 while the bank is on: visible through the spacer gap.')
led('02_power', 'D1002', 'red', 'FAULT_LED', 'FAULT_N')
res('02_power', 'R1004', '1k', '5V_IN', 'FAULT_LED',
    note='The four TPS2553 FAULT_N open drains share this net; the LED is their pull-up.')
# Rail to the P4 5 V pins through an ideal diode: the rail feeds the P4, the P4's own USB can never feed the rail,
# and when both are present the higher one carries the P4 with no current between the two sources.
add('02_power', 'U1001', 'LM66100DCKR', {1: '5V_IN', 2: 'GND', 3: 'P4_5V', 4: None, 5: 'GND', 6: 'P4_5V'},
    {1: ('VIN', 'power_in'), 2: ('GND', 'power_in'), 3: ('CE_N', 'input'), 4: ('NC', 'passive'), 5: ('ST', 'passive'), 6: ('VOUT', 'power_out')},
    'Package_TO_SOT_SMD:SOT-363_SC-70-6', lcsc='C2869734', basic=False, source='https://www.ti.com/lit/ds/symlink/lm66100.pdf',
    note='CE tied to VOUT: reverse-current blocking, off within 35 mV typ of VOUT > VIN, on again at VIN > VOUT + 150 mV. '
         '1.5 A continuous, 79 mOhm typ at 5 V: about 0.1 V drop at 1 A. ST to GND (not used).')
cap('02_power', 'C1003', '1u', '5V_IN', note='LM66100 input, TI power supply recommendations.')
two('02_power', 'D1003', 'SMAJ5.0A', 'GND', '5V_IN', 'Diode_SMD:D_SMA', names=('K', 'A'), mpn='SMAJ5.0A', lcsc='C10758', basic=False,
    note='Rail clamp at J1001: 6.4 V breakdown, 9.2 V at 43 A. Catches SW6106 output overshoot and hot-plug transients; '
         'it does not survive a sustained 9 V, so nothing on the module output may negotiate PD.')
cap('02_power', 'C1004', '1u', 'P4_5V')

# --- Cameras ------------------------------------------------------------------------------
switch_pins = {1: ('IN', 'power_in'), 2: ('GND', 'power_in'), 3: ('EN', 'input'), 4: ('FAULT_N', 'open_collector'),
               5: ('ILIM', 'passive'), 6: ('OUT', 'power_out')}
for n in range(1, 5):
    sh = f'0{n + 2}_camera{n}'
    b = 200 + 100 * (n - 1)
    c = lambda s: f'CAM{n}_{s}'
    sheet(sh, f'Camera {n}', 'TPS2553 current limit 24k: about 1.0-1.2 A; FAULT_N is shared with the other channels '
          '(one red LED on the power sheet). LM66100 ideal diode to the link header. Pull the LINK jumper before plugging node USB. '
          '2.2k series resistors keep a powered P4 from back-feeding an unpowered node through its pins.')
    xiao = {1: None, 2: c('SYNC'), 3: None, 4: None, 5: None, 6: None, 7: c('TX'), 8: c('RX'), 9: None, 10: None,
            11: None, 12: c('3V3'), 13: 'GND', 14: c('5V')}
    con(sh, f'J{b}', 'XIAO ESP32-S3 Sense socket', xiao, 'KINO_DEV:XIAO_Socket_15.24mm',
        mpn='2x Wurth 61300711821 (1x07 socket)', note='Same centres as A0.2: 22 mm pitch. Pin 2 D1 sync, 7 D6 TX, 8 D7 RX.')
    add(sh, f'U{b}', 'TPS2553DBVR', {1: '5V_IN', 2: 'GND', 3: 'CAM_PWR_EN', 4: 'FAULT_N', 5: c('ILIM'), 6: c('SW5V')},
        switch_pins, 'Package_TO_SOT_SMD:SOT-23-6', lcsc='C55266', basic=False,
        source='https://www.ti.com/lit/ds/symlink/tps2553.pdf')
    res(sh, f'R{b}', '24k', c('ILIM'), 'GND')
    cap(sh, f'C{b}', '1u', '5V_IN')
    # Ideal diode from the switch to the link header: about 0.1 V at the 1.2 A limit instead of a Schottky's 0.4 V,
    # and the node's own USB can never feed the bank (CE on VOUT: off within 35 mV of VOUT > VIN).
    add(sh, f'U{b + 1}', 'LM66100DCKR', {1: c('SW5V'), 2: 'GND', 3: c('LINK'), 4: None, 5: 'GND', 6: c('LINK')},
        {1: ('VIN', 'power_in'), 2: ('GND', 'power_in'), 3: ('CE_N', 'input'), 4: ('NC', 'passive'), 5: ('ST', 'passive'), 6: ('VOUT', 'power_out')},
        'Package_TO_SOT_SMD:SOT-363_SC-70-6', lcsc='C2869734', basic=False, source='https://www.ti.com/lit/ds/symlink/lm66100.pdf',
        note='1.5 A continuous, above the 1.2 A channel limit; 79 mOhm typ. Same part as U1001.')
    cap(sh, f'C{b + 3}', '1u', c('SW5V'), note='LM66100 input.')
    con(sh, f'JP{b}', f'LINK {n}', {1: c('LINK'), 2: c('5VJ')}, 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
        mpn='1x02 2.54 mm pin header + shunt', note='Remove before connecting node USB.')
    res(sh, f'R{b + 6}', '0R', c('5VJ'), c('5V'),
        note=f'Current-measure link: lift it and meter between TP{b + 5} (5VJ) and TP{b + 4} (5V) for this node.')
    tp(sh, f'TP{b + 5}', c('5VJ'))
    cap(sh, f'C{b + 1}', '22u', c('5V'))
    cap(sh, f'C{b + 2}', '100n', c('5V'))
    res(sh, f'R{b + 3}', '2.2k', f'P4_TX{n}', c('RX'))
    res(sh, f'R{b + 4}', '2.2k', c('TX'), f'P4_RX{n}')
    res(sh, f'R{b + 5}', '2.2k', 'SYNC_MASTER', c('SYNC'))
    for i, s in enumerate(['TX', 'RX', 'SYNC', '3V3', '5V']):
        tp(sh, f'TP{b + i}', c(s))
