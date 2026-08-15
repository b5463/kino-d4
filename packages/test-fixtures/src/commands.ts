// Command ids the simulator answers that @kino/kdp's `Cmd` enum does not
// name yet.
//
// SYNC_BENCH is in 04 §7's Diagnostics group and is what the Skew Bench runs
// against, but Task 7 shipped the Network/Roll ids without it. It sits at the
// next free slot in KDP's diagnostics range (0x40..0x45 are taken) so promoting
// it into `Cmd` later is a move, not a renumber.
export const SYNC_BENCH = 0x46;
