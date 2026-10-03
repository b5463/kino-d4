"""KINO carrier A0 electrical capture. Engineering draft, not a fabrication release.

Pin tables are factual transcriptions of the linked manufacturer datasheets.
KiCad library pin tables are used where available, without copying symbol artwork.
"""
from sexpr import symbol, pins, prop
from mechanical import WIDTH, HEIGHT, INSERT_CENTRES, CAMERA_CENTRES

PARTS = []
SHEETS = {}
SOURCES = {}

def sheet(key, title, note):
    SHEETS[key] = {'title': title, 'note': note}

def add(sheet, ref, value, nets, lib=None, footprint=None, pin_defs=None,
        mpn='', source='', note='', dnp=False, at=None):
    raw = symbol(lib) if lib else None
    pd = pins(raw) if raw else {str(k): {'name': v[0], 'type': v[1]} for k,v in pin_defs.items()}
    nn = {str(k): v for k,v in nets.items()}
    assert set(nn) == set(pd), (ref, set(pd)-set(nn), set(nn)-set(pd))
    item = dict(sheet=sheet, ref=ref, value=value, nets=nn, pins=pd,
                footprint=footprint or (prop(raw,'Footprint') if raw else ''), mpn=mpn or value,
                source=source or (prop(raw,'Datasheet') if raw else ''), note=note, dnp=dnp, at=at)
    PARTS.append(item)
    return item

def passive(sh, ref, value, a, b, kind='R', size='0603', **kw):
    fp = {'R':f'Resistor_SMD:R_{size}_1608Metric', 'C':f'Capacitor_SMD:C_{size}_1608Metric',
          'D':'Diode_SMD:D_SMA', 'L':'KINO_A0:Inductor_6.5x6.5_DRAFT',
          'F':'Fuse:Fuse_1206_3216Metric'}[kind]
    if size=='0805': fp=f'{"Resistor" if kind=="R" else "Capacitor"}_SMD:{kind}_0805_2012Metric'
    if size=='1206': fp=f'{"Resistor" if kind=="R" else "Capacitor"}_SMD:{kind}_1206_3216Metric'
    if kind=='D': names=['K','A']
    else: names=['1','2']
    return add(sh,ref,value,{1:a,2:b},footprint=kw.pop('footprint',fp),
               pin_defs={1:(names[0],'passive'),2:(names[1],'passive')},**kw)

def cap(sh,ref,net,value='100n 16V',gnd='GND',**kw): return passive(sh,ref,value,net,gnd,kind='C',**kw)
def res(sh,ref,a,b,value='10k 1%',**kw):
    # Exact manufacturer spec sheets checked 2026-09-30; power shunts are
    # deliberately excluded. This selects parts, not circuit qualification.
    from resistor_selection import select
    selected=select(value,kw.get('size','0603'))
    if selected:
        kw.setdefault('mpn',selected['mpn'])
        kw.setdefault('source',selected['source'])
    return passive(sh,ref,value,a,b,**kw)
def con(sh,ref,value,nets,footprint=None,**kw):
    fp=footprint or f'Connector_JST:JST_GH_BM{len(nets):02d}B-GHS-TBT_1x{len(nets):02d}-1MP_P1.25mm_Vertical'
    return add(sh,ref,value,nets,footprint=fp,pin_defs={str(k):(str(v or 'NC'),'passive') for k,v in nets.items()},**kw)
def tp(sh,ref,net): return con(sh,ref,net,{1:net},'TestPoint:TestPoint_Pad_D1.5mm')
def fet(sh,ref,g,s,d,value='AO4407A'):
    return add(sh,ref,value,{1:s,2:s,3:s,4:g,5:d,6:d,7:d,8:d},footprint='Package_SO:SOIC-8_3.9x4.9mm_P1.27mm',
               pin_defs={i:(('G' if i==4 else 'S' if i<4 else 'D'),'input' if i==4 else 'passive') for i in range(1,9)},
               note='Verify exact AO4407A manufacturer and SO8 pinout before BOM release.')
def nfet(sh,ref,g,s,d):
    return add(sh,ref,'2N7002',{1:g,2:s,3:d},footprint='Package_TO_SOT_SMD:SOT-23',
               pin_defs={1:('G','input'),2:('S','passive'),3:('D','passive')})

sheet('01_p4','P4 header and isolated control bus',
      'Measured ECN-0002/0003 map. JP1 pin 15 NC. 3V3 pins sense only. P4 USB power coexistence requires validation.')
