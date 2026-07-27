# The ten speakers awaiting a name

Of the 335 quotations in the corpus, 3 ship, 182 have no evidence at all, and 150
carry a `speaker_candidate` a human could confirm. **Only these ten sit in
accounts for birds this garden actually hears** — the other 140 are hummingbirds,
African sunbirds and game birds this station will never record.

## Why a machine did not do this

`speakers.json` is the extractor's **E4 channel**, and E4 is defined as *written
by the curator*. The protocol emits a speaker only on certain evidence: E4, or a
signed attribution inside the quote (E1), or a footnote and a naming clause
independently agreeing (E2+E3). Every row below is `probable` — one signal, not
two — which is exactly the state P3 refuses to promote on its own.

Two further reasons to keep this human. The surnames here are as printed
("Thompson", "Selby"); expanding them to full names needs knowledge that is **not
in the text**, and this museum's whole claim is that nothing on the wall came
from outside the source. And a wrong name would appear in 30px Cormorant under a
real person's byline — the one unrecoverable failure on this project.

## How to confirm

Read a row. If the lead-in names the speaker, write the name into
`tools/jardine/speakers.json` keyed by passage id, then re-run:

```bash
python3 tools/jardine/extract.py --fetch --cache "$SCRATCH/jardine-cache"
python3 tools/jardine/extract.py --cache "$SCRATCH/jardine-cache" --out "$SCRATCH/jardine-corpus"
```

Leave anything you are not sure of. A dropped quotation costs a paragraph; a
misattributed one costs the museum's credibility.

**The pick of them is the Blue Titmouse.** It is the loudest bird in this garden
and the library's central silence — Jardine never describes its voice. Hewitson
describes its nest built under a pump handle, destroyed daily by the handle's own
use. Confirming that one line gives this garden's noisiest bird a voice from a
different naturalist.

---

### 1. `v20-009-p02` — The Peregrine Falcon, vol. 20

- **candidate:** `Thompson`  ·  confidence: probable
- **footnote:** Mag. of Zool. and Bot. vol. ii.

**Lead-in, verbatim:**

> …ottish frontier, it is still more common, becomes rarer in the lower and richer valley
of the Forth or Mid-Lothian; but on crossing this, and entering the Highland ranges, it
again prevails. In Ireland, it is also found: Mr Thompson writes,

**The quotation:**

> It may be stated in general terms, that the Peregrine Falcon occurs in suitable
localities throughout Ireland. In the four maritime counties of Ulster, it has many
eyries, and in Antrim, whose basaltic precipices are favourable for this purpose, seven,
at least, might be enumerated: of these only one is inland.

```json
"v20-009-p02": ""
```

### 2. `v20-009-p09` — The Peregrine Falcon, vol. 20

- **candidate:** `Thompson`  ·  confidence: probable
- **footnote:** Mag. of Zool. and Bot. vol. ii.

**Lead-in, verbatim:**

> …r Thompson mentions that one of Mr Sinclair’s Hawks, which had taken up her abode in a
rookery, when flown at rocks, always struck down several before commencing to prey on
one. The same gentleman relates another anecdote to the same point:

**The quotation:**

> Mr Sinclair, when exercising his dogs, towards the end of July, preparatory to grouse
shooting, saw them point; and when coming up he started a male Peregrine Falcon off a
Grouse just killed by him, and very near the same place he came upon the female bird
also on a Grouse. Although my friend lifted both the dead birds, the Hawks continued
flying about, and on the remainder of the flock being sprung by the dogs, eith

```json
"v20-009-p09": ""
```

### 3. `v20-013-p01` — The Kestrel, vol. 20

- **candidate:** `Thompson`  ·  confidence: probable
- **footnote:** _none_

**Lead-in, verbatim:**

> …r of a mile, there may, in April or May be found from ten to twelve eyries, and in one
situation, eight or nine can be perceived at once. Mr Thompson writes us, that in
Ireland it is equally common, frequenting the inland and marine cliffs.

**The quotation:**

> Throughout the whole range of noble basaltic precipices, in the north-east of Ireland I
have remarked its presence.

```json
"v20-013-p01": ""
```

### 4. `v20-013-p03` — The Kestrel, vol. 20

- **candidate:** `Selby`  ·  confidence: probable
- **footnote:** _none_

**Lead-in, verbatim:**

> …stomachs the remains of the larger Carabi, and Geotrupes,—a fact corroborated by the
interesting anecdote recorded by Mr Selby, and which shews still more strongly the
alliance to some of the Elani, and more decidedly insectivorous species.

**The quotation:**

