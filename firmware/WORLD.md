# KINO D4 — the persistent photographic world

The next phase. `UI_DIRECTION.md` records what is built; this is what to
build next, and why. It is the original world brief with the STARBOY
research folded in, marked where the research changed the argument.

---

## Part 0 — What actually makes STARBOY work

Researched before rewriting the brief, because "be like STARBOY" is
useless without knowing which part is load-bearing. Sources at the end.

### The facts

A wearable digital pet from lilguy.net (CREATURE), £249–439, shipping
2026. A 400×400 round OLED at 60 fps. Over 500 animations, hand-keyed by
former Disney animators, driven by a custom animation and behaviour
engine the team named **Lark**. Camera, microphone, temperature sensor
and accelerometer, with small local models doing face recognition and
about 30 hand gestures. No phone connection, no internet, no LLM, no
stated utility. Each unit ships with a distinct personality and one of
5,000+ eye designs with rarity tiers, not chosen by the buyer. Devices
that meet swap eyes, trade personality traits and pass firmware along. A
haptic engine does a purr.

### The eight things that are actually doing the work

**1. There is one object, and it never leaves.**
No navigation exists. No modes are visible. There is a face, and it is
always the face. Everything the product has to say, it says by changing
that one object. This is the whole lesson and it is the one KINO has not
learned yet.

**2. The reactions are to the physical world, not to the interface.**
Cold makes it shiver. A loud room makes it anxious. Shaking makes it
dizzy. Being flipped off makes it angry. Nothing in that list is a
response to a button. The device is reacting to *reality*, through
sensors, and that is why it reads as alive rather than as a good
animation showreel.

**3. Mood persists and decays; it is not an event handler.**
The wording that matters: it "gets anxious **and has to calm down**".
That is continuous internal state with a time constant, not a clip fired
on a trigger. Every later reaction is coloured by where that state
currently sits. This is the single biggest architectural difference
between STARBOY and what KINO has now.

**4. Hand-keyed, not procedural.**
Five hundred animations, keyed by people who animate characters for a
living, on a vocabulary of two eyes. The expressiveness comes from craft
applied to almost nothing, not from a system generating variety. A blink
is not an opacity fade. It is a squash with anticipation and a settle.

**5. Identity per unit, not chosen.**
You get the eyes you get. Rarity is real and non-negotiable. Ownership
becomes attachment because the object is specifically yours and could
not be reproduced by buying another one.

**6. It never asks anything of you.**
Explicitly not a Tamagotchi. There is nothing to feed, nothing to lose,
no guilt. Reviewers name this as central to the attachment.

**7. It is legible with no language at all.**
There is no text. A single blink reads as "bored". Understanding is
immediate and requires no reading.

**8. The engine is a named, owned thing.**
Lark is part of how the product is described. The behaviour system is
treated as the product, not as plumbing under the product.

### The warning, which is as useful as the praise

Gizmodo's reviewer liked it and still found that flipping it and shaking
it "grew tiresome rapidly", with gesture recognition lagging. The novelty
of poking a sensor to see a canned reaction decays fast. What is supposed
to counter that is rarity, the long tail of behaviours, and mood
persistence making the same input read differently on different days.
Assume decay is the default and design against it deliberately.

### What does not transfer to KINO

- **The face.** KINO must not grow eyes or a character. Its equivalent
  object is the four camera views.
- **The no-utility stance.** STARBOY can be useless. KINO is a camera
  that people will use at a party. Personality that costs a photograph
  is a bug, always.
- **Poking as the interaction loop.** Shaking a camera is not a feature.
  KINO's inputs are framing, shooting, and moving between states.
- **Eye swapping between units,** at least for now. The nearest real
  analogue is four cameras that already differ, and a KINO ROLL other
  people join.

### The five lessons that become requirements