p4={1:'P4_3V3_SENSE',2:'P4_5V',3:'P4_3V3_TEST',4:'P4_5V',5:'GND',6:'GND',7:'P4_TX1',8:'P4_RX3',9:'P4_RX1',10:'CAM_GLOBAL_EN',11:'P4_TX2',12:'P4_TX4',13:'P4_RX2',14:'P4_RX4',15:None,16:'GND',17:'P4_TX3',18:'C6_3V3_TEST',19:'SYNC_MASTER',20:'C6_RX_SERVICE',21:'SHUTTER_N',22:'C6_TX_SERVICE',23:'P4_SDA',24:'C6_BOOT_SERVICE',25:'P4_SCL',26:'C6_EN_SERVICE'}
con('01_p4','J100','P4 JP1 - 26 pin IDC',p4,'Connector_IDC:IDC-Header_2x13_P2.54mm_Vertical',at=(6,18),note='1:1 electrical pin numbering; verify cable and mating views.')
con('01_p4','J101','C6 service - 3V3 sense only',{1:'GND',2:'C6_3V3_TEST',3:'C6_RX_SERVICE',4:'C6_TX_SERVICE',5:'C6_BOOT_SERVICE',6:'C6_EN_SERVICE'},'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical')
add('01_p4','U100','TCA9517ADGKR',{1:'MB_3V3',2:'P4_SCL',3:'P4_SDA',4:'GND',5:'P4_BUS_EN',6:'I2C_SDA',7:'I2C_SCL',8:'MB_3V3'},lib='Logic_LevelTranslator:TCA9517ADGK',note='B side is local. Do not cascade another B-side offset buffer on local bus.')
res('01_p4','R100','P4_3V3_SENSE','P4_BUS_EN','10k')
res('01_p4','R101','P4_BUS_EN','GND','1M')
res('01_p4','R102','I2C_SDA','MB_3V3','4.7k')
res('01_p4','R103','I2C_SCL','MB_3V3','4.7k')
cap('01_p4','C100','MB_3V3')
res('01_p4','R104','CAM_GLOBAL_EN','GND','100k')
con('01_p4','J102','3V3 I2C accessory',{1:'GND',2:'AUX_3V3',3:'I2C_SDA',4:'I2C_SCL'})
passive('01_p4','F100','PTC 100mA - select','MB_3V3','AUX_3V3',kind='F',note='Accessory protection and ESD review open.')
tp('01_p4','TP100','P4_3V3_TEST')
tp('01_p4','TP101','SYNC_MASTER')
tp('01_p4','TP102','P4_5V')

txupins={1:('VCCA','power_in'),2:('A1','input'),3:('A2','input'),4:('A3','input'),5:('A4Y','output'),6:('NC','no_connect'),7:('GND','power_in'),8:('OE','input'),9:('NC','no_connect'),10:('B4','input'),11:('B3Y','output'),12:('B2Y','output'),13:('B1Y','output'),14:('VCCB','power_in')}
switchpins={1:('IN','power_in'),2:('GND','power_in'),3:('EN','input'),4:('FAULT_N','open_collector'),5:('ILIM','passive'),6:('OUT','power_out')}
for n in range(1,5):
    sh=f'0{n+1}_camera{n}'
    sheet(sh,f'Camera {n} socket, power and signal isolation',
          'Remove the camera power link (0 ohm, JP) BEFORE connecting node USB. Row centres 15.24 mm from official Seeed PCB/footprint. Optical datum remains to be verified.')
    base=200+100*(n-1)
    local=lambda s:f'CAM{n}_{s}'
    nets={1:local('D0'),2:local('SYNC'),3:local('D2_STRAP'),4:local('D3'),5:local('D4'),6:local('D5'),7:local('TX'),8:local('RX'),9:local('D8_SD'),10:local('D9_SD'),11:local('D10_SD'),12:local('3V3'),13:'GND',14:local('5V')}
    con(sh,f'J{base}','XIAO ESP32-S3 Sense socket',nets,'KINO_A0:XIAO_Socket_15.24mm',at=CAMERA_CENTRES[n-1],note='Two 1x07 sockets; 22 mm camera pitch. 5V shared with node USB; isolate via the 0 ohm link for USB service.')
    con(sh,f'J{base+1}','GPIO breakout - SD/strap restrictions',{1:'GND',2:local('3V3'),3:local('D0'),4:local('D2_STRAP'),5:local('D3'),6:local('D4'),7:local('D5'),8:local('D8_SD'),9:local('D9_SD'),10:local('D10_SD')},'Connector_PinHeader_2.54mm:PinHeader_2x05_P2.54mm_Vertical')
    passive(sh,f'JP{base}','0R LINK - REMOVE FOR NODE USB',local('5V_ISO'),local('5V'),kind='R',footprint='KINO_A0:R_1206_3216Metric_Vishay_CRCW-HP',
            note='0 ohm link, fitted for camera operation. Desolder before connecting node USB; refit after. Flat on the front: the XIAO stays the tallest part there.')
    add(sh,f'U{base}','TXU0304PWR',{1:'MB_3V3',2:f'P4_TX{n}',3:'SYNC_MASTER',4:'GND',5:local('RX_RETURN'),6:None,7:'GND',8:'P4_BUS_EN',9:None,10:local('TX'),11:None,12:local('SYNC_BUF'),13:local('RX_BUF'),14:local('3V3')},pin_defs=txupins,footprint='Package_SO:TSSOP-14_4.4x5mm_P0.65mm',source='https://www.ti.com/lit/ds/symlink/txu0304.pdf')
    for i,(a,b) in enumerate([(local('RX_BUF'),local('RX')),(local('SYNC_BUF'),local('SYNC')),(local('RX_RETURN'),f'P4_RX{n}')]):res(sh,f'R{base+i}',a,b,'33')
    cap(sh,f'C{base}','MB_3V3');cap(sh,f'C{base+1}',local('3V3'))
    add(sh,f'U{base+1}','TPS2553DBVR',{1:local('SHUNT_OUT'),2:'GND',3:local('EN'),4:local('FAULT_N'),5:local('ILIM'),6:local('SW5V')},pin_defs=switchpins,footprint='Package_TO_SOT_SMD:SOT-23-6',source='https://www.ti.com/lit/ds/symlink/tps2553.pdf')
    res(sh,f'R{base+3}',local('ILIM'),'GND','25.5k 1%',note='Approx. 1A target; verify min/max and startup before release.')
    res(sh,f'R{base+4}',local('FAULT_N'),'MB_3V3','10k')
    res(sh,f'R{base+5}',local('EN'),'GND','100k')
    res(sh,f'RS{base}','SYS_5V',local('SHUNT_OUT'),'0.020 1% 0.5W',size='1206',note='Kelvin sense required; exact current-sense resistor MPN pending.')
    passive(sh,f'D{base}','SS34',local('5V_ISO'),local('SW5V'),kind='D',note='Reverse node USB-to-carrier isolation; does not prevent carrier-to-host VBUS feed without removing the link.')
    cap(sh,f'C{base+2}',local('SHUNT_OUT'),'1u 16V')
    cap(sh,f'C{base+3}',local('5V'),'22u 10V',size='0805')
    cap(sh,f'C{base+4}',local('5V'))
    tp(sh,f'TP{base}',local('5V'));tp(sh,f'TP{base+1}',local('SYNC'))

