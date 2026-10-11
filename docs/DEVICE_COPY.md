# Device copy

Every line the KINO D4 body says on its own screen, and when. Source of truth is `firmware/p4/main/ui.c`, `conditions.h` and `capture.c`. `npm run copy:check` reads those three files both ways. It fails when a line they can draw is not in this table, when a line in the Text, Title, Detail, Question, Line or Buttons columns below is one no source can draw any more, and when a toast runs to 40 characters or more. The sentence above is a check rather than a promise.

How to read the table: `N`, `12` or `4571` stands for a number the camera fills in, `<version>` for the firmware version, and a network or look name for itself. Case is not compared: rows, facts and condition titles are set in capitals when they are drawn.

## The rule

The person holding the camera has read nothing and will not phone anyone. Each line names what happened and, when there is one, what to do about it. Under 40 characters for a toast, one short line for a banner, two for a dialog. Plain words: lens, photo, card, cells. No codes, no contract names on the glass; those go to the log and the KDP reply. Values on a band or in a reading are in capitals: `15 S`, `2 MIN`, `MEDIUM`.

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

## Screen titles

| Text | When |
|---|---|
| `LOOK` / `GALLERY` / `PHOTO` / `ROLL` / `SETTINGS` / `POWER` | The header of each screen the menu opens. MENU and SHOOT have no header. |
| `DISPLAY` / `SOUND` / `CONNECTION` / `STORAGE` / `ABOUT` / `STATUS` | The header of each screen SETTINGS opens. |
| `12 PHOTOS` / `1 PHOTO` | GALLERY's header: how many photographs the card holds. |
| `READING CARD 120` / `READING CARD` | GALLERY's header while the card is still being counted, with the count once there is one. |

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

The lens word in "A lens is not answering" is one of `first` / `second` / `third` / `fourth`, counted from the left as the camera is held.

The rows at the foot of STATUS:

| Title | Detail | When |
|---|---|---|
| Restart the cameras | Switches the four lenses off and on | Always. |
| Measure cameras again | The next photograph measures them | Once the cameras are measured. |

| Text | When |
|---|---|
| `NOTHING TO REPORT` | No open condition. |
| `The camera has no complaints.` | With it, in a sentence rather than a state. |

## SHOOT

| Text | When |
|---|---|
| `MENU` | The way out, on the back button beside the picture. |
| `WIGGLE` / `QUAD` | The mode, on the decisions bar. Tapping the bar opens LOOK. |
| `AUTO` / `ON` / `OFF` | The flash, beside the bolt on the decisions bar. |
| `NO PICTURE` / `NO RECENT FRAME` / `NO CAMERA` | A finder pane with no pixels: the lens reported an error, its frames stopped, or it is not linked. Said once the first second of SHOOT has passed. |
| `CAM1` / `CAM2` / `CAM3` / `CAM4` | Under that word, which pane it is. |

## SHOOT banner

| Text | When |
|---|---|
| `SHOOTING` / `READING` / `SAVING` | The capture's stages. |
| `SAVING - NEXT SHOT QUEUED` | A second shutter press landed while saving; it fires when the report does. |
| `TAKE THE LENS COVER OFF` | On SHOOT, every pane was lit and then all went dark for a second: the cover went on. A body switched on facing the desk says nothing. |
| `CHECK THE SECOND LENS` | On SHOOT, one pane was lit and then went a third as bright as the rest for a second while the others stayed lit. The word is one of `FIRST` / `SECOND` / `THIRD` / `FOURTH`. |
| `10` .. `1`, `SELF-TIMER.  PRESS TO CANCEL` | A long shutter press started the timer. |
| `SAVED` | Every lens that answered is on the card. |
| `SAVED, 1 CAMERA MISSED` | A partial photograph; the cells show which. |
| `No card. Put one in.` | Shutter with no card. |
| `Card full. Delete photos or change the card.` | Shutter with no room. |
| `No lens answered. Try a restart.` | No camera node answered the probe. |
| `The lenses did not wake. Try a restart.` | The camera bank did not come back after a cycle. |
| `Card error. Photo not saved.` | The capture folder could not be made, or META.JSON would not commit and the half-made folder was removed. Both end with nothing on the card, so both say so; the log and the KDP reply separate the causes. |
| `Out of memory. Photo not saved.` | The photograph's record could not be built; the half-made folder was removed. |
| `Camera busy. Press again.` | A press landed while a bench command or a probe sweep held the capture. |
| `NO PHOTO` | A failed capture that carried no line at all. No failure path does this today. |

