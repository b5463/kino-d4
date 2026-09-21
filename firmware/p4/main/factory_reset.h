// Factory reset: what a body forgets when it changes hands.
//
// Settings go back to the defaults (config_reset, which keeps the device
// identity), saved networks are erased, and the Roll membership goes with
// its credential - a bearer token that still authorises uploads to the
// previous owner's Roll must not travel with the camera. Photographs on the
// card are not touched: the card is the owner's, and FORMAT CARD is a
// separate decision. The caller restarts afterwards.
//
// One door for both entrances, the POWER screen and KDP FACTORY_RESET, so
// they cannot drift apart about what "factory" means.
#ifndef KINO_FACTORY_RESET_H
#define KINO_FACTORY_RESET_H

void factory_reset_erase(void);

#endif
