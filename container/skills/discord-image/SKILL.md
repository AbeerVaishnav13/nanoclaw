---
name: discord-image
description: Handle Discord image attachments — explains the full image pipeline and what Rocky should do when user sends an image. Invoke when user sends an image or asks about image handling.
---

# Discord Image Pipeline

## How it works

When a user sends an image in Discord, nanoclaw processes it **before** it reaches Rocky:

1. **Discord.ts detects the attachment** — checks `message.attachments` for `image/` content type
2. **`fetchAndResizeImage()`** — downloads image from Discord CDN URL
3. **Resize** — shrinks image to max **1024px** on longest side using `sharp`
4. **Convert** — encodes as base64 JPEG
5. **Pass to agent** — image is included in the `NewMessage.images` array as an `ImageAttachment`:
   ```ts
   interface ImageAttachment {
     data: string;       // base64-encoded JPEG
     media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
     name: string;
   }
   ```
6. **Claude receives it** as a multimodal message — Rocky CAN see the image directly in the conversation

## What Rocky sees in the message

The message content will contain a placeholder like:
```
[Image: filename.png]
```
And the actual image data is passed as a multimodal attachment — **Rocky can see the full image visually**.

## Common failure modes

| Problem | Cause | Fix |
|---|---|---|
| Rocky can't see image | Image was sent in a **previous session** — data not carried over | Ask user to **resend the image** |
| Image fetch failed | Discord CDN URL expired | Ask user to resend |
| `sharp` error | ARM vs x86 module mismatch on host | Host nanoclaw issue, not container |

## What Rocky should do when image is received

1. **Look at the image** — Rocky is multimodal, just describe what you see
2. **If Rocky can't see it** (e.g., only sees `[Image: filename.png]` with no visual) → tell user "Rocky not see image — please resend!" Don't say image pipeline doesn't exist.
3. **Never say** "image attachments not supported" — they ARE supported.

## Logs to check if pipeline failed

```bash
grep -i "image\|attachment\|fetchAndResize" /workspace/extra/claw/nanoclaw/logs/nanoclaw.log | tail -20
```

Look for:
- `Fetching Discord image attachment` ✅
- `Discord image resized OK` ✅
- `Failed to process Discord image attachment` ❌