## Working banners

| Text | When |
|---|---|
| `FORMATTING THE CARD` | FORMAT confirmed; the card is locked for the seconds it takes. |
| `RESTARTING THE CAMERAS` | RESTART THE CAMERAS pressed; three seconds. |
| `RESTARTING` | The whole screen, between RESTART or FACTORY RESET confirmed and the panel going dark. |

## Toasts

| Text | When |
|---|---|
| Card ready, 4571 SHOTS | A card was put in while running and mounted. |
| Card taken out. Photos cannot be saved | The card was pulled while running. |
| Card busy. Try again | The card lock was held for two seconds by a capture or an upload. |
| Card formatted | FORMAT finished. |
| The card could not be formatted | FORMAT failed; the log has the reason. |
| Deleted.  TAP TO UNDO | One photograph moved to the trash; the toast stays thirty seconds and a tap restores it. |
| Deleted | One photograph deleted outright, because the trash folder could not take it. |
| Restored | UNDO tapped in time. |
| Could not restore it | The folder would not move back. |
| Timer cancelled | A press during the self-timer. |
| Deleting photos | DELETE ALL started on the gallery task. |
| No photos on the card | DELETE ALL with nothing to delete. |
| No card in the slot | FORMAT with nothing in the slot. |
| Cameras measured | The first photograph's measurement stored. |
| Not measured. Aim at a busier scene | The measurement found a flat scene. |
| The next photo measures the cameras | MEASURE AGAIN pressed. |
| Sent to the roll | SEND TO ROLL queued the photograph. |
| Could not send. Try again later | SEND TO ROLL could not queue it. |
| No active roll | SEND TO ROLL with no Roll joined. |
| No pictures on the card to send | SEND TO ROLL on a photograph with no frames left. |
| Could not save the change | The favourite flag could not be written. |
| Still reading the card | A tile tapped before the gallery had its id. |
| No looks on this camera | LOOK with no recipes. |
| Hold the power slide to switch off | SHUT DOWN row, which has no soft power-off. |
| Cameras did not start. Restart KINO | The shutter, on a body whose capture pipeline failed to come up at boot. Said instead of blaming a capture that is not running. |
| Favourite / Not favourite | FAVOURITE pressed on PHOTO; the mark went on or came off. |
| First photo / Last photo | PREV on the first photograph, or NEXT on the last. |
| WIGGLE / QUAD | The mode band on LOOK was pressed. |
| COLOUR / B&W | The colour band on LOOK was pressed. |

The look's own name is also toasted when a look is picked.

## Dialogs

Every dialog has two rows: the action on top, CANCEL under it, where the thumb reaches first.

| Title | Question | Line | Buttons | When |
|---|---|---|---|---|
| FIRST START | Take a photograph first. | It measures the cameras. See STATUS. | GOT IT / CANCEL | The first boot, once. |
| UPDATED | KINO has been updated. | Now on <version>. Nothing to do. | OK / CANCEL | The first boot on a new version, once. |
| RESTART | Restart the camera? | KINO restarts and opens the menu. | RESTART / CANCEL | POWER > RESTART |
| FACTORY RESET | Reset the camera? | Settings, networks and roll are erased. | RESET / CANCEL | POWER > FACTORY RESET |
| DELETE | Delete this photo? | N frames. Undo for 30 s after. | DELETE / CANCEL | PHOTO > DELETE. The toast after it offers UNDO for those 30 s. |
| DELETE ALL | Delete every photo? | N photos. This cannot be undone. | DELETE ALL / CANCEL | STORAGE > DELETE ALL PHOTOS |
| FORMAT CARD | Erase the card? | Every photo on it is deleted. | FORMAT / CANCEL | STORAGE > FORMAT CARD |

## Screen rows and labels

What each screen puts on itself, beyond the chip, the banner and the toasts
above. Every one of these is drawn by `ui.c`; the check script walks the same
calls and fails when one of them is not in this table.