| | STARBOY | KINO |
|---|---|---|
| One object | two eyes | the four camera views |
| Reacts to | cold, noise, shaking, faces | light, motion, sync quality, cadence |
| Mood | persists and decays | **to build: see Part 2** |
| Craft | 500 hand-keyed | **fewer, keyed at frame level** |
| Identity | 5,000 eye variants | **per-unit, from real camera differences** |

---

## Part 1 — One world, five states

Stop thinking:

```
SHOOT SCREEN   LOOK SCREEN   ROLL SCREEN   LINK SCREEN   SETUP SCREEN
```

Think:

```
one photographic world, in one of five operational states
```

The world is made of the four live camera views, the photographs those
cameras produce, typography, minimal geometry and motion. Everything
visible should be a transformation of that material.

Internally the firmware can keep `MODE_SHOOT`, `MODE_LOOK` and the rest.
Do not contort the state machine for design ideology. The requirement is
that the *renderer* never exposes those boundaries as five applications.

### The four views are the product

In SHOOT the four live views are the visual body of the device. They are
not four panes inside a layout. They are the layout. No chrome, no
separators drawn for decoration, no frame around them. The camera image
is the surface and everything else is secondary to it.

### Transitions are transformations

A mode change is never "old screen exits, new screen enters", however
well animated. The existing scene is rearranged. Objects keep identity,
position and momentum, and the user can follow them across.

**SHOOT to LOOK.** The four regions react at once. Separators move, one
region becomes dominant, the others compress, and the four-view structure
resolves into a single image. The four-camera surface *becomes* the
photograph. There is no frame where one thing is destroyed and another
appears.

**LOOK to ROLL.** The full image does not get replaced by a grid. It
becomes part of one. It reduces, its neighbours emerge around it, spacing
resolves, and it stays traceable the whole way. The grid is a resolved
state of the image world, not a page template.

**ROLL to LOOK.** Reversed with identity preserved. The photograph the
user touched becomes the full-screen image. It is not swapped for a
second copy of itself. Its neighbours reorganise around it. The feeling
is of having picked that one up.

**ROLL to LINK.** The roll is not cleared. Photographs collapse, stack or
move aside, space opens, and the code grows into that space. The roll has
become shareable. The camera has not opened a networking page.

**LINK to ROLL.** Returning immediately should not rebuild the roll. The
scene re-forms from where it is. This is exactly what the continuity
system exists for.

**SHOOT to LINK,** and every other pair. Transitions originate from the
real current scene, never from a normalised start pose.

**Anything to SETUP.** SETUP is allowed to break the photographic world.
The images leave, a line or simple geometry remains, and that geometry
organises the settings. Something from the previous state should become
something useful here, but do not invent a relationship that does not
help.

**Back** is continuation, not reload. Entering LOOK from a particular
roll image and going back returns to the state that follows from that
object, with the selection intact.

### Mode labels are transitional

Do not pin `SHOOT` to the corner because the mode architecture has five
entries. Let a name appear during the change, take part in the motion,
and go. The state should be readable from the world itself. Use a
persistent label only where clarity genuinely fails without one.

### Navigation is spatial, not paged

A swipe drives the transformation directly. At 20% of the gesture the
world is already 20% of the way into the next state. Do not wait for
release and then fire a canned clip.

On release, continue from the current transform at the current gesture
velocity, and settle or return. Velocity is an animation input: a fast
swipe and a slow one should not resolve identically. Different settle
timing, different overshoot, more or less separation between objects. Do
not exaggerate it. The display should feel attached to the finger.

---

## Part 2 — Mood: the missing layer

**This is the largest new requirement, and it comes directly from the
research.** KINO's behaviour system currently answers "something
happened, what do I play". STARBOY's answers "what kind of mood am I in,
and how does that colour what happens next". Build the second.

A small vector of continuous internal state, updated every pass, each
value decaying toward a resting point with its own time constant.
Something like:

| state | rises with | decays over | colours |
|---|---|---|---|
| energy | shot cadence, motion in frame, gesture speed | tens of seconds | transition speed, overshoot, how much settles |
| calm | scene stability, long framing, idle | minutes | whether reactions are quiet or emphatic |
| confidence | clean four-camera sync, successful transfers | minutes | convergence precision, how decisive the landing is |
| strain | failed captures, dropped frames, card and link trouble | minutes | hesitation, asymmetry, colour |

Exact axes are a design decision, not a specification. Three or four is
plenty. The requirements are that they are continuous, that they decay,
that real signals feed them, and that they bias both **behaviour
selection** and **motion parameters** rather than being displayed.

Two consequences:

- The same capture at high energy and at rest produces visibly different
  motion without needing two clips. Mood parameterises the clip.
- Behaviour selection reads mood first and randomness second, which is
  the fix for the animation-lottery problem below.

Mood is never shown. There is no mood indicator, no status word, no
face. If the user can name it, it has been built wrong.

---

## Part 3 — The camera should react to what it sees

KINO has four image sensors and currently uses them for zero behavioural
input. This is the clearest gap between KINO and the reference.

No computer vision, no ML. Cheap signals off frames the viewfinder is
already decoding:

- average luminance, and sudden changes in it
- frame-to-frame difference as a motion estimate
- contrast
- scene stability over the last few seconds
- time spent framing before the shutter
- exposure movement
- flash response, the frame before against the frame after
- **disagreement between the four cameras**, which is a signal no
  single-camera device has

Feed these into mood, and let mood do the rest. Concretely:

**Dark room.** Do not print `LOW LIGHT` as a status label. Let the world
adapt: reactions quieter, transitions slower, flash readiness more
present.

**High motion in frame.** Capture feedback gets faster and less
intrusive, because the user is in the middle of something.

**Stable for several seconds, then a shutter.** A deliberate shot. It can
afford a more considered landing than the fifth frame of a burst.

None of this is a feature the user is told about. It is behaviour.

### The four cameras are not identical, and that is material

They differ in framing, timing, luminance and exposure, and they have
parallax. Do not correct all of it away before the interaction can use
it. Some of KINO's character should come from the fact that these are
four physically separate cameras looking at the same room and
disagreeing slightly about it.

### Per-unit identity, from the hardware

STARBOY's 5,000 eye variants are its ownership hook. KINO's equivalent is
not cosmetic variants. It is that *this* unit's four cameras have their
own measured personality: their real timing spread, their colour
differences, their framing offsets. Seed the behaviour RNG and some
motion constants from the serial number and from those measurements.
Two KINOs should not be identical, and the difference should come from
the hardware rather than from a skin picker.

---

## Part 4 — Behaviour driven by context, not a lottery

Keep the selection infrastructure. Change what drives it.

Today:

```
capture_success  ->  weighted random over six clips
```

Wanted:

```
capture_success
   ->  context decides the family     (mood + real capture state)
   ->  small random variation inside that family
```

Real inputs available or cheap to add: synchronisation quality, whether
the flash fired, scene luminance, time since the last shot, number of
shots in the recent sequence, first shot after a wake, session count,
processing time, transfer state, and the timing spread between the four
source frames.

Examples of the mapping, not a specification:

- **An unusually clean four-camera sync** earns a precise convergence.
  The camera did something well and the motion says so.
- **A rapid burst** suppresses decoration entirely and stays responsive.
- **The first shot after a long idle** gets a stronger re-entry.
- **A flash shot** can use persistence, afterimage or channel separation
  derived from the real flash event.
- **A slow deliberate shot** after long framing lands differently from
  the fifth frame at a party.

The user never learns the rule. They feel that KINO reacted
appropriately, which is a different and better thing.

**Silence stays common.** Many captures should produce no decorative
reaction at all. This is the contrast that makes the authored ones land,
and it is also the defence against novelty decay.

---

## Part 5 — Capture, from the live surfaces

Capture keeps disproportionate attention, and it now originates from the
persistent world. Do not switch to a capture animation scene. The current
scene reacts: the live surfaces flash, split, distort, freeze, drift,
converge, keep fragments, and become the result.

