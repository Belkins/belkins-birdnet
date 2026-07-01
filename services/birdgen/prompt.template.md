# Bird illustration prompt

The prompt sent to Gemini for every illustration.

Three text placeholders get replaced per request:

- `{sci_name}` is the binomial Latin name, e.g. `Calypte anna`
- `{com_name}` is the English common name, e.g. `Anna's Hummingbird`
- `{pose}` is either `perched` (pose 1) or `in flight with wings spread` (pose 2)

`pregen.py` also attaches up to three reference images per request:

- A POSITIVE anatomy reference (Wikipedia photo of the target species). Anchors species identity, markings, and plumage.
- An OPTIONAL anti-reference (a photo of a similar-looking species the model drifts toward). Attached automatically for genera where the prior collapses: a Blue Jay for small blue corvids, a Barn Swallow for other swallows. The `{anti_ref_line}` placeholder is rewritten per-species.
- A POSITIVE style reference (a real Edo-period kachō-e print by Ohara Koson or Hiroshi Yoshida). The species in the print is irrelevant - only its painting style is borrowed.

---

## Prompt

Generate a {pose} {com_name} ({sci_name}) as an Edo-period Japanese kachō-e woodblock print. Render the bird with VERY FEW MARKS: the body is essentially 2-4 flat color zones with sharp boundaries, roughly 30 brush strokes total - no feather-by-feather rendering, no pen-line stippling, no gradient shading, no photographic texture. A few confident sumi-e outline strokes, one or two accent strokes for major wing or tail markings, and that's it. (If a woodblock-print style image is also attached, borrow only its painting technique - never its species, branches, leaves, water, or scenery.)

Confident sumi-e ink linework with soft watercolor washes. Earthy, restrained palette: burnt umber, ochre, indigo, vermillion, muted greens. The body should look like flat painted paper - not a textured surface, not shaded volume. If the species has subtle plumage variation (streaking, mottling, fine barring), ABSTRACT it into 2-3 broad zones rather than rendering it literally. Eye, beak, and feet drawn with crisp ink - these are the only places where confident dark line is appropriate.

The bird floats on a completely FLAT, UNIFORM, SOLID, UNTEXTURED background - a single warm off-white / pale cream studio ground filling the entire frame with exactly one color. NO paper texture, NO paper grain, NO mulberry paper, NO washi, NO aged or antique paper, NO mottling, NO speckling, NO fibers, NO stains, NO vignette, NO gradient, NO tonal variation, NO shadow, NO drop shadow, NO cast shadow beneath the bird. It must read like a single flat solid digital fill, not paper. This is the only background element: NO branch, NO twig, NO perch, NO leaves, NO foliage, NO substrate, NO scenery, NO sky, NO moon, NO water - only the bird floating against the flat cream ground. The perch is purely implied by toe posture - it is NEVER rendered. NO border or frame, NO text or signature.

Composition: the bird occupies one-third to one-half of the frame. Leave generous negative space (just the flat cream ground) around it. The image should feel sparse and confident, not packed with detail.

The ENTIRE bird must fit well within the image frame, comfortably centered: head, both wings (fully extended for flight pose), full tail, both legs, both feet, beak. The bird must NEVER touch or approach any edge of the frame - keep a wide, uniform margin of pure background on all four sides so every corner is clean, empty ground. Do NOT crop the wings, tail, legs, or any body part at the edge of the frame. Leave generous padding on all sides.

### Reference handling

- IMAGE 1 (positive, anatomy) IS {com_name}. Match its proportions, head color, throat, wing pattern, back color, tail pattern, leg color. If the reference shows non-breeding or worn plumage, render the brightest BREEDING (adult-summer) plumage instead - render the most diagnostic, recognizable version of the species.
{anti_ref_line}
- IMAGE 3 (positive, style), if attached, is a real Edo-period kachō-e woodblock print. The bird in IMAGE 3 is a DIFFERENT species - IGNORE its species, only borrow its painting style. Render the bird in IMAGE 3's painting style. DO NOT copy any compositional elements from IMAGE 3 (branches, leaves, water, moon, scenery).

Treat IMAGE 1 for anatomy and color information ONLY. If IMAGE 3 is attached, treat it for style ONLY - the output should then look like an Edo-period woodblock print of the species in IMAGE 1, painted by the artist of IMAGE 3.

### Anatomy

- EXACTLY TWO wings (no more, no less - count them: one left, one right). EXACTLY TWO legs. EXACTLY ONE head. EXACTLY ONE beak. EXACTLY ONE tail.
- Posture, color, markings, and body proportions match IMAGE 1 / {com_name} field-guide references.
- Pay particular attention to species-specific patterns. Do NOT default to generic markings: if the reference shows a uniformly dark head, do NOT add a white face mask. If the reference shows solid wings, do NOT add white wingbars. If the reference has no crest, do NOT add a crest.
- For close-relative species (multiple goldfinch, multiple jay, multiple sparrow species in the library), render the diagnostic differences clearly so the species are visibly distinguishable from each other.

### Feet

- BOTH FEET visible at the bottom of the body.
- Songbird feet are SMALL relative to the body. Tarsi (legs below the feathers) are roughly 10-15% of body height for finches/sparrows/warblers/chickadees, 15-20% for jays/thrushes/mockingbirds. For larger birds (ducks, hawks, owls), match the proportion in the reference photo - typically still under 25%.
- Draw slim tarsi, small delicate toes. Do NOT exaggerate feet or claws; the bird is not a chicken or a crab.
- Match foot proportion to the attached reference photo.

### Pose

- PERCHED (pose 1): one wing folded against the body, the other tucked behind. Both feet visible at the bottom, toes curled gently forward as if grasping a thin perch - but the perch itself is NOT drawn. The bird floats in space, posture suggesting it's perched.
- IN FLIGHT (pose 2): both wings fully extended in a natural flapping position. Legs and feet either (a) tucked tight against the belly with toes folded out of sight, or (b) extended straight back along the line of the tail. Do NOT dangle the feet below the body with toes splayed.

### Output

Render at high resolution. The bird is fully inside the frame with generous padding on all sides, painted over the flat solid warm off-white / pale cream field described above. Do not attempt transparency, a drop shadow, or any paper texture - the background must stay a single flat, uniform, untextured solid color right up to the bird's edge, and every corner of the frame must be pure empty ground, so it keys out cleanly. No caption.