### Main menu

| Text | When |
|---|---|
| `SHOOT` / `LOOK` / `GALLERY` / `ROLL` / `SETTINGS` / `POWER` | The six tiles. SHOOT is the large card. |
| `TAP TO OPEN` | On the menu's large card. |
| `CAMERA  4571 SHOTS` | The card's line when nothing is wrong: the card in the header chip's words. The worst condition's title takes its place when there is one. |

### LOOK

| Text | When |
|---|---|
| `MIXED` | The four lenses carry different looks. |
| `NONE` | No look is set. |
| `MODE` / `FLASH` / `COLOUR` | The legends over the three bands. |
| `WIGGLE` / `QUAD` | The mode band. |
| `AUTO` / `ON` / `OFF` | The flash band. |
| `COLOUR` / `B&W` | The colour band. |
| `TARGET` | The band that picks which lens the next look lands on. QUAD only. |
| `CAM1` / `CAM2` / `CAM3` / `CAM4` / `ALL` | The target band's choices, ALL at the hand's end. |
| `Four cameras, four looks. Pick one to see it.` | QUAD, under the card: what the mode does. |
| `AT CAPTURE` | The look is applied when the photograph is taken, not to the finder. |
| `Sets nothing on the sensor.` | A look that carries no sensor settings of its own. |
| `+1.5 EV` / `-0.5 EV` | The exposure bias a look carries, when it has one. |
| `DENOISE 2` / `SHARP 3` | The denoise and sharpness a look carries, when it has them, on the same line. |

### GALLERY

| Text | When |
|---|---|
| `NO CARD` | No card mounted. |
| `Insert a microSD card to store photos.` | Under it. |
| `READING CARD` / `READING CARD 120` | The card is still being counted. |
| `Looking through the captures on the card.` | Under it. |
| `NO PHOTOS YET` | The card holds no photographs. |
| `Press the shutter to take one.` | Under it. |
| `NO IMAGE` | A tile whose frames could not be decoded. |
| `SENT` | The badge on a tile the Roll holds every frame of. |

### PHOTO

| Text | When |
|---|---|
| `FAVOURITE` | The button; the star fills when it is on. |
| `SEND TO ROLL` | The button that queues the photograph for the Roll. |
| `DELETE` | The button that opens the DELETE dialog. |
| `SENT` | After the mode, once the Roll holds every frame. |
| `TODAY 18:01` | When it was taken, in the clock's zone; `21 SEP 18:01` on any other day. |
| `JAN` / `FEB` / `MAR` / `APR` / `MAY` / `JUN` / `JUL` / `AUG` / `SEP` / `OCT` / `NOV` / `DEC` | The month in that date. |
| `2 MISSING` | A wiggle swinging fewer than four frames: how many lenses did not reach the card. |
| `NO IMAGE` | The photograph's frames could not be decoded. |

### ROLL

| Text | When |
|---|---|
| `SCAN TO JOIN` | Over the QR, when a Roll is active. |
| `Code` / `Enter this code to join` | The short code under the QR, for someone who cannot scan. |
| `Status` | The row naming what the Roll is doing. |
| `Online` / `Offline` / `Paused` / `KINO not answering` | Its value: uploading normally, no network, halted by the server, or the Roll server not answering. |
| `Photos` | The count of photographs on the card. |
| `Uploaded` | The count of frames the Roll already holds. |
| `12 of 40` / `counting` | Its value, or `counting` while the card is still being read. |
| `3 waiting, saved on the camera.` | Photographs not yet sent. |
| `Check the roll in Studio.` | Under it, when the server halted uploads. |
| `They go when KINO answers.` / `They go when Wi-Fi returns.` | Under it, when there is no route to send them. |
| `Uploading, 12 to go.` / `Starting, 12 to go.` | Uploads running, over the progress bar. |
| `Counting the card.` | The upload queue has not finished reading the card. |
| `All uploaded, 12s ago.` / `All uploaded, 5m ago.` / `All uploaded, 2h ago.` | Nothing waiting, and when the last one went. |
| `All uploaded.` | Nothing waiting, and nothing has gone since boot. |
| `Nothing waiting.` | Nothing waiting and no route to send. |
| `Uploads resume when Wi-Fi returns.` | Under it, offline. |
| `NO ACTIVE ROLL` | No Roll joined. |
| `Make a roll in Studio over USB-C.` | With it: how to get one. |
| `It appears here with a code guests scan.` | What will be on this screen once there is one. |
| `12 PHOTOS ON THE CARD` / `1 PHOTO ON THE CARD` | No Roll joined: the card's count, in a well at the foot. |
| `They import over USB-C, and upload if a roll is assigned later.` | Under it: the photographs are not stranded. |
| `NO PHOTOS ON THE CARD` | No Roll joined and nothing on the card. |
| `Press the shutter to take one.` | Under it. |
| `The join link is too long to encode.` | The Roll's URL will not fit a QR; the code above it still works. |