> In summer, the cock-chafter supplies to this species an object of pursuit and food, and
the following curious account is given from an eye-witness of the fact:—

```json
"v20-013-p03": ""
```

### 5. `v20-029-p02` — The Common Buzzard, vol. 20

- **candidate:** `Thompson`  ·  confidence: probable
- **footnote:** Mag. of Zool. and Bot. vol. ii.

**Lead-in, verbatim:**

> … wild and rocky. In confinement, the Buzzard becomes very familiar, is easily tamed, and
as easily kept. Some interesting anecdotes are related by Mr Thompson in his “Irish
Raptores.” A male Buzzard, which had been brought up from the nest,

**The quotation:**

> when let off in the morning, his favourite perch was upon some stacks, where he remained
patiently watching for mice, which he has been seen to catch, but he was not always
successful, sometimes dashing his talons into the straw and bringing them out empty. He
preferred mice to rats, though very expert at killing both. He was quite a pet bird; one
of his favourite tricks was to fly on his master’s feet and untie his

```json
"v20-029-p02": ""
```

### 6. `v24-048-p02` — The Blue Titmouse, vol. 24

- **candidate:** `Hewitson`  ·  confidence: probable
- **footnote:** Oology, i.

**Lead-in, verbatim:**

> …a supply of some peculiar or favourite food. It breeds in the holes and rents of trees,
walls, or rocks, and we have seen it occupy the end of a leaden water-pipe, which had
fallen into disuse. Mr Hewitson relates his knowledge of one which

**The quotation:**

> continued building its nest for many days together, under the handle of a pump, although
its labours were daily destroyed by its action.

```json
"v24-048-p02": ""
```

### 7. `v24-076-p01` — Magpie, vol. 24

- **candidate:** `Hewitson`  ·  confidence: probable
- **footnote:** Mag. of Zool. and Bot. ii. p. 311.

**Lead-in, verbatim:**

> … attempted destruction on account; of its depredations upon the game, and the inmates of
the poultry yard; but in some of the European countries where it is protected, it
becomes familiar and devoid of fear. In Norway, Mr Hewitson tells us,

**The quotation:**

> It is on the most familiar terms with the inhabitants, picking close about their doors,
and sometimes walking inside their houses. It abounds in the town of Drontheim, making
its nest on the churches and warehouses. Few farm houses are without several of them
breeding under the eaves, their nest supported by the spout.

```json
"v24-076-p01": ""
```

### 8. `v24-076-p02` — Magpie, vol. 24

- **candidate:** `Laing`  ·  confidence: probable
- **footnote:** Laing’s Residence in Norway, p. 111.

**Lead-in, verbatim:**

> …lking inside their houses. It abounds in the town of Drontheim, making its nest on the
churches and warehouses. Few farm houses are without several of them breeding under the
eaves, their nest supported by the spout. Mr Laing confirms this:

**The quotation:**

> The Magpies hop about the houses in a half tame state, and are never pelted by the
children.

```json
"v24-076-p02": ""
```

### 9. `v24-080-p01` — Common Starling, vol. 24

- **candidate:** `Macgillivray`  ·  confidence: probable
- **footnote:** _none_

**Lead-in, verbatim:**

> …sen, and it is rather an unlocked for medley of forms to find the Rock-dove and
Cormorant nestling with the Starling, in the same great cavity, within the distance of a
few yards. Mr Macgillivray also mentions, that he has found their nests

**The quotation:**

> in large winding holes in grassy banks of an unfrequented islet, which I conjecture to
have been originally formed by rats.

```json
"v24-080-p01": ""
```

### 10. `v34-100-p02` — The Little Ringed Dotterel, vol. 34

- **candidate:** `Yarrell`  ·  confidence: probable
- **footnote:** Yarrell, ii. Pl. 411, 412.

**Lead-in, verbatim:**

> …he continent it is met with in several localities; in summer, so far north as Sweden,
Messrs. Dickson and Ross sent it from Erzeroom, and it extends to Japan. We do not
possess a specimen of this bird, and borrow Mr. Yarrell’s description:—

**The quotation:**

> In the adult bird the beak is black; the irides brown; the forehead white, with a black
patch above it, extending to the eye on each side; top of the head and occiput ash-
brown; lore and ear-coverts black; nape of the neck white; back scapulars, wing-coverts,
tertials, rump, and upper tail-coverts, ash-brown; primary and secondary wing-feathers
dusky-brown; these and the greater wing-coverts edged with white; the fir

```json
"v34-100-p02": ""
```

---

10 rows. Everything else in the 150 belongs to birds this garden does not hear.