sheet('06_control','Camera enables and GPIO expansion','Camera outputs default off. Firmware must configure expander before enabling GPIO31. No spare P4 pin is consumed.')
tcanets={1:None,2:'GND',3:'EXP_RESET_N',4:'CAM1_REQ',5:'CAM2_REQ',6:'CAM3_REQ',7:'CAM4_REQ',8:'CAM1_FAULT_N',9:'CAM2_FAULT_N',10:'CAM3_FAULT_N',11:'CAM4_FAULT_N',12:'GND',13:'IMU_INT',14:'RTC_INT_N',15:'SOFT_KILL',16:None,17:'POWER_INT_N',18:'FN_N',19:'HAPTIC_EN',20:'COVER_N',21:'GND',22:'I2C_SCL',23:'I2C_SDA',24:'MB_3V3'}
add('06_control','U600','TCA9539PWR',tcanets,lib='Interface_Expansion:PCA9539xPW',source='https://www.ti.com/lit/ds/symlink/tca9539.pdf',note='TCA9539 PW pin map verified against TI; address 0x74 candidate. Port 1 (pins 13-20, P1.0-P1.7): IMU_INT, RTC_INT_N, SOFT_KILL, unused, POWER_INT_N, FN_N, HAPTIC_EN, COVER_N; P1.3 (pin 16) is not connected (no layout path from the charger on the far side of the board): firmware reads the charge state from the BQ25798 status registers over I2C; configure P1.3 as an input. Order set by the layout: the lines leaving south take pins 13-17 in the order they reach their parts.')
res('06_control','R600','EXP_RESET_N','MB_3V3','10k');cap('06_control','C600','EXP_RESET_N','100n');cap('06_control','C601','MB_3V3')
andpins={i:((('VCC' if i==14 else 'GND') if i in (7,14) else f'PIN{i}'),'power_in' if i in (7,14) else 'output' if i in(3,6,8,11) else 'input') for i in range(1,15)}
add('06_control','U601','SN74LVC08APWR',{1:'CAM_GLOBAL_EN',2:'CAM1_REQ',3:'CAM1_EN',4:'CAM_GLOBAL_EN',5:'CAM2_REQ',6:'CAM2_EN',7:'GND',8:'CAM3_EN',9:'CAM_GLOBAL_EN',10:'CAM3_REQ',11:'CAM4_EN',12:'CAM_GLOBAL_EN',13:'CAM4_REQ',14:'MB_3V3'},pin_defs=andpins,footprint='Package_SO:TSSOP-14_4.4x5mm_P0.65mm',source='https://www.ti.com/lit/ds/symlink/sn74lvc08a.pdf')
cap('06_control','C602','MB_3V3')
for n in range(1,5):res('06_control',f'R{600+n}',f'CAM{n}_REQ','GND','100k')
con('06_control','J600','POGO TEST - SENSE ONLY',
    {1:'GND',2:'SYS_5V',3:'MB_3V3',4:'BAT_PROTECTED',5:'I2C_SCL',6:'I2C_SDA',
     7:'SYNC_MASTER',8:'CAM1_EN',9:'CAM2_EN',10:'CAM3_EN',11:'CAM4_EN',12:'GND'},
    'KINO_A0:Pogo_12_Asymmetric',at=(16,49),mpn='PCB feature - no fitted component',
    note='1.5mm ENIG pads, no paste. Pad 1 offset for fixture orientation. Measure enables; do not drive against U601. Rails are sense points, not a power injection connector.')
con('06_control','J601','EXTERNAL FLASH LOGIC',
    {1:'GND',2:'AUX_3V3',3:'I2C_SDA',4:'I2C_SCL',5:'FLASH_SYNC'},
    at=(39,50),mpn='BM05B-GHS-TBT(LF)(SN)',dnp=True,
    note='Logic-only internal interface. External driver must arm via I2C and gate shared SYNC. No dedicated FLASH_EN is available in the retained P4 map. Flash load requires its own qualified supply; AUX_3V3 is behind the accessory PTC.')