### SETTINGS

| Text | When |
|---|---|
| `Display` / `Sound` / `Connection` / `Storage` / `About` / `Status` | The six rows. Status only when a condition is open. |
| `1 MIN` / `2 MIN` / `5 MIN` | Display's value: the sleep time, in the DISPLAY band's words. |
| `OFF` / `LOW` / `MEDIUM` / `HIGH` | Sound's value: OFF when both sounds are off, else the volume in the SOUND band's words. |
| `Not connected` | Connection's value with no network; otherwise the network's name. |
| `4571 SHOTS` / `NO CARD` | Storage's value, in the header chip's words. About's value is the firmware version. |
| `The card is full, and 2 more` | Status's value: the worst condition, and how many others. |

### SETTINGS > DISPLAY

| Text | Choices, or when |
|---|---|
| `DIM AFTER` | `15 S` / `30 S` / `60 S` |
| `SLEEP AFTER` | `1 MIN` / `2 MIN` / `5 MIN` |
| `AFTER SHOT` | `OFF` / `1 S` / `2 S` / `3 S` / `HOLD` |
| `CAM IDLE` | `1 MIN` / `5 MIN` / `NEVER` |
| `BRIGHTNESS AND POWER` | The box over the note under the bands. |
| `On or off, not dimmable. Tap the screen to wake. Hold the slide to switch off.` | Under BRIGHTNESS AND POWER: the backlight is a switch, not a dimmer. |

### SETTINGS > SOUND

| Text | When |
|---|---|
| `Shutter sound` | The picker row naming the chosen sound. |
| `CLICK` / `CHEAP DIGI` / `TINY BEEP` / `MECHANICAL` / `SILENT` | The five built-in sounds; a clip from the card shows its own name. |
| `Play shutter sound` / `Play button sound` | The two toggles. |
| `VOLUME` | The three-segment band. |
| `LOW` / `MEDIUM` / `HIGH` | Its three segments. |
| `5 built-in sounds, and 2 clips from the card.` / `5 built-in sounds. No clips on the card.` | Under the band: where the picker's list comes from. |
| `No audio output on this body` | The amplifier did not start; the controls above do nothing until it does. |
| `The settings above are stored, and nothing plays until the amplifier starts.` | With it: the settings are not lost. |
| `Upload your own in Studio over USB-C.` | Where the sounds beyond the built-in five come from. |

### SETTINGS > CONNECTION

| Text | When |
|---|---|
| `Radio` | `ESP32-C6`, or `None` on a body without one. |
| `Link` | `Not routed` / `No response` / `Starting` / `Ready` / `Error`: whether the firmware can reach the radio. |
| `Wi-Fi` | `studio-net  ch 6  -54 dBm` when on a network, else `Getting address` / `Connecting` / `Scanning` / `Disconnected` / `Unavailable`. |
| `Address` | The IP address, or a dash. |
| `Saved networks` | How many. |
| `USB` | `Connected` / `Not connected`. |
| `Set up Wi-Fi in Studio over USB-C.` | No network saved. |
| `Captures upload to the active roll.` | A network is saved and a Roll is joined. |
| `No radio on this body. Photos leave over USB-C.` | The no-radio build. |
| `Radio fitted, no route to it yet. Photos leave over USB-C.` | The radio build on a body whose coprocessor is not reachable. |
| `TIME ZONE   UTC+01:00` | The TIME ZONE band, in quiet ink until the zone is set. |
| `+` / `-` | Its two buttons, half an hour a press. |

