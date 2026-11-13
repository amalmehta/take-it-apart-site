# Take It Apart — Guide

Open **https://amalmehta.github.io/take-it-apart-site/** in a recent browser with WebGL (Chrome, Safari, Firefox or Edge; phones work too).

## Looking around

| To… | Do this |
|---|---|
| Take it apart / put it back | Press the round button in the bottom bar (or Space), or drag the slider |
| Look around | Drag to orbit, scroll or pinch to zoom, right-drag or two-finger drag to pan |
| Identify a part | Click or tap it, or pick it in the parts list; its card explains how it works, what it's made of, key numbers and a did-you-know |
| Get close to a part | Double-click it in the list, or press **Zoom to Part** |
| Get the whole view back | The crosshair button at the top right |
| Find a part by name | Type in **Find a part** |
| Understand it from first principles | Switch the right-hand panel from **Parts** to **First principles**: the problem, the core idea, the science underneath, why it's built this way, the hardest parts (click one to see it), the x factor and questions to test your intuition |

On a phone, the ☰ button opens the object list and the panel button opens the parts list.

## Taking apart something new

The thirty-three examples (a rocket, an electric car drive unit, a camera drone, a mechanical watch, a jet engine, a road bicycle, a family car, a light helicopter, a diesel-electric submarine, a crewed spacecraft, a sailing yacht, a farm tractor, a Shinkansen bullet train, the Eiffel Tower, an acoustic guitar, a grand piano, a DSLR camera, a smartphone, a laptop, wireless earbuds, a VR headset, a game console, a 3D printer, a space telescope, a quantum computer, a fusion reactor, a humanoid robot, the original iPhone, an MRI scanner, a steam locomotive, an espresso machine, a wind turbine and an EUV lithography machine) need nothing; open the list with the ☰ button at the top left. Each has a **What it is** overview in the parts panel explaining how the object works, and a **First principles** explainer; Claude writes one for new objects too. To make new objects you need your own [Anthropic API key](https://console.anthropic.com/):

1. Open **Settings** (bottom of the object list) and paste your key. It's saved in this browser only and sent straight to Anthropic, never anywhere else.
2. Click **New Object…**, then type what it is ("a V8 car engine"), drop in a photo, or both.
3. Click **Take It Apart**. Claude designs the parts, which usually takes a minute or two. Each generation is billed to your key.

New objects are saved in this browser. Clearing the site's data removes them, and so does the × next to an object.

## Feedback

**Feedback** at the bottom of the object list opens a pre-filled issue on this repository; nothing is sent until you submit it.

This repository holds the published site. It's generated from the Take It Apart source, so changes made here directly are overwritten on the next publish.
