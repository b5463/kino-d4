// KINO D4 four-XIAO camera carrier, board A0.2 (hardware/pcb/kino-d4-carrier-a0).
//
// Not the Guition JC4880P443C-I-W the P4 sits on: that module is "the carrier"
// in board_d4v1.h. This is the camera board that hangs off the P4's JP1 by the
// 26-way ribbon. Nothing includes this file yet; it fixes the hardware facts
// the carrier firmware must follow, taken from design/circuit.py (the capture
// source of truth). Change both together.
//
// Every carrier device sits on the P4 I2C bus (BOARD_I2C_SDA/SCL, shared with
// the GT911 and ES8311) behind U100, a TCA9517 buffer that the P4's own 3V3
// enables. The carrier's 3V3 (MB_3V3) exists only while the carrier is on, so
// none of these devices answer with the carrier off.
#ifndef KINO_CARRIER_A02_H
#define KINO_CARRIER_A02_H

// The local bus has 4.7k pull-ups and about 95-150 pF, and U100 forwards every
// P4-bus transfer onto it: keep the whole bus at standard mode.
#define CARRIER_I2C_MAX_HZ 100000

// --- 7-bit I2C addresses. No clash with the P4 bus's 0x14, 0x18, 0x5d. ---
#define CARRIER_PAC1954_ADDR 0x10   // U700: four camera 5 V currents (ADDRSEL to GND)
#define CARRIER_STUSB4500_ADDR 0x28 // U1000: USB-C PD sink (ADDR0/ADDR1 to GND)
#define CARRIER_TMP117_ADDR 0x48    // U802: board temperature (ADD0 to GND)
#define CARRIER_RV3028_ADDR 0x52    // U801: RTC; keep trickle charge off (primary backup cell)
#define CARRIER_BQ27441_ADDR 0x55   // U701: fuel gauge; write CC Gain for the 5 mOhm shunt
#define CARRIER_DRV2605L_ADDR 0x5a  // U900: haptic driver
#define CARRIER_LSM6DSOX_ADDR 0x6a  // U800: IMU (SA0 to GND)
#define CARRIER_BQ25798_ADDR 0x6b   // U1100: charger
#define CARRIER_TCA9539_ADDR 0x74   // U600: GPIO expander (A0, A1 to GND)

// STUSB4500: the board survives the factory NVM (it takes 20 V from a PD
// charger), but program the NVM for 9 V / 2 A with the 5 V fallback for
// normal use.

// --- U700 PAC1954: channel n measures camera n's 5 V current ---
// Shunts RS200/RS300/RS400/RS500, 20 mOhm each (CH1..CH4 = CAM1..CAM4).
#define CARRIER_PAC1954_SHUNT_MOHM 20

// --- U600 TCA9539 GPIO expander ---
// Registers: input 0x00/0x01, output 0x02/0x03, polarity 0x04/0x05,
// configuration 0x06/0x07 (1 = input). INT is not wired: poll the inputs.
#define CARRIER_EXP_REG_INPUT0 0x00
#define CARRIER_EXP_REG_INPUT1 0x01
#define CARRIER_EXP_REG_OUTPUT0 0x02
#define CARRIER_EXP_REG_OUTPUT1 0x03
#define CARRIER_EXP_REG_CONFIG0 0x06
#define CARRIER_EXP_REG_CONFIG1 0x07

// Port 0 (pins 4-11). CAMn_REQ is ANDed with CAM_GLOBAL_EN (P4 GPIO31, JP1 10)
// by U601 to enable camera n's TPS2553 switch; each REQ is pulled down 100k,
// so cameras stay off until firmware drives both. FAULT_N is the switch's
// open-drain over-current flag, pulled up 10k: low = fault.
#define CARRIER_EXP0_CAM1_REQ (1u << 0)
#define CARRIER_EXP0_CAM2_REQ (1u << 1)
#define CARRIER_EXP0_CAM3_REQ (1u << 2)
#define CARRIER_EXP0_CAM4_REQ (1u << 3)
#define CARRIER_EXP0_CAM1_FAULT_N (1u << 4)
#define CARRIER_EXP0_CAM2_FAULT_N (1u << 5)
#define CARRIER_EXP0_CAM3_FAULT_N (1u << 6)
#define CARRIER_EXP0_CAM4_FAULT_N (1u << 7)

// Port 1 (pins 13-20), in the order the layout set (circuit.py, U600 note).
// P1.3 is not connected: the charger STAT pin had no layout path to it. Drive
// it as a low output so it does not float; read the charge state from the
// BQ25798 instead (below).
#define CARRIER_EXP1_IMU_INT (1u << 0)     // U800 INT1, push-pull
#define CARRIER_EXP1_RTC_INT_N (1u << 1)   // U801 INT, pulled up 10k
#define CARRIER_EXP1_SOFT_KILL (1u << 2)   // output: high turns the whole system off (U1300 KILL via Q1300)
#define CARRIER_EXP1_UNUSED_P1_3 (1u << 3) // not connected: output, driven low
#define CARRIER_EXP1_POWER_INT_N (1u << 4) // U1300 INT: power button pressed while on
#define CARRIER_EXP1_FN_N (1u << 5)        // J904 function button, active low, pulled up 10k
#define CARRIER_EXP1_HAPTIC_EN (1u << 6)   // output: DRV2605L EN, pulled down 100k
#define CARRIER_EXP1_COVER_N (1u << 7)     // J901 cover Hall sensor, active low

// Bring-up values: write the outputs low first, then the configuration.
// Port 0: REQ outputs, FAULT inputs. Port 1: SOFT_KILL, P1.3 and HAPTIC_EN
// outputs. U600 is reset only at carrier power-up (RC on its RESET pin), so it
// keeps its state across a P4-only reset: write both ports on every P4 boot.
#define CARRIER_EXP_OUTPUT0_DEFAULT 0x00
#define CARRIER_EXP_OUTPUT1_DEFAULT 0x00
#define CARRIER_EXP_CONFIG0 0xf0
#define CARRIER_EXP_CONFIG1 0xb3

// --- Charge state, read from the BQ25798 (no STAT pin, no charge LED) ---
// REG0x1C Charger_Status_1, CHG_STAT field, bits 7:5 (TI SLUSDV2C, section
// 7.5.1.24, table 7-37). Code 5 is reserved.
#define CARRIER_BQ25798_REG_CHARGER_STATUS_1 0x1c
#define CARRIER_BQ25798_CHG_STAT(reg) (((reg) >> 5) & 0x7u)
#define CARRIER_BQ25798_CHG_NOT_CHARGING 0
#define CARRIER_BQ25798_CHG_TRICKLE 1
#define CARRIER_BQ25798_CHG_PRECHARGE 2
#define CARRIER_BQ25798_CHG_FAST_CC 3
#define CARRIER_BQ25798_CHG_TAPER_CV 4
#define CARRIER_BQ25798_CHG_TOP_OFF 6
#define CARRIER_BQ25798_CHG_DONE 7

#endif