The photograph should feel physically produced by the four live surfaces,
not loaded after processing.

### Use the four real images, not four dots

Four marks are a useful abstraction and can stay where they earn their
place. But abstracting away the strongest material KINO has is a mistake.
During capture the four *source frames* should participate: arriving
independently, briefly disagreeing, fragments persisting, strips from
different cameras aligning, one pushing another, then resolving.

Not a diagnostic display. The message is: this camera sees the world four
times.

### Latency is material, not something to hide

The pipeline has real delay. Do not cover it with a fake loader. The
scene stays alive through it, the four regions can hold different states,
a fragment can stay unresolved, and motion can wait in tension. When real
data arrives, the choreography continues.

This requires the runtime to support phases **gated on real events**
rather than on a fixed timeline:

```
shutter
  -> immediate response
  -> source frames begin arriving
  -> behaviour adapts, holds, or evolves
  -> required data ready
  -> convergence
```

Early data continues naturally. Late data holds in something meaningful.
No frozen waiting, no visible loops. This is where the runtime's
complexity earns itself.

---

## Part 6 — ROLL, LINK, SETUP, INFO

**ROLL is accumulated photographs, not a gallery widget.** The six-up
grid is a fine resolved layout. Photographs should feel physical through
motion and relationship, never through fake paper texture. Selected
images keep momentum, old and new enter differently, and the roll
reorganises around new content.

**A new capture joining ROLL is a hero micro-interaction.** The capture
result should shrink, stay alive in the scene, and become the newest roll
item. Recognising the photograph you just made is worth more than
navigating to a gallery and finding it there.

**LINK is the world extending outward,** not a networking page. The code
is functional, but the scene around it keeps the identity of the
photographs being shared. The user should understand that *these images*
are going *there*.

**Transfer uses real state.** No automatic progress bar. The photographic
objects communicate it: one leaves the local stack, image objects move
toward the link region, photographs resolve as transfer completes. Do not
fake per-image progress the backend does not expose.

**SETUP stays boring.** Text, line, selection, restrained motion. No
icons, no theatrical transitions. Clarity wins and the product earns its
personality elsewhere.

**INFO exposes the machine.** Firmware, hardware revision, camera status,
storage, calibration, build id, runtime counters, sensor state. Dense,
technical, no playful motion. The contrast is the point.

---

## Part 7 — Craft over count

**From the research: 500 hand-keyed animations on two eyes.** KINO has 35
procedurally competent clips across five screens. That is the wrong
ratio, in both directions.

Do not add clips. Rebuild the key interactions around the world model
first. Ten exceptional interaction families beat thirty-five impressive
but disconnected ones.

Priority order:

1. ~~SHOOT to LOOK, both ways~~ — **done.** `world_shoot_look`,
   `world_look_shoot`
2. ~~LOOK to ROLL, both ways~~ — **done.** `world_roll_look`,
   `world_look_roll`
3. ~~ROLL to LINK, both ways~~ — **done.** `world_roll_link`,
   `world_link_roll`. The photographs are not cleared: the same objects
   compress into a column at the left edge, the connection facts move
   right and step down a size, and the code opens into the space they
   made as a full-width sliver that rises into a square (`link_code`).
   Returning re-forms the grid from the column rather than rebuilding
   it. Where the pictures were going used to be spelled out beside the
   transfer marks; the code says it, so that label is gone.
4. ~~capture~~ — **done.** A frame does not arrive finished. Each of the
   four arrives at its own gate off its place, torn into strips, colour
   separated and a degree out of true, and then agrees with the other
   three; the correction is the photograph being made. Each arrival
   shoves the one before it, so what moves a pane is another camera
   turning up rather than a clock. The panes keep a trace of where they
   were while the capture runs, which is what makes four rectangles
   twitching read as one surface being assembled. They arrive a shade
   oversize so a frame out of true overlaps its neighbour instead of
   opening a hole onto the ground.