### SETTINGS > STORAGE

| Text | When |
|---|---|
| `Card` | `29.7 GB` or `None`. |
| `Free space` | `12.3 GB` or `850 MB`, in whole units, with `12.3 GB  LOW` under 5 % free. |
| `Photos` | `120`, or `DELETING 120 OF 500` while DELETE ALL runs. |
| `Delete all photos` | The row that opens DELETE ALL. |
| `Format card` | The row that opens FORMAT CARD, with `Erases every photo`, or `The card cannot be read` when the card is in the slot and not mounted. |
| `17.4 GB used` | Under the gauge. |
| `FAT32, write test pass` | At its right: the card's format and whether the boot write test passed. |
| `The card cannot be read` / `No card in the slot` | No card mounted: a card is in the slot, or none is. |
| `Cards over 32 GB come in a format KINO does not read. FORMAT CARD fixes it.` | Under it, for a card with no FAT file system. |
| `Tried 3 times. Take the card out and put it back.` | Under it, for any other mount failure. The error code goes to the log and the KDP status. |
| `0 mount attempts since boot` | Under it, when nothing has failed yet. |

### SETTINGS > ABOUT

| Text | When |
|---|---|
| `Name` | The body's name, only when one is set. |
| `Model` | `KINO D4`. |
| `Hardware` / `Firmware` / `Serial` | The board revision, the firmware version and the serial. |
| `Protocol` | `KDP 3`: the protocol Studio speaks to it. |
| `Card` | `12.3 GB free of 29.7 GB`, `Not mounted`, or `None`. |
| `Uptime` | `3h 12m`, or `4m` under the hour. |
| `CAMERAS` | The heading over the four lenses. |
| `CAM1` / `CAM2` / `CAM3` / `CAM4` | One row per lens: its firmware and sensor, `0.3.1  no sensor` when the sensor did not answer, or `No answer`. |
| `SCAN FOR HELP` | Under the QR that opens a new issue with the serial and firmware filled in. |

### POWER

| Text | When |
|---|---|
| `Restart` | The row that opens RESTART, with `Opens the menu after`. |
| `Shut down` | The row; it toasts, because the slide is the only way off. With `Hold the power slide`. |
| `Factory reset` | The row that opens the confirm. |
| `Settings, networks, roll` | Under it: what a reset erases. Photographs are not on the list. |
| `RUNNING ON` | The heading over where the power comes from. |
| `Powered from the cable.` | USB-C attached. |
| `On the cells. This body has no battery gauge.` | On battery. There is no percentage because there is no sense pin. |

## Dim and sleep

At the dim time the screen darkens under a scrim on an eased ramp over 1.6 s and stays readable; a touch lifts it. 
At the sleep time the dimmed picture darkens to the ground over half a second, the mark and `GOING TO SLEEP.  TAP TO WAKE` fade in from the dark, hold half a second, fade out, and then the backlight drops: two seconds, no cut. DISPLAY says the same under BRIGHTNESS AND POWER: on or off, not dimmable; tap the screen to wake; hold the slide to switch off.

## After a shot

Every photograph opens as the wiggle for the AFTER SHOT time (at least one loop, about three seconds; HOLD stays until a finger moves it), then the screen returns to SHOOT on its own. PHOTO shows the date as `TODAY 18:01` or `21 SEP 18:01` and `SENT` once the Roll holds every frame; gallery tiles carry the same `SENT` badge.

## Help

ABOUT carries a QR under SCAN FOR HELP that opens a new issue with the serial and firmware version filled in. CONNECTION has the TIME ZONE band; the clock is on UTC until it is set there or by Studio.

## Field log

Every 30 s the log ring is appended to `/KINO/LOGS/BOOT-nnnnn.TXT` on the card; the twenty newest boots are kept. A person can copy the file from a card reader and send it. The ring holds 600 entries and carries evidence only: per-frame and per-poll numbers are telemetry and are dropped unless `body.log.telemetry` is set, which is a bench setting Studio can turn on. Clearing the logs from Studio hides what came before and does not stop the file.