res('06_control','R605','SYNC_MASTER','FLASH_SYNC','33',dnp=True,
    note='Fit with J601 only after external flash-driver timing/loading review.')

sheet('07_monitoring','Four camera currents and battery fuel gauge','PAC1954 grounded ADDRSEL: 7-bit address 0x10; calibrate shunts. BQ27441 HIGH-SIDE 5 mOhm (TI pins 7/8: SRP pack side, SRN system side). +/-25 mV range: 5 A = 25 mV. Gauge is factory-calibrated for 10 mOhm: firmware must write CC Gain for 5 mOhm.')
add('07_monitoring','U700','PAC1954T-E/4MX',{1:'GND',2:'MB_3V3',3:'GND',4:'I2C_SCL',5:'I2C_SDA',6:'GND',7:'CAM3_SHUNT_OUT',8:'SYS_5V',9:'CAM4_SHUNT_OUT',10:'SYS_5V',11:'SYS_5V',12:'CAM1_SHUNT_OUT',13:'SYS_5V',14:'CAM2_SHUNT_OUT',15:None,16:'MB_3V3',17:'GND'},lib='Sensor_Energy:PAC1954x-x4MX',footprint='KINO_A0:VQFN-16-1EP_3x3mm_P0.5mm_EP1.1x1.1mm_Pin1Corner',note='ADDRSEL tied to GND (pin 6 to the exposed pad) gives 7-bit 0x10 (Microchip evaluation guide section 4.6); the only PAC1954 on the bus, so no strap resistor. PWRDN high enables; SLOW low gives default sample rate.')
cap('07_monitoring','C700','MB_3V3');cap('07_monitoring','C701','MB_3V3','1u')
add('07_monitoring','U701','BQ27441DRZR-G1A',{1:'I2C_SDA',2:'I2C_SCL',3:'GND',4:None,5:'GAUGE_1V8',6:'PACK_FUSED',7:'BAT_PROTECTED',8:'PACK_FUSED',9:None,10:'GAUGE_BIN',11:None,12:'GAUGE_GPOUT',13:'GND'},lib='Battery_Management:BQ27441-G1',note='TI SLUSBH1C pin table: SRP (8) Kelvin to RS700 pack side, SRN (7) Kelvin to RS700 system side, BAT (6) Kelvin to pack positive. GPOUT must not float.')
cap('07_monitoring','C702','GAUGE_1V8','470n');cap('07_monitoring','C703','PACK_FUSED','1u 16V',note='TI: 1 uF from BAT to VSS, close to the gauge.')
res('07_monitoring','R701','GAUGE_BIN','GND','10k',note='Embedded pack: BIN 10k to VSS per TI.')
res('07_monitoring','R702','GAUGE_GPOUT','GAUGE_1V8','10k',note='TI: GPOUT must not float; 10k pull-up to the gauge VDD, which stays up with the camera off.')
res('07_monitoring','RS700','PACK_FUSED','BAT_PROTECTED','0.005 1% 1W',size='1206',mpn='WSLP1206R0050FEA',source='https://www.vishay.com/en/product/30122/',note='High side after F1100. 4.4 A = 22 mV (gauge range 25 mV), 97 mW. Kelvin taps from the pad inner edges.')

sheet('08_sensors','Motion, clock and board temperature','IMU mode 1; axes marked on PCB. RTC backup charging must stay disabled for primary cell. No always-on wake promise.')
imupins={1:('SA0','input'),2:('SDX','input'),3:('SCX','input'),4:('INT1','output'),5:('VDDIO','power_in'),6:('GND','power_in'),7:('GND','passive'),8:('VDD','power_in'),9:('INT2','output'),10:('OCS_AUX','no_connect'),11:('SDO_AUX','no_connect'),12:('CS','input'),13:('SCL','input'),14:('SDA','bidirectional')}
add('08_sensors','U800','LSM6DSOXTR',{1:'GND',2:'GND',3:'GND',4:'IMU_INT',5:'MB_3V3',6:'GND',7:'GND',8:'MB_3V3',9:None,10:None,11:None,12:'MB_3V3',13:'I2C_SCL',14:'I2C_SDA'},pin_defs=imupins,footprint='Package_LGA:LGA-14_3x2.5mm_P0.5mm_LayoutBorder3x4y',source='https://www.st.com/resource/en/datasheet/lsm6dsox.pdf')
cap('08_sensors','C800','MB_3V3');cap('08_sensors','C801','MB_3V3')
add('08_sensors','U801','RV-3028-C7',{1:None,2:'RTC_INT_N',3:'I2C_SCL',4:'I2C_SDA',5:'GND',6:'RTC_BACKUP',7:'MB_3V3',8:'GND'},lib='Timer_RTC:RV-3028-C7')
cap('08_sensors','C802','MB_3V3');res('08_sensors','R800','RTC_INT_N','MB_3V3','10k')
con('08_sensors','J800','3V PRIMARY RTC BACKUP',{1:'RTC_BACKUP',2:'GND'},note='Insulated remote backup cell holder; disable RTC trickle charging in hardware configuration/firmware.')
tmp=add('08_sensors','U802','TMP117AIDRVR',{1:'I2C_SCL',2:'GND',3:None,4:'GND',5:'MB_3V3',6:'I2C_SDA'},lib='Sensor_Temperature:TMP117xxDRV')
tmp['pins']['7']={'name':'EP','type':'passive'};tmp['nets']['7']='GND'
cap('08_sensors','C803','MB_3V3')