5. ~~a new capture joining ROLL~~ — **done.**
   `world_capture_joins_roll`. A photograph does not stop existing when
   the shutter sequence ends. The four views that made it become one
   object at the size they were, that object shrinks into the corner of
   the finder, and it stays there for five seconds - still in the hand.
   Opening the roll inside that window carries the same object into the
   first tile; leave it longer and it has settled into the roll like the
   others. The card's own thumbnail has not been decoded yet, so the
   object is born from the live views assembled the way the tile will be,
   and the real pixels are swapped under it without a retarget when the
   roll opens: same subject, sharper.
6. ~~transfer~~ — **done.** `world_transfer`. The four points lit by
   `burst_done / total` are gone: they were a progress bar with the bar
   taken off, and the queue cannot name the capture in flight or say how
   far through it is, so the fraction was a shape rather than a fact. The
   photographs carry it instead. Each one is restless on its own seed
   while the worker is working, so the pile is unsettled rather than
   sliding about as a piece; the pile takes one impulse at the instant
   the queue says one landed, and nothing interpolates toward a finish
   line; a stopped queue steps the photographs back and holds them
   completely still, because nothing is moving. The only number shown is
   the one the queue really has, which is how many are still owed, and it
   only ever goes down.
7. ~~wake~~ — **done.** `world_wake`. No title card and no fade. The
   panel goes dark, so the cameras stop, so every one of them is news
   again when the camera is picked up: each surface springs into its
   quarter on the frame its own sensor sends, tens of milliseconds
   apart. Nothing waits for the slowest and nothing pretends the fast
   ones were late. This needed no wake case at all - it is the same rule
   that lights a camera's mark when it starts answering, applied to the
   surface the mark stands for.
8. ~~interruption and rapid navigation~~ — **done.**
   `world_interrupt`. The hero transformation reversed a third of the
   way in, and reversed again before that has finished. Each reversal
   begins from the shape the surface had actually reached, so the second
   starts from a quad that was never a resting quad. The failure it
   films against is the one that looks fine in a still: a transformation
   that plays from its authored start pose every time, so an interrupted
   world jumps back to a shape it had already left.
9. ~~error~~ — **done.** `world_camera_lost`. The strongest error the
   world model has is the fundamental object losing a quarter, and it had
   been silent: a camera that stopped answering simply was not there any
   more. Now the picture falls out of that quarter rather than fading
   politely, its mark drops, and a rate-limited word says which one -
   once, and not again for a minute however many times the link flaps.
   The other three do not rearrange: the photograph is still a four-up
   and one of the four is missing. Every camera stopping at once is not
   this - it is the finder being turned off - and the interface has
   nothing to say about that. Coming back says nothing either: the
   quarter filling in is the message, and the word takes itself down
   rather than timing out while the camera is visibly answering.
10. ~~SETUP entry and exit~~ — **done.** `world_setup`,
    `world_setup_out`. SETUP breaks the photographic world without
    throwing it away: the four live surfaces flatten into a rule a few
    pixels tall above the first row, and continuity carries them there
    from whatever shape they were in, so the pictures are seen to leave.
    What organises the settings is made of them and is the colour of the
    room the camera is standing in. That is the whole of the personality
    this state gets; the rest is text, selection and restraint. Every
    screen in the SETUP family hangs from the same rule, INFO included.

Then, once those are right, go deep rather than wide: more keys, more
asymmetry, more per-frame decisions inside the same ten. That is where
the STARBOY quality actually lives.

### Typography is now secondary

Words punctuate. `GOT IT.` `READY.` `CONNECTED.` `SENT.` `AGAIN?` They do
not carry the personality.

**The test, taken straight from the reference:** remove every expressive
word and the product should still feel alive. STARBOY passes this
trivially because it has no words at all. KINO currently would not.

### Colour is behaviour

Neutral base, cobalt during motion and links, yellow around capture, red
only for real failure, then back to ink on ground. Apply it to the
photographic world and not only to text. A capture can disturb image
channels. A failure can briefly affect the whole scene.

