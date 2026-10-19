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
<tr><td>3</td><td>anaglyph for red-cyan glasses on/off</td></tr>
<tr><td>M or Tab</td><td>automap: the whole building as a wireframe; drag to turn it, Shift+drag to move it, mouse wheel to zoom, Esc to close</td></tr>
<tr><td>Shift+L</td><td>bake the light again</td></tr>
<tr><td>»Save light«</td><td>download the baked light as <code>level.light</code> (see below)</td></tr>
<tr><td>R</td><td>back to the start</td></tr>
</table>

Every switch is also shown at the top left and can be clicked. In VR the left
thumbstick walks, the right one turns, the grip button opens the automap.

Where you stand is kept in the address (`?view=…`), so a reload brings you
back to the same spot, as long as the floor plan has not changed.

## Files

<table>
<tr><td><code>level.ini</code></td><td>the name of the level, the room you start in, light settings</td></tr>
<tr><td><code>rooms/NAME.room</code></td><td>one file per room: its floor plan and what is in it</td></tr>
<tr><td><code>statues/</code></td><td>3D models (GLB) for statues</td></tr>
<tr><td><code>level.light</code></td><td>saved light, if you saved it (»Save light«)</td></tr>
<tr><td><code>engine/</code></td><td>the program: reading the level, building it, baking the light, walking</td></tr>
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
<tr><td>a digit</td><td>a door, described in a section <code>[digit]</code></td></tr>
</table>

A door is one field that belongs to two rooms: `[1]` with `door = gang 1`
means »this 1 is the same field as the 1 in `rooms/gang.room`«. One of the two
rooms describing the door is enough. The rooms are laid next to each other at
their doors, and all of them together are one building, so there can be as
many rooms as you like. A room that would overlap another one, or a floor
field without a wall next to it, is reported with the file and the line.

### `[room]`

<table>
<tr><td><code>name</code></td><td>shown in the automap</td></tr>
<tr><td><code>height</code></td><td>ceiling height in metres (2.7); two numbers for a sloped ceiling: <code>height = 2.5, 4</code></td></tr>
<tr><td><code>slope</code></td><td><code>flat</code>, or the direction the ceiling rises to: <code>north</code>, <code>east</code>, <code>south</code>, <code>west</code>; <code>gable</code> is a pitched roof, highest in the middle, its ridge along the longer side of the room</td></tr>
<tr><td><code>walls</code></td><td><code>wallpaper</code>, <code>marble</code> or <code>plain</code></td></tr>
<tr><td><code>floor</code></td><td><code>carpet</code>, <code>marble</code> or <code>plain</code></td></tr>
<tr><td><code>wallpaper</code>, <code>carpet</code>, <code>ceiling</code></td><td>colours, such as <code>#c9b458</code></td></tr>
<tr><td><code>baseboard</code></td><td>a skirting board: height and colour, such as <code>0.08, #5a4626</code></td></tr>
<tr><td><code>look</code></td><td>where you look at the <code>@</code>: <code>north</code>, <code>east</code>, <code>south</code>, <code>west</code> or degrees</td></tr>
<tr><td><code>ambient</code></td><td>light from everywhere in this room (0 to 1), usually not needed</td></tr>
</table>

### A lamp

<table>
<tr><td><code>light</code></td><td>its colour, such as <code>#fff3cf</code></td></tr>
<tr><td><code>power</code></td><td>how bright (1.0)</td></tr>
<tr><td><code>size</code></td><td>width and length in metres (0.6, 1.2); bigger lamps cast softer shadows</td></tr>
<tr><td><code>flicker</code></td><td><code>1</code>: the lamp flickers now and then</td></tr>
</table>

A lamp hangs just below the ceiling, in the middle of its field.

### A block

`block = 2` fills its field up to 2 metres; `block = 0.9, 6, 0.9` is 0.9 m
wide, 6 m high and 0.9 m deep, in the middle of its field: a column.
`base` lifts it off the floor, `color` paints it (without a colour, it has the
room's wallpaper).

### A statue

<table>
<tr><td><code>model</code></td><td>a GLB file, such as <code>statues/athena.glb</code></td></tr>
<tr><td><code>height</code></td><td>in metres (2.0)</td></tr>
<tr><td><code>rotation</code></td><td>in degrees, around the vertical axis</td></tr>
<tr><td><code>material</code></td><td><code>marble</code> instead of the model's own textures</td></tr>
<tr><td><code>pedestal</code></td><td>a block under it: width, height, depth; <code>pedestal_color</code> paints it</td></tr>
<tr><td><code>tilt</code></td><td>in degrees, around the x axis, for a model that still lies down</td></tr>
</table>

### `level.ini`

<table>
<tr><td><code>name</code></td><td>the name of the level</td></tr>
<tr><td><code>start</code></td><td>the room in which the level starts: <code>start = zimmer</code> reads <code>rooms/zimmer.room</code>, and from there every room a door leads to</td></tr>
<tr><td><code>bounces</code></td><td>how often light is bounced off surfaces (3)</td></tr>
<tr><td><code>detail</code></td><td>light map points per metre (16): more gives sharper shadows and takes longer</td></tr>
<tr><td><code>ambient</code></td><td>light from everywhere (0)</td></tr>
</table>

## Address parameters

<table>
<tr><td><code>?level=other.ini</code></td><td>load another level file</td></tr>
<tr><td><code>?show=light</code>, <code>direct</code>, <code>bounce</code></td><td>start with light only (no textures), or with only one part of it</td></tr>
<tr><td><code>?bounces=0</code></td><td>bake with a different number of bounces</td></tr>
<tr><td><code>?anaglyph</code>, <code>?automap</code></td><td>start with anaglyph or with the automap</td></tr>
<tr><td><code>?rebake</code></td><td>bake the light even if saved light fits</td></tr>
</table>

## Statues and licences

- `statues/athena.glb`: Athena Giustiniani, a 3D scan of the plaster cast
  KAS255 at the National Gallery of Denmark (SMK), public domain
  ([SMK Open](https://open.smk.dk/artwork/image/KAS255),
  [Public Domain Mark](https://creativecommons.org/publicdomain/mark/1.0/));
  reduced to fewer triangles.
- `vendor/three/`: [three.js](https://threejs.org/), MIT licence, see
  `vendor/three/LICENSE`.

Other GLB models work as well, if their licence allows it, for example the CC0
models in [cc0-models-Polygonal-Mind](https://github.com/ToxSam/cc0-models-Polygonal-Mind).
Write down where a model comes from and under which licence, next to the
`model =` line or in this README.