sheet('09_controls','Cover, shutter and haptic interfaces','Passive dry-contact remote only. Haptic firmware must suppress vibration through exposure and settling. Motor MPN remains to be selected.')
add('09_controls','U900','DRV2605LDGSR',{1:'HAPTIC_REG',2:'I2C_SCL',3:'I2C_SDA',4:'GND',5:'HAPTIC_EN',6:'MB_3V3',7:'MOTOR_P',8:'GND',9:'MOTOR_N',10:'MB_3V3'},lib='Driver:DRV2605LDGS')
cap('09_controls','C900','HAPTIC_REG','1u');cap('09_controls','C901','MB_3V3','1u');cap('09_controls','C902','MB_3V3','10u',size='0805')
res('09_controls','R900','HAPTIC_EN','GND','100k')
con('09_controls','J900','HAPTIC MOTOR',{1:'MOTOR_P',2:'MOTOR_N'},note='Matched LRA/ERM selection and calibration open.')
con('09_controls','J901','COVER HALL SENSOR',{1:'MB_3V3',2:'GND',3:'COVER_RAW'},note='External 3.3V open-drain Hall sensor; select magnet/threshold and serviceable mount.')
res('09_controls','R901','COVER_RAW','COVER_N','1k');res('09_controls','R902','COVER_N','MB_3V3','10k');cap('09_controls','C903','COVER_N','10n')
con('09_controls','J902','LOCAL SHUTTER',{1:'SHUTTER_N',2:'GND'})
con('09_controls','J903','REMOTE DRY CONTACT',{1:'REMOTE_CONTACT',2:'GND'},note='Internal locking connector to panel socket; choose jack with no insertion short.')
res('09_controls','R903','REMOTE_CONTACT','REMOTE_FILTER','10k');res('09_controls','R904','REMOTE_FILTER','MB_3V3','47k');cap('09_controls','C904','REMOTE_FILTER','100n')
invpins={1:('NC','no_connect'),2:('A','input'),3:('GND','power_in'),4:('Y','output'),5:('VCC','power_in')}
add('09_controls','U901','SN74LVC1G14DBVR',{1:None,2:'REMOTE_FILTER',3:'GND',4:'REMOTE_ACTIVE',5:'MB_3V3'},pin_defs=invpins,footprint='Package_TO_SOT_SMD:SOT-23-5',source='https://www.ti.com/lit/ds/symlink/sn74lvc1g14.pdf')
cap('09_controls','C905','MB_3V3');nfet('09_controls','Q900','REMOTE_ACTIVE','GND','SHUTTER_N')
res('09_controls','R905','REMOTE_ACTIVE','GND','100k')
for i,net in enumerate(['REMOTE_CONTACT','COVER_RAW','SHUTTER_N']):
    passive('09_controls',f'D{900+i}','PESD5V0S1BA','GND',net,kind='D',footprint='Diode_SMD:D_SOD-323',note='Bidirectional ESD clamp candidate; verify surge rating and leakage.')
con('09_controls','J904','FUNCTION BUTTON',{1:'FN_N',2:'GND'});res('09_controls','R906','FN_N','MB_3V3','10k')

sheet('10_usb_pd','USB-C PD sink and protected input','Charge-only port. STUSB4500 NVM must be programmed for 5V fallback and 9V/2A. Protection and gate transient review OPEN.')
usb={p:('GND' if p in ('A1','A12','B1','B12','SH') else 'USB_VBUS' if p in ('A4','A9','B4','B9') else 'USB_CC1' if p=='A5' else 'USB_CC2' if p=='B5' else None) for p in pins(symbol('Connector:USB_C_Receptacle_USB2.0_16P'))}
add('10_usb_pd','J1000','USB4105-GF-A',usb,lib='Connector:USB_C_Receptacle_USB2.0_16P',footprint='KINO_A0:USB_C_GCT_USB4105_KINO_GND0.05',at=(109,HEIGHT-4.2),note='Power-only. A6/B6 A7/B7 data unconnected; PD only, no BC1.2 data detection. Land: GCT drawing B4, outer GND lands trimmed 0.05 mm (local deviation, A02-REVIEW).')
add('10_usb_pd','U1000','STUSB4500QTR',{1:'USB_CC1',2:'USB_CC1',3:None,4:'USB_CC2',5:'USB_CC2',6:'PD_RESET',7:'I2C_SCL',8:'I2C_SDA',9:'PD_DISCH',10:'GND',11:None,12:'GND',13:'GND',14:None,15:None,16:'PD_SINK_EN_N',17:None,18:'PD_VBUS_SENSE',19:None,20:'PD_9V_OK_N',21:'PD_1V2',22:'GND',23:'PD_2V7',24:'USB_VBUS',25:'GND'},lib='Interface_USB:STUSB4500QTR')
cap('10_usb_pd','C1000','USB_VBUS','1u 35V',size='0805');cap('10_usb_pd','C1001','PD_1V2','1u');cap('10_usb_pd','C1002','PD_2V7','1u')
res('10_usb_pd','R1000','PD_RESET','GND','100k');res('10_usb_pd','R1001','USB_VBUS','PD_VBUS_SENSE','470');res('10_usb_pd','R1002','CHG_VBUS','PD_DISCH','1k')
fet('10_usb_pd','Q1000','PD_GATE','PD_COMMON_SOURCE','USB_VBUS');fet('10_usb_pd','Q1001','PD_GATE','PD_COMMON_SOURCE','CHG_VBUS')
res('10_usb_pd','R1003','PD_COMMON_SOURCE','PD_GATE','100k');res('10_usb_pd','R1004','PD_GATE','PD_SINK_EN_N','1k')
passive('10_usb_pd','D1000','BZT52C10','PD_COMMON_SOURCE','PD_GATE',kind='D',footprint='Diode_SMD:D_SOD-123')
passive('10_usb_pd','D1001','SMF12A','USB_VBUS','GND',kind='D',footprint='Diode_SMD:D_SOD-123F')
for i in (1,2):passive('10_usb_pd',f'D{1001+i}','PESD24VL1BA',f'USB_CC{i}','GND',kind='D',footprint='Diode_SMD:D_SOD-323',mpn='PESD24VL1BA,115',source='https://assets.nexperia.com/documents/data-sheet/PESD24VL1BA.pdf',note='VRWM 24 V, VBR 25.4 V min, 11 pF. A 5 V part conducts if CC shorts to 9 V VBUS.')
tp('10_usb_pd','TP1000','USB_VBUS');tp('10_usb_pd','TP1001','PD_9V_OK_N')