### The disc and the line are tools

They do not need to appear in every state to prove consistency.
Consistency comes from motion behaviour, typography, spatial continuity,
image treatment and timing.

### Stillness is required

A persistent world does not mean perpetual motion. A live view can just
be a live view. A photograph can sit there. Motion matters because it
marks a change of state, not because something is always performing.

---

## Part 8 — What to build, and how to prove it

### Runtime work implied by this brief

- ~~**Mood state**, continuous, decaying, feeding selection and motion
  parameters.~~ **Done.** `kmood.h`: energy, calm, confidence and strain,
  each with its own time constant, read as tempo and vigour by the motion
  runtime and as bands by behaviour selection.
- ~~**Cheap frame signals** off the viewfinder, feeding mood.~~ **Done.**
  `ksense.h`: luminance, its rate, motion, contrast, stillness and
  inter-camera spread, off a sparse grid at 12 Hz.
- ~~**Per-unit seeding** from serial and measured camera differences.~~
  **Done.** `kmood_identity()` seeds the behaviour RNG, a permanent tempo
  bias, the leading camera and a skew bias.
- ~~**Event-gated choreography phases**, so a clip can wait on real data.~~
  **Done.** A clip may carry gates (`{ t, wait }`); the runtime pins its clock
  to the first gate still shut until the firmware opens it (`ks_open_gate`).
  `cap_frames` gates each of the four panes on its own source frame, so early
  data flows through at the authored timings and late data holds each pane
  where it is while the procedural layer keeps it breathing. Filmed as
  `world_delayed_data`.
- ~~**Gesture-driven transforms**, with displacement and release velocity
  as inputs.~~ **Done.** The world is displaced by the finger as it
  travels: the mode's word leads, the picture follows at a fraction, and
  the ends of the row resist. The release only chooses which state the
  world was already heading for and lends it the finger's speed through an
  impulse, so a flick and a drag do not settle the same way; a gesture let
  go halfway comes back from where it is. Committing is distance OR speed.
  Filmed as `world_drag_slow`, `world_drag_return` and `world_drag_flick`.
- ~~**Cross-state object identity**, so a scene object survives a mode
  change and changes role.~~ **Done.** A node carries its own id, so an
  object can be named after the thing it shows rather than the slot it
  occupies. The four live views are one surface (`sync_camera_surface`)
  that SHOOT poses as a quad and LOOK poses with one view filling the
  screen, so the cameras are seen to become the photograph. A photograph
  is `ph:<capture>` in the roll and on its own screen, grown by scale from
  the same box with the same parent, so the user picks one up rather than
  being handed a copy; its neighbours push outward and are let go.

- ~~**A scene pool that can outlive a session**, since a photograph's node
  is named after its capture and a card holds more captures than the pool
  holds slots.~~ **Done.** A node nobody has asked for in 180 passes is
  reclaimed when the pool needs the slot, never one a clip is driving and
  never one that is still somebody's parent - parents are held as
  indices, so handing that slot out would silently reparent whatever
  pointed at it. Before this, the 161st photograph was drawn as the
  finder. The preview puts 400 photographs through the 160-slot pool and
  reports whether the last one still has a node of its own; INFO shows
  `NODES n/160`.

Three rules the transitions turned up, all now in the code:

- **Continuity works in local space, so a reparent breaks it.** A
  photograph parented to the grid in one state and to a photo group in
  the other appears to jump, because the offset the spring is holding
  means something different on each side. Objects that travel between
  states stay in one space.
- **A clip still running holds its nodes on screen wherever the camera
  goes next,** because a bound node is drawn whether or not the screen
  asked for it. What belongs to a state is stopped when that state is
  left.

Selection is now context-first, proven by the distribution the host
preview prints on every run. The same event, a thousand draws per world:

