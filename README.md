# Audio Locomotion Lab (Three.js, GitHub Pages)

Static Three.js repo meant to run on GitHub Pages (no build step).

## Controls
- WASD: move (W forward, S back, A/D strafe)
- Mouse: aim (click canvas to lock mouse)
- Shift: sprint (4 stages)
  - Stage up by re-tapping Shift within 2 seconds after releasing it
- Space: jump
- Ctrl (hold): crouch/slide (momentum-based)
- Scroll: zoom in/out (smooth)
- Alt: show cursor
- Alt + RMB drag: orbit camera around character

## Audio emitters
- Click an emitter to play/stop (works best when mouse is NOT locked)
- Upload an audio file per emitter to replace its sound

## Character asset
- Optional: upload a GLB/GLTF to replace the capsule placeholder
- The controller drives the root transform. Animations are not wired yet.

## Deploy on GitHub Pages
1. Create a repo (public recommended).
2. Add these files.
3. GitHub → Settings → Pages
4. Source: `Deploy from a branch`
5. Branch: `main` (or `master`), folder `/root`
6. Save, then open the Pages URL.

## Notes about selecting audio output device
Browsers generally do NOT let a webpage freely pick the system output device unless you use `setSinkId()` on an `HTMLMediaElement` and the browser supports it.
The device picker you see "near the URL" is usually a browser feature for media inputs (mic/cam) or site permissions, not a universal output selector for WebAudio.