sheet('11_charger','1S charger and battery entry','CE pulled LOW: charges with the camera off, POR defaults 4.2 V / 1 A (PROG 3.00k, TI tables 7-1/7-2). 103AT-2 pack NTC, TS window 1-60 C (TI RT1 5.24k / RT2 30.31k). Open or shorted NTC suspends charge. Fit R1110 only to inhibit charging at bring-up. STAT (pin 1) is left open: the pin sits inside the charger power copper with no layout path out; firmware reads the charge state from the status registers over I2C.')
con('11_charger','J1100','PROTECTED 1S PACK / NTC',{1:'PACK_PLUS',2:'PACK_NTC',3:'GND'},'Connector_JST:JST_VH_B3P-VH_1x03_P3.96mm_Vertical',note='New rated harness required. Keying is not electronic reverse-polarity protection.')
passive('11_charger','F1100','7A fast 1206','PACK_PLUS','PACK_FUSED',kind='F',footprint='Fuse:Fuse_1206_3216Metric',mpn='SF-1206F700-2',source='Bourns SF-1206F series datasheet',note='5 A planning current = 71 % of 7 A. Interrupt rating 50 A relies on the pack PCM clearing a hard short first.')
add('11_charger','U1100','BQ25798RQMR',{1:None,2:'CHG_VBUS',3:'CHG_VBUS',4:'CHG_BTST1',5:'CHG_REGN',6:None,7:None,8:'CHG_VBUS',9:'CHG_VBUS',10:'GND',11:'GND',12:None,13:'CHARGE_CE_N',14:'I2C_SCL',15:'I2C_SDA',16:'CHG_TS',17:'CHG_ILIM',18:'CHG_BATP',19:'CHG_BTST2',20:'CHG_PROG',21:None,22:'BAT_PROTECTED',23:'BAT_PROTECTED',24:'CHG_SDRV',25:'SYS_RAW',26:'CHG_SW2',27:'GND',28:'CHG_SW1',29:'CHG_PMID'},lib='Battery_Management:BQ25798')
res('11_charger','R1100','CHG_PROG','GND','3.00k 1%',note='TI Table 7-1: 1S, 1.5MHz. Default 4.2V / 1A charge, hardware-disabled until qualified.')
res('11_charger','R1101','BAT_PROTECTED','CHG_BATP','100')
res('11_charger','R1102','CHARGE_CE_N','GND','100k',note='TI pin 13: CE must be pulled high or low. LOW = charge whenever VBUS is valid and EN_CHG=1; firmware inhibits with EN_CHG, not this pin.')
res('11_charger','R1110','CHARGE_CE_N','CHG_REGN','10k',dnp=True,note='BRING-UP ONLY: FIT = CHARGE INHIBIT. 10k over R1102 100k holds CE at 0.91 REGN.')
res('11_charger','R1104','CHG_REGN','CHG_ILIM','30.1k 1%',mpn='RC0603FR-0730K1L',source='https://www.yageogroup.com/component-documentation/download/specsheet/RC0603FR-0730K1L',note='Fallback only: 30.1k/10k keeps ILIM above restart at REGN 4.6-5.2V. Nominal command 184-371mA. Full-load PD policy remains required; not universal USB-A compliance.')
res('11_charger','R1105','CHG_ILIM','GND','10k 1%',mpn='RC0603FR-0710KL',source='https://www.yageogroup.com/component-documentation/download/specsheet/RC0603FR-0710KL')
res('11_charger','R1106','CHG_REGN','CHG_TS','5.23k 1%',note='RT1. TI 5.24k for 103AT-2; E96 5.23k gives 0.97 C / 59.9 C (T1 73.3 % / T5 34.2 % of REGN).')
res('11_charger','R1107','CHG_TS','GND','30.1k 1%',note='RT2. TI 30.31k; open NTC gives 85 % REGN = cold = charge suspended.')
res('11_charger','R1108','CHG_TS','PACK_NTC','0',note='NTC returns to pack negative = board GND; the gauge shunt is on the high side, so no TS offset.')
cap('11_charger','C1100','CHG_SDRV','1n 50V');cap('11_charger','C1101','CHG_REGN','4.7u 10V',size='0805')
cap('11_charger','C1102','CHG_BTST1','47n 16V',gnd='CHG_SW1');cap('11_charger','C1103','CHG_BTST2','47n 16V',gnd='CHG_SW2')
passive('11_charger','L1100','1.0uH 14.1A Isat','CHG_SW1','CHG_SW2',kind='L',footprint='KINO_A0:L_TDK_SPM6530',mpn='SPM6530T-1R0M120',source='TDK SPM6530 catalog 20160825 p5-6',note='TI BQ25798 characterization part (L1 1 uH). 7.81 mOhm max, Isat 14.1 A (-20 %), Itemp 13 A (+40 C). Land 1.85 x 3.4 mm, gap 3.7 mm per TDK.')
ci=1104
for net,count in [('CHG_VBUS',2),('CHG_PMID',3),('SYS_RAW',5),('BAT_PROTECTED',2)]:
    for j in range(count): cap('11_charger',f'C{ci}',net,'10u 35V X7R',size='1206');ci+=1
    cap('11_charger',f'C{ci}',net,'100n 35V');ci+=1