```
at rest, ordinary room   none=413 quiet=275 text_hit=130 four_merge=120 hard_cut=62
mid burst                none=705 quiet=231 hard_cut=64
clean four-way sync      none=320 four_merge=315 quiet=235 text_hit=93 hard_cut=37
flash fired              none=328 quiet=249 energy=196 four_merge=93 text_hit=81
held a long time         none=302 text_hit=339 quiet=231 four_merge=79 hard_cut=49
dark room                none=587 quiet=413
```

A burst is 70% silence and reaches no decoration. A clean sync more than
doubles the convergence. The flash brings in a behaviour that appears
nowhere else except rarely. A dark room never reaches a loud one.

### Playground additions

~~The existing scenes stay. Add world-level tests, which now matter more
than isolated shape tests.~~ **Done.** Five world scenes beside the
seventeen shape tests, and the important thing about them is that they
**drive the product's own screens on a loop** rather than posing a copy.
A shape test answers "does the runtime do this"; these answer "does the
world hold together", and a second implementation of a transformation is
a test that can quietly drift from the thing it is testing. They change
state through `go()`, not by assignment, because what a state stops when
it is left is exactly the sort of thing that only shows up on the fourth
loop.

- `world_surface` — four live regions becoming one image, and back
- `world_roll` — six photographs resolving into one, and back out into
  six; the photograph is opened the way a tap opens it
- `world_link` — the roll reorganising into sharing, and the code
  growing into the room it makes
- `world_interrupt` — the same transformation reversed twice before it
  can land
- `world_deform` — real image content under deformation: the capture's
  own choreography on the live surfaces, gates opened on a schedule
  rather than by a pipeline, so the tear can be watched over a real room

They loop at four seconds, which means the Twin can show them at full
frame rate in a browser - the one place motion can actually be judged
before there is hardware. A gesture-driven partial mode change, a capture
result becoming a roll item, and delayed backend data need the input and
capture paths, and are covered by the product films `world_drag_return`,
`world_capture_joins_roll` and `world_delayed_data`.

### The films that become the design reviews

```
world_shoot_look      four live surfaces resolve into one image
world_look_roll       the current image becomes the roll
world_roll_link       the roll reorganises into sharing
world_interrupt       rapid gesture changes mid-transformation
world_capture         full capture from the live state
world_capture_roll    the result becomes the newest roll object
world_transfer        photographs respond to real transfer progress
world_delayed_data    late capture data, behaviour stays coherent
world_drag_slow       the finger carries the world across, and commits
world_drag_return     a gesture let go halfway, coming back from where it is
world_drag_flick      short and fast: commits on speed, not distance
world_shoot_look      the four cameras become the photograph
world_look_shoot      and shrink back into their quarters
world_roll_look       a photograph grows out of the grid it was in
world_look_roll       and settles back into its slot
```

The three drag films exist because the requirement is about the frames
*during* the gesture, not the ones after it. If the world only moves on
release, the films look identical to the old canned transition.

### Test with difficult photography

~~Not just attractive samples. A dark frame, an overexposed one, high
motion, a flat beige wall, a face close-up, a crowded party, a nearly
black frame, a heavily saturated scene. The system has to hold up when
the photography itself is visually difficult.~~ **Done.** Six rooms an
interface never gets shown in a portfolio - dark, blown out, a beige
wall, a red-lit room, a face against a window, a crowd - and the finder,
a capture, the roll, the sharing screen and the settings rule shot in
each (`hard_*`). They are synthetic, but their statistics are the ones
that matter, and the harness reports what the camera made of each room
beside the picture.

It found three real defects, none of them visible on a pleasant
gradient:

- **`over_picture` had never drawn anything.** Static text at its
  natural size takes a fast path that blits glyphs straight from the
  font with no mask behind it, so it silently dropped every shadow the
  interface asked for - and that is exactly the text that sits on the
  picture. Shadowed text now takes the path that can draw one.
- **A drop shadow is the wrong device over photography.** It puts dark
  down and to the right, which does nothing where the picture is
  already bright: white type on a blown window or a crowd has no edge
  at all. It is now a two pixel contour, grown from the glyph mask once
  per string. One pixel is not enough - the white pass that follows is
  antialiased and its own soft edge paints over it.
