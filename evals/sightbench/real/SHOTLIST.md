# SightBench real-world set: photo shot list

Goal: 60 or more household items, photographed the same way, so we can test the parcel check on real photos.

## What to photograph (60+ items)
Aim for these mixes. Add more where you can.
- Clothes with size tags (20+): several colours. Include pairs that are easy to confuse: navy and black, black and charcoal, navy and charcoal. Use the same cut and size where possible.
- Shoes with size labels (8+).
- Mugs (8+): different colours and sizes.
- Chargers and cables with model numbers (10+).
- Cosmetics with a name or shade on the label (8+).
- Books (6+): cover, and edition or ISBN on the back.

## Shots per item
Three lighting conditions, two shots each, plus an optional damage shot.

| Light | Code | How |
|---|---|---|
| Daylight by a window | day | Near a window, no direct sun on the item. |
| Indoor lamp | lamp | Normal room lamp, curtains closed. |
| Dim | dim | One small light on in the next room. No flash. |

| Shot | Code | How |
|---|---|---|
| Whole item, front | item | Phone about an arm's length away. Whole item in frame. |
| Label or tag close-up | label | Phone about a hand's width from the label. Text readable. |
| Damage (optional) | damage | Only if the item has a tear, stain, crack or dent. Close, in lamp light. |

Total: 6 required photos per item (3 lights x 2 shots), plus 0 to 3 damage photos.

General rules:
- Plain background: a plain sheet, table or floor. Nothing else in frame.
- Hold the phone with both hands. One photo per shot, do not use burst or filters.
- Use the normal camera app, no flash, no HDR or beauty modes.
- Take what you get. Do not retake because a photo looks dim or blurry. That is the test.

## File names
`<itemId>_<light>_<shot>.jpg`
- itemId: `r001`, `r002` ... zero-padded, unique.
- light: `day`, `lamp` or `dim`.
- shot: `item`, `label` or `damage`.
- Examples: `r001_day_item.jpg`, `r001_dim_label.jpg`, `r014_lamp_damage.jpg`.
- If you take more than one damage photo, add a number: `r014_lamp_damage2.jpg`.

## items.csv
One row per item, in `evals/sightbench/real/items.csv`. Header:

```
item_id,category,brand,title,colour,size,model,notes
r001,clothing,Brandname,Crew-neck sweater,navy,M,,cotton knit; tag inside collar
r002,clothing,Brandname,Crew-neck sweater,charcoal,M,,same cut as r001
r003,charger,Brandname,USB-C wall charger,white,,AB-1234,model on back in small print
```

- Leave a cell empty if it does not apply. Quote cells that contain commas.
- Write colour and size as they appear on the item or tag, not what you guess.
- Put damage details in notes.

## Near-miss pairing
Each item gets two listings:
- True listing: matches the item exactly.
- Near-miss listing: differs by exactly one attribute (colour, size, model or product). For example, navy vs charcoal, M vs L, or model AB-1234 vs AB-1243.
The one changed attribute is recorded for each pair. Do not change two things at once.

## Privacy rules
- No faces, yours or anyone else's. No people or reflections in mirrors or glass.
- No addresses, house numbers or street names. No parcel labels with a name or address.
- No screens showing personal information.
- No documents, letters, cards or ID.
- Remove location data (GPS and place tags) from every photo before saving. Turn off location tagging in the camera settings, and check with an EXIF tool.
- Only photograph items you own or have permission to photograph.

## Where files go
Put photos in `evals/data/raw/real/` (git-ignored, never committed). Keep `items.csv` in `evals/sightbench/real/`.

## Split rule
The test split is frozen before any tuning. Choose it once, write the item ids to a file, and do not look at test results while changing prompts, thresholds or models. If an item is added later, it goes to a new split, not the frozen test set.