tp('11_charger','TP1101','SYS_RAW')

sheet('12_boost','5V boost and main load disconnect','5V = 0.6*(1+110k/15k). L Isat 19.6 A > ILIM 17.1 A max (TI 9.2.2.2). Comp per TI eq 12-14: fc 8-16 kHz, PM > 68 deg over Co 50-110 uF, L +/-20 %, Vin 3.0-4.3 V. Calculated; measure loop on bench.')
boostpins={1:('FB','input'),2:('COMP','passive'),3:('PGND','power_in'),4:('SW','passive'),5:('VOUT','power_out'),6:('EN','input'),7:('VIN','power_in'),8:('BST','passive'),9:('SW','passive'),10:('AGND','power_in'),11:('VCC','power_out')}
add('12_boost','U1200','TPS61288LRQQR',{1:'BOOST_FB',2:'BOOST_COMP',3:'GND',4:'BOOST_SW',5:'BOOST_5V',6:'BOOST_ENABLE',7:'SYS_RAW',8:'BOOST_BST',9:'BOOST_SW',10:'GND',11:'BOOST_VCC'},pin_defs=boostpins,footprint='KINO_A0:TPS61288_RQQ0011A_DRAFT',source='https://www.ti.com/lit/ds/symlink/tps61288.pdf',note='Custom land pattern independently transcribed; fabrication review mandatory.')
passive('12_boost','L1200','2.2uH 19.6A Isat','SYS_RAW','BOOST_SW',kind='L',footprint='Inductor_SMD:L_Coilcraft_XAL7070-XXX',mpn='XAL7070-222MEC',source='https://www.coilcraft.com/getmedia/1ba55433-bcc8-4838-9b21-382f497e12e0/xal7070.pdf',note='Isat 19.6 A (-30 %) > TPS61288 ILIM 17.1 A max, per TI 9.2.2.2. 6.33 mOhm max, Irms 13.2 A (+20 C). Worst operating peak 6.1 A at 3.0 V in, 2.6 A out. Same family as TI table 9-2 XAL1060, which does not fit. 7.0 mm tall.')
res('12_boost','R1200','BOOST_5V','BOOST_FB','110k 0.1%');res('12_boost','R1201','BOOST_FB','GND','15k 0.1%')
res('12_boost','R1202','BOOST_COMP','BOOST_COMP_RC','20.5k 1%',note='RC per TI eq 12 at fc 8 kHz, Co_eff 72 uF, Vin 3.0 V. Bench loop measurement required.')
cap('12_boost','C1200','BOOST_COMP_RC','3.3n 50V',note='CC per TI eq 13 at 2.6 A load.');cap('12_boost','C1201','BOOST_COMP','100p',dnp=True)
cap('12_boost','C1202','BOOST_VCC','4.7u 16V',note='TI: VCC needs > 1.0 uF effective; 2.2 uF 0603 is about 1.0 uF at 5 V.');cap('12_boost','C1203','BOOST_BST','100n',gnd='BOOST_SW')
cap('12_boost','C1204','SYS_RAW','22u 10V',size='1206');cap('12_boost','C1205','SYS_RAW')
for i in range(6):cap('12_boost',f'C{1206+i}','BOOST_5V','22u 10V',size='1206')
fet('12_boost','Q1200','MAIN_GATE','MAIN_COMMON','BOOST_5V');fet('12_boost','Q1201','MAIN_GATE','MAIN_COMMON','SYS_5V')
res('12_boost','R1203','MAIN_COMMON','MAIN_GATE','100k');nfet('12_boost','Q1202','BOOST_ENABLE','GND','MAIN_GATE')
add('12_boost','U1201','TPS62162DSGR',{1:'GND',2:'SYS_5V',3:'SYS_5V',4:'GND',5:'GND',6:'MB_3V3',7:'BUCK_SW',8:None,9:'GND'},lib='Regulator_Switching:TPS62162DSG')
passive('12_boost','L1201','2.2uH 1.5A','BUCK_SW','MB_3V3',kind='L',footprint='Inductor_SMD:L_Taiyo-Yuden_NR-30xx',mpn='TBD-2u2-1A')
cap('12_boost','C1212','SYS_5V','10u',size='0805');cap('12_boost','C1213','MB_3V3','22u',size='0805')
passive('12_boost','D1200','SS34','P4_5V_ISO','SYS_5V',kind='D')
passive('12_boost','JP1200','0R LINK - REMOVE FOR P4 USB SERVICE','P4_5V_ISO','P4_5V',kind='R',footprint='KINO_A0:R_1206_3216Metric_Vishay_CRCW-HP',note='Reverse isolation diode plus manual disconnect (0 ohm link, desolder for P4 USB service). Verify Guition external supply and USB topology before simultaneous connection.')
tp('12_boost','TP1200','SYS_5V');tp('12_boost','TP1201','MB_3V3');tp('12_boost','TP1202','GND')

