# Backrooms Starter

A starter project for building your own Backrooms: rooms described in plain
text files, joined at their doors into one building, lit by lamps whose light
is baked in the browser, with soft shadows and light bounced off walls, floors
and ceilings. Walk through it on a computer, with red-cyan glasses or with a
VR headset.

Everything runs in the browser. There is nothing to install or build;
[three.js](https://threejs.org/) is included in `vendor/`.

## Start

Serve this folder with any static web server and open `index.html`:

- in Hackschule Workspace or VS Code: »Go Live« in the status bar
- elsewhere: `python3 -m http.server` and open <http://localhost:8000/>

Opening `index.html` directly as a file does not work: the browser does not
let a page load the room files from disk.

## Three levels

- `level.ini` and `rooms/`: your level. It starts small: a room, a corridor
  and two coloured rooms. Build on it.
- `lobby/`: »Level 0: Die Lobby«, a whole level with fourteen rooms, a corridor
  that opens up nine metres high, a colonnade, a gallery of pedestals, a
  marble hall with a statue and a way over ramps on which nothing is level. Open it with `index.html?level=lobby/level.ini`.
  Its light is already baked (`lobby/level.light`), so it is there at once.
- `tiefe/`: »Level 1: Die Tiefe«, rooms above and below each other: a narrow
  corridor whose wallpaper turns grey, a hall of columns with an opening
  eight metres above an abyss, an office upstairs with a hole in its floor, a
  pit, low cellars, a tiled hall under the earth with a pool and a red corridor that
  climbs back up. Open it with `index.html?level=tiefe/level.ini`; its light
  is baked too.

After a change to a room, reload the page.

## Saved light

Baking takes a while, so the light is kept:

- **In the browser:** once the light is baked, it is stored in this browser
  (IndexedDB). Reloading the same level loads it instead of baking.
- **As a file:** »Save light« downloads `level.light`. Put it next to
  `level.ini`; when the level is served with it, for example as a static web
  page or on a VR headset, the light is loaded from that file.

Saved light belongs to exactly one version of the level: a fingerprint of
`level.ini`, every room, every statue and the parts of `engine/` that bake
the light says whether it still fits. Change one character and it no longer
does; the light is then baked again (and `level.light` has to be saved again).
Shift+L, or `?rebake` in the address, bakes the light again in any case.

## Keys

<table>
<tr><td>click into the picture</td><td>look around with the mouse (Esc gives the mouse back)</td></tr>
<tr><td>W A S D</td><td>walk; hold Shift to run</td></tr>
<tr><td>arrow keys</td><td>up and down walk, left and right turn</td></tr>
<tr><td>T</td><td>textures on/off</td></tr>
<tr><td>L</td><td>direct light on/off</td></tr>
<tr><td>B</td><td>bounce light on/off</td></tr>
<tr><td>O</td><td>occlusion (contact shadows in corners) on/off</td></tr>
<tr><td>F</td><td>flickering lamps on/off</td></tr>
<tr><td>E</td><td>edges (wireframe) on/off</td></tr>
<tr><td>G</td><td>light points: a dot for every point of the light map at which the light is computed</td></tr>
<tr><td>H</td><td>bloom: very bright light glows into its surroundings, as in a camera (on; not with red-cyan glasses, in VR or in the automap)</td></tr>
<tr><td>C</td><td>VHS: as if filmed with an old camcorder, with scan lines, smeared colours, a rolling tracking band and today's date and time on the tape (off; not with red-cyan glasses, in VR or in the automap)</td></tr>
<tr><td>X</td><td>chromatic aberration: coloured fringes towards the edges, red outwards, blue inwards, as through a simple lens (off; not with red-cyan glasses, in VR or in the automap)</td></tr>
<tr><td>3</td><td>anaglyph for red-cyan glasses on/off</td></tr>
<tr><td>M or Tab</td><td>automap: the whole building as a wireframe; drag to turn it, Shift+drag to move it, mouse wheel to zoom, V shows the rooms themselves from above instead, U shows which rooms are drawn from where you stand (the others pale, the portals you look through orange), Esc to close</td></tr>
<tr><td>Shift+L</td><td>bake the light again</td></tr>
<tr><td>»Save light«</td><td>download the baked light as <code>level.light</code> (see below)</td></tr>
<tr><td>Shift+R</td><td>back to the start</td></tr>
<tr><td>P</td><td>hide the panel at the top left, and show it again</td></tr>
</table>

Every switch is also shown at the top left and can be clicked; ☰ at the top
right hides the panel and brings it back. In VR the left thumbstick walks, the
right one turns, the grip button opens the automap.

On a phone or tablet the left thumb walks: where it touches the picture, a
ring appears, and pushing away from its middle walks that way (all the way:
run). The right thumb swipes to look around. In the automap one finger turns
it, two fingers zoom and move it.

Where you stand is kept in the address (`?view=…`), so a reload brings you
back to the same spot, as long as the floor plan has not changed. An open
automap is kept there too (`?automap=…`), turned, moved and zoomed as it
was: change a room, reload, and look at the same place again.

## Stains

The textures repeat every metre (`engine/textures.js`), so they have no
stains: those would repeat with them and form a pattern on a large wall.
Stains come in when drawing, from noise over the whole world, in three
sizes (`stains` in `engine/main.js`), and never repeat.

## Portals

Only what you can see is drawn. You see into another room only through an
opening, a door or a hole: a portal. From the room you stand in, the program
projects every portal onto the screen as a rectangle; where it lies in the
picture, you look through it into the room behind, but only through that
rectangle, and from there on through that room's portals, each cut down to
the rectangle you are looking through (`engine/portals.js`). Every room
reached this way is drawn, all others are not, and a pool only reflects when
its room is among them. In the automap, U shows it.

## Files

<table>
<tr><td><code>level.ini</code></td><td>the name of the level, the room you start in, light settings</td></tr>
<tr><td><code>rooms/NAME.room</code></td><td>one file per room: its floor plan and what is in it</td></tr>
<tr><td><code>lobby/</code></td><td>a whole level to try, with its rooms and its baked light</td></tr>
<tr><td><code>statues/</code></td><td>3D models (glTF or GLB): a statue, a sofa, a wall lamp</td></tr>
<tr><td><code>level.light</code></td><td>saved light, if you saved it (»Save light«)</td></tr>
<tr><td><code>engine/</code></td><td>the program: reading the level, building it, baking the light, walking</td></tr>
<tr><td><code>textures.html</code></td><td>the textures on their own: <code>?show=marble</code> (also <code>wallpaper</code>, <code>wood</code>) step by step, <code>?tile=marble&amp;edges</code> nine times side by side</td></tr>
<tr><td><code>vendor/three/</code></td><td>three.js r185 (MIT licence)</td></tr>
</table>

## A room

```ini
# A small room. You don't know how you got here.

[room]
name = Zimmer
height = 2.6
look = east              # at the @ you look towards the door

[map]
#######
#.....#
#.@.L.1
#.....#
#######

[L]
light = #ffe7b8
power = 0.9

[1]
door = gang 1
```

In `[map]`, every character is one metre:

<table>
<tr><td><code>#</code></td><td>wall</td></tr>
<tr><td><code>.</code></td><td>floor</td></tr>
<tr><td><code>@</code></td><td>you start here (once in the whole level)</td></tr>
<tr><td>space</td><td>nothing, outside the room</td></tr>
<tr><td>a letter</td><td>a lamp, a block or a statue, described in a section <code>[letter]</code></td></tr>
<tr><td>a digit</td><td>a door, described in a section <code>[digit]</code>; the same digit side by side (<code>111</code>) or one below the other is one wide door</td></tr>
<tr><td><code>_</code></td><td>a hole in the floor: below it lies another room, described in <code>[_]</code></td></tr>
<tr><td><code>^</code></td><td>a hole in the ceiling: the room above has its <code>_</code> here</td></tr>
</table>

How high a room lies follows from its doors: on a door, both floors are at
the same height, starting from the room in `start`. A door where the floors
cannot meet is reported.

A door is one field (or a row of fields) that belongs to two rooms: `[1]`
with `door = gang 1` means »this 1 is the same field as the 1 in
`rooms/gang.room`«. One of the two rooms describing the door is enough, and
two rooms may share several doors. A wide door (`111`) needs an equally wide
one on the other side. The rooms are laid next to each other at their doors,
and all of them together are one building, so there can be as many rooms as
you like. A floor field without a wall next to it, or two rooms in the same
place at the same height, is reported with the file and the line.

`arch = 2.4` in a door's section makes it round at the top: a semicircle,
2.4 m above the floor in its middle, as wide as the door. `arch = 2.4, 0.8`
makes the arch only 0.8 m wide, in the middle of the door, with wall beside
it. Either side of the door may say it.

Rooms may lie on top of each other: a ramp leads up one storey, and the room
up there may lie over the one below, as long as its floor is not below that
room's ceiling. A hole joins two rooms like a door, only vertically:

```ini
# rooms/oben.room: a hole in the floor (_), two fields by two
[map]
##########
#...__...#
#...__...#
##########

[_]
below = keller     # the room underneath; its ^ lies right below
slab = 0.3         # how thick the floor between the two is, in metres (0.3)
```

In `rooms/keller.room` the same fields are `^` (a hole in the ceiling). The
hole places the room below so that its ceiling lies `slab` under this floor,
just as a door places its neighbour. Whoever steps onto the hole falls.

### `[room]`

<table>
<tr><td><code>name</code></td><td>shown in the automap</td></tr>
<tr><td><code>height</code></td><td>ceiling height above the floor in metres (2.7); two numbers for a sloped ceiling: <code>height = 2.5, 4</code></td></tr>
<tr><td><code>ramp</code></td><td>a sloped floor: the direction it rises to and by how many metres, such as <code>ramp = east, 4</code>; it rises from the first field inside the wall to the last; a door between two floors that slope differently joins both</td></tr>
<tr><td><code>slope</code></td><td><code>flat</code>, or the direction the ceiling rises to: <code>north</code>, <code>east</code>, <code>south</code>, <code>west</code>; <code>gable</code> is a pitched roof, highest in the middle, its ridge along the longer side of the room</td></tr>
<tr><td><code>walls</code></td><td><code>wallpaper</code>, <code>marble</code>, <code>wood</code> (vertical boards), <code>tiles</code> (10 cm, as in a pool), <code>velvet</code> (vertical stripes, as in a cinema) or <code>plain</code>, in the colour of <code>wallpaper</code></td></tr>
<tr><td><code>floor</code></td><td><code>carpet</code>, <code>marble</code>, <code>wood</code> (floorboards), <code>tiles</code> or <code>plain</code>, in the colour of <code>carpet</code></td></tr>
<tr><td><code>wallpaper</code>, <code>carpet</code>, <code>ceiling</code></td><td>colours, such as <code>#c9b458</code></td></tr>
<tr><td><code>baseboard</code></td><td>the skirting board: height and colour, such as <code>0.08, #86763c</code>; without it, 8 cm and half as bright as the wallpaper; <code>none</code>: no skirting board</td></tr>
<tr><td><code>look</code></td><td>where you look at the <code>@</code>: <code>north</code>, <code>east</code>, <code>south</code>, <code>west</code> or degrees, clockwise from north (<code>look = 30</code>: a little east of north)</td></tr>
<tr><td><code>ambient</code></td><td>light from everywhere in this room (0 to 1), usually not needed</td></tr>
</table>

### A lamp

<table>
<tr><td><code>light</code></td><td>its colour, such as <code>#fff3cf</code></td></tr>
<tr><td><code>power</code></td><td>how bright (1.0)</td></tr>
<tr><td><code>size</code></td><td>width and length in metres, or one number for a square lamp (0.85); bigger lamps cast softer shadows</td></tr>
<tr><td><code>flicker</code></td><td><code>1</code>: the lamp flickers now and then. Flickering lamps can have up to four different colours in a level; with more, some share a colour in between</td></tr>
</table>

A lamp hangs just below the ceiling, in the middle of its field.

### A block

`block = 2` fills its field up to 2 metres; `block = 0.9, 6, 0.9` is 0.9 m
wide, 6 m high and 0.9 m deep, in the middle of its field: a column.
`base` lifts it off the floor, `color` paints it (without a colour, it has the
room's wallpaper). `material` makes it of `marble`, `wood`, `tiles`, `velvet`,
`wallpaper` or `plain`, whatever the room's walls are, in the colour of
`color` or the room's wallpaper. `shape = round` makes it a round column (an
oval one when width and depth differ).

### A model: a statue, furniture, a lamp

<table>
<tr><td><code>model</code></td><td>a glTF file (with its <code>.bin</code> and textures next to it) or a GLB file, such as <code>statues/athena.glb</code></td></tr>
<tr><td><code>height</code></td><td>in metres (2.0)</td></tr>
<tr><td><code>rotation</code></td><td>in degrees, around the vertical axis</td></tr>
<tr><td><code>offset</code></td><td>x, y, z in metres, out of the middle of its field, as in three.js: x east, y up, z south, such as <code>offset = 0, 1.6, -0.42</code> for a lamp on the north wall</td></tr>
<tr><td><code>light</code></td><td>a colour: the model is a lamp. Its light comes from its glowing parts (emissive in the model, or, when nothing is, the materials whose name says bulb or flame) and shines in all directions; <code>power</code> and <code>flicker</code> as for a lamp</td></tr>
<tr><td><code>beam</code></td><td>for a lamp with a shade: its light falls only downwards, in a cone up to that many degrees from the vertical, such as <code>beam = 75</code>; <code>beam = up, 60</code> sends it upwards</td></tr>
<tr><td><code>material</code></td><td><code>marble</code> instead of the model's own textures</td></tr>
<tr><td><code>pedestal</code></td><td>a block under it: width, height, depth; <code>pedestal_color</code> paints it, <code>pedestal_material</code> makes it of marble, wood and so on</td></tr>
<tr><td><code>tilt</code></td><td>in degrees, around the x axis, for a model that still lies down</td></tr>
</table>

### A pool

Every field with the letter is part of the pool; fields next to each other
with the same depth and the same water are one pool. Its floor lies `pool`
below the floor of the room, lined with tiles, and the water stands `water`
below the edge. You can't walk into water; into an empty pool you fall
(Shift+R takes you back). A room with a pool has no ramp. `pool` may also
stand in the section of a lamp, a block or a model: its field is part of the
pool and still has its thing, a column standing in the water (on the floor of
the pool) or a lamp above it.

```
[W]
pool = 2.2         # how deep the pool goes below the floor, in metres
water = 0.25       # how far below the floor the water stands
railing = on
```

<table>
<tr><td><code>pool</code></td><td>depth below the floor, 0.2 to 20 metres</td></tr>
<tr><td><code>water</code></td><td>how far below the floor the water stands (0.15); <code>off</code>: an empty pool</td></tr>
<tr><td><code>tint</code></td><td>the colour of the water: what white looks like behind 2 m of it (<code>#bff0f3</code>, clear); <code>#6f8f5a</code> is murky</td></tr>
<tr><td><code>color</code></td><td>the tiles of the pool (<code>#bcd8da</code>)</td></tr>
<tr><td><code>railing</code></td><td><code>on</code>: a metal railing wherever you can stand at the edge</td></tr>
</table>

The water reflects the room and shows the floor of the pool, bluer the more
water lies in between, with small slow waves and light dancing on the floor
(`engine/water.js`). For that the room is drawn twice more for every picture
in which water is seen: once mirrored, once only what lies under the water.
In VR the water is a simple, half transparent surface.

### `level.ini`

<table>
<tr><td><code>name</code></td><td>the name of the level</td></tr>
<tr><td><code>start</code></td><td>the room in which the level starts: <code>start = zimmer</code> reads <code>rooms/zimmer.room</code>, and from there every room a door leads to</td></tr>
<tr><td><code>bounces</code></td><td>how often light is bounced off surfaces (3)</td></tr>
<tr><td><code>detail</code></td><td>light map points per metre (16): more gives sharper shadows and takes longer</td></tr>
<tr><td><code>ambient</code></td><td>light from everywhere (0)</td></tr>
<tr><td><code>vhs</code></td><td><code>on</code>: the level starts with the VHS look (C switches it off)</td></tr>
<tr><td><code>aberration</code></td><td><code>on</code>: the level starts with chromatic aberration (X switches it off)</td></tr>
</table>

## Address parameters

<table>
<tr><td><code>?level=other.ini</code></td><td>load another level file</td></tr>
<tr><td><code>?show=light</code>, <code>direct</code>, <code>bounce</code></td><td>start with light only (no textures), or with only one part of it</td></tr>
<tr><td><code>?bounces=0</code></td><td>bake with a different number of bounces</td></tr>
<tr><td><code>?anaglyph</code>, <code>?automap</code>, <code>?vhs</code>, <code>?aberration</code></td><td>start with anaglyph, with the automap, with the VHS look or with chromatic aberration</td></tr>
<tr><td><code>?automap=-40,35,12.0,0.0,0.0,0.0,rooms</code></td><td>the automap as it was: turned and tilted (degrees), distance and shift (metres), <code>follow</code> (turns with you) and <code>rooms</code> (rooms instead of wireframe); written by the program itself</td></tr>
<tr><td><code>?rebake</code></td><td>bake the light even if saved light fits</td></tr>
<tr><td><code>?sharp</code></td><td>render at the full resolution of the screen, for pictures (otherwise at most twice the page's pixels)</td></tr>
</table>

## Statues and licences

- `statues/athena.glb` (used in `lobby/rooms/halle.room`): Athena Giustiniani, a 3D scan of the plaster cast
  KAS255 at the National Gallery of Denmark (SMK), public domain
  ([SMK Open](https://open.smk.dk/artwork/image/KAS255),
  [Public Domain Mark](https://creativecommons.org/publicdomain/mark/1.0/));
  reduced to fewer triangles.
- `statues/sofa_03/`: [Sofa 03](https://polyhaven.com/a/sofa_03) by Fran Calvente,
  `statues/industrial_wall_lamp/`: [Industrial Wall Lamp](https://polyhaven.com/a/industrial_wall_lamp),
  `statues/industrial_wall_sconce/`: [Industrial Wall Sconce](https://polyhaven.com/a/industrial_wall_sconce) by Ulan Cabanilla,
  `statues/brass_candleholders/`: the large candelabra from
  [Brass Candleholders](https://polyhaven.com/a/brass_candleholders) by Tina (only that one, moved to the origin),
  and, for `tiefe/`, [Metal Office Desk](https://polyhaven.com/a/metal_office_desk),
  [School Chair 01](https://polyhaven.com/a/SchoolChair_01),
  [Vintage Wooden Drawer 01](https://polyhaven.com/a/vintage_wooden_drawer_01),
  [Worn Metal Rack](https://polyhaven.com/a/worn_metal_rack),
  [Old Bed Frame](https://polyhaven.com/a/old_bed_frame),
  [Plastic Monobloc Chair 01](https://polyhaven.com/a/plastic_monobloc_chair_01),
  [Rockingchair 01](https://polyhaven.com/a/Rockingchair_01) and
  [Small Wooden Table 01](https://polyhaven.com/a/small_wooden_table_01),
  all from [Poly Haven](https://polyhaven.com/models), CC0, glTF at 1K.
- `vendor/three/`: [three.js](https://threejs.org/), MIT licence, see
  `vendor/three/LICENSE`.
- `engine/fonts/vcr-osd-mono.ttf`: [VCR OSD Mono](https://www.dafont.com/vcr-osd-mono.font)
  by Riciery Leal, the date and time of the VHS look, free (»100% Free«).

Other models work as well, if their licence allows it. On
[Poly Haven](https://polyhaven.com/models) every model is CC0: choose glTF and
1K (the program uses only the colour texture, larger ones look the same) and
unpack the ZIP into its own folder in `statues`. More CC0 models: the
[Smithsonian's 3D scans](https://3d.si.edu/collections) and
[Sketchfab](https://sketchfab.com/search?features=downloadable&licenses=7c23a1ba438d4306920229c12afcb5f9&type=models)
(download as GLB). Write down where a model comes from and under which
licence, next to the `model =` line or in this README.
