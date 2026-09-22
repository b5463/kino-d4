# Device copy

Every line the KINO D4 body says on its own screen, and when. Source of truth is `firmware/p4/main/ui.c`, `conditions.h` and `capture.c`. `npm run copy:check` walks those three files and fails when a line they can draw is not in this table, so the sentence above is a check rather than a promise.

## The rule

The person holding the camera has read nothing and will not phone anyone. Each line names what happened and, when there is one, what to do about it. Under 40 characters for a toast, one short line for a banner, two for a dialog. Plain words: lens, photo, card, cells. No codes, no camera numbers, no contract names on the glass; those go to the log and the KDP reply.

## Header chip

| Text | When |
|---|---|
| `PROBLEM` / `CHECK` / `NOTE` | The worst open condition. Absent when there is none. |
| `4571 SHOTS` | Card mounted, photographs left at 6 MB each. |
| `LAST 5` .. `LAST 1` | Five or fewer left. |
| `CARD FULL` | None left. |
| `NO CARD` | No card mounted since boot. |
| `CARD OUT` | The card was pulled while running. |
| `USB` / `BATTERY` | Where the power comes from. |

## STATUS rows

Severity words: PROBLEM stops photographs, CHECK does not yet, NOTE is information.

| Title | Detail | Severity |
|---|---|---|
| No card | Put a card in. Photos cannot be saved. | PROBLEM |
| The card was taken out | Put it back. Photos cannot be saved. | PROBLEM |
| The card cannot be read | Not a format KINO reads. Use a card up to 32 GB, or format it. | PROBLEM |
| This card failed a write | Copy your photos off it and change the card. | PROBLEM |
| This card is slow | Photos take longer to save. A faster card helps. | CHECK |
| The card is full | Delete photos or change the card. | PROBLEM |
| Card nearly full | Room for about N more photos. | CHECK |
| A lens is not answering | The second from the left. Try RESTART THE CAMERAS below. | PROBLEM, with the four cells |
| Lenses are not answering | 2 of 4. Try RESTART THE CAMERAS below. | PROBLEM, with the four cells |
| The cameras need an update | Connect to Studio to update them. | CHECK |
| The date is not set | Wi-Fi or Studio sets it once. | CHECK |
| Cameras not measured | The first photograph measures them. | NOTE |
| The camera lost power while running | Charge or replace the cells. | CHECK |
| Running without Wi-Fi | It crashed 3 times in a row. Restart to try again. | PROBLEM |
| The camera is warm | 78 C inside. The finder slows until it cools. | CHECK |
| The clock is on UTC | Set the time zone in CONNECTION. | NOTE |
| Uploads have no server | Set the Roll server in Studio. Photos stay on the card. | CHECK |

Action rows at the foot of STATUS: **Restart the cameras** (always) and **Measure cameras again** (once measured).

## SHOOT banner

| Text | When |
|---|---|
| `SHOOTING` / `READING` / `SAVING` | The capture's stages. |
| `SAVING - NEXT SHOT QUEUED` | A second shutter press landed while saving; it fires when the report does. |
| `TAKE THE LENS COVER OFF` | On SHOOT, every pane was lit and then all went dark for a second: the cover went on. A body switched on facing the desk says nothing. |
| `CHECK THE SECOND LENS` | On SHOOT, one pane was lit and then went a third as bright as the rest for a second while the others stayed lit. |
| `10` .. `1`, `SELF-TIMER.  PRESS TO CANCEL` | A long shutter press started the timer. |
| `SAVED` | Every lens that answered is on the card. |
| `SAVED, 1 CAMERA MISSED` | A partial photograph; the cells show which. |
| `No card. Put one in.` | Shutter with no card. |
| `Card full. Delete photos or change the card.` | Shutter with no room. |
| `No lens answered. Try a restart.` | No camera node answered the probe. |
| `The lenses did not wake. Try a restart.` | The camera bank did not come back after a cycle. |
| `Card error. Photo not saved.` | The capture folder could not be made. |
| `Card error. Photo saved without its notes.` | Frames on the card, META.JSON failed. |

## Working banners

