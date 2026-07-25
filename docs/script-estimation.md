---
created: 2026-07-25
updated: 2026-07-25
---

# Script to clip durations

For video models that speak the script inside the clip (grok-class). The clip's length must be chosen before the voice exists. This is how to choose it, and what to do after.

The unit of everything here is the **beat**: one continuous shot and the words that live inside it. The duration question only exists per beat, never per script.

## The five moves

**1. Slice the script into beats.**
Whatever form the script arrives in, cut it into beats: who speaks, what happens, where it starts and ends. The beat map is a draft, not a contract. Beats get split, merged, and moved as the math and the watched takes push back. Re-slicing is free; just redo the counting for the reshaped beat.

**2. Count the beat's claps.**
Rewrite the beat's words the way a mouth says them: "240" becomes "two hundred forty", "Dr." becomes "Doctor". Then count syllables, the claps of speech ("fam-i-lies" is three, "God" is one). Count claps, never words: words lie about their size, claps don't. One number comes out.

**3. Turn claps into a clip length.**

> clip seconds = claps ÷ speed, + 1 for breathing, + however long the wordless actions take. Round up.

The **speed** is the model's measured talking pace (see "Measuring the speed" below). Use the slow end of its range: if the model talks faster than planned, the extra air gets trimmed for free; if you plan fast and it talks slow, the last words fall off the end, and the last words are usually the point.

The **wordless actions** are things the script stages without speech: a turn to camera, a held look, a car crossing behind. They cost time like words do. Price them by imagining doing them ("turn... one second; van crosses... two").

**4. Too big for the model's ceiling? Cut the beat in two.**
Cut where a listener expects a breath: at a turn in the thought. Never cut in the middle of a build (a repeated phrase, a rising list); a build split across two clips gets performed with two different energies and breaks. Each half is then a normal beat: count it, size it. The seam can be invisible (next clip starts from the last frame of the previous, same shot continues) or a real cut to a new angle.

**5. After generating: check the soundtrack, then trim.**

```
ffmpeg -i clip.mp4 -af "silencedetect=noise=-27dB:d=0.4" -f null -
```

The silence list tells you two things: where the talking actually ends, and whether your written pauses happened where you wrote them. If constant background sound hides the silences, transcribe instead; word timestamps are the ground truth.

Then **trim, don't reroll**: keep the talking plus a short beat after the last word (or the scripted held look), fade the audio over a blink, keep the original file. Leftover air costs one scissors cut; a reroll costs money and re-rolls a performance you already liked.

## Directing notes (they shape the time, so they live here)

- **A pause only exists if it's written.** Prose direction ("speak slowly, pause dramatically") does nothing. Marks inside the quoted line work every time: `...` where the pause goes. The silence detector will show the pauses landing exactly on the dots, which is also how you audit a take without watching it.
- **CAPS give emphasis at no time cost. Exclamation points buy energy by spending time**: they speed the delivery up. Use them knowingly.
- **The speaking speed is not a knob.** Tone words barely move it. The knobs are the container (clip length), the punctuation inside the quotes, and the script itself. The speed is a reading you take, then plan around.

## Measuring the speed

Every generated clip re-measures the speed for free: you knew the beat's claps when you sized it, and the silence check just told you the talking time. Claps ÷ talking seconds = today's speed. Take the reading from the last few keepers rather than trusting an old note.

To calibrate a brand-new model: one short script with a known clap count, one take, divide. Also note whether the model paces itself to fit the container at all (grok does; it talks a little faster in tight clips and a little slower in roomy ones).

**Last readings:** grok-imagine-video-1.5, July 2026: 4.3 claps/second relaxed, up to 4.7 squeezed. Ceiling 15 seconds. Size with 4.3.

## Worked example

Anchor line, counted at 45 claps, one `...`, ends on a short hang:
45 ÷ 4.3 ≈ 10.5 talking, + 1 breathing, + a short hang ≈ 12. **Container: 12 seconds.**
Generated: talking measured to 11.2s, pause landed on the dots, 0.8s of air trimmed off the tail. Done.