sheet('13_power_button','Hardware on/off and user indication','Power controller TS8 pin map checked against manufacturer package drawing; EN is pin 7. KILL is pulled high until software requests shutdown. Long-hold target remains provisional. One green power LED (D1300, on MB_3V3, so lit only while the camera runs); there is no charge LED: the charger STAT pin has no layout path out, and charge state is shown by firmware from the charger status read over I2C.')
ltcpins={1:('ON','input'),2:('KILL','input'),3:('TMR','passive'),4:('GND','power_in'),5:('PB_N','input'),6:('VIN','power_in'),7:('EN','output'),8:('INT_N','open_collector')}
add('13_power_button','U1300','LTC2955ITS8-1',{1:'GND',2:'POWER_KILL_N',3:'POWER_TMR',4:'GND',5:'POWER_PB_N',6:'SYS_RAW',7:'BOOST_ENABLE',8:'POWER_INT_N'},pin_defs=ltcpins,footprint='Package_TO_SOT_SMD:TSOT-23-8',source='https://www.analog.com/media/en/technical-documentation/data-sheets/2955fa.pdf',note='TS8 p2: 1 ON, 2 KILL, 3 TMR, 4 GND, 5 PB, 6 VIN, 7 EN, 8 INT. Enable drive/loading still requires review.')
cap('13_power_button','C1300','SYS_RAW');cap('13_power_button','C1301','POWER_TMR','1.5u 16V',note='1.8 uF 0603 is not stocked by a major maker. Timer constant from the ADI data sheet still to confirm; about 7.9 s at 5.2 s/uF.')
res('13_power_button','R1300','POWER_KILL_N','SYS_RAW','100k');nfet('13_power_button','Q1300','SOFT_KILL','GND','POWER_KILL_N')
res('13_power_button','R1301','SOFT_KILL','GND','100k');res('13_power_button','R1302','POWER_INT_N','MB_3V3','10k')
con('13_power_button','J1300','POWER PUSHBUTTON',{1:'POWER_PB_N',2:'GND'})
res('13_power_button','R1303','MB_3V3','POWER_LED_A','2.2k')
passive('13_power_button','D1300','LED GREEN','GND','POWER_LED_A',kind='D',footprint='LED_SMD:LED_0603_1608Metric')

# Inner P4 brass inserts; do not substitute the outer case's 108 x 60 pattern.
for i,(x,y) in enumerate(INSERT_CENTRES):
    add('01_p4',f'H{i+1}','P4 M2 insert mount',{},pin_defs={},footprint='MountingHole:MountingHole_2.2mm_M2',at=(x,y),note='61.9 x 54.8 inner insert centres. Offset -9.3 mm is drawing-derived, pending physical fit. Extension spacers required for P4 component/header clearance.')

import json as _json
from pathlib import Path as _Path
_sel = _json.loads(_Path(__file__).with_name('part_selection.json').read_text(encoding='utf-8'))
_by_ref = {p['ref']: p for p in PARTS}
_OVERRIDDEN = {'D1002', 'D1003', 'C1202', 'C703', 'RS700', 'F1100', 'U1300', 'C1301'}   # changed after the selection run
for _s in _sel['selections']:
    for _r in _s['refs']:
        if _r in _by_ref and _r not in _OVERRIDDEN and not _by_ref[_r]['mpn'].startswith(('RC0603', 'RT0603')):
            _by_ref[_r]['mpn'] = _s['manufacturer'] + ' ' + _s['mpn']
            _by_ref[_r]['source'] = _s['datasheet']
_MPN = {'D1002': 'Nexperia PESD24VL1BA,115', 'D1003': 'Nexperia PESD24VL1BA,115',
        'C1202': 'Samsung CL10A475KO8NNNC', 'C703': 'Samsung CL10A105KB8NNNC', 'RS700': 'Vishay Dale WSLP1206R0050FEA',
        'F1100': 'Bourns SF-1206F700-2', 'U1300': 'Analog Devices LTC2955ITS8-1#TRMPBF', 'C1301': 'Samsung CL10A155KO8NNNC'}
for _r, _m in _MPN.items(): _by_ref[_r]['mpn'] = _m

assert len({p['ref'] for p in PARTS}) == len(PARTS)
