# HaptiNav — Obstacle Detection for Visually Impaired

A browser-only, real-time obstacle detection app that gives voice, haptic
(vibration), and audio-beep feedback using nothing but the device camera —
no backend, no external libraries.

## Files

| File         | Language   | Purpose                                              |
|--------------|------------|-------------------------------------------------------|
| `index.html` | HTML5      | Page structure: welcome screen, camera view, controls |
| `style.css`  | CSS3       | All styling, layout, colors, and animations            |
| `script.js`  | JavaScript | Camera capture, frame-differencing detection, zone mapping, and voice/haptic/audio feedback logic |

## How it works

1. Requests camera access (`getUserMedia`) on the rear camera.
2. Downscales each frame to 160×120 and compares it against the previous
   frame (frame-differencing) to detect motion.
3. Groups moving pixels into blobs (flood-fill / connected components) and
   maps each blob onto a 3×2 zone grid (Left / Centre / Right, Front-Left /
   Front / Front-Right).
4. Classifies the nearest blob as Safe, Caution, or Danger and raises a
   zone-specific voice alert (Web Speech API), vibration pattern
   (Vibration API), and audio tone (Web Audio API).

## Running locally

Just open `index.html` in a browser — or, for camera access to work
reliably, serve the folder locally, e.g.:

```bash
npx serve .
```

Then visit `http://localhost:3000` (or the port shown) on a device with a
camera.

## Deploying with GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Set the source to the `main` branch, root folder.
4. Your app will be live at `https://<username>.github.io/<repo-name>/`.
5.