- **The settings rule is black on black in a dark room.** The structure
  the settings hang from cannot depend on the lighting, so it carries a
  hairline of its own, for the same reason and in the same spirit as
  the contour.

It also found that the harness's own white frame marker pinned `ksense`
contrast at full range in every preview run, because contrast is the
distance between the darkest and brightest sample and one white pixel in
the grid is enough. The difficult frames carry a marker inside their own
range instead.

### What a frame costs

The perf report had been printing zeros since it existed: the runtime
reads one clock, and on the host preview that clock is a variable the
harness winds forward by hand. Cost is the one figure that has to be
measured on a clock that is running, so it has its own hook now, and the
harness prints what every state costs to draw. The numbers are a desktop
and say nothing about the P4 - they say whether a change made the work
several times bigger, which is what they immediately did:

```
shoot, at rest        579 -> 317 us
shoot, mid capture   5759 -> 1975 us
look                 1466 ->  618 us
```

- **The motion trace on the panes was three fifths of the capture and
  invisible.** A trace is drawn under the object, so it only shows where
  the object has moved further than its own size. Four quarters
  correcting by ten pixels cover their own trace completely. The
  fragments in the merge do travel, and keep theirs.
- **Text was four fifths of the cost of drawing the finder.** Giving
  type a contour sent it down the general path, whose per-pixel rotation
  and bilinear sample are pure waste for upright unscaled words. Type at
  rest is redrawn every pass forever; it has its own loop now, and
  anything moving or scaled still takes the general one.
- **A strip of three quarters of a pixel kept a full screen photograph
  on the mapping path.** The test between the row copy and the inverse
  mapping was set at "not quite zero", and a transition's spring settles
  toward zero without arriving. It is set at the limit of what can be
  seen instead. A grade was on that path too, and is not a deformation
  at all: it is a function of the colour, not of where the pixel came
  from.

INFO reports `PX` and `MAPPED` beside the frame cost, so the same
question can be asked on the panel.

### Do not polish the wrong layer

Before touching tracking, line length, label spacing or micro-animations,
ask whether the interaction still feels like page navigation. If it does,
that is the bug.

---

## Definition of success

The user should not think "I moved from SHOOT to LOOK". They should feel
that **the four cameras became the photograph**.

Not "I opened the gallery", but **the photograph became the roll**.

Not "I opened the sharing page", but **the roll opened itself to KINO
ROLL**.

And the test the research adds: **with every word removed, the product
should still feel alive.**

---

## Final model

KINO is not five screens connected by animation. It is one persistent
photographic world with five operational states and a mood.

The four camera views are its fundamental object. The photographs they
make stay visually traceable through the product. Navigation transforms
the world. Capture disrupts it. ROLL accumulates it. LINK extends it.
SETUP strips it away. INFO exposes the machine underneath.

The engine should spend its complexity on maintaining that continuity and
on reacting to what the cameras actually see, not on decorating screens.

---

## Sources

- [Starboy is a weird, anti-AI wearable, Alex Heath](https://sources.news/p/starboy-anti-ai-wearable)
- [This $400 (Not) AI Keychain Is Pointless, Extravagant, and Weirdly Lovable, Gizmodo](https://gizmodo.com/starboy-ai-keychain-is-pointless-extravagant-and-weirdly-lovable-2000740949)
- [CREATURE's STARBOY: A Digital Pet You Can Wear, Hypebeast](https://hypebeast.com/2026/3/creature-starboy-wearable-digital-pet-debut-release-info)
- [STARBOY Review: do the eyes really say it all?](https://mia-cat.com/en/pet-robot/starboy-review/)
- [Daniel Kuntz on the Lark animation and behaviour engine](https://x.com/dankuntz/status/2031745878898430026)
- [Daniel Kuntz on moods and personality](https://x.com/dankuntz/status/2031745870488863154)
- [lilguy.net](https://lilguy.net/)