| Text | When |
|---|---|
| `FORMATTING THE CARD` | FORMAT confirmed; the card is locked for the seconds it takes. |
| `RESTARTING THE CAMERAS` | RESTART THE CAMERAS pressed; three seconds. |

## Toasts

| Text | When |
|---|---|
| Card ready, 4571 SHOTS | A card was put in while running and mounted. |
| Card taken out. Photos cannot be saved | The card was pulled while running. |
| Card busy. Try again | The card lock was held for two seconds by a capture or an upload. |
| Card formatted | FORMAT finished. |
| The card could not be formatted | FORMAT failed; the log has the reason. |
| Deleted.  TAP TO UNDO | One photograph moved to the trash; the toast stays thirty seconds and a tap restores it. |
| Restored | UNDO tapped in time. |
| Could not restore it | The folder would not move back. |
| Timer cancelled | A press during the self-timer. |
| Deleting photos | DELETE ALL started on the gallery task. |
| No photos on the card | DELETE ALL with nothing to delete. |
| No card in the slot | FORMAT with nothing in the slot. |
| Cameras measured | The first photograph's measurement stored. |
| Not measured: aim at something with detail | The measurement found a flat scene. |
| The next photo measures the cameras | MEASURE AGAIN pressed. |
| Sent to the roll | SEND TO ROLL queued the photograph. |
| Could not send. Try again later | SEND TO ROLL could not queue it. |
| No active roll | SEND TO ROLL with no Roll joined. |
| No pictures on the card to send | SEND TO ROLL on a photograph with no frames left. |
| Could not save the change | The favourite flag could not be written. |
| Still reading the card | A tile tapped before the gallery had its id. |
| No looks on this camera | LOOK with no recipes. |
| Hold the power slide to switch off | SHUT DOWN row, which has no soft power-off. |
| Favourite / Not favourite | FAVOURITE pressed on PHOTO; the mark went on or came off. |
| First photo / Last photo | PREV on the first photograph, or NEXT on the last. |

## Dialogs

| Title | Body | Buttons | When |
|---|---|---|---|
| FIRST START | Take a photograph first. It measures the cameras. See STATUS. | GOT IT | The first boot, once. |
| UPDATED | KINO has been updated. Now on 0.4.58. Nothing to do. | OK | The first boot on a new version, once. |
| RESTART | Back in a moment? KINO restarts and comes back to SHOOT. | RESTART / CANCEL | POWER > RESTART |
| FACTORY RESET | Reset the camera? Settings, networks and roll are erased. | RESET / CANCEL | POWER > FACTORY RESET |
| DELETE | Delete this photo? N frames. This cannot be undone. | DELETE / CANCEL | PHOTO > DELETE |
| DELETE ALL | Delete all photos? N photos. This cannot be undone. | DELETE / CANCEL | STORAGE > DELETE ALL PHOTOS |
| FORMAT CARD | Erase the card? Every photo on it is deleted. | FORMAT / CANCEL | STORAGE > FORMAT CARD |

## Screen rows and labels

What each screen puts on itself, beyond the chip, the banner and the toasts
above. Every one of these is drawn by `ui.c`; the check script walks the same
calls and fails when one of them is not in this table.

### SHOOT

| Text | When |
|---|---|
| `MENU` | The way out, on the back button beside the picture. |
| `WIGGLE` / `QUAD` | The mode, on the decisions bar. Tapping the bar opens LOOK. |

### LOOK

| Text | When |
|---|---|
| `TARGET` | The band that picks which lens the next look lands on. QUAD only. |
| `B&W` / `COLOUR` | The colour control. |
| `Four cameras, four looks. Pick one to see it.` | QUAD, under the card: what the mode does. |
| `AT CAPTURE` | The look is applied when the photograph is taken, not to the finder. |
| `Sets nothing on the sensor.` | A look that carries no sensor settings of its own. |
| `+1.5 EV` / `-0.5 EV` | The exposure bias a look carries, when it has one. |

### GALLERY

| Text | When |
|---|---|
| `NO IMAGE` | A tile whose frames could not be decoded. |
| `Press the shutter to take one.` | The card holds no photographs. |

### PHOTO

| Text | When |
|---|---|
| `FAVOURITE` | The button; the star fills when it is on. |

### ROLL

| Text | When |
|---|---|
| `SCAN TO JOIN` | Over the QR, when a Roll is active. |
| `Code` / `Enter this code to join` | The short code under the QR, for someone who cannot scan. |
| `Status` | The row naming what the Roll is doing. |
| `Uploaded` | The count of frames the Roll already holds. |
| `NO ACTIVE ROLL` | No Roll joined. |
| `Make a roll in Studio over USB-C.` | With it: how to get one. |
| `It appears here with a code guests scan.` | What will be on this screen once there is one. |
| `NO PHOTOS ON THE CARD` | A Roll is joined and there is nothing to send. |
| `They import over USB-C, and upload if a roll is assigned later.` | Under it: the photographs are not stranded. |
| `The join link is too long to encode.` | The Roll's URL will not fit a QR; the code above it still works. |

### SETTINGS > SOUND

| Text | When |
|---|---|
| `Shutter sound` | The picker row naming the chosen sound. |
| `Play shutter sound` / `Play button sound` | The two toggles. |
| `VOLUME` | The three-segment band. |
| `No audio output on this body` | The amplifier did not start; the controls above do nothing until it does. |
| `The settings above are stored, and nothing plays until the amplifier starts.` | With it: the settings are not lost. |
| `Upload your own in Studio over USB-C.` | Where the sounds beyond the built-in five come from. |

### SETTINGS > DISPLAY

| Text | When |
|---|---|
| `On or off, not dimmable. Tap the screen to wake. Hold the slide to switch off.` | Under BRIGHTNESS AND POWER: the backlight is a switch, not a dimmer. |

### SETTINGS > CONNECTION

| Text | When |
|---|---|
| `Set up Wi-Fi in Studio over USB-C.` | No network saved. |
| `Captures upload to the active roll.` | A network is saved and a Roll is joined. |
| `No radio on this body. Photos leave over USB-C.` | The no-radio build. |
| `Radio fitted, no route to it yet. Photos leave over USB-C.` | The radio build on a body whose coprocessor is not reachable. |
| `+` / `-` | The TIME ZONE band's two buttons, half an hour a press. |

### SETTINGS > STORAGE

| Text | When |
|---|---|
| `Free space` | The reading row, in whole units. |

### SETTINGS > STATUS

| Text | When |
|---|---|
| `NOTHING TO REPORT` | No open condition. |
| `The camera has no complaints.` | With it, in a sentence rather than a state. |

### POWER

| Text | When |
|---|---|
| `RUNNING ON` | The heading over where the power comes from. |
| `Powered from the cable.` | USB-C attached. |
| `On the cells. This body has no battery gauge.` | On battery. There is no percentage because there is no sense pin. |
| `Shut down` | The row; it toasts, because the slide is the only way off. |
| `Factory reset` | The row that opens the confirm. |
| `Settings, networks, roll` | Under it: what a reset erases. Photographs are not on the list. |

### Main menu

| Text | When |
|---|---|
| `TAP TO OPEN` | On the menu's large card. |

## Dim and sleep

At the dim time the screen darkens under a scrim on an eased ramp over 1.6 s and stays readable; a touch lifts it. 
At the sleep time the dimmed picture darkens to the ground over half a second, the mark and `GOING TO SLEEP.  TAP TO WAKE` fade in from the dark, hold half a second, fade out, and then the backlight drops: two seconds, no cut. DISPLAY says the same under BRIGHTNESS AND POWER: on or off, not dimmable; tap the screen to wake; hold the slide to switch off.

## After a shot

Every photograph opens as the wiggle for the AFTER SHOT time (at least one loop, about three seconds; HOLD stays until a finger moves it), then the screen returns to SHOOT on its own. PHOTO shows the date as `TODAY 18:01` or `21 SEP 18:01` and `SENT` once the Roll holds every frame; gallery tiles carry the same `SENT` badge.

## Help

ABOUT carries a QR under SCAN FOR HELP that opens a new issue with the serial and firmware version filled in. CONNECTION has the TIME ZONE band; the clock is on UTC until it is set there or by Studio.

## Field log

Every 30 s the log ring is appended to `/KINO/LOGS/BOOT-nnnnn.TXT` on the card; the twenty newest boots are kept. A person can copy the file from a card reader and send it.
